use crate::{
    db::{self, s, Library, Result},
    secrets,
};
use serde_json::{json, Value};
use std::{
    collections::HashSet,
    sync::{Mutex, OnceLock},
    time::Duration,
};
use tauri::{AppHandle, Emitter};
use tokio_util::sync::CancellationToken;

#[path = "jam_lan.rs"]
mod lan;

pub struct JamRealtime {
    cancel: Mutex<Option<CancellationToken>>,
}

impl JamRealtime {
    pub fn new() -> Self {
        Self {
            cancel: Mutex::new(None),
        }
    }

    pub fn replace(&self) -> CancellationToken {
        let next = CancellationToken::new();
        if let Ok(mut guard) = self.cancel.lock() {
            if let Some(prev) = guard.replace(next.clone()) {
                prev.cancel();
            }
        }
        next
    }

    pub fn stop(&self) {
        if let Ok(mut guard) = self.cancel.lock() {
            if let Some(prev) = guard.take() {
                prev.cancel();
            }
        }
    }
}

pub fn validate_endpoint(raw: &str) -> Result<String> {
    if raw.is_empty() {
        return Ok(String::new());
    }
    let u = url::Url::parse(raw).map_err(|_| "Endereço da JAM inválido.")?;
    let local = match u.host() {
        Some(url::Host::Domain("localhost")) => true,
        Some(url::Host::Ipv4(v)) => v.is_loopback() || v.is_private(),
        Some(url::Host::Ipv6(v)) => v.is_loopback() || v.is_unique_local(),
        _ => false,
    };
    if raw.len() > 2048
        || u.host_str().is_none()
        || !u.username().is_empty()
        || u.password().is_some()
        || u.query().is_some()
        || u.fragment().is_some()
        || u.path() != "/"
        || !(u.scheme() == "https" || (u.scheme() == "http" && local))
    {
        return Err("Use HTTPS para a JAM. HTTP é aceito somente em uma rede local.".into());
    }
    Ok(raw.trim_end_matches('/').to_string())
}

fn client() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .timeout(Duration::from_secs(7))
            .connect_timeout(Duration::from_secs(4))
            .redirect(reqwest::redirect::Policy::none())
            .user_agent("LiquidHub-JAM/3")
            .build()
            .expect("jam http")
    })
}

fn sse_client() -> &'static reqwest::Client {
    static SSE_CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    SSE_CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(5))
            .read_timeout(Duration::from_secs(45))
            .redirect(reqwest::redirect::Policy::none())
            .user_agent("LiquidHub-JAM-SSE/3")
            .build()
            .expect("jam sse")
    })
}

fn bearer_for_endpoint(secrets_mtx: &Mutex<secrets::Secrets>, endpoint: &str) -> Option<String> {
    if endpoint.is_empty() || validate_endpoint(endpoint).is_err() {
        return None;
    }
    let guard = secrets_mtx.lock().ok()?;
    let session = guard.hub_session.as_ref()?;
    if !session.access_token.is_empty() && session.expires_at > db::now() {
        Some(session.access_token.clone())
    } else {
        None
    }
}

fn endpoint_mode(endpoint: &str) -> &'static str {
    if endpoint.starts_with("http://") {
        "lan"
    } else {
        "cloud"
    }
}

fn recent_lan_store() -> &'static Mutex<Vec<String>> {
    static RECENT: OnceLock<Mutex<Vec<String>>> = OnceLock::new();
    RECENT.get_or_init(|| Mutex::new(Vec::new()))
}

fn remember_lan_endpoint(ep: &str) {
    if !ep.starts_with("http://") {
        return;
    }
    if let Ok(mut list) = recent_lan_store().lock() {
        list.retain(|x| x != ep);
        list.insert(0, ep.to_string());
        list.truncate(4);
    }
}

fn recent_lan_endpoints() -> Vec<String> {
    recent_lan_store()
        .lock()
        .map(|l| l.clone())
        .unwrap_or_default()
}

