use crate::db::{self, s, Result};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use ring::rand::{SecureRandom, SystemRandom};
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet},
    io::{BufRead, BufReader, Read, Write},
    net::{IpAddr, Ipv4Addr, SocketAddrV4, TcpListener, TcpStream, UdpSocket},
    sync::{
        mpsc::{self, SyncSender},
        Arc, Mutex, OnceLock,
    },
    time::Duration,
};

const LAN_DISCOVERY_PORT: u16 = 43879;
const LAN_MAGIC: &[u8] = b"LIQUID_HUB_JAM_DISCOVER_V2";
const MAX_PARTICIPANTS: usize = 8;
const INVITE_ALPHABET: &[u8] = b"ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const DEFAULT_INVITE_TTL_MS: i64 = 2 * 60 * 60 * 1000;
const TOMBSTONE_RETENTION_MS: i64 = 24 * 60 * 60 * 1000;
const MEMBER_GRACE_MS: i64 = 35_000;
const MAX_SSE_CLIENTS: usize = 24;

#[derive(Clone)]
struct Member {
    id: String,
    token: String,
    client_id: Option<String>,
    name: String,
    avatar: Option<String>,
    host: bool,
    online: bool,
    joined_at: i64,
    seen: i64,
}

#[derive(Clone)]
struct RecentMember {
    id: String,
    token: String,
    client_id: Option<String>,
    name: String,
    avatar: Option<String>,
    host: bool,
    joined_at: i64,
}

struct Room {
    room_id: String,
    code: String,
    room_name: String,
    host_avatar: Option<String>,
    locked: bool,
    require_auth: bool,
    max_participants: usize,
    invite_expires_at: i64,
    created_at: i64,
    members: HashMap<String, Member>,
    recent_members: HashMap<String, RecentMember>,
    kicked_keys: HashSet<String>,
    playback: Value,
    touched: i64,
}

#[derive(Clone)]
struct Tombstone {
    code: String,
    room_id: String,
    room_name: String,
    host_name: String,
    host_avatar: Option<String>,
    reason: &'static str, // "ended" | "expired"
    created_at: i64,
    ended_at: i64,
    expires_at: i64,
}

#[derive(Debug)]
struct LanErr {
    status: u16,
    message: String,
    error_code: Option<&'static str>,
    preview: Option<Value>,
}

impl LanErr {
    fn new(status: u16, message: impl Into<String>, error_code: Option<&'static str>) -> Self {
        Self {
            status,
            message: message.into(),
            error_code,
            preview: None,
        }
    }

    fn with_preview(
        status: u16,
        message: impl Into<String>,
        error_code: &'static str,
        preview: Value,
    ) -> Self {
        Self {
            status,
            message: message.into(),
            error_code: Some(error_code),
            preview: Some(preview),
        }
    }

    fn to_json(&self) -> Value {
        let mut obj = json!({ "error": self.message });
        if let Some(code) = self.error_code {
            obj["errorCode"] = json!(code);
        }
        if let Some(ref preview) = self.preview {
            obj["preview"] = preview.clone();
        }
        obj
    }
}

struct SseClient {
    room_id: String,
    token: String,
    tx: SyncSender<String>,
}

#[derive(Debug)]
struct DispatchEvents {
    broadcasts: Vec<(String, &'static str, Value)>,
    kicks: Vec<(String, String, Value)>,
    close_room_id: Option<String>,
}

impl DispatchEvents {
    fn none() -> Self {
        Self {
            broadcasts: Vec::new(),
            kicks: Vec::new(),
            close_room_id: None,
        }
    }
}

struct Coordinator {
    rooms: HashMap<String, Room>,
    tombstones: HashMap<String, Tombstone>,
    rates: HashMap<String, (i64, usize)>,
    nonces: HashMap<String, i64>,
}

fn token() -> String {
    let mut bytes = [0u8; 24];
    if SystemRandom::new().fill(&mut bytes).is_ok() {
        return URL_SAFE_NO_PAD.encode(bytes);
    }
    let mut fallback = Vec::from(uuid::Uuid::new_v4().as_bytes().as_slice());
    fallback.extend_from_slice(&uuid::Uuid::new_v4().as_bytes()[..8]);
    URL_SAFE_NO_PAD.encode(fallback)
}

fn generate_invite_code(rooms: &HashMap<String, Room>) -> String {
    let rng = SystemRandom::new();
    for _ in 0..32 {
        let mut bytes = [0u8; 8];
        if rng.fill(&mut bytes).is_ok() {
            let code: String = bytes
                .iter()
                .map(|b| INVITE_ALPHABET[(b & 31) as usize] as char)
                .collect();
            if !rooms.contains_key(&code) {
                return code;
            }
        }
    }
    loop {
        let code = uuid::Uuid::new_v4().simple().to_string()[..8].to_uppercase();
        if !rooms.contains_key(&code) {
            return code;
        }
    }
}

fn name(v: &Value) -> String {
    let clean: String = s(v, "name")
        .chars()
        .filter(|c| !c.is_control())
        .take(40)
        .collect();
    if clean.trim().is_empty() {
        "Ouvinte".into()
    } else {
        clean.trim().into()
    }
}

fn room_name(v: &Value, host_name: &str) -> String {
    let clean: String = s(v, "roomName")
        .chars()
        .filter(|c| !c.is_control())
        .take(60)
        .collect();
    if clean.trim().is_empty() {
        format!("JAM de {host_name}").chars().take(60).collect()
    } else {
        clean.trim().into()
    }
}

fn safe_client_id(v: &Value) -> Option<String> {
    let cid = s(v, "clientId");
    if (8..=80).contains(&cid.len())
        && cid
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"_-".contains(&b))
    {
        Some(cid.to_string())
    } else {
        None
    }
}

fn safe_avatar(v: &Value) -> Option<String> {
    let raw = s(v, "avatar").trim();
    if raw.is_empty() || raw.len() > 2048 {
        return None;
    }
    let u = url::Url::parse(raw).ok()?;
    let host = u.host_str().unwrap_or("");
    if u.scheme() == "https"
        && u.username().is_empty()
        && u.password().is_none()
        && u.port().is_none()
        && host.contains('.')
        && host != "localhost"
        && host.parse::<IpAddr>().is_err()
        && !host.ends_with(".local")
        && !host.ends_with(".localhost")
        && !host.ends_with(".internal")
    {
        Some(u.to_string())
    } else {
        None
    }
}

fn valid_token_str(tok: &str) -> bool {
    (32..=64).contains(&tok.len())
        && tok
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"_-".contains(&b))
}

fn track(v: &Value) -> Result<Value> {
    if v.is_null() {
        return Ok(Value::Null);
    }
    db::validate_track(v)?;
    if s(v, "kind") != "track" || !["youtube", "link", "soundcloud"].contains(&s(v, "source")) {
        return Err("A JAM aceita músicas online. Arquivos locais ficam no seu dispositivo.".into());
    }
    let url = url::Url::parse(s(v, "url")).map_err(|_| "Link público inválido.")?;
    let host = url.host_str().unwrap_or("");
    let allowed_host = [
        "www.youtube.com",
        "youtube.com",
        "music.youtube.com",
        "youtu.be",
        "open.spotify.com",
        "www.deezer.com",
        "deezer.com",
        "soundcloud.com",
        "www.soundcloud.com",
        "music.apple.com",
        "itunes.apple.com",
        "tidal.com",
        "www.tidal.com",
        "listen.tidal.com",
    ]
    .contains(&host)
        || crate::platforms::is_bandcamp(host);
    if url.scheme() != "https"
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port().is_some()
        || !allowed_host
    {
        return Err("Link público da música inválido.".into());
    }
    let mut value = json!({
        "id": v["id"],
        "source": v["source"],
        "sourceId": v["sourceId"],
        "kind": "track",
        "title": v["title"],
        "artist": v["artist"],
        "duration": v["duration"],
        "url": url.as_str(),
        "addedAt": 0
    });
    if db::artwork_url(s(v, "artwork")) {
        value["artwork"] = v["artwork"].clone();
    }
    let playback = s(v, "playbackId");
    if playback.len() == 11
        && playback
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"_-".contains(&b))
    {
        value["playbackId"] = json!(playback);
    }
    Ok(value)
}

fn escape_html(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    for c in raw.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&#39;"),
            _ => out.push(c),
        }
    }
    out
}

