use crate::db::{self, s, Result};
use serde_json::{json, Value};

pub fn validate_base(raw: &str, allow_local: bool) -> Result<String> {
    if raw.is_empty() { return Ok(String::new()); }
    let u = url::Url::parse(raw).map_err(|_| "Endereço do catálogo inválido.")?;
    if raw.len() > 2048 || u.host_str().is_none() || !u.username().is_empty() || u.password().is_some()
        || u.query().is_some() || u.fragment().is_some() || u.path() != "/"
        || !(u.scheme() == "https" || (allow_local && u.scheme() == "http" && u.host_str() == Some("127.0.0.1"))) {
        return Err("O catálogo distribuído deve usar um endereço HTTPS sem credenciais.".into());
    }
    Ok(raw.trim_end_matches('/').to_string())
}

pub fn configured_url() -> Result<String> {
    let config: Value = serde_json::from_str(include_str!("../catalog.json")).map_err(|_| "Configuração de distribuição inválida.")?;
    // Local overrides exist only for isolated integration-test profiles, never as an end-user setting.
    if std::env::var_os("GLASS_TEST_DATA").is_some() {
        if let Ok(raw) = std::env::var("GLASS_TEST_CATALOG_URL") { return validate_base(&raw, true); }
    }
    validate_base(s(&config, "catalogUrl"), false)
}

async fn fetch(base: &str, path: &str, query: &[(&str, &str)]) -> Result<Value> {
    if base.is_empty() { return Err("O catálogo online ainda não foi ativado para esta edição do Liquid Hub. Links públicos continuam disponíveis.".into()); }
    let mut response = crate::providers::client().get(format!("{base}{path}")).query(query).send().await
        .map_err(|_| "Não foi possível conectar ao catálogo. Verifique sua internet e tente novamente.")?;
    let status = response.status(); let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| "Resposta incompleta do catálogo.")? {
        if bytes.len() + chunk.len() > 2_000_000 { return Err("Resposta do catálogo maior que o permitido.".into()); }
        bytes.extend_from_slice(&chunk);
    }
    let value: Value = serde_json::from_slice(&bytes).map_err(|_| "Resposta inválida do catálogo.")?;
    if !status.is_success() {
        let message = s(&value, "error");
        return Err(if !message.is_empty() && message.len() <= 1000 { message.to_string() } else { "O catálogo está temporariamente indisponível.".into() });
    }
    Ok(value)
}

fn validate_items(value: &Value, source: &str) -> Result<()> {
    let items = value.as_array().ok_or("Lista inválida do catálogo.")?;
    if items.len() > 60 { return Err("Lista do catálogo muito grande.".into()); }
    for item in items {
        db::validate_track(item)?;
        if ["spotify", "deezer"].contains(&source) {
            if s(item, "source") != "link" || s(item, "catalogSource") != source {
                return Err("Fonte inválida no catálogo.".into());
            }
        } else if s(item, "source") != source {
            return Err("Fonte inválida no catálogo.".into());
        }
    }
    Ok(())
}

pub async fn search(base: &str, source: &str, request: &Value) -> Result<Value> {
    if s(request, "kind") == "album" && ["youtube", "soundcloud"].contains(&source) {
        return Ok(json!({"items":[]}));
    }
    let value = fetch(base, "/v1/search", &[("source", source), ("q", s(request, "query")), ("kind", s(request, "kind")), ("cursor", s(&request["cursor"], source))]).await?;
    validate_items(&value["items"], source)?;
    if !value["next"].is_null() && (!value["next"].is_string() || s(&value, "next").len() > 100) { return Err("Página inválida do catálogo.".into()); }
    Ok(json!({"items":value["items"],"next":value["next"]}))
}

pub async fn discover(base: &str) -> Result<Value> {
    let value = fetch(base, "/v1/discover", &[]).await?;
    let sections = value["sections"].as_array().ok_or("Resposta inválida do catálogo.")?;
    if sections.len() > 6 { return Err("Resposta inválida do catálogo.".into()); }
    let mut clean = Vec::new();
    for section in sections {
        let source = s(section, "source");
        if !["youtube", "soundcloud"].contains(&source) || !db::valid_id(s(section, "id")) || s(section, "title").is_empty() || s(section, "title").len() > 500 { return Err("Seção inválida do catálogo.".into()); }
        validate_items(&section["items"], source)?;
        clean.push(json!({"id":section["id"],"source":source,"title":section["title"],"items":section["items"]}));
    }
    let notices: Vec<_> = value["notices"].as_array().into_iter().flatten().filter_map(|n| n.as_str()).take(6).map(|n| n.chars().take(500).collect::<String>()).collect();
    Ok(json!({"sections":clean,"notices":notices}))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn distribution_url_is_not_an_end_user_secret() {
        assert_eq!(validate_base("https://catalog.example/", false).unwrap(), "https://catalog.example");
        for bad in ["http://catalog.example", "https://user:secret@catalog.example", "https://catalog.example/?key=secret", "https://catalog.example/path"] { assert!(validate_base(bad, false).is_err()); }
        assert!(validate_base("http://127.0.0.1:8788", false).is_err());
        assert!(validate_base("http://127.0.0.1:8788", true).is_ok());
    }
    #[test]
    fn rejects_provider_spoofing() {
        assert!(validate_items(&json!([{ "id":"local:fake", "source":"local" }]), "youtube").is_err());
        assert!(validate_items(&json!({}), "youtube").is_err());
    }
}
