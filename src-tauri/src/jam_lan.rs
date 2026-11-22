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
const JOIN_REQUEST_TTL_MS: i64 = 5 * 60 * 1000;
const APPROVED_CLAIM_TTL_MS: i64 = 90 * 1000;
const RESOLVED_STATUS_TTL_MS: i64 = 120 * 1000;
const MAX_PENDING_JOIN_REQUESTS: usize = 32;
const REQUEST_JOIN_IP_LIMIT_PER_MIN: usize = 6;
const TOMBSTONE_RETENTION_MS: i64 = 24 * 60 * 60 * 1000;
const MEMBER_GRACE_MS: i64 = 35_000;
const MAX_SSE_CLIENTS: usize = 24;

#[derive(Clone)]
struct Permissions {
    allow_queue_add: bool,
    allow_vote_skip: bool,
    allow_chat: bool,
    allow_recommendations: bool,
}

impl Default for Permissions {
    fn default() -> Self {
        Self {
            allow_queue_add: true,
            allow_vote_skip: true,
            allow_chat: true,
            allow_recommendations: true,
        }
    }
}

impl Permissions {
    fn to_json(&self) -> Value {
        json!({
            "allowQueueAdd": self.allow_queue_add,
            "allowVoteSkip": self.allow_vote_skip,
            "allowChat": self.allow_chat,
            "allowRecommendations": self.allow_recommendations
        })
    }

    fn apply_patch(&mut self, v: &Value) {
        if let Some(obj) = v.as_object() {
            if let Some(b) = obj.get("allowQueueAdd").and_then(Value::as_bool) {
                self.allow_queue_add = b;
            }
            if let Some(b) = obj.get("allowVoteSkip").and_then(Value::as_bool) {
                self.allow_vote_skip = b;
            }
            if let Some(b) = obj.get("allowChat").and_then(Value::as_bool) {
                self.allow_chat = b;
            }
            if let Some(b) = obj.get("allowRecommendations").and_then(Value::as_bool) {
                self.allow_recommendations = b;
            }
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum JoinRequestStatus {
    Pending,
    Approved,
    Rejected,
    Blocked,
    Expired,
}

impl JoinRequestStatus {
    fn as_str(&self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::Approved => "approved",
            Self::Rejected => "rejected",
            Self::Blocked => "blocked",
            Self::Expired => "expired",
        }
    }
}

#[derive(Clone)]
struct JoinRequest {
    id: String,
    request_token: String,
    name: String,
    avatar: Option<String>,
    client_id: Option<String>,
    requested_at: i64,
    expires_at: i64,
    status: JoinRequestStatus,
    reason: Option<String>,
    error_code: Option<&'static str>,
    approved_session: Option<Value>,
}

#[derive(Clone)]
struct BlockedParticipant {
    key: String,
    name: String,
    blocked_at: i64,
}

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
    require_approval: bool,
    permissions: Permissions,
    max_participants: usize,
    invite_expires_at: i64,
    created_at: i64,
    members: HashMap<String, Member>,
    recent_members: HashMap<String, RecentMember>,
    kicked_keys: HashSet<String>,
    blocked_keys: HashSet<String>,
    blocked_list: Vec<BlockedParticipant>,
    join_requests: HashMap<String, JoinRequest>,
    playback: Value,
    skip_votes: HashSet<String>,
    skip_triggered_at: i64,
    jam_queue: Vec<Value>,
    recommendations: Vec<Value>,
    messages: Vec<Value>,
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
    host: bool,
    tx: SyncSender<String>,
}

#[derive(Debug)]
struct SseBroadcast {
    room_id: String,
    event: &'static str,
    guest_payload: Value,
    host_payload: Value,
    host_only: bool,
}

#[derive(Debug)]
struct DispatchEvents {
    broadcasts: Vec<SseBroadcast>,
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

    fn push_room_state(
        &mut self,
        room: &Room,
        event: &'static str,
        now: i64,
        host_only: bool,
    ) {
        let host_payload = Coordinator::view(room, now, &Value::Null, true);
        let guest_payload = if host_only {
            Value::Null
        } else {
            Coordinator::view(room, now, &Value::Null, false)
        };
        self.broadcasts.push(SseBroadcast {
            room_id: room.room_id.clone(),
            event,
            guest_payload,
            host_payload,
            host_only,
        });
    }