fn render_lan_invite_html(
    code: &str,
    origin: &str,
    preview: Option<&Value>,
    err_message: Option<&str>,
    nonce: &str,
) -> String {
    let encoded_origin: String = url::form_urlencoded::byte_serialize(origin.as_bytes()).collect();
    let deep_link = format!("liquidhub://jam/join/{code}?endpoint={encoded_origin}");
    let room_title = preview
        .and_then(|p| p["roomName"].as_str())
        .unwrap_or("Convite de JAM");
    let host_name = preview
        .and_then(|p| p["hostName"].as_str())
        .unwrap_or("Liquid Hub");
    let count = preview
        .and_then(|p| p["participantCount"].as_u64())
        .unwrap_or(0);
    let max_p = preview
        .and_then(|p| p["maxParticipants"].as_u64())
        .unwrap_or(MAX_PARTICIPANTS as u64);
    let status_raw = preview
        .and_then(|p| p["status"].as_str())
        .unwrap_or("ended");
    let can_join = preview
        .and_then(|p| p["canJoin"].as_bool())
        .unwrap_or(false);
    let status_label = match status_raw {
        "active" => "Ao vivo (LAN)",
        "full" => "Lotada",
        "locked" => "Trancada",
        "expired" => "Expirada",
        _ => "Indisponível",
    };
    let status_cls = match status_raw {
        "active" => "live",
        "full" | "locked" => "warn",
        _ => "ended",
    };
    let host_initial = host_name
        .trim()
        .chars()
        .next()
        .map(|c| c.to_ascii_uppercase().to_string())
        .unwrap_or_else(|| "L".to_string());
    let reason = preview
        .and_then(|p| p["reason"].as_str())
        .or(err_message)
        .unwrap_or("");
    let track_block = if let Some(track) = preview.and_then(|p| p.get("currentTrack")).filter(|t| t.is_object()) {
        let title = track["title"].as_str().unwrap_or("");
        let artist = track["artist"].as_str().unwrap_or("");
        let playing = preview.and_then(|p| p["playing"].as_bool()).unwrap_or(false);
        if !title.is_empty() && status_raw != "ended" && status_raw != "expired" {
            format!(
                "<div class=\"track\"><span>{}</span><strong>{}</strong><small>{}</small></div>",
                if playing { "Tocando agora" } else { "Na fila" },
                escape_html(title),
                escape_html(artist)
            )
        } else {
            String::new()
        }
    } else {
        String::new()
    };

    let open_btn = if can_join {
        format!(
            "<a id=\"open-app\" class=\"btn primary\" href=\"{}\">Abrir no Liquid Hub</a>",
            escape_html(&deep_link)
        )
    } else {
        String::new()
    };
    let reason_block = if !can_join && !reason.is_empty() {
        format!("<p class=\"meta\">{}</p>", escape_html(reason))
    } else {
        String::new()
    };

    let code_json = serde_json::to_string(code).unwrap_or_else(|_| "\"\"".into());
    let link_json = serde_json::to_string(&deep_link).unwrap_or_else(|_| "\"\"".into());

    format!(
        "<!doctype html><html lang=\"pt-BR\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><meta name=\"theme-color\" content=\"#0b0d10\"><title>{} · Liquid Hub</title><style nonce=\"{}\">:root{{color-scheme:dark;--bg:#0b0d10;--surface:#14171c;--border:rgba(255,255,255,.1);--text:#f3f5f7;--muted:#9aa4b2;--accent:#52b79a;--warn:#e0a54c;--err:#e57373}}*{{box-sizing:border-box}}body{{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px;background:radial-gradient(circle at top,rgba(82,183,154,.12),transparent 52%),var(--bg);color:var(--text);font:400 14px/1.5 -apple-system,BlinkMacSystemFont,\"Segoe UI\",Roboto,sans-serif}}.card{{width:100%;max-width:440px;background:var(--surface);border:1px solid var(--border);border-radius:14px;padding:24px;display:grid;gap:18px}}.brand{{display:flex;align-items:center;justify-content:space-between;font-size:12px;color:var(--muted);text-transform:uppercase;letter-spacing:.04em;font-weight:600}}.pill{{padding:3px 9px;border-radius:99px;font-size:11px;font-weight:600;text-transform:none;letter-spacing:0;background:rgba(255,255,255,.07);color:var(--muted)}}.pill.live{{background:rgba(82,183,154,.16);color:#7fe0c3}}.pill.warn{{background:rgba(224,165,76,.16);color:var(--warn)}}.pill.ended{{background:rgba(229,115,115,.15);color:var(--err)}}.host{{display:flex;align-items:center;gap:14px}}.avatar{{width:48px;height:48px;border-radius:50%;display:grid;place-items:center;background:rgba(82,183,154,.18);color:#8ce2b4;font-weight:700;font-size:18px;flex:none;border:1px solid rgba(82,183,154,.3)}}h1{{margin:0;font-size:20px;line-height:1.25}}.meta{{color:var(--muted);font-size:13px;margin:2px 0 0}}.code-box{{display:flex;align-items:center;justify-content:space-between;padding:12px 14px;border-radius:10px;background:rgba(0,0,0,.28);border:1px solid var(--border)}}.code-box span{{font-size:12px;color:var(--muted)}}.code-box strong{{font-size:18px;letter-spacing:.16em}}.track{{padding:12px 14px;border-radius:10px;background:rgba(255,255,255,.04);border:1px solid var(--border);display:grid;gap:2px}}.track span{{font-size:11px;color:var(--accent);font-weight:600;text-transform:uppercase}}.actions{{display:grid;gap:10px}}.btn{{display:inline-flex;align-items:center;justify-content:center;min-height:42px;padding:0 16px;border-radius:9px;font-weight:600;font-size:13.5px;text-decoration:none;cursor:pointer;border:1px solid transparent}}.btn.primary{{background:var(--accent);color:#09110e}}.btn.secondary{{background:rgba(255,255,255,.07);border-color:var(--border);color:var(--text)}}.btn.ghost{{background:transparent;border-color:var(--border);color:var(--muted)}}.hint{{margin:0;font-size:12px;color:var(--muted);text-align:center}}</style></head><body><main class=\"card\"><div class=\"brand\"><span>Liquid Hub · JAM</span><span class=\"pill {}\">{}</span></div><div class=\"host\"><div class=\"avatar\">{}</div><div><h1>{}</h1><p class=\"meta\">{}</p></div></div>{}<div class=\"code-box\"><span>Código da JAM</span><strong id=\"jam-code\">{}</strong></div>{}<div class=\"actions\">{}<button id=\"copy-code\" class=\"btn secondary\" type=\"button\">Copiar código ({})</button><a class=\"btn ghost\" href=\"https://github.com/nlzwrld/glass-music/releases/latest\" target=\"_blank\" rel=\"noopener noreferrer\">Baixar Liquid Hub</a></div><p class=\"hint\">Clique em Abrir no Liquid Hub ou cole o código na aba JAM do aplicativo.</p></main><script nonce=\"{}\">(function(){{var c={},d={},a={};var b=document.getElementById('copy-code');if(b){{b.addEventListener('click',function(){{navigator.clipboard&&navigator.clipboard.writeText(c).then(function(){{b.textContent='Código copiado!';setTimeout(function(){{b.textContent='Copiar código ('+c+')';}},1800)}}).catch(function(){{}})}})}}if(a){{setTimeout(function(){{try{{window.location.href=d}}catch(e){{}}}},80)}}}})();</script></body></html>",
        escape_html(room_title),
        escape_html(nonce),
        status_cls,
        escape_html(status_label),
        escape_html(&host_initial),
        escape_html(room_title),
        escape_html(&if preview.is_some() {
            format!("Anfitrião: {host_name} · {count}/{max_p} ouvintes")
        } else {
            err_message.unwrap_or("Convite indisponível.").to_string()
        }),
        track_block,
        escape_html(code),
        reason_block,
        open_btn,
        escape_html(code),
        escape_html(nonce),
        code_json,
        link_json,
        if can_join { "true" } else { "false" }
    )
}

impl Coordinator {
    fn new() -> Self {
        Self {
            rooms: HashMap::new(),
            tombstones: HashMap::new(),
            rates: HashMap::new(),
            nonces: HashMap::new(),
        }
    }

