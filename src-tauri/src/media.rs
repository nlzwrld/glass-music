use crate::db::{self, now, Library, Result};
use lofty::{
    file::{AudioFile, TaggedFileExt},
    tag::Accessor,
};
use serde_json::json;
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File},
    io::{Read, Seek, SeekFrom},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicU64, Ordering},
        mpsc::{sync_channel, SyncSender},
        Arc, Mutex, OnceLock,
    },
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tiny_http::{Header, Request, Response, Server, StatusCode};

pub const NOW_PLAYING_SLOT_ID: i32 = 1001;
pub const NOW_PLAYING_TAG: &str = "liquid-hub-now-playing";

/// Anti-spam gate separating real-time OS media metadata from desktop pop-up notifications.
#[derive(Default)]
pub struct NotificationGate {
    active_track_id: Option<String>,
    last_notified_track_id: Option<String>,
    pending_abort: Option<tokio::task::AbortHandle>,
}

pub fn resolve_notification_mode(pref: &serde_json::Value) -> &'static str {
    match db::s(pref, "notificationMode") {
        "off" => "off",
        "background" => "background",
        "always" => "always",
        _ => {
            if pref["notifications"] == true {
                "background"
            } else {
                "off"
            }
        }
    }
}

impl NotificationGate {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn cancel_pending(&mut self) {
        if let Some(handle) = self.pending_abort.take() {
            handle.abort();
        }
    }

    /// Updates immediate OS/tray track identity and aborts any pending notification from a skipped track.
    pub fn on_track_metadata(&mut self, track_id: &str) {
        if self.active_track_id.as_deref() != Some(track_id) {
            self.cancel_pending();
            self.active_track_id = if track_id.is_empty() {
                None
            } else {
                Some(track_id.to_string())
            };
        }
    }

    /// Evaluates focus-aware suppression, user preference mode, and single-slot deduplication.
    pub fn should_dispatch(&mut self, mode: &str, window_focused: bool, track_id: &str) -> bool {
        self.cancel_pending();
        if mode == "off" || !["background", "always"].contains(&mode) {
            return false;
        }
        if mode == "background" && window_focused {
            return false;
        }
        if track_id.is_empty() {
            return false;
        }
        if self.last_notified_track_id.as_deref() == Some(track_id) {
            return false;
        }
        self.last_notified_track_id = Some(track_id.to_string());
        true
    }
}

