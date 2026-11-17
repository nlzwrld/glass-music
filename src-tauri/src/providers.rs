use crate::{
    db::{self, now, s, Result},
};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    time::{Duration, Instant}, sync::OnceLock,
};
use tokio_util::sync::CancellationToken;
pub struct SearchState {
    pub cache: HashMap<String, (Instant, Value)>,
    pub requests: HashMap<String, CancellationToken>,
}
impl SearchState {
    pub fn new() -> Self {
        Self {
            cache: HashMap::new(),
            requests: HashMap::new(),
        }
    }
}
pub fn client() -> reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(6))
        .timeout(Duration::from_secs(18))
        .redirect(reqwest::redirect::Policy::none())
        .user_agent("GlassMusic/1.0")
        .build()
        .expect("http client")).clone()
}
async fn fetch(req: reqwest::RequestBuilder) -> Result<Value> {
    let r = req
        .send()
        .await
        .map_err(|_| "Falha de conexão. Verifique a internet e tente novamente.")?;
    let status = r.status();
    if !status.is_success() {
        return Err(match status.as_u16() {
            401 | 403 => "O serviço recusou o acesso. Confira a chave, a cota e as permissões.",
            404 => "Conteúdo removido, privado ou não encontrado.",
            429 => "Limite temporário de consultas. Aguarde e tente novamente.",
            _ => "O serviço está indisponível neste momento.",
        }
        .into());
    }
    if r.content_length().unwrap_or(0) > 5_000_000 {
        return Err("Resposta muito grande.".into());
    }
    r.json()
        .await
        .map_err(|_| "Resposta inválida do serviço.".into())
}
pub async fn resolve(raw: &str) -> Result<Value> {
    if raw.len() > 2048 || !db::official_url(raw) {
        return Err("Use um link público do YouTube ou SoundCloud.".into());
    }
    let mut u = url::Url::parse(raw).map_err(|_| "Link inválido")?;
    let host = u.host_str().unwrap_or("").to_string();
    let c = client();
    if ["youtube.com", "www.youtube.com", "music.youtube.com", "youtu.be"].contains(&host.as_str()) {
        let id = if host == "youtu.be" {
            u.path().trim_matches('/').to_string()
        } else if u.path() == "/watch" {
            u.query_pairs()
                .find(|(k, _)| k == "v")
                .map(|(_, v)| v.into_owned())
                .unwrap_or_default()
        } else {
            u.path()
                .split('/')
                .filter(|s| !s.is_empty())
                .nth(1)
                .unwrap_or("")
                .to_string()
        };
        if id.len() != 11
            || !id
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || b"_-".contains(&c))
        {
            return Err("Use o link de um vídeo do YouTube.".into());
        }
        let url = format!("https://www.youtube.com/watch?v={id}");
        let d = fetch(
            c.get("https://www.youtube.com/oembed")
                .query(&[("url", &url), ("format", &"json".into())]),
        )
        .await?;
        let t = json!({"id":format!("youtube:{id}"),"source":"youtube","sourceId":id,"kind":"track","title":d["title"],"artist":d["author_name"],"artwork":d["thumbnail_url"],"duration":0,"url":url,"addedAt":now()});
        db::validate_track(&t)?;
        Ok(t)
    } else if ["soundcloud.com", "www.soundcloud.com"].contains(&host.as_str()) {
        if u.path().split('/').filter(|s| !s.is_empty()).count() < 2 {
            return Err("Use o link completo de uma faixa ou playlist pública.".into());
        }
        u.set_query(None);
        u.set_fragment(None);
        let url = u.to_string();
        let d = fetch(
            c.get("https://soundcloud.com/oembed")
                .query(&[("url", &url), ("format", &"json".into())]),
        )
        .await?;
        let id = format!("{:x}", Sha256::digest(url.as_bytes()))[..32].to_string();
        let t = json!({"id":format!("soundcloud:{id}"),"source":"soundcloud","sourceId":id,"kind":if u.path().contains("/sets/"){"playlist"}else{"track"},"title":d["title"],"artist":d["author_name"],"artwork":d["thumbnail_url"],"duration":0,"url":url,"addedAt":now()});
        db::validate_track(&t)?;
        Ok(t)
    } else {
        Err("Plataforma não suportada.".into())
    }
}
pub fn validate_search(r: &Value) -> Result<()> {
    if s(r, "query").trim().is_empty()
        || s(r, "query").len() > 800
        || !db::valid_id(s(r, "requestId"))
        || !["all", "local", "youtube", "soundcloud", "deezer", "apple"].contains(&s(r, "source"))
        || !["all", "track", "artist", "playlist", "album"].contains(&s(r, "kind"))
        || r.to_string().len() > 6000
    {
        return Err("Pesquisa inválida.".into());
    }
    Ok(())
}
pub async fn search(r: &Value, local: Vec<Value>, consent: bool, catalog: &str, direct: &crate::direct_catalog::DirectCatalog) -> Result<Value> {
    let source = s(r, "source");
    let kind = s(r, "kind");
    let query = s(r, "query").to_lowercase();
    let mut items = vec![];
    let mut notices = vec![];
    let mut next = json!({});
    if ["all", "local"].contains(&source) {
        items.extend(local.into_iter().filter(|t| {
            (kind == "all" || s(t, "kind") == kind)
                && format!("{} {} {}", s(t, "title"), s(t, "artist"), s(t, "album"))
                    .to_lowercase()
                    .contains(&query)
        }));
    }
    let (yt, dz, ap, sc) = tokio::join!(
        async {
            if consent && ["all", "youtube"].contains(&source) && kind != "album" {
                Some(if !catalog.is_empty() { crate::catalog::search(catalog, "youtube", r).await } else { direct.search("youtube", r).await })
            } else {
                None
            }
        },
        async {
            if consent && ["all", "deezer"].contains(&source) {
                Some(crate::platforms::search_deezer(r).await)
            } else {
                None
            }
        },
        async {
            if consent && ["apple"].contains(&source) || (consent && source == "all" && kind == "album") {
                Some(crate::platforms::search_apple(r).await)
            } else {
                None
            }
        },
        async {
            if consent && ["all", "soundcloud"].contains(&source) && kind != "album" {
                Some(if !catalog.is_empty() { crate::catalog::search(catalog, "soundcloud", r).await } else { direct.search("soundcloud", r).await })
            } else {
                None
            }
        }
    );
    for (key, label, result) in [
        ("youtube", "YouTube", yt),
        ("deezer", "Deezer", dz),
        ("apple", "Apple Music", ap),
        ("soundcloud", "SoundCloud", sc),
    ] {
        if let Some(result) = result {
            match result {
                Ok(v) => {
                    if let Some(rows) = v["items"].as_array() {
                        items.extend(rows.iter().cloned());
                    }
                    if v["next"].is_string() {
                        next[key] = v["next"].clone();
                    }
                }
                Err(e) => {
                    let notice = format!("{label}: {e}");
                    if !notices.contains(&notice) {
                        notices.push(notice);
                    }
                }
            }
        }
    }
    if !consent && source != "local" {
        notices.push("Ative as integrações em Configurações para pesquisar online.".into());
    }
    Ok(json!({"items":items,"next":next,"notices":notices}))
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn invalid_search_is_rejected() {
        assert!(validate_search(
            &json!({"query":"x","requestId":"../../bad","source":"all","kind":"all"})
        )
        .is_err());
    }
}