    fn room_status(room: &Room, now: i64) -> &'static str {
        if room.invite_expires_at <= now {
            "expired"
        } else if room.locked {
            "locked"
        } else if room.members.len() >= room.max_participants {
            "full"
        } else {
            "active"
        }
    }

    fn view(room: &Room, now: i64, p: &Value) -> Value {
        let members: Vec<Value> = room
            .members
            .values()
            .map(|m| {
                let mut obj = json!({
                    "id": m.id,
                    "name": m.name,
                    "host": m.host,
                    "online": m.online,
                    "joinedAt": m.joined_at
                });
                if let Some(ref av) = m.avatar {
                    obj["avatar"] = json!(av);
                }
                obj
            })
            .collect();
        let unchanged = s(p, "action") == "poll"
            && p["sinceSequence"]
                .as_u64()
                .is_some_and(|seq| seq == room.playback["sequence"].as_u64().unwrap_or(0));
        let mut val = json!({
            "roomId": room.room_id,
            "code": room.code,
            "roomName": room.room_name,
            "status": Self::room_status(room, now),
            "locked": room.locked,
            "requireAuth": room.require_auth,
            "maxParticipants": room.max_participants,
            "inviteExpiresAt": room.invite_expires_at,
            "createdAt": room.created_at,
            "members": members,
            "playback": room.playback,
            "serverTime": now
        });
        if unchanged {
            val["unchanged"] = json!(true);
        }
        if let Some(ct) = p["clientTime"].as_f64().filter(|n| n.is_finite()) {
            val["echoClientTime"] = json!(ct);
        }
        val
    }

    fn preview(room: &Room, now: i64) -> Value {
        let host = room.members.values().find(|m| m.host);
        let host_name = host.map(|m| m.name.as_str()).unwrap_or("Anfitrião");
        let status = Self::room_status(room, now);
        let reason = match status {
            "expired" => Some("Este convite expirou. Peça um novo link ao anfitrião."),
            "locked" => Some("O anfitrião trancou a entrada de novos ouvintes."),
            "full" => Some("Esta JAM atingiu o limite de participantes."),
            _ => None,
        };
        let t = &room.playback["track"];
        let current_track = if t.is_object() {
            json!({
                "id": t["id"],
                "title": t["title"],
                "artist": t["artist"],
                "artwork": t["artwork"],
                "source": t["source"]
            })
        } else {
            Value::Null
        };
        let mut out = json!({
            "roomId": room.room_id,
            "code": room.code,
            "roomName": room.room_name,
            "participantCount": room.members.len(),
            "maxParticipants": room.max_participants,
            "hostName": host_name,
            "status": status,
            "canJoin": status == "active",
            "requireAuth": room.require_auth,
            "currentTrack": current_track,
            "playing": room.playback["playing"] == true,
            "inviteExpiresAt": room.invite_expires_at,
            "createdAt": room.created_at,
            "serverTime": now
        });
        if let Some(av) = room
            .host_avatar
            .as_ref()
            .or_else(|| host.and_then(|m| m.avatar.as_ref()))
        {
            out["hostAvatar"] = json!(av);
        }
        if let Some(r) = reason {
            out["reason"] = json!(r);
        }
        out
    }

    fn tombstone_preview(t: &Tombstone, now: i64) -> Value {
        let reason_text = if t.reason == "ended" {
            "Esta JAM foi encerrada pelo anfitrião."
        } else {
            "Este convite expirou. Peça um novo link ao anfitrião."
        };
        let mut out = json!({
            "roomId": t.room_id,
            "code": t.code,
            "roomName": t.room_name,
            "hostName": t.host_name,
            "participantCount": 0,
            "maxParticipants": MAX_PARTICIPANTS,
            "status": t.reason,
            "canJoin": false,
            "reason": reason_text,
            "inviteExpiresAt": t.ended_at,
            "createdAt": t.created_at,
            "serverTime": now
        });
        if let Some(ref av) = t.host_avatar {
            out["hostAvatar"] = json!(av);
        }
        out
    }

    fn record_tombstone(&mut self, room: &Room, code: &str, reason: &'static str, now: i64) {
        if self.tombstones.len() >= 1024 {
            if let Some(oldest) = self.tombstones.keys().next().cloned() {
                self.tombstones.remove(&oldest);
            }
        }
        let host = room.members.values().find(|m| m.host);
        self.tombstones.insert(
            code.to_string(),
            Tombstone {
                code: code.to_string(),
                room_id: room.room_id.clone(),
                room_name: room.room_name.clone(),
                host_name: host
                    .map(|m| m.name.clone())
                    .unwrap_or_else(|| "Anfitrião".to_string()),
                host_avatar: room
                    .host_avatar
                    .clone()
                    .or_else(|| host.and_then(|m| m.avatar.clone())),
                reason,
                created_at: room.created_at,
                ended_at: now,
                expires_at: now + TOMBSTONE_RETENTION_MS,
            },
        );
    }

    fn prune(&mut self, now: i64) -> DispatchEvents {
        let mut events = DispatchEvents::none();
        let expired_rooms: Vec<String> = self
            .rooms
            .iter()
            .filter(|(_, r)| now - r.touched > 900_000)
            .map(|(c, _)| c.clone())
            .collect();
        for code in expired_rooms {
            if let Some(room) = self.rooms.remove(&code) {
                self.record_tombstone(&room, &code, "expired", now);
                events.broadcasts.push((
                    room.room_id.clone(),
                    "closed",
                    json!({
                        "closed": true,
                        "reason": "Esta JAM expirou por inatividade.",
                        "errorCode": "ROOM_ENDED",
                        "serverTime": now
                    }),
                ));
                events.close_room_id = Some(room.room_id);
            }
        }
        self.rates.retain(|_, v| v.0 > now);
        self.nonces.retain(|_, until| *until > now);
        self.tombstones.retain(|_, t| t.expires_at > now);

        for room in self.rooms.values_mut() {
            let timed_out: Vec<String> = room
                .members
                .iter()
                .filter(|(_, m)| !m.host && now - m.seen > MEMBER_GRACE_MS)
                .map(|(k, _)| k.clone())
                .collect();
            if !timed_out.is_empty() {
                for tok in timed_out {
                    if let Some(m) = room.members.remove(&tok) {
                        if room.recent_members.len() >= 32 {
                            if let Some(oldest) = room.recent_members.keys().next().cloned() {
                                room.recent_members.remove(&oldest);
                            }
                        }
                        room.recent_members.insert(
                            m.token.clone(),
                            RecentMember {
                                id: m.id,
                                token: m.token,
                                client_id: m.client_id,
                                name: m.name,
                                avatar: m.avatar,
                                host: m.host,
                                joined_at: m.joined_at,
                            },
                        );
                    }
                }
                events
                    .broadcasts
                    .push((room.room_id.clone(), "state", Self::view(room, now, &Value::Null)));
            }
        }
        events
    }

    fn lookup(&self, raw_code: &str, now: i64) -> std::result::Result<Value, LanErr> {
        let code = crate::deeplink::normalize_code(raw_code)
            .ok_or_else(|| LanErr::new(400, "Código da JAM inválido.", Some("INVITE_INVALID")))?;
        if let Some(room) = self.rooms.get(&code) {
            let preview = Self::preview(room, now);
            if room.invite_expires_at <= now {
                return Err(LanErr::with_preview(
                    410,
                    "Este convite expirou. Peça um novo link ao anfitrião.",
                    "INVITE_EXPIRED",
                    preview,
                ));
            }
            return Ok(preview);
        }
        if let Some(tomb) = self.tombstones.get(&code) {
            if tomb.expires_at > now {
                let preview = Self::tombstone_preview(tomb, now);
                if tomb.reason == "ended" {
                    return Err(LanErr::with_preview(
                        410,
                        "Esta JAM foi encerrada pelo anfitrião.",
                        "ROOM_ENDED",
                        preview,
                    ));
                }
                return Err(LanErr::with_preview(
                    410,
                    "Este convite expirou. Peça um novo link ao anfitrião.",
                    "INVITE_EXPIRED",
                    preview,
                ));
            }
        }
        Err(LanErr::new(
            404,
            "Nenhuma JAM encontrada com este código.",
            Some("INVITE_NOT_FOUND"),
        ))
    }

    fn check_replay(&mut self, p: &Value, now: i64) -> std::result::Result<(), LanErr> {
        let has_nonce = p.get("nonce").is_some();
        let has_ts = p.get("timestamp").is_some();
        if !has_nonce && !has_ts {
            return Ok(());
        }
        if !has_nonce || !has_ts {
            return Err(LanErr::new(
                400,
                "Nonce e timestamp devem ser enviados juntos.",
                None,
            ));
        }
        let nonce = p["nonce"]
            .as_str()
            .filter(|n| {
                (16..=128).contains(&n.len())
                    && n.bytes()
                        .all(|b| b.is_ascii_alphanumeric() || b"_-".contains(&b))
            })
            .ok_or_else(|| LanErr::new(400, "Nonce inválido.", None))?;
        let ts = p["timestamp"]
            .as_i64()
            .ok_or_else(|| LanErr::new(400, "Timestamp inválido.", None))?;
        if (now - ts).abs() > 60_000 {
            return Err(LanErr::new(
                401,
                "Solicitação expirada (timestamp fora da janela).",
                None,
            ));
        }
        if self.nonces.contains_key(nonce) {
            return Err(LanErr::new(409, "Replay detectado: nonce já utilizado.", None));
        }
        if self.nonces.len() >= 8192 {
            self.nonces.clear();
        }
        self.nonces.insert(nonce.to_string(), now + 120_000);
        Ok(())
    }

    fn summaries(&self, endpoint: &str, now: i64) -> Vec<Value> {
        self.rooms
            .values()
            .map(|r| {
                let host_name = r
                    .members
                    .values()
                    .find(|m| m.host)
                    .map(|m| m.name.as_str())
                    .unwrap_or("Anfitrião");
                let mut obj = json!({
                    "roomId": r.room_id,
                    "code": r.code,
                    "roomName": r.room_name,
                    "endpoint": endpoint,
                    "hostName": host_name,
                    "members": r.members.len(),
                    "maxParticipants": r.max_participants,
                    "status": Self::room_status(r, now),
                    "updatedAt": r.touched
                });
                if let Some(title) = r.playback["track"]["title"].as_str() {
                    obj["currentTrackTitle"] = json!(title);
                }
                if let Some(artist) = r.playback["track"]["artist"].as_str() {
                    obj["currentTrackArtist"] = json!(artist);
                }
                obj
            })
            .collect()
    }

    fn handle_with_events(
        &mut self,
        p: &Value,
        ip: &str,
        now: i64,
    ) -> std::result::Result<(Value, DispatchEvents), LanErr> {
        let mut events = self.prune(now);
        let action = s(p, "action");
        let entry = ["create", "join", "resume"].contains(&action);
        let is_lookup = action == "lookup";
        let kind = if entry {
            "entry"
        } else if is_lookup {
            "lookup"
        } else {
            "active"
        };
        let key = format!("{ip}:{kind}");
        if self.rates.len() >= 1024 && !self.rates.contains_key(&key) {
            return Err(LanErr::new(503, "Serviço ocupado.", Some("UNAVAILABLE")));
        }
        let rate = self.rates.entry(key).or_insert((now + 60_000, 0));
        rate.1 += 1;
        let max_req = if entry {
            30
        } else if is_lookup {
            120
        } else {
            1800
        };
        if rate.1 > max_req {
            return Err(LanErr::new(429, "Muitas tentativas. Aguarde um minuto.", None));
        }

        if action == "ping" {
            self.check_replay(p, now)?;
            let mut out = json!({ "pong": true, "serverTime": now });
            if let Some(ct) = p["clientTime"].as_f64().filter(|n| n.is_finite()) {
                out["echoClientTime"] = json!(ct);
            }
            return Ok((out, events));
        }

        if action == "lookup" {
            self.check_replay(p, now)?;
            let preview = self.lookup(s(p, "code"), now)?;
            return Ok((preview, events));
        }

        if action == "create" {
            if self.rooms.len() >= 16 {
                return Err(LanErr::new(503, "As salas estão ocupadas.", Some("UNAVAILABLE")));
            }
            self.check_replay(p, now)?;
            let preferred = crate::deeplink::normalize_code(s(p, "preferredCode"));
            let code = if let Some(pref) = preferred.filter(|c| !self.rooms.contains_key(c)) {
                pref
            } else {
                generate_invite_code(&self.rooms)
            };
            self.tombstones.remove(&code);
            let host_name = name(p);
            let avatar = safe_avatar(p);
            let client_id = safe_client_id(p);
            let rname = room_name(p, &host_name);
            let invite_ttl = p["inviteTtlMs"]
                .as_i64()
                .map(|v| v.clamp(60_000, 86_400_000))
                .unwrap_or(DEFAULT_INVITE_TTL_MS);

            let member = Member {
                id: uuid::Uuid::new_v4().simple().to_string(),
                token: token(),
                client_id: client_id.clone(),
                name: host_name,
                avatar: avatar.clone(),
                host: true,
                online: true,
                joined_at: now,
                seen: now,
            };
            let auth = member.token.clone();
            let mid = member.id.clone();
            let room = Room {
                room_id: format!("jam_{}", uuid::Uuid::new_v4().simple()),
                code: code.clone(),
                room_name: rname,
                host_avatar: avatar,
                locked: false,
                require_auth: p["requireAuth"] == true,
                max_participants: MAX_PARTICIPANTS,
                invite_expires_at: now + invite_ttl,
                created_at: now,
                members: HashMap::from([(auth.clone(), member)]),
                recent_members: HashMap::new(),
                kicked_keys: HashSet::new(),
                playback: json!({"track":null,"playing":false,"position":0,"updatedAt":now,"sequence":0}),
                touched: now,
            };
            let mut value = Self::view(&room, now, p);
            value["token"] = json!(auth);
            value["memberId"] = json!(mid);
            value["host"] = json!(true);
            if let Some(cid) = client_id {
                value["clientId"] = json!(cid);
            }
            self.rooms.insert(code, room);
            return Ok((value, events));
        }

        let code = crate::deeplink::normalize_code(s(p, "code"))
            .ok_or_else(|| LanErr::new(400, "Código da JAM inválido.", Some("INVITE_INVALID")))?;

        if !self.rooms.contains_key(&code) {
            if let Some(tomb) = self.tombstones.get(&code) {
                if tomb.expires_at > now {
                    let preview = Self::tombstone_preview(tomb, now);
                    if tomb.reason == "ended" {
                        return Err(LanErr::with_preview(
                            410,
                            "Esta JAM foi encerrada pelo anfitrião.",
                            "ROOM_ENDED",
                            preview,
                        ));
                    }
                    return Err(LanErr::with_preview(
                        410,
                        "Este convite expirou. Peça um novo link ao anfitrião.",
                        "INVITE_EXPIRED",
                        preview,
                    ));
                }
            }
            return Err(LanErr::new(
                410,
                "Esta JAM foi encerrada ou expirou.",
                Some("ROOM_ENDED"),
            ));
        }

        if action == "join" || action == "resume" {
            if action == "join" && self.rooms[&code].invite_expires_at <= now {
                let preview = Self::preview(&self.rooms[&code], now);
                return Err(LanErr::with_preview(
                    410,
                    "Este convite expirou. Peça um novo link ao anfitrião.",
                    "INVITE_EXPIRED",
                    preview,
                ));
            }
            let client_id = safe_client_id(p);
            let resume_token = {
                let rt = s(p, "resumeToken");
                let tok = s(p, "token");
                if valid_token_str(rt) {
                    Some(rt.to_string())
                } else if valid_token_str(tok) {
                    Some(tok.to_string())
                } else {
                    None
                }
            };

            {
                let room = &self.rooms[&code];
                if resume_token
                    .as_ref()
                    .is_some_and(|t| room.kicked_keys.contains(&format!("tok:{t}")))
                    || client_id
                        .as_ref()
                        .is_some_and(|c| room.kicked_keys.contains(&format!("cid:{c}")))
                {
                    return Err(LanErr::new(
                        403,
                        "Você foi removido desta JAM pelo anfitrião.",
                        Some("KICKED"),
                    ));
                }
            }

            // Check existing active member first
            let existing_key = {
                let room = &self.rooms[&code];
                resume_token
                    .as_ref()
                    .filter(|t| room.members.contains_key(*t))
                    .cloned()
                    .or_else(|| {
                        client_id.as_ref().and_then(|cid| {
                            room.members
                                .iter()
                                .find(|(_, m)| m.client_id.as_deref() == Some(cid.as_str()))
                                .map(|(k, _)| k.clone())
                        })
                    })
            };

            if let Some(tok) = existing_key {
                self.check_replay(p, now)?;
                let room = self.rooms.get_mut(&code).unwrap();
                let is_host = {
                    let mbr = room.members.get_mut(&tok).unwrap();
                    mbr.seen = now;
                    mbr.online = true;
                    if !s(p, "name").trim().is_empty() {
                        mbr.name = name(p);
                    }
                    if let Some(av) = safe_avatar(p) {
                        mbr.avatar = Some(av);
                    }
                    mbr.host
                };
                if is_host {
                    room.touched = now;
                }
                let mbr = &room.members[&tok];
                let mut value = Self::view(room, now, p);
                value["token"] = json!(mbr.token);
                value["memberId"] = json!(mbr.id);
                value["host"] = json!(mbr.host);
                if let Some(ref cid) = mbr.client_id {
                    value["clientId"] = json!(cid);
                }
                events
                    .broadcasts
                    .push((room.room_id.clone(), "state", Self::view(room, now, &Value::Null)));
                return Ok((value, events));
            }

            // Check recent_members grace cache
            let recent_key = {
                let room = &self.rooms[&code];
                resume_token
                    .as_ref()
                    .filter(|t| room.recent_members.contains_key(*t))
                    .cloned()
                    .or_else(|| {
                        client_id.as_ref().and_then(|cid| {
                            room.recent_members
                                .iter()
                                .find(|(_, m)| m.client_id.as_deref() == Some(cid.as_str()))
                                .map(|(k, _)| k.clone())
                        })
                    })
            };

            if let Some(rtok) = recent_key {
                if self.rooms[&code].members.len() >= self.rooms[&code].max_participants {
                    let preview = Self::preview(&self.rooms[&code], now);
                    return Err(LanErr::with_preview(
                        409,
                        "Esta JAM já atingiu o limite de participantes.",
                        "ROOM_FULL",
                        preview,
                    ));
                }
                self.check_replay(p, now)?;
                let room = self.rooms.get_mut(&code).unwrap();
                let recent = room.recent_members.remove(&rtok).unwrap();
                let restored = Member {
                    id: recent.id,
                    token: recent.token.clone(),
                    client_id: client_id.or(recent.client_id),
                    name: if !s(p, "name").trim().is_empty() {
                        name(p)
                    } else {
                        recent.name
                    },
                    avatar: safe_avatar(p).or(recent.avatar),
                    host: recent.host,
                    online: true,
                    joined_at: recent.joined_at,
                    seen: now,
                };
                let auth = restored.token.clone();
                let mid = restored.id.clone();
                let is_host = restored.host;
                let cid_out = restored.client_id.clone();
                room.members.insert(auth.clone(), restored);
                let mut value = Self::view(room, now, p);
                value["token"] = json!(auth);
                value["memberId"] = json!(mid);
                value["host"] = json!(is_host);
                if let Some(cid) = cid_out {
                    value["clientId"] = json!(cid);
                }
                events
                    .broadcasts
                    .push((room.room_id.clone(), "state", Self::view(room, now, &Value::Null)));
                return Ok((value, events));
            }

            if action == "resume" {
                return Err(LanErr::new(
                    401,
                    "Sua sessão expirou. Entre novamente.",
                    Some("SESSION_EXPIRED"),
                ));
            }

            if self.rooms[&code].locked {
                let preview = Self::preview(&self.rooms[&code], now);
                return Err(LanErr::with_preview(
                    403,
                    "Esta JAM está trancada pelo anfitrião.",
                    "ROOM_LOCKED",
                    preview,
                ));
            }
            if self.rooms[&code].members.len() >= self.rooms[&code].max_participants {
                let preview = Self::preview(&self.rooms[&code], now);
                return Err(LanErr::with_preview(
                    409,
                    "Esta JAM já tem 8 pessoas.",
                    "ROOM_FULL",
                    preview,
                ));
            }
            self.check_replay(p, now)?;
            let room = self.rooms.get_mut(&code).unwrap();
            let member = Member {
                id: uuid::Uuid::new_v4().simple().to_string(),
                token: token(),
                client_id: client_id.clone(),
                name: name(p),
                avatar: safe_avatar(p),
                host: false,
                online: true,
                joined_at: now,
                seen: now,
            };
            let auth = member.token.clone();
            let mid = member.id.clone();
            room.members.insert(auth.clone(), member);
            let mut value = Self::view(room, now, p);
            value["token"] = json!(auth);
            value["memberId"] = json!(mid);
            value["host"] = json!(false);
            if let Some(cid) = client_id {
                value["clientId"] = json!(cid);
            }
            events
                .broadcasts
                .push((room.room_id.clone(), "state", Self::view(room, now, &Value::Null)));
            return Ok((value, events));
        }

        let auth = s(p, "token");
        let is_host = {
            let room = self.rooms.get_mut(&code).unwrap();
            if !valid_token_str(auth) {
                return Err(LanErr::new(401, "Sessão da JAM inválida.", Some("SESSION_EXPIRED")));
            }
            let Some(member) = room.members.get_mut(auth) else {
                if room.kicked_keys.contains(&format!("tok:{auth}")) {
                    return Err(LanErr::new(
                        403,
                        "Você foi removido desta JAM pelo anfitrião.",
                        Some("KICKED"),
                    ));
                }
                return Err(LanErr::new(
                    401,
                    "Sua sessão expirou. Entre novamente.",
                    Some("SESSION_EXPIRED"),
                ));
            };
            member.seen = now;
            member.online = true;
            if member.host {
                room.touched = now;
            }
            member.host
        };

        if action == "leave" {
            self.check_replay(p, now)?;
            if is_host {
                if let Some(room) = self.rooms.remove(&code) {
                    let rid = room.room_id.clone();
                    self.record_tombstone(&room, &code, "ended", now);
                    events.broadcasts.push((
                        rid.clone(),
                        "closed",
                        json!({
                            "closed": true,
                            "reason": "O anfitrião encerrou a JAM.",
                            "errorCode": "ROOM_ENDED",
                            "serverTime": now
                        }),
                    ));
                    events.close_room_id = Some(rid);
                }
            } else if let Some(room) = self.rooms.get_mut(&code) {
                room.members.remove(auth);
                events
                    .broadcasts
                    .push((room.room_id.clone(), "state", Self::view(room, now, &Value::Null)));
            }
            return Ok((json!({"closed": is_host, "serverTime": now}), events));
        }

        if action == "rotateInvite" {
            if !is_host {
                return Err(LanErr::new(
                    403,
                    "Somente o anfitrião pode gerar um novo convite.",
                    Some("FORBIDDEN"),
                ));
            }
            self.check_replay(p, now)?;
            let new_code = generate_invite_code(&self.rooms);
            let mut room = self.rooms.remove(&code).unwrap();
            self.record_tombstone(&room, &code, "expired", now);
            room.code = new_code.clone();
            room.invite_expires_at = now + DEFAULT_INVITE_TTL_MS;
            self.tombstones.remove(&new_code);
            let out = Self::view(&room, now, p);
            events
                .broadcasts
                .push((room.room_id.clone(), "state", Self::view(&room, now, &Value::Null)));
            self.rooms.insert(new_code, room);
            return Ok((out, events));
        }

        if action == "updateRoom" {
            if !is_host {
                return Err(LanErr::new(
                    403,
                    "Somente o anfitrião pode alterar as opções da JAM.",
                    Some("FORBIDDEN"),
                ));
            }
            self.check_replay(p, now)?;
            let room = self.rooms.get_mut(&code).unwrap();
            let host_name = room
                .members
                .values()
                .find(|m| m.host)
                .map(|m| m.name.clone())
                .unwrap_or_else(|| "Anfitrião".to_string());
            if p.get("roomName").is_some() {
                room.room_name = room_name(p, &host_name);
            }
            if let Some(locked) = p["locked"].as_bool() {
                room.locked = locked;
            }
            let out = Self::view(room, now, p);
            events
                .broadcasts
                .push((room.room_id.clone(), "state", Self::view(room, now, &Value::Null)));
            return Ok((out, events));
        }

        if action == "kick" {
            if !is_host {
                return Err(LanErr::new(
                    403,
                    "Somente o anfitrião pode remover participantes.",
                    Some("FORBIDDEN"),
                ));
            }
            let target_id = s(p, "memberId");
            if target_id.is_empty() {
                return Err(LanErr::new(400, "Participante inválido.", None));
            }
            self.check_replay(p, now)?;
            let room = self.rooms.get_mut(&code).unwrap();
            let target_token = room
                .members
                .iter()
                .find(|(_, m)| m.id == target_id)
                .map(|(k, _)| k.clone())
                .ok_or_else(|| LanErr::new(404, "Participante não encontrado.", None))?;
            if room.members[&target_token].host {
                return Err(LanErr::new(400, "Não é possível remover o anfitrião.", None));
            }
            let kicked = room.members.remove(&target_token).unwrap();
            room.recent_members.remove(&target_token);
            room.kicked_keys.insert(format!("tok:{}", kicked.token));
            if let Some(cid) = kicked.client_id {
                room.kicked_keys.insert(format!("cid:{cid}"));
            }
            events.kicks.push((
                room.room_id.clone(),
                kicked.token,
                json!({
                    "kicked": true,
                    "reason": "Você foi removido desta JAM pelo anfitrião.",
                    "errorCode": "KICKED",
                    "serverTime": now
                }),
            ));
            let out = Self::view(room, now, p);
            events
                .broadcasts
                .push((room.room_id.clone(), "state", Self::view(room, now, &Value::Null)));
            return Ok((out, events));
        }

        if action == "sync" {
            if !is_host {
                return Err(LanErr::new(
                    403,
                    "Somente quem criou a JAM controla a reprodução.",
                    Some("FORBIDDEN"),
                ));
            }
            let play = &p["playback"];
            let pos = play["position"]
                .as_f64()
                .ok_or_else(|| LanErr::new(400, "Reprodução inválida.", None))?;
            if !play["playing"].is_boolean() || !pos.is_finite() || !(0.0..=86400.0).contains(&pos)
            {
                return Err(LanErr::new(400, "Reprodução inválida.", None));
            }
            let song = track(&play["track"]).map_err(|e| LanErr::new(400, e, None))?;
            self.check_replay(p, now)?;
            let position = pos.min(song["duration"].as_f64().filter(|d| *d > 0.0).unwrap_or(86400.0));
            let playing = !song.is_null() && play["playing"] == true;
            let room = self.rooms.get_mut(&code).unwrap();
            room.playback = json!({
                "track": song,
                "playing": playing,
                "position": position,
                "updatedAt": now,
                "sequence": room.playback["sequence"].as_u64().unwrap_or(0) + 1
            });
            let out = Self::view(room, now, p);
            events
                .broadcasts
                .push((room.room_id.clone(), "playback", Self::view(room, now, &Value::Null)));
            return Ok((out, events));
        }
        if action != "poll" {
            return Err(LanErr::new(400, "Operação inválida.", None));
        }
        self.check_replay(p, now)?;
        let room = self.rooms.get(&code).unwrap();
        Ok((Self::view(room, now, p), events))
    }

    #[cfg(test)]
    fn handle(&mut self, p: &Value, ip: &str, now: i64) -> std::result::Result<Value, (u16, String)> {
        self.handle_with_events(p, ip, now)
            .map(|(v, _)| v)
            .map_err(|e| (e.status, e.message))
    }
}