fn candidate_endpoints(
    explicit: &str,
    configured: &str,
    code: &str,
) -> Result<Vec<(String, &'static str)>> {
    let mut out = Vec::new();
    let mut seen = HashSet::new();
    let mut push_ep = |raw: &str, mode_override: Option<&'static str>| -> Result<()> {
        if raw.is_empty() {
            return Ok(());
        }
        let valid = validate_endpoint(raw)?;
        if !valid.is_empty() && seen.insert(valid.clone()) {
            out.push((valid.clone(), mode_override.unwrap_or_else(|| endpoint_mode(&valid))));
        }
        Ok(())
    };

    push_ep(explicit, None)?;
    push_ep(configured, Some("cloud"))?;
    if explicit.is_empty() {
        if let Some(local_ep) = lan::current_endpoint() {
            let _ = push_ep(&local_ep, Some("lan"));
        }
        let discovered = lan::discover_rooms();
        for r in &discovered {
            if crate::deeplink::normalize_code(s(r, "code")).as_deref() == Some(code) {
                let _ = push_ep(s(r, "endpoint"), Some("lan"));
            }
        }
        for r in &discovered {
            let _ = push_ep(s(r, "endpoint"), Some("lan"));
        }
        for ep in recent_lan_endpoints() {
            let _ = push_ep(&ep, Some("lan"));
        }
    }
    Ok(out)
}

