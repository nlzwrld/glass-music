use crate::db::{now, s, Result};
use serde_json::Value;
use std::{
    collections::HashMap,
    io::{Cursor, Read},
    sync::{Arc, Mutex, OnceLock},
    time::{Duration, Instant},
};
use tiny_http::{Header, Request, Response, StatusCode};

const INITIAL_CHUNK: u64 = 262_143; // 256 KB (~16s of 128kbps m4a/opus — instant start!)
const FOLLOW_CHUNK: u64 = 524_287; // 512 KB for steady streaming

#[derive(Clone)]
struct HeadChunk {
    bytes: Arc<Vec<u8>>,
    total: Option<u64>,
}

#[derive(Clone)]
pub struct Stream {
    url: String,
    agent: String,
    mime: String,
    expires: i64,
    head: Arc<OnceLock<HeadChunk>>,
}

pub struct AudioStreams {
    entries: Mutex<HashMap<String, Stream>>,
    cache: Mutex<HashMap<String, (Instant, String, f64)>>,
}

fn http_client() -> &'static reqwest::blocking::Client {
    static CLIENT: OnceLock<reqwest::blocking::Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        let redirect_policy = reqwest::redirect::Policy::custom(|attempt| {
            if attempt.previous().len() >= 3 {
                return attempt.stop();
            }
            if valid_cdn(attempt.url().as_str()) {
                attempt.follow()
            } else {
                attempt.stop()
            }
        });
        crate::providers::blocking_http_client_builder()
            .connect_timeout(Duration::from_secs(7))
            .timeout(Duration::from_secs(60))
            .pool_idle_timeout(Duration::from_secs(20))
            .pool_max_idle_per_host(8)
            .redirect(redirect_policy)
            .build()
            .expect("audio HTTP client")
    })
}

fn parse_total(content_range: Option<&str>, len: usize) -> Option<u64> {
    if let Some(raw) = content_range {
        if let Some((_, total)) = raw.strip_prefix("bytes ")?.split_once('/') {
            if let Ok(n) = total.parse::<u64>() {
                return Some(n);
            }
        }
    }
    if len < (INITIAL_CHUNK as usize + 1) {
        Some(len as u64)
    } else {
        None
    }
}

fn prefetch_head(stream: Stream) {
    std::thread::spawn(move || {
        let mut req = http_client()
            .get(&stream.url)
            .header("Range", format!("bytes=0-{INITIAL_CHUNK}"));
        if !stream.agent.is_empty() {
            req = req.header("User-Agent", &stream.agent);
        }
        let Ok(resp) = req.send() else { return };
        if ![200, 206].contains(&resp.status().as_u16()) {
            return;
        }
        let cr = resp
            .headers()
            .get("Content-Range")
            .and_then(|v| v.to_str().ok())
            .map(str::to_string);
        let mut bytes = Vec::with_capacity((INITIAL_CHUNK as usize) + 1);
        if resp
            .take(INITIAL_CHUNK + 2)
            .read_to_end(&mut bytes)
            .is_ok()
            && !bytes.is_empty()
            && bytes.len() <= (INITIAL_CHUNK as usize + 1)
        {
            let total = parse_total(cr.as_deref(), bytes.len());
            let _ = stream.head.set(HeadChunk {
                bytes: Arc::new(bytes),
                total,
            });
        }
    });
}