fn dispatch_sse_events(subscribers: &Arc<Mutex<Vec<SseClient>>>, events: DispatchEvents) {
    if events.broadcasts.is_empty() && events.kicks.is_empty() && events.close_room_id.is_none() {
        return;
    }
    let Ok(mut subs) = subscribers.lock() else {
        return;
    };
    for (rid, tok, payload) in &events.kicks {
        let msg = format!("event: kicked\ndata: {}\n\n", payload);
        for sub in subs.iter() {
            if sub.room_id == *rid && sub.token == *tok {
                let _ = sub.tx.try_send(msg.clone());
            }
        }
        subs.retain(|s| !(s.room_id == *rid && s.token == *tok));
    }
    for (rid, ev_name, payload) in &events.broadcasts {
        let msg = format!("event: {ev_name}\ndata: {}\n\n", payload);
        subs.retain(|sub| {
            if sub.room_id == *rid {
                !matches!(sub.tx.try_send(msg.clone()), Err(mpsc::TrySendError::Disconnected(_)))
            } else {
                true
            }
        });
    }
    if let Some(close_rid) = events.close_room_id {
        subs.retain(|s| s.room_id != close_rid);
    }
}

fn send_http(mut stream: TcpStream, status: u16, content_type: &str, body: &str, extra_headers: &str) {
    let headers = format!(
        "HTTP/1.1 {status} Result\r\nContent-Type: {content_type}\r\nCache-Control: no-store\r\nX-Service: liquid-hub-jam\r\nX-Content-Type-Options: nosniff\r\nX-Frame-Options: DENY\r\n{extra_headers}Connection: close\r\nContent-Length: {}\r\n\r\n",
        body.len()
    );
    let _ = stream.write_all(headers.as_bytes());
    let _ = stream.write_all(body.as_bytes());
}