async fn post_jam(
    base: &str,
    payload: &Value,
    bearer: Option<&str>,
) -> std::result::Result<(u16, Value), String> {
    let mut req = client()
        .post(format!("{base}/v1/jam"))
        .header("Accept-Encoding", "identity")
        .json(payload);
    if let Some(tok) = bearer {
        req = req.bearer_auth(tok);
    }
    let mut response = req.send().await.map_err(|_| {
        "Não foi possível conectar à JAM. Verifique sua conexão e permita a rede privada no Firewall do Windows."
            .to_string()
    })?;
    let status = response.status().as_u16();
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| "A conexão com a JAM foi interrompida.".to_string())?
    {
        if bytes.len() + chunk.len() > 96000 {
            return Err("Resposta da JAM maior que o permitido.".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    let value: Value =
        serde_json::from_slice(&bytes).map_err(|_| "Resposta inválida do servidor de JAM.".to_string())?;
    Ok((status, value))
}

fn valid_room_code(code: &str) -> bool {
    (6..=16).contains(&code.len()) && code.bytes().all(|b| b.is_ascii_alphanumeric())
}

fn validate_room_payload(value: &Value) -> Result<()> {
    let code = s(value, "code");
    if !valid_room_code(code)
        || !value["serverTime"].is_number()
        || value["members"].as_array().is_none_or(|v| v.len() > 8)
        || !value["playback"]["playing"].is_boolean()
        || !value["playback"]["position"].is_number()
        || !value["playback"]["updatedAt"].is_number()
    {
        return Err("Estado inválido da JAM.".into());
    }
    if !value["playback"]["track"].is_null() {
        db::validate_track(&value["playback"]["track"])?;
        if s(&value["playback"]["track"], "source") == "local" {
            return Err("A JAM recebeu um arquivo local inválido.".into());
        }
    }
    Ok(())
}

fn default_endpoint() -> String {
    if std::env::var_os("GLASS_TEST_DATA").is_some() {
        return std::env::var("GLASS_TEST_JAM_URL").unwrap_or_default();
    }
    if let Some(env_url) = option_env!("LIQUID_JAM_URL").or(option_env!("GLASS_JAM_URL")) {
        if !env_url.trim().is_empty() {
            return env_url.trim().to_string();
        }
    }
    serde_json::from_str::<Value>(include_str!("../jam.json"))
        .ok()
        .map(|v| s(&v, "jamUrl").trim().to_string())
        .unwrap_or_default()
}

pub async fn call(
    app: &AppHandle,
    db_mtx: &Mutex<Library>,
    secrets_mtx: &Mutex<secrets::Secrets>,
    realtime: &JamRealtime,
    p: &Value,
    endpoint: &str,
    consent: bool,
) -> Result<Value> {
    let default_url = default_endpoint();
    let configured_base = if endpoint.is_empty() {
        default_url.as_str()
    } else {
        endpoint
    };
    let explicit_ep = s(p, "endpoint");
    let selected = if !explicit_ep.is_empty() {
        explicit_ep
    } else {
        configured_base
    };
    let mut base = validate_endpoint(selected)?;
    let action_raw = s(p, "action");

    if action_raw == "status" {
        let client_id = db_mtx
            .lock()
            .map(|d| d.jam_client_id())
            .unwrap_or_else(|_| "lh_fallback".into());
        let (hub_auth, hub_subject, hub_display_name, hub_avatar) = secrets_mtx
            .lock()
            .map(|sec| {
                let pub_st = sec.public_hub_status(db::now());
                let subj = pub_st["subject"].as_str().unwrap_or("").to_string();
                let dname = pub_st["displayName"]
                    .as_str()
                    .filter(|s| !s.is_empty())
                    .map(String::from)
                    .unwrap_or_else(|| subj.clone());
                let av = pub_st["avatarUrl"]
                    .as_str()
                    .map(String::from);
                (pub_st["authenticated"] == true, subj, dname, av)
            })
            .unwrap_or((false, String::new(), String::new(), None));
        return Ok(json!({
            "endpoint": validate_endpoint(configured_base).unwrap_or_default(),
            "configured": !configured_base.is_empty(),
            "clientId": client_id,
            "hubAuthenticated": hub_auth,
            "hubSubject": hub_subject,
            "hubDisplayName": hub_display_name,
            "hubAvatar": hub_avatar,
            "protocolRegistered": crate::deeplink::is_protocol_registered()
        }));
    }

    if action_raw == "unsubscribe" {
        realtime.stop();
        return Ok(json!({ "ok": true }));
    }

    if !consent {
        return Err("Permita o acesso online antes de entrar em uma JAM.".into());
    }

    if action_raw == "discoverLan" {
        let rooms = lan::discover_rooms();
        for r in &rooms {
            let ep = s(r, "endpoint");
            if !ep.is_empty() && validate_endpoint(ep).is_ok() {
                remember_lan_endpoint(ep);
            }
        }
        return Ok(json!({ "rooms": rooms, "serverTime": db::now() }));
    }

    if action_raw == "lookup" {
        let Some(code) = crate::deeplink::normalize_code(s(p, "code")) else {
            return Ok(json!({
                "found": false,
                "errorCode": "INVITE_INVALID",
                "error": "Código de convite inválido. Use de 6 a 16 letras ou números."
            }));
        };
        let candidates = candidate_endpoints(explicit_ep, configured_base, &code)?;
        if candidates.is_empty() {
            return Ok(json!({
                "found": false,
                "errorCode": "INVITE_NOT_FOUND",
                "error": "Nenhuma JAM encontrada. Na rede local, aguarde o anfitrião criar a sala ou cole o link completo do convite."
            }));
        }

        let mut best_err: Option<(u16, String, Value)> = None;
        let mut reachable = false;
        let lookup_body = json!({ "action": "lookup", "code": code });

        for (ep, mode) in &candidates {
            let bearer = bearer_for_endpoint(secrets_mtx, ep);
            match post_jam(ep, &lookup_body, bearer.as_deref()).await {
                Ok((200, mut val)) => {
                    remember_lan_endpoint(ep);
                    val["endpoint"] = json!(ep);
                    val["mode"] = json!(mode);
                    return Ok(json!({ "found": true, "preview": val }));
                }
                Ok((status, val)) => {
                    reachable = true;
                    let code_str = s(&val, "errorCode").to_string();
                    let msg = s(&val, "error");
                    let priority = if status == 410 { 3 } else if status == 401 || status == 403 { 2 } else { 1 };
                    let prev_priority = best_err.as_ref().map(|(s, _, _)| if *s == 410 { 3 } else if *s == 401 || *s == 403 { 2 } else { 1 }).unwrap_or(0);
                    if priority > prev_priority {
                        let mut preview = val.get("preview").cloned().unwrap_or(Value::Null);
                        if preview.is_object() {
                            preview["endpoint"] = json!(ep);
                            preview["mode"] = json!(mode);
                        }
                        best_err = Some((
                            status,
                            if code_str.is_empty() {
                                if status == 410 { "ROOM_ENDED".into() } else { "INVITE_NOT_FOUND".into() }
                            } else {
                                code_str
                            },
                            json!({
                                "found": false,
                                "error": if msg.is_empty() { "Convite da JAM indisponível." } else { msg },
                                "preview": preview
                            }),
                        ));
                    }
                }
                Err(_) => {}
            }
        }

        if let Some((_, err_code, mut obj)) = best_err {
            obj["errorCode"] = json!(err_code);
            return Ok(obj);
        }
        return Ok(json!({
            "found": false,
            "errorCode": if reachable { "INVITE_NOT_FOUND" } else { "UNAVAILABLE" },
            "error": if reachable {
                "Nenhuma JAM encontrada com este código."
            } else {
                "Não foi possível conectar ao servidor da JAM para verificar este código."
            }
        }));
    }

    if action_raw == "subscribe" {
        let Some(code) = crate::deeplink::normalize_code(s(p, "code")) else {
            return Err("Código da JAM inválido.".into());
        };
        let token = s(p, "token").to_string();
        if token.len() < 32 || token.len() > 64 {
            return Err("Sessão da JAM inválida.".into());
        }
        if base.is_empty() {
            return Err("Endpoint da JAM ausente.".into());
        }
        let cancel = realtime.replace();
        let app_handle = app.clone();
        let sse_url = format!("{base}/v1/jam/events?code={code}");

        tokio::spawn(async move {
            let req = sse_client()
                .get(&sse_url)
                .header("Accept", "text/event-stream")
                .bearer_auth(&token);

            let res = tokio::select! {
                _ = cancel.cancelled() => return,
                r = req.send() => r,
            };

            let mut response = match res {
                Ok(r) if r.status().is_success() => r,
                Ok(r) => {
                    let status = r.status().as_u16();
                    let _ = app_handle.emit_to(
                        "main",
                        "jam-event",
                        json!({
                            "event": "stream_closed",
                            "errorCode": if status == 401 { "SESSION_EXPIRED" } else { "UNAVAILABLE" },
                            "reason": format!("Stream SSE recusado ({status}).")
                        }),
                    );
                    return;
                }
                Err(_) => {
                    let _ = app_handle.emit_to(
                        "main",
                        "jam-event",
                        json!({
                            "event": "stream_closed",
                            "errorCode": "UNAVAILABLE",
                            "reason": "Falha ao abrir canal em tempo real."
                        }),
                    );
                    return;
                }
            };

            let _ = app_handle.emit_to("main", "jam-event", json!({ "event": "stream_open" }));

            let mut buf = String::new();
            let mut event_name = String::from("message");
            let mut data_lines: Vec<String> = Vec::new();

            loop {
                let chunk = tokio::select! {
                    _ = cancel.cancelled() => return,
                    c = response.chunk() => c,
                };
                match chunk {
                    Ok(Some(bytes)) => {
                        if buf.len() + bytes.len() > 32_768 {
                            break;
                        }
                        buf.push_str(&String::from_utf8_lossy(&bytes));
                        while let Some(pos) = buf.find('\n') {
                            let line = buf[..pos].trim_end_matches('\r').to_string();
                            buf.drain(..=pos);
                            if line.is_empty() {
                                if !data_lines.is_empty() {
                                    let joined = data_lines.join("\n");
                                    data_lines.clear();
                                    let ev = std::mem::replace(&mut event_name, String::from("message"));
                                    if let Ok(parsed) = serde_json::from_str::<Value>(&joined) {
                                        match ev.as_str() {
                                            "state" | "playback" => {
                                                let _ = app_handle.emit_to(
                                                    "main",
                                                    "jam-event",
                                                    json!({ "event": ev, "room": parsed }),
                                                );
                                            }
                                            "closed" | "kicked" => {
                                                let _ = app_handle.emit_to(
                                                    "main",
                                                    "jam-event",
                                                    json!({
                                                        "event": ev,
                                                        "reason": parsed["reason"],
                                                        "errorCode": parsed["errorCode"],
                                                        "serverTime": parsed["serverTime"]
                                                    }),
                                                );
                                                return;
                                            }
                                            _ => {}
                                        }
                                    }
                                } else {
                                    event_name = String::from("message");
                                }
                            } else if let Some(rest) = line.strip_prefix("event:") {
                                event_name = rest.trim().to_string();
                            } else if let Some(rest) = line.strip_prefix("data:") {
                                data_lines.push(rest.trim_start().to_string());
                            }
                        }
                    }
                    Ok(None) | Err(_) => break,
                }
            }

            if !cancel.is_cancelled() {
                let _ = app_handle.emit_to(
                    "main",
                    "jam-event",
                    json!({ "event": "stream_closed" }),
                );
            }
        });

        return Ok(json!({ "ok": true }));
    }

    let mut payload = p.clone();
    if let Some(obj) = payload.as_object_mut() {
        obj.remove("endpoint");
    }
    if action_raw == "createLocal" {
        base = lan::start()?;
        payload["action"] = json!("create");
    }

    if ["join", "resume"].contains(&action_raw) {
        if let Some(norm) = crate::deeplink::normalize_code(s(&payload, "code")) {
            payload["code"] = json!(norm);
        }
        if explicit_ep.is_empty() {
            let code_norm = s(&payload, "code").to_string();
            let candidates = candidate_endpoints("", configured_base, &code_norm)?;
            if candidates.len() > 1 {
                let probe = json!({ "action": "lookup", "code": code_norm });
                for (ep, _) in &candidates {
                    let bearer = bearer_for_endpoint(secrets_mtx, ep);
                    if let Ok((st_code, _)) = post_jam(ep, &probe, bearer.as_deref()).await {
                        if [200, 401, 403, 409, 410].contains(&st_code) {
                            base = ep.clone();
                            break;
                        }
                    }
                }
            } else if let Some((first_ep, _)) = candidates.first() {
                base = first_ep.clone();
            }
        }
    }

    if base.is_empty() {
        return Err(
            "O serviço de JAM ainda não foi conectado. Configure um servidor ou crie na rede local."
                .into(),
        );
    }

    let action = s(&payload, "action").to_string();
    if ![
        "create",
        "join",
        "resume",
        "poll",
        "sync",
        "ping",
        "rotateInvite",
        "updateRoom",
        "kick",
        "voteSkip",
        "queueAdd",
        "queueRemove",
        "recommendPlaylist",
        "chat",
        "leave",
    ]
    .contains(&action.as_str())
    {
        return Err("Operação de JAM inválida.".into());
    }

    if ["create", "join", "resume"].contains(&action.as_str()) && s(&payload, "clientId").is_empty() {
        if let Ok(d) = db_mtx.lock() {
            payload["clientId"] = json!(d.jam_client_id());
        }
    }

    if serde_json::to_vec(&payload)
        .map_err(|_| "Solicitação inválida.")?
        .len()
        > 48000
    {
        return Err("Solicitação da JAM muito grande.".into());
    }

    if action == "sync" && !payload["playback"]["track"].is_null() {
        db::validate_track(&payload["playback"]["track"])?;
        if s(&payload["playback"]["track"], "source") == "local" {
            return Err("Arquivos locais não são compartilhados na JAM.".into());
        }
    }

    let bearer = if ["create", "join", "resume"].contains(&action.as_str()) {
        bearer_for_endpoint(secrets_mtx, &base)
    } else {
        None
    };

    let (status, mut value) = post_jam(&base, &payload, bearer.as_deref()).await?;

    if !(200..300).contains(&status) {
        return Err(if s(&value, "error").is_empty() {
            "O serviço de JAM está indisponível.".to_string()
        } else {
            s(&value, "error").chars().take(500).collect()
        });
    }

    if action == "ping" {
        if !value["serverTime"].is_number() {
            return Err("Resposta de ping inválida.".into());
        }
        return Ok(value);
    }

    if [
        "create",
        "join",
        "resume",
        "poll",
        "sync",
        "rotateInvite",
        "updateRoom",
        "kick",
        "voteSkip",
        "queueAdd",
        "queueRemove",
        "recommendPlaylist",
        "chat",
    ]
    .contains(&action.as_str())
    {
        validate_room_payload(&value)?;
    }
    if ["create", "join", "resume"].contains(&action.as_str()) {
        remember_lan_endpoint(&base);
        value["endpoint"] = json!(base);
    }
    Ok(value)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn endpoints_require_tls_or_explicit_local_network() {
        for good in [
            "https://jam.example",
            "http://127.0.0.1:8789",
            "http://192.168.1.4:8789",
            "http://[::1]:8789",
            "",
        ] {
            assert!(validate_endpoint(good).is_ok(), "{good}");
        }
        for bad in [
            "http://jam.example",
            "https://user:password@jam.example",
            "https://jam.example/?token=secret",
            "file:///tmp/s",
            "https://jam.example/path",
            "https://jam.example/#fragment",
        ] {
            assert!(validate_endpoint(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn bundled_default_jam_endpoint_is_valid_https() {
        let cfg: Value = serde_json::from_str(include_str!("../jam.json")).expect("valid jam.json");
        let url = s(&cfg, "jamUrl");
        assert!(url.starts_with("https://"), "default jamUrl must use HTTPS: {url}");
        assert!(validate_endpoint(url).is_ok(), "default jamUrl invalid: {url}");
    }
}