impl AudioStreams {
    pub fn new() -> Self {
        Self {
            entries: Mutex::new(HashMap::new()),
            cache: Mutex::new(HashMap::new()),
        }
    }
    pub fn cached(&self, id: &str) -> Option<(String, f64)> {
        let hit = self
            .cache
            .lock()
            .unwrap()
            .get(id)
            .filter(|(at, _, _)| at.elapsed() < Duration::from_secs(1200))
            .cloned();
        hit.and_then(|(_, ticket, duration)| {
            self.entries
                .lock()
                .unwrap()
                .get(&ticket)
                .filter(|stream| stream.expires > now() + 60_000)
                .map(|_| (ticket, duration))
        })
    }
    pub fn clear(&self) {
        self.cache.lock().unwrap().clear();
        self.entries.lock().unwrap().clear();
    }
    pub fn invalidate(&self, id_or_ticket: &str) {
        if id_or_ticket.is_empty() {
            return;
        }
        let mut entries = self.entries.lock().unwrap();
        let mut cache = self.cache.lock().unwrap();
        entries.remove(id_or_ticket);
        if let Some((_, ticket, _)) = cache.remove(id_or_ticket) {
            entries.remove(&ticket);
        }
        cache.retain(|_, (_, ticket, _)| ticket != id_or_ticket);
    }
    pub fn register(&self, id: &str, data: &Value) -> Result<(String, f64)> {
        let url = s(data, "url");
        if !valid_cdn(url)
            || s(data, "vcodec") != "none"
            || s(data, "acodec") == "none"
            || s(data, "protocol") != "https"
        {
            return Err("A plataforma não disponibilizou um fluxo de áudio compatível.".into());
        }
        let duration = data["duration"]
            .as_f64()
            .filter(|v| v.is_finite() && *v > 0.0 && *v <= 604800.0)
            .unwrap_or(0.0);
        let parsed = url::Url::parse(url).unwrap();
        let expires = parsed
            .query_pairs()
            .find(|(k, _)| k == "expire")
            .and_then(|(_, v)| v.parse::<i64>().ok())
            .map(|n| n.saturating_mul(1000))
            .unwrap_or(now() + 3_600_000)
            .min(now() + 21_600_000);
        if expires < now() + 60_000 {
            return Err("O endereço do áudio expirou. Tente reproduzir novamente.".into());
        }
        let agent = s(&data["http_headers"], "User-Agent");
        let agent = if agent.len() <= 512 && agent.is_ascii() && !agent.contains(['\r', '\n']) {
            agent.to_string()
        } else {
            String::new()
        };
        let ticket = uuid::Uuid::new_v4().simple().to_string();
        let stream = Stream {
            url: url.to_string(),
            agent,
            mime: match s(data, "ext") {
                "m4a" => "audio/mp4",
                "mp3" => "audio/mpeg",
                _ => "audio/webm",
            }
            .into(),
            expires,
            head: Arc::new(OnceLock::new()),
        };
        prefetch_head(stream.clone());
        let mut entries = self.entries.lock().unwrap();
        entries.retain(|_, v| v.expires > now());
        // Only current/recent track references are kept in memory, never saved audio files.
        if entries.len() >= 48 {
            entries.clear();
            self.cache.lock().unwrap().clear();
        }
        entries.insert(ticket.clone(), stream);
        drop(entries);
        self.cache
            .lock()
            .unwrap()
            .insert(id.into(), (Instant::now(), ticket.clone(), duration));
        Ok((ticket, duration))
    }
    pub fn respond(&self, req: Request, token: &str, allowed: bool) {
        let h = |k: &str, v: &str| Header::from_bytes(k, v).unwrap();
        let fail = |req: Request, code: u16| {
            let mut resp = Response::from_string("Áudio indisponível").with_status_code(code);
            resp.add_header(Header::from_bytes("Access-Control-Allow-Origin", "*").unwrap());
            resp.add_header(Header::from_bytes("Cross-Origin-Resource-Policy", "cross-origin").unwrap());
            resp.add_header(Header::from_bytes("Cache-Control", "no-store").unwrap());
            let _ = req.respond(resp);
        };
        if !allowed {
            fail(req, 403);
            return;
        }
        let stream = self
            .entries
            .lock()
            .unwrap()
            .get(token)
            .filter(|v| v.expires > now())
            .cloned();
        let Some(stream) = stream else {
            fail(req, 404);
            return;
        };
        let range = req
            .headers()
            .iter()
            .find(|h| h.field.equiv("Range"))
            .map(|h| h.value.as_str().to_string());
        if range.as_deref().is_some_and(|v| !valid_range(v)) {
            fail(req, 416);
            return;
        }
        let base_headers = || {
            vec![
                h("Content-Type", &stream.mime),
                h("Access-Control-Allow-Origin", "*"),
                h(
                    "Access-Control-Expose-Headers",
                    "Content-Range, Accept-Ranges, Content-Length",
                ),
                h("Cross-Origin-Resource-Policy", "cross-origin"),
                h("Accept-Ranges", "bytes"),
                h("Cache-Control", "no-store"),
                h("X-Content-Type-Options", "nosniff"),
            ]
        };
        let target_range = bounded_range(range.as_deref());
        // Serve directly from pre-buffered RAM head chunk when possible (<1 ms!).
        if req.method().as_str() == "GET" {
            if let Some(head) = stream.head.get() {
                if let Some(total) = head.total {
                    if let Some((start, end)) = target_range
                        .strip_prefix("bytes=")
                        .and_then(|v| v.split_once('-'))
                        .and_then(|(a, b)| Some((a.parse::<usize>().ok()?, b.parse::<usize>().ok()?)))
                    {
                        let capped_end = end.min(head.bytes.len().saturating_sub(1));
                        if start < head.bytes.len() && capped_end >= start && (end < head.bytes.len() || head.bytes.len() as u64 == total) {
                            let slice = head.bytes[start..=capped_end].to_vec();
                            let len = slice.len();
                            let mut headers = base_headers();
                            headers.push(h(
                                "Content-Range",
                                &format!("bytes {start}-{capped_end}/{total}"),
                            ));
                            let _ = req.respond(Response::new(
                                StatusCode(206),
                                headers,
                                Cursor::new(slice),
                                Some(len),
                                None,
                            ));
                            return;
                        }
                    }
                }
            }
        }
        let client = http_client();
        let is_head = req.method().as_str() == "HEAD";
        let mut upstream = None;
        for _ in 0..2 {
            let mut request = if is_head {
                client.head(&stream.url)
            } else {
                client.get(&stream.url)
            };
            if !stream.agent.is_empty() {
                request = request.header("User-Agent", &stream.agent);
            }
            request = request.header("Range", &target_range);
            match request.send() {
                Ok(resp) => {
                    upstream = Some(resp);
                    break;
                }
                Err(_) => continue,
            }
        }
        let Some(upstream) = upstream else {
            fail(req, 502);
            return;
        };
        let status = upstream.status().as_u16();
        if ![200, 206].contains(&status) {
            if matches!(status, 403 | 404 | 410) {
                self.invalidate(token);
            }
            fail(req, if status == 416 { 416 } else { 502 });
            return;
        }
        if upstream.content_length().unwrap_or(0) > 2_000_000_000 {
            fail(req, 502);
            return;
        }
        let mut headers = base_headers();
        if let Some(value) = upstream
            .headers()
            .get("Content-Range")
            .and_then(|v| v.to_str().ok())
        {
            if value.len() < 100 {
                headers.push(h("Content-Range", value));
            }
        }
        let len = upstream
            .content_length()
            .and_then(|v| usize::try_from(v).ok());
        let _ = req.respond(Response::new(StatusCode(status), headers, upstream, len, None));
    }
}