fn respond(
    mut stream: TcpStream,
    endpoint: &str,
    coordinator: &Arc<Mutex<Coordinator>>,
    subscribers: &Arc<Mutex<Vec<SseClient>>>,
) {
    let _ = stream.set_read_timeout(Some(Duration::from_secs(3)));
    let _ = stream.set_write_timeout(Some(Duration::from_secs(3)));
    let ip = stream
        .peer_addr()
        .map(|a| a.ip().to_string())
        .unwrap_or_default();

    let mut content_length = None;
    let mut content_type = false;
    let mut auth_bearer: Option<String> = None;
    let mut host_header: Option<String> = None;
    let mut first = String::new();
    let mut header_ok = true;
    let mut header_err: Option<(u16, String)> = None;

    let Ok(read_stream) = stream.try_clone() else {
        return;
    };
    let mut reader = BufReader::new(read_stream);
    let mut header = Vec::new();
    loop {
        let before = header.len();
        if reader
            .by_ref()
            .take((8193 - before) as u64)
            .read_until(b'\n', &mut header)
            .is_err()
            || header.len() > 8192
            || header.len() == before
        {
            header_ok = false;
            header_err = Some((400, "Solicitação incompleta.".into()));
            break;
        }
        let Ok(line_raw) = std::str::from_utf8(&header[before..]) else {
            header_ok = false;
            header_err = Some((400, "Cabeçalhos inválidos.".into()));
            break;
        };
        let line = line_raw.trim();
        if first.is_empty() {
            first = line.into();
            continue;
        }
        if line.is_empty() {
            break;
        }
        if let Some((key, value)) = line.split_once(':') {
            match key.trim().to_ascii_lowercase().as_str() {
                "content-length" => {
                    if content_length.is_some() {
                        header_ok = false;
                        header_err = Some((400, "Tamanho duplicado.".into()));
                        break;
                    }
                    match value.trim().parse::<usize>() {
                        Ok(n) => content_length = Some(n),
                        Err(_) => {
                            header_ok = false;
                            header_err = Some((400, "Tamanho inválido.".into()));
                            break;
                        }
                    }
                }
                "content-type" => content_type = value.trim().starts_with("application/json"),
                "transfer-encoding" => {
                    header_ok = false;
                    header_err = Some((400, "Codificação não permitida.".into()));
                    break;
                }
                "authorization" => {
                    let v = value.trim();
                    if let Some(tok) = v.strip_prefix("Bearer ").or_else(|| v.strip_prefix("bearer ")) {
                        auth_bearer = Some(tok.trim().to_string());
                    }
                }
                "host" => {
                    let h = value.trim();
                    if !h.is_empty() && h.len() <= 128 && h.bytes().all(|b| b.is_ascii_alphanumeric() || b".:-".contains(&b)) {
                        host_header = Some(h.to_string());
                    }
                }
                _ => {}
            }
        }
    }

    if !header_ok {
        let (st, msg) = header_err.unwrap_or((400, "Solicitação inválida.".into()));
        send_http(stream, st, "application/json; charset=utf-8", &json!({ "error": msg }).to_string(), "");
        return;
    }

    let request: Vec<&str> = first.split_whitespace().collect();
    if request.len() != 3 {
        send_http(stream, 400, "application/json; charset=utf-8", &json!({ "error": "Solicitação inválida." }).to_string(), "");
        return;
    }

    let method = request[0];
    let target = request[1];
    let (path, query_str) = target.split_once('?').unwrap_or((target, ""));

    if method == "GET" && path == "/health" {
        send_http(
            stream,
            200,
            "application/json; charset=utf-8",
            &json!({"service": "liquid-hub-jam", "version": 3, "runtime": "lan"}).to_string(),
            "",
        );
        return;
    }

    if method == "GET" && path.starts_with("/v1/jam/invites/") {
        let raw_code = path.trim_start_matches("/v1/jam/invites/");
        let res = coordinator
            .lock()
            .map_err(|_| LanErr::new(503, "Serviço ocupado.", Some("UNAVAILABLE")))
            .and_then(|c| c.lookup(raw_code, db::now()));
        match res {
            Ok(v) => send_http(stream, 200, "application/json; charset=utf-8", &v.to_string(), ""),
            Err(e) => send_http(stream, e.status, "application/json; charset=utf-8", &e.to_json().to_string(), ""),
        }
        return;
    }

    if method == "GET" && (path.starts_with("/jam/join/") || path.starts_with("/join/")) {
        let raw_code = path
            .strip_prefix("/jam/join/")
            .or_else(|| path.strip_prefix("/join/"))
            .unwrap_or("")
            .split('/')
            .next()
            .unwrap_or("");
        let clean_code = crate::deeplink::normalize_code(raw_code)
            .unwrap_or_else(|| raw_code.trim().to_uppercase().chars().take(16).collect());
        let origin = host_header
            .map(|h| format!("http://{h}"))
            .unwrap_or_else(|| endpoint.to_string());
        let mut nonce_bytes = [0u8; 16];
        let _ = SystemRandom::new().fill(&mut nonce_bytes);
        let nonce = URL_SAFE_NO_PAD.encode(nonce_bytes);
        let lookup = coordinator
            .lock()
            .map_err(|_| LanErr::new(503, "Serviço ocupado.", Some("UNAVAILABLE")))
            .and_then(|c| c.lookup(raw_code, db::now()));

        let (status, preview, err_msg) = match lookup {
            Ok(v) => (200, Some(v), None),
            Err(e) => (if e.status == 400 { 404 } else { e.status }, e.preview, Some(e.message)),
        };
        let html = render_lan_invite_html(
            if clean_code.is_empty() { "INVÁLIDO" } else { &clean_code },
            &origin,
            preview.as_ref(),
            err_msg.as_deref(),
            &nonce,
        );
        let csp = format!(
            "Content-Security-Policy: default-src 'none'; style-src 'nonce-{nonce}'; script-src 'nonce-{nonce}'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'\r\n"
        );
        send_http(stream, status, "text/html; charset=utf-8", &html, &csp);
        return;
    }

    if method == "GET" && path == "/v1/jam/events" {
        let params: HashMap<String, String> = url::form_urlencoded::parse(query_str.as_bytes())
            .into_owned()
            .collect();
        let Some(code) = params
            .get("code")
            .and_then(|c| crate::deeplink::normalize_code(c))
        else {
            send_http(
                stream,
                400,
                "application/json; charset=utf-8",
                &json!({ "error": "Código da JAM inválido.", "errorCode": "INVITE_INVALID" }).to_string(),
                "",
            );
            return;
        };
        let tok = auth_bearer
            .or_else(|| params.get("token").cloned())
            .unwrap_or_default();
        if !valid_token_str(&tok) {
            send_http(
                stream,
                401,
                "application/json; charset=utf-8",
                &json!({ "error": "Sessão da JAM inválida.", "errorCode": "SESSION_EXPIRED" }).to_string(),
                "",
            );
            return;
        }
        let now = db::now();
        let auth_check = {
            let Ok(mut coord) = coordinator.lock() else {
                send_http(stream, 503, "application/json; charset=utf-8", &json!({"error":"Serviço ocupado."}).to_string(), "");
                return;
            };
            if let Some(room) = coord.rooms.get_mut(&code) {
                if let Some(mbr) = room.members.get_mut(&tok) {
                    mbr.online = true;
                    mbr.seen = now;
                    let is_host = mbr.host;
                    if is_host {
                        room.touched = now;
                    }
                    let view = Coordinator::view(room, now, &Value::Null);
                    Some((room.room_id.clone(), view))
                } else {
                    None
                }
            } else {
                None
            }
        };
        let Some((room_id, initial_view)) = auth_check else {
            send_http(
                stream,
                401,
                "application/json; charset=utf-8",
                &json!({ "error": "Sessão da JAM inválida ou expirada.", "errorCode": "SESSION_EXPIRED" }).to_string(),
                "",
            );
            return;
        };

        let (tx, rx) = mpsc::sync_channel::<String>(32);
        {
            let Ok(mut subs) = subscribers.lock() else {
                return;
            };
            if subs.len() >= MAX_SSE_CLIENTS {
                send_http(
                    stream,
                    503,
                    "application/json; charset=utf-8",
                    &json!({ "error": "Limite de conexões em tempo real atingido." }).to_string(),
                    "",
                );
                return;
            }
            subs.push(SseClient {
                room_id: room_id.clone(),
                token: tok.clone(),
                tx,
            });
        }

        // Notify peers of online presence
        dispatch_sse_events(
            subscribers,
            DispatchEvents {
                broadcasts: vec![(room_id.clone(), "state", initial_view.clone())],
                kicks: Vec::new(),
                close_room_id: None,
            },
        );

        let _ = stream.set_write_timeout(Some(Duration::from_secs(5)));
        let head = "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream; charset=utf-8\r\nCache-Control: no-store\r\nConnection: keep-alive\r\nX-Service: liquid-hub-jam\r\nX-Content-Type-Options: nosniff\r\n\r\n";
        let initial_evt = format!("event: state\ndata: {}\n\n", initial_view);
        if stream.write_all(head.as_bytes()).is_err()
            || stream.write_all(initial_evt.as_bytes()).is_err()
            || stream.flush().is_err()
        {
            if let Ok(mut subs) = subscribers.lock() {
                subs.retain(|s| !(s.room_id == room_id && s.token == tok));
            }
            return;
        }

        let coord_ref = coordinator.clone();
        let subs_ref = subscribers.clone();
        let _ = std::thread::Builder::new()
            .name("liquid-jam-lan-sse".into())
            .spawn(move || {
                loop {
                    match rx.recv_timeout(Duration::from_secs(15)) {
                        Ok(msg) => {
                            if stream.write_all(msg.as_bytes()).is_err() || stream.flush().is_err() {
                                break;
                            }
                        }
                        Err(mpsc::RecvTimeoutError::Timeout) => {
                            let now_ping = db::now();
                            if let Ok(mut c) = coord_ref.lock() {
                                for room in c.rooms.values_mut() {
                                    if room.room_id == room_id {
                                        if let Some(mbr) = room.members.get_mut(&tok) {
                                            mbr.seen = now_ping;
                                            mbr.online = true;
                                            if mbr.host {
                                                room.touched = now_ping;
                                            }
                                        }
                                        break;
                                    }
                                }
                            }
                            if stream.write_all(b": ping\n\n").is_err() || stream.flush().is_err() {
                                break;
                            }
                        }
                        Err(mpsc::RecvTimeoutError::Disconnected) => break,
                    }
                }
                let still_connected = if let Ok(mut subs) = subs_ref.lock() {
                    if let Some(pos) = subs
                        .iter()
                        .position(|s| s.room_id == room_id && s.token == tok)
                    {
                        subs.remove(pos);
                    }
                    subs.iter().any(|s| s.room_id == room_id && s.token == tok)
                } else {
                    false
                };
                if !still_connected {
                    let now_off = db::now();
                    let broadcast_view = if let Ok(mut c) = coord_ref.lock() {
                        c.rooms
                            .values_mut()
                            .find(|r| r.room_id == room_id)
                            .and_then(|room| {
                                if let Some(mbr) = room.members.get_mut(&tok) {
                                    mbr.online = false;
                                    mbr.seen = now_off;
                                    Some(Coordinator::view(room, now_off, &Value::Null))
                                } else {
                                    None
                                }
                            })
                    } else {
                        None
                    };
                    if let Some(v) = broadcast_view {
                        dispatch_sse_events(
                            &subs_ref,
                            DispatchEvents {
                                broadcasts: vec![(room_id, "state", v)],
                                kicks: Vec::new(),
                                close_room_id: None,
                            },
                        );
                    }
                }
            });
        return;
    }

    if path != "/v1/jam" {
        send_http(stream, 404, "application/json; charset=utf-8", &json!({ "error": "Não encontrado." }).to_string(), "");
        return;
    }
    if method != "POST" {
        send_http(stream, 405, "application/json; charset=utf-8", &json!({ "error": "Método não permitido." }).to_string(), "");
        return;
    }
    if !content_type {
        send_http(stream, 415, "application/json; charset=utf-8", &json!({ "error": "Envie JSON." }).to_string(), "");
        return;
    }
    let Some(length) = content_length else {
        send_http(stream, 411, "application/json; charset=utf-8", &json!({ "error": "Tamanho obrigatório." }).to_string(), "");
        return;
    };
    if length > 16384 {
        send_http(stream, 413, "application/json; charset=utf-8", &json!({ "error": "Solicitação muito grande." }).to_string(), "");
        return;
    }
    let mut bytes = vec![0u8; length];
    if reader.read_exact(&mut bytes).is_err() {
        send_http(stream, 400, "application/json; charset=utf-8", &json!({ "error": "Solicitação incompleta." }).to_string(), "");
        return;
    }
    let Some(p) = serde_json::from_slice::<Value>(&bytes)
        .ok()
        .filter(|v| v.is_object())
    else {
        send_http(stream, 400, "application/json; charset=utf-8", &json!({ "error": "Solicitação inválida." }).to_string(), "");
        return;
    };

    let outcome = coordinator
        .lock()
        .map_err(|_| LanErr::new(503, "Serviço ocupado.", Some("UNAVAILABLE")))
        .and_then(|mut c| c.handle_with_events(&p, &ip, db::now()));

    match outcome {
        Ok((val, events)) => {
            dispatch_sse_events(subscribers, events);
            let status = if s(&p, "action") == "create" { 201 } else { 200 };
            send_http(stream, status, "application/json; charset=utf-8", &val.to_string(), "");
        }
        Err(err) => {
            send_http(stream, err.status, "application/json; charset=utf-8", &err.to_json().to_string(), "");
        }
    }
}