pub fn hash(raw: &[u8]) -> String {
    format!("{:x}", Sha256::digest(raw))
}
#[allow(dead_code)] // Retained for existing local libraries and metadata regression coverage.
pub fn import_file(db: &Library, path: &Path, data: &Path) -> Result<()> {
    let path = path.canonicalize().map_err(|_| "Arquivo não encontrado")?;
    if fs::metadata(&path).map_err(|e| e.to_string())?.len() > 2_000_000_000 {
        return Err("Arquivo maior que 2 GB.".into());
    }
    let tagged =
        lofty::read_from_path(&path).map_err(|_| "Não foi possível ler este formato de áudio.")?;
    let tag = tagged.primary_tag().or_else(|| tagged.first_tag());
    let id = hash(path.to_string_lossy().to_lowercase().as_bytes());
    let fallback = path
        .file_stem()
        .unwrap_or_default()
        .to_string_lossy()
        .to_string();
    let dur_sec = tagged.properties().duration().as_secs_f64();
    let mut t = json!({"id":format!("local:{id}"),"source":"local","sourceId":id,"kind":"track","title":tag.and_then(|t|t.title()).map(|s|s.into_owned()).unwrap_or(fallback),"artist":tag.and_then(|t|t.artist()).map(|s|s.into_owned()).unwrap_or("Artista desconhecido".into()),"album":tag.and_then(|t|t.album()).map(|s|s.into_owned()).unwrap_or_default(),"duration":dur_sec,"durationMs":(dur_sec * 1000.0).round(),"catalogSource":"local","streamProvider":"local","available":true,"addedAt":now()});
    if let Some(pic) = tag.and_then(|t| t.pictures().first()) {
        if pic.data().len() < 4_000_000 {
            let ext = match pic.mime_type().map(|m| m.as_str()) {
                Some("image/jpeg") => Some("jpg"),
                Some("image/png") => Some("png"),
                Some("image/webp") => Some("webp"),
                _ => None,
            };
            if let Some(ext) = ext {
                let name = format!("{}.{ext}", hash(pic.data()));
                fs::create_dir_all(data.join("covers")).map_err(|e| e.to_string())?;
                fs::write(data.join("covers").join(&name), pic.data())
                    .map_err(|e| e.to_string())?;
                t["artwork"] = json!(format!("glass://app/covers/{name}"));
            }
        }
    }
    db.save(&t, Some(&path.to_string_lossy()))
}
pub fn seed(db: &Library, _resources: &Path) -> Result<()> {
    // Only the three authored demo IDs are removed; personal imports are preserved.
    db.transact(|| {
        db.db.execute("DELETE FROM history WHERE track_id IN ('local:glass-prisma','local:glass-mare','local:glass-orbita')",[]).map_err(|e|e.to_string())?;
        db.db.execute("DELETE FROM tracks WHERE id IN ('local:glass-prisma','local:glass-mare','local:glass-orbita')",[]).map_err(|e|e.to_string())?;
        db.db.execute("INSERT OR REPLACE INTO settings VALUES('demo-removed','1')",[]).map_err(|e|e.to_string())?;
        Ok(())
    })
}
pub fn range(raw: Option<&str>, len: u64) -> Result<(u64, u64, bool)> {
    if len == 0 {
        return Err("Arquivo vazio".into());
    }
    let Some(raw) = raw else {
        return Ok((0, len - 1, false));
    };
    let pair = raw.strip_prefix("bytes=").ok_or("Range inválido")?;
    let (a, b) = pair.split_once('-').ok_or("Range inválido")?;
    if a.is_empty() {
        let n = b.parse::<u64>().map_err(|_| "Range inválido")?;
        if n == 0 {
            return Err("Range inválido".into());
        }
        return Ok((len.saturating_sub(n), len - 1, true));
    }
    let start = a.parse::<u64>().map_err(|_| "Range inválido")?;
    let end = if b.is_empty() {
        len - 1
    } else {
        b.parse::<u64>().map_err(|_| "Range inválido")?.min(len - 1)
    };
    if start > end || start >= len {
        return Err("Range fora do arquivo".into());
    }
    Ok((start, end, true))
}
fn header(k: &str, v: &str) -> Header {
    Header::from_bytes(k, v).expect("header")
}
fn mime(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase()
        .as_str()
    {
        "webm" => "audio/webm",
        "mp3" => "audio/mpeg",
        "wav" => "audio/wav",
        "flac" => "audio/flac",
        "ogg" | "opus" => "audio/ogg",
        "m4a" | "mp4" => "audio/mp4",
        "aac" => "audio/aac",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        _ => "application/octet-stream",
    }
}
pub fn video_mime(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase()
        .as_str()
    {
        "mp4" | "m4v" => "video/mp4",
        "webm" => "video/webm",
        "mov" => "video/quicktime",
        "mkv" => "video/x-matroska",
        "ogv" | "ogg" => "video/ogg",
        _ => "application/octet-stream",
    }
}
pub fn resolve_background_video_path(db: &Library, id: &str) -> Option<PathBuf> {
    if id.is_empty() {
        return None;
    }
    let meta = db.background_video()?;
    if db::s(&meta, "id") != id {
        return None;
    }
    let raw_path = db::s(&meta, "path");
    if raw_path.is_empty() || raw_path.contains('\0') {
        return None;
    }
    let path = PathBuf::from(raw_path);
    let fs_meta = fs::metadata(&path).ok()?;
    if !fs_meta.is_file() || fs_meta.len() == 0 || fs_meta.len() > 2_000_000_000 {
        return None;
    }
    Some(path)
}
pub fn clear_covers(data: &Path) {
    let path = data.join("cover-cache");
    if let Ok(entries) = fs::read_dir(path) {
        for e in entries.flatten() {
            if e.file_type().is_ok_and(|t| t.is_file()) {
                let _ = fs::remove_file(e.path());
            }
        }
    }
}
fn sniff_image_mime(file: &mut File, fallback_path: &Path) -> &'static str {
    let mut head = [0u8; 16];
    let n = file.read(&mut head).unwrap_or(0);
    let _ = file.seek(SeekFrom::Start(0));
    if n >= 3 && head[0] == 0xFF && head[1] == 0xD8 && head[2] == 0xFF {
        return "image/jpeg";
    }
    if n >= 8 && &head[..8] == b"\x89PNG\r\n\x1a\n" {
        return "image/png";
    }
    if n >= 12 && &head[..4] == b"RIFF" && &head[8..12] == b"WEBP" {
        return "image/webp";
    }
    if n >= 6 && (&head[..6] == b"GIF87a" || &head[..6] == b"GIF89a") {
        return "image/gif";
    }
    if n >= 12 && &head[4..8] == b"ftyp" {
        return "image/avif";
    }
    mime(fallback_path)
}
fn maybe_trim_cache(dir: &Path, max: u64) {
    static LAST_TRIM_SECS: AtomicU64 = AtomicU64::new(0);
    let now_secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let prev = LAST_TRIM_SECS.load(Ordering::Relaxed);
    if now_secs.saturating_sub(prev) < 60 {
        return;
    }
    if LAST_TRIM_SECS
        .compare_exchange(prev, now_secs, Ordering::Relaxed, Ordering::Relaxed)
        .is_ok()
    {
        trim_cache(dir, max);
    }
}
fn trim_cache(dir: &Path, max: u64) {
    let mut entries: Vec<_> = fs::read_dir(dir)
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|e| {
            let m = e.metadata().ok()?;
            if !m.is_file() {
                return None;
            }
            Some((e.path(), m.len(), m.modified().ok()?))
        })
        .collect();
    entries.sort_by_key(|e| e.2);
    let mut size: u64 = entries.iter().map(|e| e.1).sum();
    for (p, n, time) in entries {
        if size > max || time.elapsed().unwrap_or_default() > Duration::from_secs(28 * 86400) {
            let _ = fs::remove_file(p);
            size = size.saturating_sub(n);
        }
    }
}
pub fn serve(db: Arc<Mutex<Library>>, data: PathBuf, audio: Arc<crate::audio::AudioStreams>) -> Result<String> {
    let server = Arc::new(Server::http("127.0.0.1:0").map_err(|e| e.to_string())?);
    let addr = server.server_addr().to_ip().ok_or("Porta indisponível")?;
    let token = uuid::Uuid::new_v4().simple().to_string();
    let base = format!("http://{addr}/{token}");
    let (audio_tx,audio_rx)=sync_channel::<(Request,String,bool)>(32);
    let audio_rx=Arc::new(Mutex::new(audio_rx));
    for _ in 0..8 {
        let receiver=audio_rx.clone();let audio=audio.clone();
        std::thread::spawn(move||loop {
            let next=receiver.lock().unwrap().recv();
            match next {Ok((req,ticket,allowed))=>audio.respond(req,&ticket,allowed),Err(_)=>break}
        });
    }
    for _ in 0..16 {
        let server = server.clone();
        let db = db.clone();
        let data = data.clone();
        let audio_tx = audio_tx.clone();
        let token = token.clone();
        std::thread::spawn(move || {
            for req in server.incoming_requests() {
                handle(req, &db, &data, &token, &addr.to_string(), &audio_tx);
            }
        });
    }
    Ok(base)
}
fn handle(req: Request, db: &Arc<Mutex<Library>>, data: &Path, token: &str, host: &str, audio: &SyncSender<(Request,String,bool)>) {
    let cors = vec![
        header("Access-Control-Allow-Origin", "*"),
        header("Cross-Origin-Resource-Policy", "cross-origin"),
        header("X-Content-Type-Options", "nosniff"),
    ];
    let fail = |req: Request, status: u16| {
        let _ = req.respond(
            Response::from_string("Recurso indisponível")
                .with_status_code(status)
                .with_header(header("Access-Control-Allow-Origin", "*"))
                .with_header(header("Cross-Origin-Resource-Policy", "cross-origin"))
                .with_header(header("Cache-Control", "no-store")),
        );
    };
    if req
        .headers()
        .iter()
        .find(|h| h.field.equiv("Host"))
        .map(|h| h.value.as_str())
        != Some(host)
        || !matches!(req.method().as_str(), "GET" | "HEAD")
    {
        fail(req, 403);
        return;
    }
    let u = match url::Url::parse(&format!("http://{host}{}", req.url())) {
        Ok(u) => u,
        Err(_) => {
            fail(req, 400);
            return;
        }
    };
    let prefix = format!("/{token}/");
    let Some(path) = u.path().strip_prefix(&prefix) else {
        fail(req, 404);
        return;
    };
    if let Some(ticket)=path.strip_prefix("audio/") {
        let pref=db.lock().unwrap().pref();let allowed=pref["onlineConsent"]==true&&pref["onboardingDone"]==true;
        if let Err(error)=audio.try_send((req,ticket.to_string(),allowed)) {
            let (std::sync::mpsc::TrySendError::Full((req,_,_))|std::sync::mpsc::TrySendError::Disconnected((req,_,_)))=error;fail(req,503);
        }
        return;
    }
    let embed = match path {
        "embed/index.html" => Some((
            include_str!("../../desktop/embed/index.html"),
            "text/html; charset=utf-8",
        )),
        "embed/engine.js" => Some((
            include_str!("../../desktop/embed/engine.js"),
            "application/javascript",
        )),
        "embed/style.css" => Some((include_str!("../../desktop/embed/style.css"), "text/css")),
        _ => None,
    };
    if let Some((body, mime)) = embed {
        let csp="default-src 'none'; script-src 'self' https://w.soundcloud.com; style-src 'self' 'unsafe-inline'; img-src https: data:; frame-src https://w.soundcloud.com; connect-src https://w.soundcloud.com; frame-ancestors https://tauri.localhost http://tauri.localhost http://127.0.0.1:5173";
        let mut r = Response::from_string(body)
            .with_header(header("Content-Type", mime))
            .with_header(header("Content-Security-Policy", csp))
            .with_header(header("Referrer-Policy", "strict-origin-when-cross-origin"));
        for h in cors {
            r.add_header(h);
        }
        let _ = req.respond(r);
        return;
    }
    let path_is_cover = path == "cover" || path.starts_with("covers/");
    let path_is_bg_video = path.starts_with("bg-video/");
    let file = if let Some(id)=path.strip_prefix("offline/"){
      let decoded=url::form_urlencoded::parse(format!("id={id}").as_bytes()).next().map(|(_,v)|v.into_owned()).unwrap_or_default();
      db.lock().unwrap().offline_path(&decoded).filter(|(p,_)|crate::offline::owned_path(data,p)).map(|(p,_)|PathBuf::from(p))
    }else if let Some(id) = path.strip_prefix("media/") {
        let decoded = url::form_urlencoded::parse(format!("id={id}").as_bytes())
            .next()
            .map(|(_, v)| v.into_owned())
            .unwrap_or_default();
        db.lock().unwrap().path(&decoded).map(PathBuf::from)
    } else if let Some(name) = path.strip_prefix("covers/") {
        if !db::artwork_url(&format!("glass://app/covers/{name}")) {
            None
        } else {
            Some(data.join("covers").join(name))
        }
    } else if path == "cover" {
        let (consent, max) = {
            let p = db.lock().unwrap().pref();
            (
                p["onlineConsent"] == true && p["onboardingDone"] == true,
                p["coverCacheMB"].as_u64().unwrap_or(128) * 1024 * 1024,
            )
        };
        let url = u
            .query_pairs()
            .find(|(k, _)| k == "url")
            .map(|(_, v)| v.into_owned())
            .unwrap_or_default();
        if !consent || !url.starts_with("https://") || !db::artwork_url(&url) {
            None
        } else {
            let dir = data.join("cover-cache");
            let _ = fs::create_dir_all(&dir);
            maybe_trim_cache(&dir, max);
            let h = hash(url.as_bytes());
            let p = dir.join(format!("{h}.jpg"));
            let valid_cached = fs::metadata(&p).map(|m| m.len() > 64).unwrap_or(false);
            if !valid_cached {
                static COVERS: OnceLock<reqwest::blocking::Client> = OnceLock::new();
                if let Some(c) = COVERS.get().or_else(|| {
                    let redirect_policy = reqwest::redirect::Policy::custom(|attempt| {
                        if attempt.previous().len() >= 3 {
                            return attempt.stop();
                        }
                        if db::artwork_url(attempt.url().as_str()) {
                            attempt.follow()
                        } else {
                            attempt.stop()
                        }
                    });
                    let client = crate::providers::blocking_http_client_builder()
                        .connect_timeout(Duration::from_secs(4))
                        .timeout(Duration::from_secs(8))
                        .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36")
                        .redirect(redirect_policy)
                        .build()
                        .ok()?;
                    let _ = COVERS.set(client);
                    COVERS.get()
                }) {
                    if let Ok(r) = c
                        .get(&url)
                        .header("Accept", "image/avif,image/webp,image/apng,image/*,*/*;q=0.8")
                        .send()
                    {
                        let ct_ok = r
                            .headers()
                            .get("content-type")
                            .and_then(|h| h.to_str().ok())
                            .is_none_or(|t| {
                                let lower = t.to_ascii_lowercase();
                                lower.starts_with("image/") || lower.starts_with("application/octet-stream")
                            });
                        if r.status().is_success() && ct_ok {
                            let mut bytes = Vec::new();
                            let _ = r.take(4_000_001).read_to_end(&mut bytes);
                            if bytes.len() > 64 && bytes.len() <= 4_000_000 {
                                let tmp = dir.join(format!("{h}.{}.tmp", uuid::Uuid::new_v4().simple()));
                                if fs::write(&tmp, &bytes).is_ok() {
                                    if fs::rename(&tmp, &p).is_err() {
                                        let _ = fs::remove_file(&tmp);
                                    }
                                }
                            }
                        }
                    }
                }
            }
            if fs::metadata(&p).map(|m| m.len() > 64).unwrap_or(false) {
                Some(p)
            } else {
                None
            }
        }
    } else if let Some(id) = path.strip_prefix("bg-video/") {
        let decoded = url::form_urlencoded::parse(format!("id={id}").as_bytes())
            .next()
            .map(|(_, v)| v.into_owned())
            .unwrap_or_default();
        resolve_background_video_path(&db.lock().unwrap(), &decoded)
    } else {
        None
    };
    let Some(path) = file else {
        fail(req, 404);
        return;
    };
    let Ok(mut file) = File::open(&path) else {
        fail(req, 404);
        return;
    };
    let len = file.metadata().map(|m| m.len()).unwrap_or(0);
    let raw = req
        .headers()
        .iter()
        .find(|h| h.field.equiv("Range"))
        .map(|h| h.value.as_str());
    let Ok((start, end, partial)) = range(raw, len) else {
        let _ = req.respond(
            Response::empty(416).with_header(header("Content-Range", &format!("bytes */{len}"))),
        );
        return;
    };
    let content_type = if path_is_cover {
        sniff_image_mime(&mut file, &path)
    } else if path_is_bg_video {
        video_mime(&path)
    } else {
        mime(&path)
    };
    let _ = file.seek(SeekFrom::Start(start));
    let size = end - start + 1;
    let mut headers = cors;
    headers.push(header("Content-Type", content_type));
    headers.push(header("Accept-Ranges", "bytes"));
    headers.push(header("Cache-Control", "private, max-age=3600"));
    if partial {
        headers.push(header(
            "Content-Range",
            &format!("bytes {start}-{end}/{len}"),
        ));
    }
    let r = Response::new(
        StatusCode(if partial { 206 } else { 200 }),
        headers,
        file.take(size),
        Some(size as usize),
        None,
    );
    let _ = req.respond(r);
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn ranges() {
        assert_eq!(range(Some("bytes=2-5"), 10).unwrap(), (2, 5, true));
        assert_eq!(range(Some("bytes=-3"), 10).unwrap(), (7, 9, true));
        assert!(range(Some("bytes=100-"), 10).is_err());
        assert!(range(Some("bytes=0-1,3-4"), 10).is_err());
        assert!(range(None, 0).is_err());
    }
    #[test]
    fn imports_real_audio_metadata() {
        let db = Library::open(Path::new(":memory:")).unwrap();
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../assets");
        let path = root.join("audio/prisma.wav");
        import_file(&db, &path, &root).unwrap();
        let snap = db.snapshot().unwrap();
        let t = &snap["tracks"][0];
        assert_eq!(t["duration"], 48.0);
        assert_eq!(t["available"], true);
        assert!(db.path(db::s(t, "id")).unwrap().ends_with("prisma.wav"));
    }

    #[test]
    fn notification_gate_suppresses_off_focused_and_duplicate_tracks() {
        let mut gate = NotificationGate::new();
        // Off mode (default) never dispatches
        assert!(!gate.should_dispatch("off", false, "youtube:track1"));
        // Background mode suppresses when window is focused
        assert!(!gate.should_dispatch("background", true, "youtube:track1"));
        // Background mode dispatches once when unfocused
        assert!(gate.should_dispatch("background", false, "youtube:track1"));
        // Pause/play/seek on the same track never re-notifies
        assert!(!gate.should_dispatch("background", false, "youtube:track1"));
        assert!(!gate.should_dispatch("always", false, "youtube:track1"));
        // Advancing to a new track dispatches and updates slot
        gate.on_track_metadata("youtube:track2");
        assert!(gate.should_dispatch("background", false, "youtube:track2"));
    }

    #[test]
    fn video_mime_maps_video_extensions_without_altering_audio_mime() {
        assert_eq!(video_mime(Path::new("loop.mp4")), "video/mp4");
        assert_eq!(video_mime(Path::new("loop.M4V")), "video/mp4");
        assert_eq!(video_mime(Path::new("loop.webm")), "video/webm");
        assert_eq!(video_mime(Path::new("loop.mov")), "video/quicktime");
        assert_eq!(video_mime(Path::new("loop.mkv")), "video/x-matroska");
        assert_eq!(video_mime(Path::new("loop.ogv")), "video/ogg");
        assert_eq!(video_mime(Path::new("loop.ogg")), "video/ogg");
        assert_eq!(video_mime(Path::new("loop.unknown")), "application/octet-stream");
        assert_eq!(video_mime(Path::new("no_extension")), "application/octet-stream");

        // Audio mime() must remain untouched
        assert_eq!(mime(Path::new("track.mp4")), "audio/mp4");
        assert_eq!(mime(Path::new("track.webm")), "audio/webm");
        assert_eq!(mime(Path::new("track.ogg")), "audio/ogg");
    }

    #[test]
    fn bg_video_resolution_checks_id_match_and_valid_file() {
        let db = Library::open(Path::new(":memory:")).unwrap();
        let tmp_dir = std::env::temp_dir().join(format!(
            "lh-bg-video-test-{}",
            uuid::Uuid::new_v4().simple()
        ));
        fs::create_dir_all(&tmp_dir).unwrap();
        let file_path = tmp_dir.join("backdrop.mp4");
        fs::write(&file_path, b"ftypisom-mock-video-bytes").unwrap();

        let id = "bgvid-1234abcd";
        db.set_background_video(&json!({
            "id": id,
            "path": file_path.to_string_lossy(),
            "name": "backdrop.mp4",
            "size": 25,
            "mime": "video/mp4"
        }))
        .unwrap();

        assert_eq!(resolve_background_video_path(&db, id), Some(file_path.clone()));
        assert_eq!(resolve_background_video_path(&db, "wrong-id"), None);
        assert_eq!(resolve_background_video_path(&db, ""), None);

        // Directory path must be rejected (not a regular file)
        db.set_background_video(&json!({
            "id": "dir-id",
            "path": tmp_dir.to_string_lossy(),
            "name": "dir",
            "size": 0,
            "mime": "application/octet-stream"
        }))
        .unwrap();
        assert_eq!(resolve_background_video_path(&db, "dir-id"), None);

        // Empty file must be rejected
        let empty_path = tmp_dir.join("empty.mp4");
        fs::write(&empty_path, b"").unwrap();
        db.set_background_video(&json!({
            "id": "empty-id",
            "path": empty_path.to_string_lossy(),
            "name": "empty.mp4",
            "size": 0,
            "mime": "video/mp4"
        }))
        .unwrap();
        assert_eq!(resolve_background_video_path(&db, "empty-id"), None);

        // Deleted file must be rejected
        let _ = fs::remove_file(&file_path);
        db.set_background_video(&json!({
            "id": id,
            "path": file_path.to_string_lossy(),
            "name": "backdrop.mp4",
            "size": 25,
            "mime": "video/mp4"
        }))
        .unwrap();
        assert_eq!(resolve_background_video_path(&db, id), None);

        let _ = fs::remove_dir_all(&tmp_dir);
    }
}
