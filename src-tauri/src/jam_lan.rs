use crate::db::{self, s, Result};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    io::{BufRead, BufReader, Read, Write},
    net::{IpAddr, Ipv4Addr, SocketAddrV4, TcpListener, TcpStream, UdpSocket},
    sync::{Arc, Mutex, OnceLock},
    time::Duration,
};

const LAN_DISCOVERY_PORT: u16 = 43879;
const LAN_MAGIC: &[u8] = b"LIQUID_HUB_JAM_DISCOVER_V2";

struct Member {
    id: String,
    token: String,
    name: String,
    host: bool,
    seen: i64,
}
struct Room {
    code: String,
    members: HashMap<String, Member>,
    playback: Value,
    touched: i64,
}
struct Coordinator {
    rooms: HashMap<String, Room>,
    rates: HashMap<String, (i64, usize)>,
    nonces: HashMap<String, i64>,
}

fn token() -> String {
    let mut bytes = Vec::from(uuid::Uuid::new_v4().as_bytes().as_slice());
    bytes.extend_from_slice(&uuid::Uuid::new_v4().as_bytes()[..8]);
    URL_SAFE_NO_PAD.encode(bytes)
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

impl Coordinator {
    fn new() -> Self {
        Self {
            rooms: HashMap::new(),
            rates: HashMap::new(),
            nonces: HashMap::new(),
        }
    }

    fn view(room: &Room, now: i64, p: &Value) -> Value {
        let members: Vec<Value> = room
            .members
            .values()
            .map(|m| json!({"id": m.id, "name": m.name, "host": m.host}))
            .collect();
        let unchanged = s(p, "action") == "poll"
            && p["sinceSequence"]
                .as_u64()
                .is_some_and(|seq| seq == room.playback["sequence"].as_u64().unwrap_or(0));
        let mut val = json!({
            "code": room.code,
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

    fn check_replay(&mut self, p: &Value, now: i64) -> std::result::Result<(), (u16, String)> {
        let has_nonce = p.get("nonce").is_some();
        let has_ts = p.get("timestamp").is_some();
        if !has_nonce && !has_ts {
            return Ok(());
        }
        if !has_nonce || !has_ts {
            return Err((400, "Nonce e timestamp devem ser enviados juntos.".into()));
        }
        let nonce = p["nonce"]
            .as_str()
            .filter(|n| {
                (16..=128).contains(&n.len())
                    && n.bytes()
                        .all(|b| b.is_ascii_alphanumeric() || b"_-".contains(&b))
            })
            .ok_or((400, "Nonce inválido.".to_string()))?;
        let ts = p["timestamp"]
            .as_i64()
            .ok_or((400, "Timestamp inválido.".to_string()))?;
        if (now - ts).abs() > 60_000 {
            return Err((401, "Solicitação expirada (timestamp fora da janela).".into()));
        }
        if self.nonces.contains_key(nonce) {
            return Err((409, "Replay detectado: nonce já utilizado.".into()));
        }
        if self.nonces.len() >= 8192 {
            self.nonces.clear();
        }
        self.nonces.insert(nonce.to_string(), now + 120_000);
        Ok(())
    }

    fn summaries(&self, endpoint: &str) -> Vec<Value> {
        self.rooms
            .values()
            .map(|r| {
                let host_name = r
                    .members
                    .values()
                    .find(|m| m.host)
                    .map(|m| m.name.as_str())
                    .unwrap_or("Anfitrião");
                json!({
                    "code": r.code,
                    "endpoint": endpoint,
                    "hostName": host_name,
                    "members": r.members.len(),
                    "updatedAt": r.touched
                })
            })
            .collect()
    }

    fn handle(&mut self, p: &Value, ip: &str, now: i64) -> std::result::Result<Value, (u16, String)> {
        self.rooms.retain(|_, r| now - r.touched <= 900000);
        self.rates.retain(|_, v| v.0 > now);
        self.nonces.retain(|_, until| *until > now);
        for room in self.rooms.values_mut() {
            room.members.retain(|_, m| m.host || now - m.seen <= 35000);
        }
        let action = s(p, "action");
        let entry = ["create", "join"].contains(&action);
        let key = format!("{ip}:{entry}");
        if self.rates.len() >= 1024 && !self.rates.contains_key(&key) {
            return Err((503, "Serviço ocupado.".into()));
        }
        let rate = self.rates.entry(key).or_insert((now + 60000, 0));
        rate.1 += 1;
        if rate.1 > if entry { 30 } else { 1800 } {
            return Err((429, "Muitas tentativas. Aguarde um minuto.".into()));
        }

        if action == "ping" {
            self.check_replay(p, now)?;
            let mut out = json!({ "pong": true, "serverTime": now });
            if let Some(ct) = p["clientTime"].as_f64().filter(|n| n.is_finite()) {
                out["echoClientTime"] = json!(ct);
            }
            return Ok(out);
        }

        if action == "create" {
            if self.rooms.len() >= 16 {
                return Err((503, "As salas estão ocupadas.".into()));
            }
            self.check_replay(p, now)?;
            let preferred = s(p, "preferredCode");
            let mut code = if preferred.len() == 10
                && preferred.bytes().all(|b| b.is_ascii_hexdigit())
                && !self.rooms.contains_key(preferred)
            {
                preferred.to_uppercase()
            } else {
                uuid::Uuid::new_v4().simple().to_string()[..10].to_uppercase()
            };
            while self.rooms.contains_key(&code) {
                code = uuid::Uuid::new_v4().simple().to_string()[..10].to_uppercase();
            }
            let member = Member {
                id: uuid::Uuid::new_v4().simple().to_string(),
                token: token(),
                name: name(p),
                host: true,
                seen: now,
            };
            let auth = member.token.clone();
            let mid = member.id.clone();
            let room = Room {
                code: code.clone(),
                members: HashMap::from([(auth.clone(), member)]),
                playback: json!({"track":null,"playing":false,"position":0,"updatedAt":now,"sequence":0}),
                touched: now,
            };
            let mut value = Self::view(&room, now, p);
            value["token"] = json!(auth);
            value["memberId"] = json!(mid);
            value["host"] = json!(true);
            self.rooms.insert(code, room);
            return Ok(value);
        }

        let code = s(p, "code");
        if code.len() != 10 || !code.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Err((400, "Código da JAM inválido.".into()));
        }
        if !self.rooms.contains_key(code) {
            return Err((410, "Esta JAM foi encerrada ou expirou.".into()));
        }
        if action == "join" {
            if self.rooms[code].members.len() >= 8 {
                return Err((409, "Esta JAM já tem 8 pessoas.".into()));
            }
            self.check_replay(p, now)?;
            let room = self.rooms.get_mut(code).unwrap();
            let member = Member {
                id: uuid::Uuid::new_v4().simple().to_string(),
                token: token(),
                name: name(p),
                host: false,
                seen: now,
            };
            let auth = member.token.clone();
            let mid = member.id.clone();
            room.members.insert(auth.clone(), member);
            let mut value = Self::view(room, now, p);
            value["token"] = json!(auth);
            value["memberId"] = json!(mid);
            value["host"] = json!(false);
            return Ok(value);
        }

        let auth = s(p, "token");
        let is_host = {
            let room = self.rooms.get_mut(code).unwrap();
            let member = room
                .members
                .get_mut(auth)
                .ok_or((401, "Sua sessão expirou. Entre novamente.".to_string()))?;
            member.seen = now;
            if member.host {
                room.touched = now;
            }
            member.host
        };

        if action == "leave" {
            self.check_replay(p, now)?;
            if is_host {
                self.rooms.remove(code);
            } else if let Some(room) = self.rooms.get_mut(code) {
                room.members.remove(auth);
            }
            return Ok(json!({"closed": is_host, "serverTime": now}));
        }
        if action == "sync" {
            if !is_host {
                return Err((403, "Somente quem criou a JAM controla a reprodução.".into()));
            }
            let play = &p["playback"];
            let pos = play["position"]
                .as_f64()
                .ok_or((400, "Reprodução inválida.".to_string()))?;
            if !play["playing"].is_boolean() || !pos.is_finite() || !(0.0..=86400.0).contains(&pos) {
                return Err((400, "Reprodução inválida.".into()));
            }
            let song = track(&play["track"]).map_err(|e| (400, e))?;
            self.check_replay(p, now)?;
            let position = pos.min(song["duration"].as_f64().filter(|d| *d > 0.0).unwrap_or(86400.0));
            let playing = !song.is_null() && play["playing"] == true;
            let room = self.rooms.get_mut(code).unwrap();
            room.playback = json!({
                "track": song,
                "playing": playing,
                "position": position,
                "updatedAt": now,
                "sequence": room.playback["sequence"].as_u64().unwrap_or(0) + 1
            });
            return Ok(Self::view(room, now, p));
        }
        if action != "poll" {
            return Err((400, "Operação inválida.".into()));
        }
        self.check_replay(p, now)?;
        let room = self.rooms.get(code).unwrap();
        Ok(Self::view(room, now, p))
    }
}

fn respond(mut stream: TcpStream, coordinator: &Mutex<Coordinator>) {
    let _ = stream.set_read_timeout(Some(Duration::from_secs(3)));
    let _ = stream.set_write_timeout(Some(Duration::from_secs(3)));
    let ip = stream
        .peer_addr()
        .map(|a| a.ip().to_string())
        .unwrap_or_default();
    let result = (|| -> std::result::Result<Value, (u16, String)> {
        let mut reader = BufReader::new(&mut stream);
        let mut header = Vec::new();
        let mut content_length = None;
        let mut content_type = false;
        let mut first = String::new();
        loop {
            let before = header.len();
            reader
                .by_ref()
                .take((8193 - before) as u64)
                .read_until(b'\n', &mut header)
                .map_err(|_| (400, "Solicitação incompleta.".into()))?;
            if header.len() > 8192 || header.len() == before {
                return Err((413, "Cabeçalhos inválidos.".into()));
            }
            let line = std::str::from_utf8(&header[before..])
                .map_err(|_| (400, "Cabeçalhos inválidos.".into()))?
                .trim();
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
                            return Err((400, "Tamanho duplicado.".into()));
                        }
                        content_length = Some(
                            value
                                .trim()
                                .parse::<usize>()
                                .map_err(|_| (400, "Tamanho inválido.".to_string()))?,
                        );
                    }
                    "content-type" => content_type = value.trim().starts_with("application/json"),
                    "transfer-encoding" => return Err((400, "Codificação não permitida.".into())),
                    _ => {}
                }
            }
        }
        let request: Vec<&str> = first.split_whitespace().collect();
        if request.len() != 3 {
            return Err((400, "Solicitação inválida.".into()));
        }
        if request[0] == "GET" && request[1] == "/health" {
            return Ok(json!({"service": "liquid-hub-jam", "version": 2}));
        }
        if request[1] != "/v1/jam" {
            return Err((404, "Não encontrado.".into()));
        }
        if request[0] != "POST" {
            return Err((405, "Método não permitido.".into()));
        }
        if !content_type {
            return Err((415, "Envie JSON.".into()));
        }
        let length = content_length.ok_or((411, "Tamanho obrigatório.".to_string()))?;
        if length > 16384 {
            return Err((413, "Solicitação muito grande.".into()));
        }
        let mut bytes = vec![0u8; length];
        reader
            .read_exact(&mut bytes)
            .map_err(|_| (400, "Solicitação incompleta.".into()))?;
        let p: Value =
            serde_json::from_slice(&bytes).map_err(|_| (400, "Solicitação inválida.".into()))?;
        if !p.is_object() {
            return Err((400, "Solicitação inválida.".into()));
        }
        coordinator
            .lock()
            .map_err(|_| (503, "Serviço ocupado.".to_string()))?
            .handle(&p, &ip, db::now())
    })();
    let (status, value) = match result {
        Ok(v) => (200, v),
        Err((status, error)) => (status, json!({ "error": error })),
    };
    let data = value.to_string();
    let headers = format!(
        "HTTP/1.1 {status} Result\r\nContent-Type: application/json; charset=utf-8\r\nCache-Control: no-store\r\nX-Service: liquid-hub-jam\r\nX-Content-Type-Options: nosniff\r\nConnection: close\r\nContent-Length: {}\r\n\r\n",
        data.len()
    );
    let _ = stream.write_all(headers.as_bytes());
    let _ = stream.write_all(data.as_bytes());
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
                    let payload = json!({ "rooms": guard.summaries(&endpoint) }).to_string();
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
    spawn_lan_beacon(endpoint.clone(), coordinator.clone());
    for worker in 0..4 {
        let listener = listener.clone();
        let coordinator = coordinator.clone();
        std::thread::Builder::new()
            .name(format!("liquid-jam-lan-{worker}"))
            .spawn(move || {
                while let Ok((stream, _)) = listener.accept() {
                    respond(stream, &coordinator);
                }
            })
            .map_err(|_| "Não foi possível iniciar o serviço de JAM.")?;
    }
    Ok((endpoint, coordinator))
}

static LOCAL_INSTANCE: OnceLock<Mutex<Option<(String, Arc<Mutex<Coordinator>>)>>> = OnceLock::new();

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
    let mut seen = std::collections::HashSet::new();

    if let Some(mtx) = LOCAL_INSTANCE.get() {
        if let Ok(guard) = mtx.lock() {
            if let Some((endpoint, coord)) = &*guard {
                if let Ok(c) = coord.lock() {
                    for r in c.summaries(endpoint) {
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
                        if code.len() == 10
                            && code.bytes().all(|b| b.is_ascii_hexdigit())
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
}