fn spawn_lan_beacon(endpoint: String, coordinator: Arc<Mutex<Coordinator>>) {
    let _ = std::thread::Builder::new()
        .name("liquid-jam-lan-beacon".into())
        .spawn(move || {
            let Ok(sock) = UdpSocket::bind(("0.0.0.0", LAN_DISCOVERY_PORT)) else {
                return;
            };
            let mut buf = [0u8; 256];
            while let Ok((len, peer)) = sock.recv_from(&mut buf) {
                if &buf[..len] != LAN_MAGIC {
                    continue;
                }
                if let Ok(guard) = coordinator.lock() {
                    let payload = json!({ "rooms": guard.summaries(&endpoint, db::now()) }).to_string();
                    if payload.len() <= 8192 {
                        let _ = sock.send_to(payload.as_bytes(), peer);
                    }
                }
            }
        });
}

fn serve(ip: IpAddr) -> Result<(String, Arc<Mutex<Coordinator>>)> {
    let listener = Arc::new(
        TcpListener::bind((ip, 0)).map_err(|_| "Não foi possível abrir a JAM na rede local.")?,
    );
    let endpoint = format!(
        "http://{}",
        listener
            .local_addr()
            .map_err(|_| "Endereço da JAM indisponível.")?
    );
    let coordinator = Arc::new(Mutex::new(Coordinator::new()));
    let subscribers = Arc::new(Mutex::new(Vec::<SseClient>::new()));
    spawn_lan_beacon(endpoint.clone(), coordinator.clone());
    for worker in 0..4 {
        let listener = listener.clone();
        let coordinator = coordinator.clone();
        let subscribers = subscribers.clone();
        let ep = endpoint.clone();
        std::thread::Builder::new()
            .name(format!("liquid-jam-lan-{worker}"))
            .spawn(move || {
                while let Ok((stream, _)) = listener.accept() {
                    respond(stream, &ep, &coordinator, &subscribers);
                }
            })
            .map_err(|_| "Não foi possível iniciar o serviço de JAM.")?;
    }
    Ok((endpoint, coordinator))
}