pub fn valid_cdn(raw: &str) -> bool {
    url::Url::parse(raw).is_ok_and(|u| {
        if u.scheme() != "https"
            || !u.username().is_empty()
            || u.password().is_some()
            || u.port().is_some()
            || raw.len() >= 16000
        {
            return false;
        }
        let Some(host) = u.host_str() else {
            return false;
        };
        let is_youtube_cdn = host.ends_with(".googlevideo.com") && u.path() == "/videoplayback";
        let is_soundcloud_cdn = (host == "cf-media.sndcdn.com"
            || host == "playback.media-streaming.soundcloud.cloud"
            || (host.ends_with(".sndcdn.com") && host.len() > ".sndcdn.com".len()))
            && (u.path().starts_with("/media/")
                || u.path().contains(".mp3")
                || u.path().contains(".m4a")
                || u.path().contains(".opus")
                || u.path().contains("/playlist"));
        is_youtube_cdn || is_soundcloud_cdn
    })
}

fn bounded_range(raw: Option<&str>) -> String {
    let value = raw.unwrap_or("bytes=0-");
    let Some((start, end)) = value
        .strip_prefix("bytes=")
        .and_then(|v| v.split_once('-'))
    else {
        return format!("bytes=0-{INITIAL_CHUNK}");
    };
    if start.is_empty() {
        return value.into();
    }
    let first = start.parse::<u64>().unwrap_or(0);
    let span = if first == 0 { INITIAL_CHUNK } else { FOLLOW_CHUNK };
    let last = first.saturating_add(span);
    let end = end.parse::<u64>().map(|n| n.min(last)).unwrap_or(last);
    format!("bytes={first}-{end}")
}