    fn push_uniform(&mut self, room_id: String, event: &'static str, payload: Value) {
        self.broadcasts.push(SseBroadcast {
            room_id,
            event,
            guest_payload: payload.clone(),
            host_payload: payload,
            host_only: false,
        });
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

fn safe_request_id(v: &Value) -> Option<String> {
    let rid = s(v, "requestId");
    if (6..=64).contains(&rid.len())
        && rid
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"_-".contains(&b))
    {
        Some(rid.to_string())
    } else {
        None
    }
}

fn safe_block_key(v: &Value) -> Option<String> {
    let key = s(v, "blockKey");
    let Some((_, rest)) = key.split_once(':') else {
        return None;
    };
    let prefix = &key[..key.len() - rest.len()];
    if ["uid:", "cid:", "id:", "tok:"].contains(&prefix)
        && (2..=120).contains(&rest.len())
        && rest
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"_.:-".contains(&b))
    {
        Some(key.to_string())
    } else {
        None
    }
}

fn is_blocked_requester(room: &Room, client_id: Option<&str>) -> bool {
    client_id.is_some_and(|cid| room.blocked_keys.contains(&format!("cid:{cid}")))
}

fn add_block_keys(
    room: &mut Room,
    id: &str,
    name: &str,
    tok: &str,
    client_id: Option<&str>,
    now: i64,
    revoke_token: bool,
) {
    if revoke_token {
        room.kicked_keys.insert(format!("tok:{tok}"));
    }
    if let Some(cid) = client_id {
        room.kicked_keys.insert(format!("cid:{cid}"));
        room.blocked_keys.insert(format!("cid:{cid}"));
    }
    room.blocked_keys.insert(format!("id:{id}"));
    let primary_key = if let Some(cid) = client_id {
        format!("cid:{cid}")
    } else {
        format!("id:{id}")
    };
    room.blocked_list.retain(|b| b.key != primary_key);
    room.blocked_list.push(BlockedParticipant {
        key: primary_key,
        name: name.to_string(),
        blocked_at: now,
    });
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

    fn prune_join_requests(room: &mut Room, now: i64) -> bool {
        let mut changed = false;
        for req in room.join_requests.values_mut() {
            if req.status == JoinRequestStatus::Pending && req.expires_at <= now {
                req.status = JoinRequestStatus::Expired;
                req.reason =
                    Some("Solicitação expirada. Peça entrada novamente ao anfitrião.".into());
                req.error_code = Some("INVITE_EXPIRED");
                req.expires_at = now + RESOLVED_STATUS_TTL_MS;
                changed = true;
            }
        }
        room.join_requests
            .retain(|_, r| r.status == JoinRequestStatus::Pending || r.expires_at > now);
        changed
    }

    fn pending_requests_json(room: &Room, now: i64) -> Vec<Value> {
        let mut list: Vec<Value> = room
            .join_requests
            .values()
            .filter(|r| r.status == JoinRequestStatus::Pending && r.expires_at > now)
            .map(|r| {
                let mut obj = json!({
                    "id": r.id,
                    "name": r.name,
                    "requestedAt": r.requested_at,
                    "expiresAt": r.expires_at,
                    "status": r.status.as_str()
                });
                if let Some(ref av) = r.avatar {
                    obj["avatar"] = json!(av);
                }
                if let Some(ref cid) = r.client_id {
                    obj["clientId"] = json!(cid);
                }
                obj
            })
            .collect();
        list.sort_by_key(|v| v["requestedAt"].as_i64().unwrap_or(0));
        list
    }

    fn view(room: &Room, now: i64, p: &Value, for_host: bool) -> Value {
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
        let pending = Self::pending_requests_json(room, now);
        let online_count = room.members.values().filter(|m| m.online).count().max(1);
        let skip_threshold = ((online_count + 1) / 2).max(1);
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
            "requireApproval": room.require_approval,
            "permissions": room.permissions.to_json(),
            "maxParticipants": room.max_participants,
            "inviteExpiresAt": room.invite_expires_at,
            "createdAt": room.created_at,
            "members": members,
            "pendingRequestCount": pending.len(),
            "playback": room.playback,
            "skipVotes": room.skip_votes.iter().cloned().collect::<Vec<_>>(),
            "skipThreshold": skip_threshold,
            "serverTime": now
        });
        let host_avatar = room
            .host_avatar
            .as_ref()
            .or_else(|| room.members.values().find(|m| m.host).and_then(|m| m.avatar.as_ref()));
        if let Some(av) = host_avatar {
            val["hostAvatar"] = json!(av);
        }
        if room.skip_triggered_at > 0 {
            val["skipTriggeredAt"] = json!(room.skip_triggered_at);
        }
        if !room.jam_queue.is_empty() {
            val["jamQueue"] = json!(room.jam_queue);
        }
        if !room.recommendations.is_empty() {
            val["recommendations"] = json!(room.recommendations);
        }
        if !room.messages.is_empty() {
            val["messages"] = json!(room.messages);
        }
        if for_host {
            val["joinRequests"] = Value::Array(pending);
            val["blockedList"] = Value::Array(
                room.blocked_list
                    .iter()
                    .map(|b| json!({"key": b.key, "name": b.name, "blockedAt": b.blocked_at}))
                    .collect(),
            );
        }
        if unchanged {
            val["unchanged"] = json!(true);
        }
        if let Some(ct) = p["clientTime"].as_f64().filter(|n| n.is_finite()) {
            val["echoClientTime"] = json!(ct);
        }
        val
    }

    fn build_member_session(room: &Room, mbr: &Member, now: i64, p: &Value) -> Value {
        let mut value = Self::view(room, now, p, mbr.host);
        value["token"] = json!(mbr.token);
        value["memberId"] = json!(mbr.id);
        value["host"] = json!(mbr.host);
        if let Some(ref cid) = mbr.client_id {
            value["clientId"] = json!(cid);
        }
        value
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
            "requireApproval": room.require_approval,
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
                events.push_uniform(
                    room.room_id.clone(),
                    "closed",
                    json!({
                        "closed": true,
                        "reason": "Esta JAM expirou por inatividade.",
                        "errorCode": "ROOM_ENDED",
                        "serverTime": now
                    }),
                );
                events.close_room_id = Some(room.room_id);
            }
        }
        self.rates.retain(|_, v| v.0 > now);
        self.nonces.retain(|_, until| *until > now);
        self.tombstones.retain(|_, t| t.expires_at > now);

        for room in self.rooms.values_mut() {
            let jr_changed = Self::prune_join_requests(room, now);
            let timed_out: Vec<String> = room
                .members
                .iter()
                .filter(|(_, m)| !m.host && now - m.seen > MEMBER_GRACE_MS)
                .map(|(k, _)| k.clone())
                .collect();
            let had_timed_out = !timed_out.is_empty();
            if had_timed_out {
                for tok in timed_out {
                    if let Some(m) = room.members.remove(&tok) {
                        room.skip_votes.remove(&m.id);
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
                events.push_room_state(room, "state", now, false);
            } else if jr_changed {
                events.push_room_state(room, "state", now, true);
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
            let mut permissions = Permissions::default();
            permissions.apply_patch(&p["permissions"]);
            let require_approval = p["requireApproval"] == true;
            let room = Room {
                room_id: format!("jam_{}", uuid::Uuid::new_v4().simple()),
                code: code.clone(),
                room_name: rname,
                host_avatar: avatar,
                locked: false,
                require_auth: p["requireAuth"] == true,
                require_approval,
                permissions,
                max_participants: MAX_PARTICIPANTS,
                invite_expires_at: now + invite_ttl,
                created_at: now,
                members: HashMap::from([(auth.clone(), member)]),
                recent_members: HashMap::new(),
                kicked_keys: HashSet::new(),
                blocked_keys: HashSet::new(),
                blocked_list: Vec::new(),
                join_requests: HashMap::new(),
                playback: json!({"track":null,"playing":false,"position":0,"updatedAt":now,"sequence":0}),
                skip_votes: HashSet::new(),
                skip_triggered_at: 0,
                jam_queue: Vec::new(),
                recommendations: Vec::new(),
                messages: Vec::new(),
                touched: now,
            };
            let value = Self::build_member_session(&room, &room.members[&auth], now, p);
            let _ = mid;
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

        if action == "requestJoin" {
            self.check_replay(p, now)?;
            let client_id = safe_client_id(p);
            {
                let room = &self.rooms[&code];
                if room.invite_expires_at <= now {
                    return Err(LanErr::with_preview(
                        410,
                        "Este convite expirou. Peça um novo link ao anfitrião.",
                        "INVITE_EXPIRED",
                        Self::preview(room, now),
                    ));
                }
                if is_blocked_requester(room, client_id.as_deref()) {
                    return Err(LanErr::with_preview(
                        403,
                        "Você foi bloqueado pelo anfitrião desta JAM.",
                        "BLOCKED",
                        Self::preview(room, now),
                    ));
                }
                if room.locked {
                    return Err(LanErr::with_preview(
                        403,
                        "Esta JAM está trancada pelo anfitrião.",
                        "ROOM_LOCKED",
                        Self::preview(room, now),
                    ));
                }
                if room.members.len() >= room.max_participants {
                    return Err(LanErr::with_preview(
                        409,
                        "Esta JAM atingiu o limite de participantes.",
                        "ROOM_FULL",
                        Self::preview(room, now),
                    ));
                }
            }

            let req_rate_key = format!("req:{code}:{ip}");
            if self.rates.len() >= 1024 && !self.rates.contains_key(&req_rate_key) {
                return Err(LanErr::new(503, "Serviço ocupado.", Some("UNAVAILABLE")));
            }
            let req_rate = self.rates.entry(req_rate_key).or_insert((now + 60_000, 0));
            req_rate.1 += 1;
            if req_rate.1 > REQUEST_JOIN_IP_LIMIT_PER_MIN {
                return Err(LanErr::new(
                    429,
                    "Muitas solicitações de entrada. Aguarde um minuto.",
                    Some("RATE_LIMITED"),
                ));
            }

            let room = self.rooms.get_mut(&code).unwrap();
            if client_id.as_ref().is_some_and(|cid| {
                room.members
                    .values()
                    .any(|m| m.client_id.as_deref() == Some(cid.as_str()))
            }) {
                return Err(LanErr::new(
                    409,
                    "Você já está participando desta JAM.",
                    Some("REQUEST_DUPLICATE"),
                ));
            }
            let _ = Self::prune_join_requests(room, now);
            if client_id.as_ref().is_some_and(|cid| {
                room.join_requests.values().any(|r| {
                    r.status == JoinRequestStatus::Pending
                        && r.expires_at > now
                        && r.client_id.as_deref() == Some(cid.as_str())
                })
            }) {
                let preview = Self::preview(room, now);
                return Err(LanErr::with_preview(
                    409,
                    "Você já enviou uma solicitação pendente para esta JAM.",
                    "REQUEST_DUPLICATE",
                    preview,
                ));
            }
            if Self::pending_requests_json(room, now).len() >= MAX_PENDING_JOIN_REQUESTS {
                return Err(LanErr::new(
                    429,
                    "Muitas solicitações pendentes no momento. Aguarde o anfitrião.",
                    Some("RATE_LIMITED"),
                ));
            }

            let req_id = format!("jrq_{}", &uuid::Uuid::new_v4().simple().to_string()[..12]);
            let req_tok = token();
            let expires_at = now + JOIN_REQUEST_TTL_MS;
            let req = JoinRequest {
                id: req_id.clone(),
                request_token: req_tok.clone(),
                name: name(p),
                avatar: safe_avatar(p),
                client_id,
                requested_at: now,
                expires_at,
                status: JoinRequestStatus::Pending,
                reason: None,
                error_code: None,
                approved_session: None,
            };
            room.join_requests.insert(req_id.clone(), req);
            let preview = Self::preview(room, now);
            events.push_room_state(room, "state", now, true);
            return Ok((
                json!({
                    "status": "pending",
                    "requestId": req_id,
                    "requestToken": req_tok,
                    "expiresAt": expires_at,
                    "preview": preview,
                    "serverTime": now
                }),
                events,
            ));
        }

        if action == "checkJoinRequest" {
            let req_id = safe_request_id(p)
                .ok_or_else(|| LanErr::new(400, "Solicitação inválida.", None))?;
            let req_tok = s(p, "requestToken");
            if !valid_token_str(req_tok) {
                return Err(LanErr::new(
                    401,
                    "Token da solicitação inválido.",
                    Some("SESSION_EXPIRED"),
                ));
            }
            self.check_replay(p, now)?;
            let room = self.rooms.get_mut(&code).unwrap();
            let expired_some = Self::prune_join_requests(room, now);
            let valid_match = room
                .join_requests
                .get(&req_id)
                .is_some_and(|r| r.request_token == req_tok);
            if !valid_match {
                if expired_some {
                    events.push_room_state(room, "state", now, true);
                }
                return Ok((
                    json!({
                        "status": "expired",
                        "requestId": req_id,
                        "reason": "Solicitação expirada ou cancelada.",
                        "errorCode": "INVITE_EXPIRED",
                        "serverTime": now
                    }),
                    events,
                ));
            }
            let ready_to_claim = room
                .join_requests
                .get(&req_id)
                .is_some_and(|r| r.status == JoinRequestStatus::Approved && r.approved_session.is_some());
            if ready_to_claim {
                let removed = room.join_requests.remove(&req_id).unwrap();
                let claimed = removed.approved_session.unwrap();
                let target_member_id = claimed["memberId"].as_str().unwrap_or("");
                let session_out = room
                    .members
                    .values()
                    .find(|m| m.id == target_member_id)
                    .map(|m| Self::build_member_session(room, m, now, p))
                    .unwrap_or(claimed);
                events.push_room_state(room, "state", now, true);
                return Ok((
                    json!({
                        "status": "approved",
                        "requestId": req_id,
                        "session": session_out,
                        "serverTime": now
                    }),
                    events,
                ));
            }
            let r = &room.join_requests[&req_id];
            let mut out = json!({
                "status": r.status.as_str(),
                "requestId": r.id,
                "expiresAt": r.expires_at,
                "serverTime": now
            });
            if let Some(ref reason) = r.reason {
                out["reason"] = json!(reason);
            }
            if let Some(code_err) = r.error_code {
                out["errorCode"] = json!(code_err);
            }
            if expired_some {
                events.push_room_state(room, "state", now, true);
            }
            return Ok((out, events));
        }

        if action == "cancelJoinRequest" {
            let req_id = safe_request_id(p)
                .ok_or_else(|| LanErr::new(400, "Solicitação inválida.", None))?;
            let req_tok = s(p, "requestToken");
            if !valid_token_str(req_tok) {
                return Err(LanErr::new(
                    401,
                    "Token da solicitação inválido.",
                    Some("SESSION_EXPIRED"),
                ));
            }
            self.check_replay(p, now)?;
            let room = self.rooms.get_mut(&code).unwrap();
            if room
                .join_requests
                .get(&req_id)
                .is_some_and(|r| r.request_token == req_tok)
            {
                room.join_requests.remove(&req_id);
                events.push_room_state(room, "state", now, true);
            }
            return Ok((
                json!({
                    "status": "cancelled",
                    "requestId": req_id,
                    "serverTime": now
                }),
                events,
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
                if is_blocked_requester(room, client_id.as_deref()) {
                    return Err(LanErr::new(
                        403,
                        "Você foi bloqueado pelo anfitrião desta JAM.",
                        Some("BLOCKED"),
                    ));
                }
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
                let value = Self::build_member_session(room, &room.members[&tok], now, p);
                events.push_room_state(room, "state", now, false);
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
                room.members.insert(auth.clone(), restored);
                let value = Self::build_member_session(room, &room.members[&auth], now, p);
                events.push_room_state(room, "state", now, false);
                return Ok((value, events));
            }

            if action == "resume" {
                return Err(LanErr::new(
                    401,
                    "Sua sessão expirou. Entre novamente.",
                    Some("SESSION_EXPIRED"),
                ));
            }

            if self.rooms[&code].require_approval {
                let preview = Self::preview(&self.rooms[&code], now);
                return Err(LanErr::with_preview(
                    403,
                    "Esta JAM exige aprovação do anfitrião. Envie uma solicitação de entrada.",
                    "APPROVAL_REQUIRED",
                    preview,
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
                client_id,
                name: name(p),
                avatar: safe_avatar(p),
                host: false,
                online: true,
                joined_at: now,
                seen: now,
            };
            let auth = member.token.clone();
            room.members.insert(auth.clone(), member);
            let value = Self::build_member_session(room, &room.members[&auth], now, p);
            events.push_room_state(room, "state", now, false);
            return Ok((value, events));
        }

        let auth = s(p, "token");
        let (is_host, member_id, member_name, member_avatar) = {
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
            (
                member.host,
                member.id.clone(),
                member.name.clone(),
                member.avatar.clone(),
            )
        };

        if action == "leave" {
            self.check_replay(p, now)?;
            if is_host {
                if let Some(room) = self.rooms.remove(&code) {
                    let rid = room.room_id.clone();
                    self.record_tombstone(&room, &code, "ended", now);
                    events.push_uniform(
                        rid.clone(),
                        "closed",
                        json!({
                            "closed": true,
                            "reason": "O anfitrião encerrou a JAM.",
                            "errorCode": "ROOM_ENDED",
                            "serverTime": now
                        }),
                    );
                    events.close_room_id = Some(rid);
                }
            } else if let Some(room) = self.rooms.get_mut(&code) {
                if let Some(removed) = room.members.remove(auth) {
                    room.skip_votes.remove(&removed.id);
                }
                events.push_room_state(room, "state", now, false);
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
            let out = Self::view(&room, now, p, true);
            events.push_room_state(&room, "state", now, false);
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
            if let Some(ra) = p["requireAuth"].as_bool() {
                room.require_auth = ra;
            }
            if let Some(rap) = p["requireApproval"].as_bool() {
                room.require_approval = rap;
            }
            if p.get("permissions").is_some() {
                room.permissions.apply_patch(&p["permissions"]);
            }
            let out = Self::view(room, now, p, true);
            events.push_room_state(room, "state", now, false);
            return Ok((out, events));
        }

        if action == "approveJoin" {
            if !is_host {
                return Err(LanErr::new(
                    403,
                    "Somente o anfitrião pode aprovar participantes.",
                    Some("FORBIDDEN"),
                ));
            }
            let req_id = safe_request_id(p)
                .ok_or_else(|| LanErr::new(400, "Solicitação inválida.", None))?;
            self.check_replay(p, now)?;
            let room = self.rooms.get_mut(&code).unwrap();
            let _ = Self::prune_join_requests(room, now);
            let (status, expires_at, req_name, req_avatar, req_cid) = match room.join_requests.get(&req_id) {
                Some(r) => (
                    r.status,
                    r.expires_at,
                    r.name.clone(),
                    r.avatar.clone(),
                    r.client_id.clone(),
                ),
                None => {
                    return Err(LanErr::new(404, "Solicitação de entrada não encontrada.", None));
                }
            };
            if status != JoinRequestStatus::Pending {
                return Err(LanErr::new(
                    409,
                    "Esta solicitação já foi processada.",
                    Some("REQUEST_DUPLICATE"),
                ));
            }
            if expires_at <= now {
                if let Some(r) = room.join_requests.get_mut(&req_id) {
                    r.status = JoinRequestStatus::Expired;
                    r.expires_at = now + RESOLVED_STATUS_TTL_MS;
                }
                return Err(LanErr::new(
                    410,
                    "Esta solicitação expirou.",
                    Some("INVITE_EXPIRED"),
                ));
            }
            if is_blocked_requester(room, req_cid.as_deref()) {
                if let Some(r) = room.join_requests.get_mut(&req_id) {
                    r.status = JoinRequestStatus::Blocked;
                    r.error_code = Some("BLOCKED");
                    r.expires_at = now + RESOLVED_STATUS_TTL_MS;
                }
                return Err(LanErr::new(
                    403,
                    "Este usuário está bloqueado nesta JAM.",
                    Some("BLOCKED"),
                ));
            }
            if req_cid.as_ref().is_some_and(|cid| {
                room.members
                    .values()
                    .any(|m| m.client_id.as_deref() == Some(cid.as_str()))
            }) {
                room.join_requests.remove(&req_id);
                return Err(LanErr::new(
                    409,
                    "Este usuário já entrou na JAM.",
                    Some("REQUEST_DUPLICATE"),
                ));
            }
            if room.members.len() >= room.max_participants {
                return Err(LanErr::new(
                    409,
                    format!("Esta JAM já tem {} pessoas.", room.max_participants),
                    Some("ROOM_FULL"),
                ));
            }
            let new_member = Member {
                id: uuid::Uuid::new_v4().simple().to_string(),
                token: token(),
                client_id: req_cid,
                name: req_name,
                avatar: req_avatar,
                host: false,
                online: true,
                joined_at: now,
                seen: now,
            };
            let new_tok = new_member.token.clone();
            room.members.insert(new_tok.clone(), new_member);
            let session_out = Self::build_member_session(room, &room.members[&new_tok], now, &Value::Null);
            if let Some(r) = room.join_requests.get_mut(&req_id) {
                r.status = JoinRequestStatus::Approved;
                r.expires_at = now + APPROVED_CLAIM_TTL_MS;
                r.approved_session = Some(session_out);
            }
            let out = Self::view(room, now, p, true);
            events.push_room_state(room, "state", now, false);
            return Ok((out, events));
        }

        if action == "rejectJoin" {
            if !is_host {
                return Err(LanErr::new(
                    403,
                    "Somente o anfitrião pode recusar participantes.",
                    Some("FORBIDDEN"),
                ));
            }
            let req_id = safe_request_id(p)
                .ok_or_else(|| LanErr::new(400, "Solicitação inválida.", None))?;
            self.check_replay(p, now)?;
            let room = self.rooms.get_mut(&code).unwrap();
            let _ = Self::prune_join_requests(room, now);
            let should_block = p["block"] == true;
            let (status, req_name, req_tok, req_cid) = match room.join_requests.get(&req_id) {
                Some(r) => (
                    r.status,
                    r.name.clone(),
                    r.request_token.clone(),
                    r.client_id.clone(),
                ),
                None => {
                    return Err(LanErr::new(404, "Solicitação de entrada não encontrada.", None));
                }
            };
            if status != JoinRequestStatus::Pending {
                return Err(LanErr::new(
                    409,
                    "Esta solicitação já foi processada.",
                    Some("REQUEST_DUPLICATE"),
                ));
            }
            if let Some(r) = room.join_requests.get_mut(&req_id) {
                if should_block {
                    r.status = JoinRequestStatus::Blocked;
                    r.error_code = Some("BLOCKED");
                    r.reason = Some("Sua entrada foi bloqueada pelo anfitrião.".into());
                } else {
                    r.status = JoinRequestStatus::Rejected;
                    r.error_code = Some("REQUEST_REJECTED");
                    r.reason = Some("O anfitrião recusou sua solicitação de entrada.".into());
                }
                r.expires_at = now + RESOLVED_STATUS_TTL_MS;
            }
            if should_block {
                add_block_keys(
                    room,
                    &req_id,
                    &req_name,
                    &req_tok,
                    req_cid.as_deref(),
                    now,
                    false,
                );
            }
            let out = Self::view(room, now, p, true);
            events.push_room_state(room, "state", now, true);
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
            room.skip_votes.remove(&kicked.id);
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
            let out = Self::view(room, now, p, true);
            events.push_room_state(room, "state", now, false);
            return Ok((out, events));
        }

        if action == "blockMember" {
            if !is_host {
                return Err(LanErr::new(
                    403,
                    "Somente o anfitrião pode bloquear participantes.",
                    Some("FORBIDDEN"),
                ));
            }
            let target_id = s(p, "memberId");
            if target_id.is_empty() {
                return Err(LanErr::new(400, "Participante inválido.", None));
            }
            self.check_replay(p, now)?;
            let room = self.rooms.get_mut(&code).unwrap();
            let active_tok = room
                .members
                .iter()
                .find(|(_, m)| m.id == target_id)
                .map(|(k, _)| k.clone());
            let recent_tok = if active_tok.is_none() {
                room.recent_members
                    .iter()
                    .find(|(_, m)| m.id == target_id)
                    .map(|(k, _)| k.clone())
            } else {
                None
            };
            if let Some(tok) = active_tok {
                if room.members[&tok].host {
                    return Err(LanErr::new(400, "Não é possível bloquear o anfitrião.", None));
                }
                let removed = room.members.remove(&tok).unwrap();
                room.recent_members.remove(&tok);
                room.skip_votes.remove(&removed.id);
                add_block_keys(
                    room,
                    &removed.id,
                    &removed.name,
                    &removed.token,
                    removed.client_id.as_deref(),
                    now,
                    true,
                );
                events.kicks.push((
                    room.room_id.clone(),
                    removed.token,
                    json!({
                        "kicked": true,
                        "reason": "Você foi bloqueado nesta JAM pelo anfitrião.",
                        "errorCode": "BLOCKED",
                        "serverTime": now
                    }),
                ));
            } else if let Some(tok) = recent_tok {
                if room.recent_members[&tok].host {
                    return Err(LanErr::new(400, "Não é possível bloquear o anfitrião.", None));
                }
                let removed = room.recent_members.remove(&tok).unwrap();
                room.skip_votes.remove(&removed.id);
                add_block_keys(
                    room,
                    &removed.id,
                    &removed.name,
                    &removed.token,
                    removed.client_id.as_deref(),
                    now,
                    true,
                );
            } else {
                return Err(LanErr::new(404, "Participante não encontrado.", None));
            }
            let out = Self::view(room, now, p, true);
            events.push_room_state(room, "state", now, false);
            return Ok((out, events));
        }

        if action == "unblockMember" {
            if !is_host {
                return Err(LanErr::new(
                    403,
                    "Somente o anfitrião pode desbloquear participantes.",
                    Some("FORBIDDEN"),
                ));
            }
            let block_key = safe_block_key(p)
                .ok_or_else(|| LanErr::new(400, "Identificador de bloqueio inválido.", None))?;
            self.check_replay(p, now)?;
            let room = self.rooms.get_mut(&code).unwrap();
            room.blocked_list.retain(|b| b.key != block_key);
            room.blocked_keys.remove(&block_key);
            room.kicked_keys.remove(&block_key);
            let out = Self::view(room, now, p, true);
            events.push_room_state(room, "state", now, true);
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
            let prev_id = room.playback["track"]["id"].as_str().map(str::to_string);
            let next_id = song["id"].as_str().map(str::to_string);
            if prev_id != next_id {
                room.skip_votes.clear();
                room.skip_triggered_at = 0;
            }
            room.playback = json!({
                "track": song,
                "playing": playing,
                "position": position,
                "updatedAt": now,
                "sequence": room.playback["sequence"].as_u64().unwrap_or(0) + 1
            });
            let out = Self::view(room, now, p, true);
            events.push_room_state(room, "playback", now, false);
            return Ok((out, events));
        }

        if action == "voteSkip" {
            if !is_host && !self.rooms[&code].permissions.allow_vote_skip {
                return Err(LanErr::new(
                    403,
                    "O anfitrião desativou a votação para pular músicas.",
                    Some("FORBIDDEN"),
                ));
            }
            self.check_replay(p, now)?;
            let room = self.rooms.get_mut(&code).unwrap();
            if room.skip_votes.contains(&member_id) {
                room.skip_votes.remove(&member_id);
            } else {
                room.skip_votes.insert(member_id);
            }
            let online_count = room.members.values().filter(|m| m.online).count().max(1);
            let threshold = ((online_count + 1) / 2).max(1);
            if room.skip_votes.len() >= threshold {
                room.skip_triggered_at = now;
                room.skip_votes.clear();
            }
            let out = Self::view(room, now, p, is_host);
            events.push_room_state(room, "state", now, false);
            return Ok((out, events));
        }

        if action == "queueAdd" {
            if !is_host && !self.rooms[&code].permissions.allow_queue_add {
                return Err(LanErr::new(
                    403,
                    "O anfitrião desativou a adição de músicas à fila pelos participantes.",
                    Some("FORBIDDEN"),
                ));
            }
            let t = track(&p["track"]).map_err(|e| LanErr::new(400, e, None))?;
            if !t.is_object() {
                return Err(LanErr::new(
                    400,
                    "Selecione uma música online válida para a fila.",
                    None,
                ));
            }
            self.check_replay(p, now)?;
            let room = self.rooms.get_mut(&code).unwrap();
            if room.jam_queue.len() >= 30 {
                return Err(LanErr::new(
                    400,
                    "A fila da JAM atingiu o limite de 30 músicas.",
                    None,
                ));
            }
            room.jam_queue.push(json!({
                "id": format!("jq_{}", &uuid::Uuid::new_v4().simple().to_string()[..12]),
                "track": t,
                "addedById": member_id,
                "addedByName": member_name,
                "addedAt": now
            }));
            let out = Self::view(room, now, p, is_host);
            events.push_room_state(room, "state", now, false);
            return Ok((out, events));
        }

        if action == "queueRemove" {
            let item_id = s(p, "queueItemId").trim().to_string();
            if item_id.is_empty() {
                return Err(LanErr::new(400, "Item da fila inválido.", None));
            }
            self.check_replay(p, now)?;
            let room = self.rooms.get_mut(&code).unwrap();
            if let Some(pos) = room
                .jam_queue
                .iter()
                .position(|it| it["id"].as_str() == Some(item_id.as_str()))
            {
                let added_by = room.jam_queue[pos]["addedById"].as_str().unwrap_or("");
                if !is_host && added_by != member_id {
                    return Err(LanErr::new(
                        403,
                        "Somente o anfitrião ou quem adicionou pode remover da fila.",
                        Some("FORBIDDEN"),
                    ));
                }
                room.jam_queue.remove(pos);
            }
            let out = Self::view(room, now, p, is_host);
            events.push_room_state(room, "state", now, false);
            return Ok((out, events));
        }

        if action == "recommendPlaylist" {
            if !is_host && !self.rooms[&code].permissions.allow_recommendations {
                return Err(LanErr::new(
                    403,
                    "O anfitrião desativou o envio de playlists pelos participantes.",
                    Some("FORBIDDEN"),
                ));
            }
            let clean_name: String = s(p, "playlistName")
                .chars()
                .filter(|c| !c.is_control())
                .collect::<String>()
                .trim()
                .chars()
                .take(60)
                .collect();
            if clean_name.is_empty() {
                return Err(LanErr::new(
                    400,
                    "Informe o nome da playlist recomendada.",
                    None,
                ));
            }
            let mut valid_tracks = Vec::new();
            if let Some(arr) = p["playlistTracks"].as_array() {
                for cand in arr.iter().take(20) {
                    if let Ok(t) = track(cand) {
                        if t.is_object() {
                            valid_tracks.push(t);
                        }
                    }
                }
            }
            if valid_tracks.is_empty() {
                return Err(LanErr::new(
                    400,
                    "A playlist recomendada precisa ter ao menos uma música online.",
                    None,
                ));
            }
            self.check_replay(p, now)?;
            let room = self.rooms.get_mut(&code).unwrap();
            room.recommendations.insert(
                0,
                json!({
                    "id": format!("jr_{}", &uuid::Uuid::new_v4().simple().to_string()[..12]),
                    "name": clean_name,
                    "trackCount": valid_tracks.len(),
                    "tracks": valid_tracks,
                    "recommendedById": member_id,
                    "recommendedByName": member_name,
                    "recommendedAt": now
                }),
            );
            room.recommendations.truncate(15);
            let out = Self::view(room, now, p, is_host);
            events.push_room_state(room, "state", now, false);
            return Ok((out, events));
        }

        if action == "chat" {
            if !is_host && !self.rooms[&code].permissions.allow_chat {
                return Err(LanErr::new(
                    403,
                    "O anfitrião desativou o bate-papo desta JAM.",
                    Some("FORBIDDEN"),
                ));
            }
            let clean_msg: String = s(p, "message")
                .chars()
                .filter(|c| !c.is_control())
                .collect::<String>()
                .trim()
                .chars()
                .take(300)
                .collect();
            if clean_msg.is_empty() {
                return Err(LanErr::new(
                    400,
                    "Digite uma mensagem para enviar no chat.",
                    None,
                ));
            }
            self.check_replay(p, now)?;
            let room = self.rooms.get_mut(&code).unwrap();
            let mut msg_obj = json!({
                "id": format!("jm_{}", &uuid::Uuid::new_v4().simple().to_string()[..12]),
                "memberId": member_id,
                "name": member_name,
                "text": clean_msg,
                "sentAt": now
            });
            if let Some(ref av) = member_avatar {
                msg_obj["avatar"] = json!(av);
            }
            room.messages.push(msg_obj);
            if room.messages.len() > 80 {
                let extra = room.messages.len() - 80;
                room.messages.drain(0..extra);
            }
            let out = Self::view(room, now, p, is_host);
            events.push_room_state(room, "state", now, false);
            return Ok((out, events));
        }

        if action != "poll" {
            return Err(LanErr::new(400, "Operação inválida.", None));
        }
        self.check_replay(p, now)?;
        let room = self.rooms.get(&code).unwrap();
        Ok((Self::view(room, now, p, is_host), events))
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
    for b in &events.broadcasts {
        let guest_msg = if b.host_only {
            None
        } else {
            Some(format!("event: {}\ndata: {}\n\n", b.event, b.guest_payload))
        };
        let host_msg = format!("event: {}\ndata: {}\n\n", b.event, b.host_payload);
        subs.retain(|sub| {
            if sub.room_id != b.room_id {
                return true;
            }
            if sub.host {
                !matches!(sub.tx.try_send(host_msg.clone()), Err(mpsc::TrySendError::Disconnected(_)))
            } else if let Some(ref gm) = guest_msg {
                !matches!(sub.tx.try_send(gm.clone()), Err(mpsc::TrySendError::Disconnected(_)))
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
                    let initial_view = Coordinator::view(room, now, &Value::Null, is_host);
                    let guest_view = Coordinator::view(room, now, &Value::Null, false);
                    let host_view = if is_host {
                        initial_view.clone()
                    } else {
                        Coordinator::view(room, now, &Value::Null, true)
                    };
                    Some((
                        room.room_id.clone(),
                        is_host,
                        initial_view,
                        guest_view,
                        host_view,
                    ))
                } else {
                    None
                }
            } else {
                None
            }
        };
        let Some((room_id, is_host, initial_view, guest_view, host_view)) = auth_check else {
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
                host: is_host,
                tx,
            });
        }

        // Notify peers of online presence
        dispatch_sse_events(
            subscribers,
            DispatchEvents {
                broadcasts: vec![SseBroadcast {
                    room_id: room_id.clone(),
                    event: "state",
                    guest_payload: guest_view,
                    host_payload: host_view,
                    host_only: false,
                }],
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
                    let mut offline_events = DispatchEvents::none();
                    if let Ok(mut c) = coord_ref.lock() {
                        if let Some(room) = c.rooms.values_mut().find(|r| r.room_id == room_id) {
                            if let Some(mbr) = room.members.get_mut(&tok) {
                                mbr.online = false;
                                mbr.seen = now_off;
                                offline_events.push_room_state(room, "state", now_off, false);
                            }
                        }
                    }
                    dispatch_sse_events(&subs_ref, offline_events);
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

    #[test]
    fn lan_approval_entry_block_permissions_and_rate_limit_work() {
        let mut server = Coordinator::new();
        let host = server
            .handle(
                &json!({
                    "action": "create",
                    "name": "Host",
                    "roomName": "LAN Segura",
                    "requireApproval": true,
                    "clientId": "host_lan_01"
                }),
                "127.0.0.1",
                1000,
            )
            .unwrap();
        let code = host["code"].as_str().unwrap().to_string();
        assert_eq!(host["requireApproval"], true);

        // Direct join without approval must fail with APPROVAL_REQUIRED
        let direct_err = server
            .handle_with_events(
                &json!({"action":"join","code":code,"name":"Intruso","clientId":"guest_lan_01"}),
                "127.0.0.2",
                1005,
            )
            .unwrap_err();
        assert_eq!(direct_err.status, 403);
        assert_eq!(direct_err.error_code, Some("APPROVAL_REQUIRED"));

        // Request join creates pending request
        let req_res = server
            .handle(
                &json!({"action":"requestJoin","code":code,"name":"Bia","clientId":"guest_lan_01"}),
                "127.0.0.2",
                1010,
            )
            .unwrap();
        assert_eq!(req_res["status"], "pending");
        let req_id = req_res["requestId"].as_str().unwrap().to_string();
        let req_tok = req_res["requestToken"].as_str().unwrap().to_string();

        // Duplicate request from same clientId blocked with 409 REQUEST_DUPLICATE
        let dup_err = server
            .handle_with_events(
                &json!({"action":"requestJoin","code":code,"name":"Bia","clientId":"guest_lan_01"}),
                "127.0.0.2",
                1011,
            )
            .unwrap_err();
        assert_eq!(dup_err.status, 409);
        assert_eq!(dup_err.error_code, Some("REQUEST_DUPLICATE"));

        // Host sees joinRequests
        let host_poll = server
            .handle(
                &json!({"action":"poll","code":code,"token":host["token"]}),
                "127.0.0.1",
                1012,
            )
            .unwrap();
        assert_eq!(host_poll["joinRequests"].as_array().unwrap().len(), 1);

        // Host approves -> requester claims single-use session
        server
            .handle(
                &json!({"action":"approveJoin","code":code,"token":host["token"],"requestId":req_id}),
                "127.0.0.1",
                1015,
            )
            .unwrap();
        let claimed = server
            .handle(
                &json!({"action":"checkJoinRequest","code":code,"requestId":req_id,"requestToken":req_tok}),
                "127.0.0.2",
                1016,
            )
            .unwrap();
        assert_eq!(claimed["status"], "approved");
        let guest_tok = claimed["session"]["token"].as_str().unwrap().to_string();
        let guest_id = claimed["session"]["memberId"].as_str().unwrap().to_string();
        assert!(claimed["session"].get("joinRequests").is_none());
        assert!(claimed["session"].get("blockedList").is_none());

        // Second check returns expired (single claim consumed)
        let second_claim = server
            .handle(
                &json!({"action":"checkJoinRequest","code":code,"requestId":req_id,"requestToken":req_tok}),
                "127.0.0.2",
                1017,
            )
            .unwrap();
        assert_eq!(second_claim["status"], "expired");

        // Disable chat permission and test server enforcement
        server
            .handle(
                &json!({"action":"updateRoom","code":code,"token":host["token"],"permissions":{"allowChat":false}}),
                "127.0.0.1",
                1020,
            )
            .unwrap();
        let chat_err = server
            .handle_with_events(
                &json!({"action":"chat","code":code,"token":guest_tok,"message":"Oi"}),
                "127.0.0.2",
                1021,
            )
            .unwrap_err();
        assert_eq!(chat_err.status, 403);
        assert_eq!(chat_err.error_code, Some("FORBIDDEN"));

        // Block member revokes token & blocks future requests
        let blocked_view = server
            .handle(
                &json!({"action":"blockMember","code":code,"token":host["token"],"memberId":guest_id}),
                "127.0.0.1",
                1025,
            )
            .unwrap();
        let block_key = blocked_view["blockedList"][0]["key"].as_str().unwrap().to_string();
        let poll_after_block = server
            .handle_with_events(
                &json!({"action":"poll","code":code,"token":guest_tok}),
                "127.0.0.2",
                1026,
            )
            .unwrap_err();
        assert_eq!(poll_after_block.status, 403);

        let blocked_req = server
            .handle_with_events(
                &json!({"action":"requestJoin","code":code,"name":"Bia","clientId":"guest_lan_01"}),
                "127.0.0.2",
                1027,
            )
            .unwrap_err();
        assert_eq!(blocked_req.status, 403);
        assert_eq!(blocked_req.error_code, Some("BLOCKED"));

        // Unblock restores ability to request
        server
            .handle(
                &json!({"action":"unblockMember","code":code,"token":host["token"],"blockKey":block_key}),
                "127.0.0.1",
                1030,
            )
            .unwrap();
        let unblocked_req = server
            .handle(
                &json!({"action":"requestJoin","code":code,"name":"Bia","clientId":"guest_lan_01"}),
                "127.0.0.2",
                1031,
            )
            .unwrap();
        assert_eq!(unblocked_req["status"], "pending");

        // Spam rate limit (>6 requestJoin/min from same IP)
        for i in 0..6 {
            let cid = format!("spam_client_{i}");
            let _ = server
                .handle(
                    &json!({"action":"requestJoin","code":code,"name":"Spam","clientId":cid}),
                    "127.0.0.99",
                    2000 + i,
                )
                .unwrap();
        }
        let rate_err = server
            .handle_with_events(
                &json!({"action":"requestJoin","code":code,"name":"Spam7","clientId":"spam_client_7"}),
                "127.0.0.99",
                2010,
            )
            .unwrap_err();
        assert_eq!(rate_err.status, 429);
        assert_eq!(rate_err.error_code, Some("RATE_LIMITED"));
    }
}