static LOCAL_INSTANCE: OnceLock<Mutex<Option<(String, Arc<Mutex<Coordinator>>)>>> = OnceLock::new();

pub fn current_endpoint() -> Option<String> {
    LOCAL_INSTANCE
        .get()
        .and_then(|mtx| mtx.lock().ok())
        .and_then(|guard| guard.as_ref().map(|(ep, _)| ep.clone()))
}

pub fn start() -> Result<String> {
    let mut service = LOCAL_INSTANCE
        .get_or_init(|| Mutex::new(None))
        .lock()
        .map_err(|_| "Não foi possível iniciar a JAM.")?;
    if let Some((endpoint, _)) = &*service {
        return Ok(endpoint.clone());
    }
    let socket =
        UdpSocket::bind("0.0.0.0:0").map_err(|_| "Não foi possível encontrar a rede local.")?;
    socket
        .connect("192.0.2.1:80")
        .map_err(|_| "Conecte-se a uma rede local antes de criar uma JAM.")?;
    let ip = socket
        .local_addr()
        .map_err(|_| "Endereço da rede local indisponível.")?
        .ip();
    if !matches!(ip, IpAddr::V4(v) if v.is_private() || v.is_loopback()) {
        return Err(
            "Não foi encontrado um endereço privado. Use um servidor HTTPS nas opções de JAM."
                .into(),
        );
    }
    let (endpoint, coord) = serve(ip)?;
    *service = Some((endpoint.clone(), coord));
    Ok(endpoint)
}