fn valid_range(raw: &str) -> bool {
    let Some(range) = raw.strip_prefix("bytes=") else {
        return false;
    };
    let Some((start, end)) = range.split_once('-') else {
        return false;
    };
    raw.len() < 80
        && (!start.is_empty() || !end.is_empty())
        && start.bytes().all(|b| b.is_ascii_digit())
        && end.bytes().all(|b| b.is_ascii_digit())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn stream_destinations_cannot_be_supplied_arbitrarily() {
        assert!(valid_cdn("https://rr2---test.googlevideo.com/videoplayback?expire=1"));
        for u in [
            "https://googlevideo.com.attacker.test/videoplayback",
            "https://127.0.0.1/videoplayback",
            "http://x.googlevideo.com/videoplayback",
            "https://x.googlevideo.com:444/videoplayback",
            "https://user@x.googlevideo.com/videoplayback",
            "https://x.googlevideo.com/other",
        ] {
            assert!(!valid_cdn(u), "{u}");
        }
        for r in ["bytes=0-", "bytes=10-500", "bytes=-100"] {
            assert!(valid_range(r));
        }
        for r in [
            "bytes=0-10,20-30",
            "bytes=0-10\r\nHost: evil",
            "bytes=-",
            "other=1-2",
        ] {
            assert!(!valid_range(r));
        }
    }
    #[test]
    fn open_ended_streams_use_small_direct_ranges() {
        assert_eq!(bounded_range(None), "bytes=0-262143");
        assert_eq!(bounded_range(Some("bytes=0-")), "bytes=0-262143");
        assert_eq!(bounded_range(Some("bytes=262144-")), "bytes=262144-786431");
        assert_eq!(bounded_range(Some("bytes=2-20")), "bytes=2-20");
        assert_eq!(bounded_range(Some("bytes=-100")), "bytes=-100");
    }
    #[test]
    fn video_streams_are_rejected_even_on_the_media_cdn() {
        let streams = AudioStreams::new();
        assert!(streams
            .register(
                "test",
                &serde_json::json!({"url":"https://x.googlevideo.com/videoplayback","vcodec":"h264","acodec":"aac","protocol":"https"})
            )
            .is_err());
    }
    #[test]
    fn invalidate_evicts_dead_stream_ticket_and_cache_entry() {
        let streams = AudioStreams::new();
        let (ticket, _) = streams
            .register(
                "dQw4w9WgXcQ",
                &serde_json::json!({
                    "url": "https://rr1---sn-test.googlevideo.com/videoplayback?expire=9999999999",
                    "vcodec": "none",
                    "acodec": "mp4a.40.2",
                    "protocol": "https",
                    "ext": "m4a",
                    "duration": 212.0
                }),
            )
            .unwrap();
        assert!(streams.cached("dQw4w9WgXcQ").is_some());
        streams.invalidate(&ticket);
        assert!(streams.cached("dQw4w9WgXcQ").is_none());
    }
}
