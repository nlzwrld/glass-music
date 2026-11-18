use crate::db::{self, s, Result};
use serde_json::{json, Value};
use std::{sync::OnceLock, time::Duration};
#[path = "jam_lan.rs"]
mod lan;

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
            .user_agent("LiquidHub-JAM/2")
            .build()
            .expect("jam http")
    })
}

pub async fn call(p: &Value, endpoint: &str, consent: bool) -> Result<Value> {
    let default_env = option_env!("LIQUID_JAM_URL")
        .or(option_env!("GLASS_JAM_URL"))
        .unwrap_or("");
    let selected = if !s(p, "endpoint").is_empty() {
        s(p, "endpoint")
    } else if endpoint.is_empty() {
        default_env
    } else {
        endpoint
    };
    let mut base = validate_endpoint(selected)?;
    if s(p, "action") == "status" {
        return Ok(json!({ "endpoint": base, "configured": !base.is_empty() }));
    }
    if !consent {
        return Err("Permita o acesso online antes de entrar em uma JAM.".into());
    }
    if s(p, "action") == "discoverLan" {
        return Ok(json!({ "rooms": lan::discover_rooms(), "serverTime": db::now() }));
    }
    let mut payload = p.clone();
    if let Some(obj) = payload.as_object_mut() {
        obj.remove("endpoint");
    }
    if s(p, "action") == "createLocal" {
        base = lan::start()?;
        payload["action"] = json!("create");
    }
    if base.is_empty() {
        return Err(
            "O serviço de JAM ainda não foi conectado. Configure um servidor ou crie na rede local."
                .into(),
        );
    }
    let action = s(&payload, "action");
    if !["create", "join", "poll", "sync", "ping", "leave"].contains(&action) {
        return Err("Operação de JAM inválida.".into());
    }
    if serde_json::to_vec(&payload)
        .map_err(|_| "Solicitação inválida.")?
        .len()
        > 16000
    {
        return Err("Solicitação da JAM muito grande.".into());
    }
    if action == "sync" && !payload["playback"]["track"].is_null() {
        db::validate_track(&payload["playback"]["track"])?;
        if s(&payload["playback"]["track"], "source") == "local" {
            return Err("Arquivos locais não são compartilhados na JAM.".into());
        }
    }
    let mut response = client()
        .post(format!("{base}/v1/jam"))
        .header("Accept-Encoding", "identity")
        .json(&payload)
        .send()
        .await
        .map_err(|_| {
            "Não foi possível conectar à JAM. Verifique sua conexão e permita a rede privada no Firewall do Windows."
                .to_string()
        })?;
    let status = response.status();
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| "A conexão com a JAM foi interrompida.")?
    {
        if bytes.len() + chunk.len() > 24000 {
            return Err("Resposta da JAM maior que o permitido.".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    let mut value: Value =
        serde_json::from_slice(&bytes).map_err(|_| "Resposta inválida do servidor de JAM.")?;
    if !status.is_success() {
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
    if ["create", "join", "poll", "sync"].contains(&action) {
        let code = s(&value, "code");
        if code.len() != 10
            || !code.bytes().all(|b| b.is_ascii_hexdigit())
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
    }
    if ["create", "join"].contains(&action) {
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
}