pub fn discover_rooms() -> Vec<Value> {
    let mut rooms = Vec::new();
    let mut seen = HashSet::new();
    let now = db::now();

    if let Some(mtx) = LOCAL_INSTANCE.get() {
        if let Ok(guard) = mtx.lock() {
            if let Some((endpoint, coord)) = &*guard {
                if let Ok(c) = coord.lock() {
                    for r in c.summaries(endpoint, now) {
                        if let Some(code) = r["code"].as_str() {
                            seen.insert(code.to_string());
                        }
                        rooms.push(r);
                    }
                }
            }
        }
    }

    if let Ok(sock) = UdpSocket::bind("0.0.0.0:0") {
        let _ = sock.set_broadcast(true);
        let _ = sock.set_read_timeout(Some(Duration::from_millis(180)));
        let _ = sock.send_to(
            LAN_MAGIC,
            SocketAddrV4::new(Ipv4Addr::LOCALHOST, LAN_DISCOVERY_PORT),
        );
        let _ = sock.send_to(
            LAN_MAGIC,
            SocketAddrV4::new(Ipv4Addr::BROADCAST, LAN_DISCOVERY_PORT),
        );
        let mut buf = [0u8; 8192];
        for _ in 0..8 {
            let Ok((len, _)) = sock.recv_from(&mut buf) else {
                break;
            };
            if let Ok(val) = serde_json::from_slice::<Value>(&buf[..len]) {
                if let Some(arr) = val["rooms"].as_array() {
                    for r in arr {
                        let code = s(r, "code");
                        if crate::deeplink::normalize_code(code).is_some()
                            && crate::jam::validate_endpoint(s(r, "endpoint")).is_ok()
                            && seen.insert(code.to_string())
                        {
                            rooms.push(r.clone());
                        }
                    }
                }
            }
        }
    }
    rooms
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn embedded_coordinator_supports_sync_ping_replay_guard_and_preferred_code() {
        let mut server = Coordinator::new();
        let host = server
            .handle(
                &json!({"action":"create","name":"Host","preferredCode":"ABCDEF0123","nonce":"abcdef0123456789","timestamp":1000}),
                "127.0.0.1",
                1000,
            )
            .unwrap();
        assert_eq!(host["code"], "ABCDEF0123");
        // Replayed nonce must be rejected with 409
        assert_eq!(
            server
                .handle(
                    &json!({"action":"ping","nonce":"abcdef0123456789","timestamp":1001}),
                    "127.0.0.1",
                    1001
                )
                .unwrap_err()
                .0,
            409
        );
        let pong = server
            .handle(&json!({"action":"ping","clientTime":1234.0}), "127.0.0.1", 1005)
            .unwrap();
        assert_eq!(pong["pong"], true);

        let code = host["code"].clone();
        let guest = server
            .handle(
                &json!({"action":"join","code":code,"name":"Friend"}),
                "127.0.0.2",
                1006,
            )
            .unwrap();
        let track = json!({"id":"youtube:M7lc1UVf-VE","source":"youtube","sourceId":"M7lc1UVf-VE","kind":"track","title":"Test","artist":"Liquid","duration":180,"url":"https://www.youtube.com/watch?v=M7lc1UVf-VE","addedAt":0});
        server
            .handle(
                &json!({"action":"sync","code":code,"token":host["token"],"playback":{"track":track,"playing":true,"position":20}}),
                "127.0.0.1",
                2000,
            )
            .unwrap();
        let follow = server
            .handle(
                &json!({"action":"poll","code":code,"token":guest["token"]}),
                "127.0.0.2",
                3000,
            )
            .unwrap();
        assert_eq!(follow["playback"]["track"]["id"], track["id"]);
        assert_eq!(follow["playback"]["updatedAt"], 2000);
        assert_eq!(follow["members"].as_array().unwrap().len(), 2);
        assert!(follow["members"]
            .as_array()
            .unwrap()
            .iter()
            .all(|m| m.get("token").is_none()));
        assert_eq!(
            server
                .handle(
                    &json!({"action":"sync","code":code,"token":guest["token"],"playback":{"track":track,"playing":false,"position":20}}),
                    "127.0.0.2",
                    3001
                )
                .unwrap_err()
                .0,
            403
        );
        server
            .handle(
                &json!({"action":"leave","code":code,"token":host["token"]}),
                "127.0.0.1",
                4000,
            )
            .unwrap();
        assert_eq!(
            server
                .handle(
                    &json!({"action":"poll","code":code,"token":guest["token"]}),
                    "127.0.0.2",
                    4001
                )
                .unwrap_err()
                .0,
            410
        );
    }

    #[test]
    fn supports_case_insensitive_lookup_dedup_resume_rotate_lock_kick_and_tombstones() {
        let mut server = Coordinator::new();
        let host = server
            .handle(
                &json!({"action":"create","name":"Duda","roomName":"Noite Indie","clientId":"client_host_1234"}),
                "127.0.0.1",
                1000,
            )
            .unwrap();
        let code = host["code"].as_str().unwrap().to_string();
        let lower_hyphen = format!("{}-{}", &code[..4].to_lowercase(), &code[4..].to_lowercase());

        // Case-insensitive & hyphenated lookup works!
        let preview = server
            .handle(&json!({"action":"lookup","code":lower_hyphen}), "127.0.0.2", 1001)
            .unwrap();
        assert_eq!(preview["roomName"], "Noite Indie");
        assert_eq!(preview["hostName"], "Duda");
        assert_eq!(preview["canJoin"], true);

        // Joining with same clientId deduplicates cleanly
        let g1 = server
            .handle(
                &json!({"action":"join","code":lower_hyphen,"name":"Leo","clientId":"client_leo_1234"}),
                "127.0.0.2",
                1002,
            )
            .unwrap();
        let g2 = server
            .handle(
                &json!({"action":"join","code":code,"name":"Leo","clientId":"client_leo_1234"}),
                "127.0.0.2",
                1003,
            )
            .unwrap();
        assert_eq!(g1["memberId"], g2["memberId"]);
        assert_eq!(g2["members"].as_array().unwrap().len(), 2);

        // Absent guest moves to grace cache after 36s, and resume restores without duplicating
        let _ = server.handle(
            &json!({"action":"poll","code":code,"token":host["token"]}),
            "127.0.0.1",
            38_000,
        );
        let resumed = server
            .handle(
                &json!({"action":"resume","code":code,"resumeToken":g1["token"],"clientId":"client_leo_1234"}),
                "127.0.0.2",
                38_500,
            )
            .unwrap();
        assert_eq!(resumed["memberId"], g1["memberId"]);
        assert_eq!(resumed["members"].as_array().unwrap().len(), 2);

        // Rotate invite expires old code and activates new code
        let rotated = server
            .handle(
                &json!({"action":"rotateInvite","code":code,"token":host["token"]}),
                "127.0.0.1",
                39_000,
            )
            .unwrap();
        let new_code = rotated["code"].as_str().unwrap().to_string();
        assert_ne!(new_code, code);
        let old_lookup = server
            .handle_with_events(&json!({"action":"lookup","code":code}), "127.0.0.3", 39_100)
            .unwrap_err();
        assert_eq!(old_lookup.status, 410);
        assert_eq!(old_lookup.error_code, Some("INVITE_EXPIRED"));

        // Lock prevents new guests while existing members stay
        server
            .handle(
                &json!({"action":"updateRoom","code":new_code,"token":host["token"],"locked":true}),
                "127.0.0.1",
                39_200,
            )
            .unwrap();
        let locked_err = server
            .handle_with_events(
                &json!({"action":"join","code":new_code,"name":"Intruso"}),
                "127.0.0.3",
                39_300,
            )
            .unwrap_err();
        assert_eq!(locked_err.status, 403);
        assert_eq!(locked_err.error_code, Some("ROOM_LOCKED"));

        // Kick blocks kicked member from resuming
        server
            .handle(
                &json!({"action":"kick","code":new_code,"token":host["token"],"memberId":g1["memberId"]}),
                "127.0.0.1",
                39_400,
            )
            .unwrap();
        let kick_err = server
            .handle_with_events(
                &json!({"action":"resume","code":new_code,"resumeToken":g1["token"],"clientId":"client_leo_1234"}),
                "127.0.0.2",
                39_500,
            )
            .unwrap_err();
        assert_eq!(kick_err.status, 403);
        assert_eq!(kick_err.error_code, Some("KICKED"));

        // Host leave creates ROOM_ENDED tombstone
        server
            .handle(
                &json!({"action":"leave","code":new_code,"token":host["token"]}),
                "127.0.0.1",
                39_600,
            )
            .unwrap();
        let ended_err = server
            .handle_with_events(
                &json!({"action":"lookup","code":new_code}),
                "127.0.0.3",
                39_700,
            )
            .unwrap_err();
        assert_eq!(ended_err.status, 410);
        assert_eq!(ended_err.error_code, Some("ROOM_ENDED"));
    }

    #[test]
    fn html_landing_page_escapes_xss_and_embeds_deep_link() {
        let preview = json!({
            "roomName": "<script>alert(1)</script>",
            "hostName": "Alice\" & Bob",
            "participantCount": 2,
            "maxParticipants": 8,
            "status": "active",
            "canJoin": true
        });
        let html = render_lan_invite_html(
            "K9M4P2XR",
            "http://192.168.1.5:43880",
            Some(&preview),
            None,
            "nonce123",
        );
        assert!(!html.contains("<script>alert(1)</script>"));
        assert!(html.contains("&lt;script&gt;alert(1)&lt;/script&gt;"));
        assert!(html.contains("liquidhub://jam/join/K9M4P2XR?endpoint="));
    }
}
