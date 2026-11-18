use crate::{
    collections::Collection,
    db::{self, now, s, Result},
};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::time::Duration;

const PAGE: usize = 20;
const MAX_OFFSET: usize = 180;

pub fn link_hash(canonical: &str) -> String {
    format!("{:x}", Sha256::digest(canonical.as_bytes()))[..32].to_string()
}

pub fn is_bandcamp(host: &str) -> bool {
    host.ends_with(".bandcamp.com")
        && host.len() > ".bandcamp.com".len()
        && !host.starts_with('.')
        && host[..host.len() - ".bandcamp.com".len()]
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-')
}

pub fn supported_link_host(host: &str) -> bool {
    matches!(
        host,
        "open.spotify.com"
            | "deezer.com"
            | "www.deezer.com"
            | "music.apple.com"
            | "itunes.apple.com"
            | "tidal.com"
            | "www.tidal.com"
            | "listen.tidal.com"
    ) || is_bandcamp(host)
}

fn parse_offset(raw: &str) -> Result<usize> {
    if raw.is_empty() {
        return Ok(0);
    }
    if raw.len() > 3 || !raw.bytes().all(|b| b.is_ascii_digit()) {
        return Err("Página de busca inválida.".into());
    }
    let n: usize = raw.parse().map_err(|_| "Página de busca inválida.")?;
    if n > MAX_OFFSET || n % PAGE != 0 {
        return Err("Página de busca inválida.".into());
    }
    Ok(n)
}

async fn get_json(url: &str, query: &[(&str, &str)], max_bytes: usize) -> Result<Value> {
    let mut response = crate::providers::client()
        .get(url)
        .query(query)
        .timeout(Duration::from_secs(10))
        .send()
        .await
        .map_err(|_| "Não foi possível conectar à plataforma.")?;
    if !response.status().is_success() {
        return Err(match response.status().as_u16() {
            429 => "Limite temporário da plataforma. Aguarde e tente novamente.",
            404 => "Conteúdo não encontrado na plataforma.",
            _ => "A plataforma está indisponível neste momento.",
        }
        .into());
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| "Resposta incompleta.")? {
        if bytes.len() + chunk.len() > max_bytes {
            return Err("Resposta da plataforma maior que o permitido.".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&bytes).map_err(|_| "Resposta inválida da plataforma.".into())
}

async fn get_html(url: &str, max_bytes: usize) -> Result<String> {
    let mut response = crate::providers::client()
        .get(url)
        .header(
            "User-Agent",
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36",
        )
        .header("Accept-Language", "pt-BR,pt;q=0.9,en;q=0.8")
        .timeout(Duration::from_secs(10))
        .send()
        .await
        .map_err(|_| "Não foi possível consultar o link.")?;
    if !response.status().is_success() {
        return Err("Conteúdo não encontrado ou indisponível publicamente.".into());
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| "Resposta incompleta.")? {
        if bytes.len() + chunk.len() > max_bytes {
            return Err("Página muito grande.".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    String::from_utf8(bytes).map_err(|_| "Página inválida.".into())
}

pub fn deezer_item(row: &Value, kind: &str) -> Option<Value> {
    let id = row["id"]
        .as_u64()
        .map(|n| n.to_string())
        .or_else(|| row["id"].as_str().map(str::to_string))?;
    if id.is_empty() || id.len() > 25 || !id.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    let (entity, title, artist, artwork, album, duration) = match kind {
        "album" => (
            "album",
            row["title"].as_str()?,
            row["artist"]["name"].as_str().unwrap_or("Deezer"),
            row["cover_big"]
                .as_str()
                .or_else(|| row["cover_medium"].as_str())
                .unwrap_or(""),
            "",
            0.0,
        ),
        "playlist" => (
            "playlist",
            row["title"].as_str()?,
            row["user"]["name"]
                .as_str()
                .or_else(|| row["creator"]["name"].as_str())
                .unwrap_or("Deezer"),
            row["picture_big"]
                .as_str()
                .or_else(|| row["picture_medium"].as_str())
                .unwrap_or(""),
            "",
            0.0,
        ),
        "artist" => (
            "artist",
            row["name"].as_str()?,
            row["name"].as_str()?,
            row["picture_big"]
                .as_str()
                .or_else(|| row["picture_medium"].as_str())
                .unwrap_or(""),
            "",
            0.0,
        ),
        _ => (
            "track",
            row["title"].as_str()?,
            row["artist"]["name"].as_str().unwrap_or("Deezer"),
            row["album"]["cover_big"]
                .as_str()
                .or_else(|| row["album"]["cover_medium"].as_str())
                .or_else(|| row["cover_medium"].as_str())
                .unwrap_or(""),
            row["album"]["title"].as_str().unwrap_or(""),
            row["duration"].as_f64().unwrap_or(0.0).clamp(0.0, 604800.0),
        ),
    };
    let canonical = format!("https://www.deezer.com/{entity}/{id}");
    let hash = link_hash(&canonical);
    let mut track = json!({
        "id": format!("link:{hash}"),
        "source": "link",
        "sourceId": hash,
        "kind": entity,
        "title": title,
        "artist": artist,
        "duration": duration,
        "durationMs": (duration * 1000.0).round(),
        "catalogSource": "deezer",
        "url": canonical,
        "addedAt": now()
    });
    if entity == "track" {
        track["resolvedExternalId"] = json!(id);
        if let Some(isrc) = row["isrc"].as_str() {
            if (12..=15).contains(&isrc.len())
                && isrc.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
            {
                track["isrc"] = json!(isrc.to_uppercase());
            }
        }
    }
    if !album.is_empty() {
        track["album"] = json!(album);
    }
    if db::artwork_url(artwork) {
        track["artwork"] = json!(artwork);
    }
    db::validate_track(&track).ok()?;
    Some(track)
}

pub async fn lookup_deezer_isrc(isrc: &str) -> Option<Value> {
    let clean: String = isrc
        .chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .collect::<String>()
        .to_uppercase();
    if clean.len() != 12 {
        return None;
    }
    let data = get_json(&format!("https://api.deezer.com/2.0/track/isrc:{clean}"), &[], 512_000)
        .await
        .ok()?;
    if data.get("error").is_some() {
        return None;
    }
    deezer_item(&data, "track")
}

pub async fn search_deezer(request: &Value) -> Result<Value> {
    let query = s(request, "query").trim();
    let requested = s(request, "kind");
    let offset = parse_offset(s(&request["cursor"], "deezer"))?;
    let endpoint = match requested {
        "album" => "album",
        "playlist" => "playlist",
        "artist" => "artist",
        _ => "track",
    };
    let index_str = offset.to_string();
    let limit_str = (PAGE + 1).to_string();
    let data = get_json(
        &format!("https://api.deezer.com/search/{endpoint}"),
        &[("q", query), ("index", &index_str), ("limit", &limit_str)],
        1_500_000,
    )
    .await?;
    if data.get("error").is_some() {
        return Err("O Deezer está temporariamente indisponível.".into());
    }
    let rows = data["data"].as_array().ok_or("Resposta inválida do Deezer.")?;
    let items: Vec<Value> = rows
        .iter()
        .take(PAGE)
        .filter_map(|r| deezer_item(r, endpoint))
        .collect();
    let has_next = (rows.len() > PAGE || !data["next"].is_null()) && offset < MAX_OFFSET;
    Ok(json!({
        "items": items,
        "next": if has_next { json!((offset + PAGE).to_string()) } else { Value::Null }
    }))
}

pub async fn discover_deezer() -> Result<Vec<Value>> {
    let data = get_json("https://api.deezer.com/chart/0/tracks", &[("limit", "12")], 1_000_000).await?;
    let rows = data["data"].as_array().ok_or("Seleção do Deezer indisponível.")?;
    let items: Vec<Value> = rows
        .iter()
        .filter_map(|r| deezer_item(r, "track"))
        .take(10)
        .collect();
    if items.is_empty() {
        return Err("Nenhuma música retornada pelo Deezer.".into());
    }
    Ok(items)
}

fn apple_artwork(raw: &str) -> String {
    if raw.is_empty() {
        return String::new();
    }
    let upgraded = raw
        .replace("100x100bb", "500x500bb")
        .replace("60x60bb", "500x500bb");
    if db::artwork_url(&upgraded) {
        upgraded
    } else if db::artwork_url(raw) {
        raw.to_string()
    } else {
        String::new()
    }
}

pub fn apple_item(row: &Value, fallback_country: &str) -> Option<Value> {
    let wrapper = s(row, "wrapperType");
    let cc = fallback_country.to_lowercase();
    let cc = if cc.len() == 2 && cc.bytes().all(|b| b.is_ascii_alphabetic()) {
        cc
    } else {
        "br".into()
    };
    let (kind, title, artist, album, duration, canonical) = if wrapper == "collection" {
        let id = row["collectionId"].as_u64()?;
        (
            "album",
            row["collectionName"].as_str()?,
            row["artistName"].as_str().unwrap_or("Apple Music"),
            row["collectionName"].as_str().unwrap_or(""),
            0.0,
            format!("https://music.apple.com/{cc}/album/{id}"),
        )
    } else if wrapper == "artist" {
        let id = row["artistId"].as_u64()?;
        let name = row["artistName"].as_str()?;
        (
            "artist",
            name,
            name,
            "",
            0.0,
            format!("https://music.apple.com/{cc}/artist/{id}"),
        )
    } else {
        let track_id = row["trackId"].as_u64()?;
        let album_id = row["collectionId"].as_u64();
        let canonical = if let Some(aid) = album_id {
            format!("https://music.apple.com/{cc}/album/{aid}?i={track_id}")
        } else {
            format!("https://music.apple.com/{cc}/song/{track_id}")
        };
        (
            "track",
            row["trackName"].as_str()?,
            row["artistName"].as_str().unwrap_or("Apple Music"),
            row["collectionName"].as_str().unwrap_or(""),
            (row["trackTimeMillis"].as_f64().unwrap_or(0.0) / 1000.0).clamp(0.0, 604800.0),
            canonical,
        )
    };
    let hash = link_hash(&canonical);
    let mut track = json!({
        "id": format!("link:{hash}"),
        "source": "link",
        "sourceId": hash,
        "kind": kind,
        "title": title,
        "artist": artist,
        "duration": duration,
        "url": canonical,
        "addedAt": now()
    });
    if !album.is_empty() && kind == "track" {
        track["album"] = json!(album);
    }
    let art = apple_artwork(s(row, "artworkUrl100"));
    if !art.is_empty() {
        track["artwork"] = json!(art);
    }
    db::validate_track(&track).ok()?;
    Some(track)
}

pub async fn search_apple(request: &Value) -> Result<Value> {
    let requested = s(request, "kind");
    if requested == "playlist" {
        return Ok(json!({"items": [], "next": Value::Null}));
    }
    let query = s(request, "query").trim();
    let offset = parse_offset(s(&request["cursor"], "apple"))?;
    let entity = match requested {
        "album" => "album",
        "artist" => "musicArtist",
        _ => "song",
    };
    let limit_str = (PAGE + 1).to_string();
    let offset_str = offset.to_string();
    let data = get_json(
        "https://itunes.apple.com/search",
        &[
            ("term", query),
            ("country", "BR"),
            ("media", "music"),
            ("entity", entity),
            ("limit", &limit_str),
            ("offset", &offset_str),
        ],
        1_500_000,
    )
    .await?;
    let rows = data["results"]
        .as_array()
        .ok_or("Resposta inválida do Apple Music.")?;
    let items: Vec<Value> = rows
        .iter()
        .take(PAGE)
        .filter_map(|r| apple_item(r, "br"))
        .collect();
    let has_next = rows.len() > PAGE && offset < MAX_OFFSET;
    Ok(json!({
        "items": items,
        "next": if has_next { json!((offset + PAGE).to_string()) } else { Value::Null }
    }))
}

pub fn parse_apple_url(u: &url::Url) -> Result<(String, &'static str, String)> {
    let parts: Vec<_> = u
        .path_segments()
        .into_iter()
        .flatten()
        .filter(|p| !p.is_empty())
        .collect();
    let (cc, rest) = if parts
        .first()
        .is_some_and(|c| c.len() == 2 && c.bytes().all(|b| b.is_ascii_alphabetic()))
    {
        (parts[0].to_lowercase(), &parts[1..])
    } else {
        ("br".to_string(), &parts[..])
    };
    if let Some(song_id) = u
        .query_pairs()
        .find(|(k, _)| k == "i")
        .map(|(_, v)| v.into_owned())
    {
        if !song_id.is_empty() && song_id.len() <= 25 && song_id.bytes().all(|b| b.is_ascii_digit()) {
            return Ok((cc, "track", song_id));
        }
    }
    let kind = match rest.first().copied() {
        Some("song") => "track",
        Some("album") => "album",
        Some("artist") => "artist",
        _ => return Err("Use o link de uma música, álbum ou artista do Apple Music.".into()),
    };
    let id = rest
        .iter()
        .rev()
        .map(|s| s.strip_prefix("id").unwrap_or(s))
        .find(|s| !s.is_empty() && s.len() <= 25 && s.bytes().all(|b| b.is_ascii_digit()))
        .ok_or("Identificador do Apple Music inválido.")?;
    Ok((cc, kind, id.to_string()))
}

pub async fn resolve_apple(u: &url::Url) -> Result<Value> {
    let (cc, kind, id) = parse_apple_url(u)?;
    let country = cc.to_uppercase();
    let data = get_json(
        "https://itunes.apple.com/lookup",
        &[("id", &id), ("country", &country)],
        1_000_000,
    )
    .await?;
    let first = data["results"]
        .as_array()
        .and_then(|a| a.first())
        .ok_or("Conteúdo não encontrado no Apple Music.")?;
    apple_item(first, &cc).ok_or_else(|| {
        if kind == "track" {
            "Faixa do Apple Music indisponível.".into()
        } else {
            "Conteúdo do Apple Music indisponível.".into()
        }
    })
}

pub async fn apple_collection(u: &url::Url) -> Result<Collection> {
    let (cc, kind, id) = parse_apple_url(u)?;
    if kind == "track" {
        return Err("Use o link de um álbum ou artista.".into());
    }
    let country = cc.to_uppercase();
    let data = get_json(
        "https://itunes.apple.com/lookup",
        &[("id", &id), ("entity", "song"), ("limit", "200"), ("country", &country)],
        2_000_000,
    )
    .await?;
    let rows = data["results"]
        .as_array()
        .ok_or("Álbum ou artista não encontrado no Apple Music.")?;
    let header = rows.first().ok_or("Lista vazia no Apple Music.")?;
    let name = header["collectionName"]
        .as_str()
        .or_else(|| header["artistName"].as_str())
        .unwrap_or("Apple Music")
        .to_string();
    let mut cover = apple_artwork(s(header, "artworkUrl100"));
    let mut tracks = Vec::new();
    let mut skipped = 0;
    for row in rows.iter().skip(1) {
        if s(row, "wrapperType") != "track" {
            continue;
        }
        if let Some(t) = apple_item(row, &cc) {
            if cover.is_empty() {
                cover = s(&t, "artwork").to_string();
            }
            tracks.push(t);
        } else {
            skipped += 1;
        }
    }
    if tracks.is_empty() {
        return Err("Nenhuma faixa disponível neste item do Apple Music.".into());
    }
    Ok(Collection {
        artwork: cover,
        key: format!("https://music.apple.com/{cc}/{kind}/{id}"),
        name,
        tracks,
        warning: String::new(),
        skipped,
    })
}

pub fn parse_iso_duration(raw: &str) -> f64 {
    let Some(rest) = raw.strip_prefix('P') else {
        return 0.0;
    };
    let body = rest.strip_prefix('T').unwrap_or(rest);
    let mut total = 0.0;
    let mut current = String::new();
    for ch in body.chars() {
        if ch == 'T' {
            current.clear();
            continue;
        }
        if ch.is_ascii_digit() || ch == '.' {
            current.push(ch);
        } else {
            if let Ok(n) = current.parse::<f64>() {
                match ch {
                    'H' => total += n * 3600.0,
                    'M' => total += n * 60.0,
                    'S' => total += n,
                    _ => {}
                }
            }
            current.clear();
        }
    }
    total.clamp(0.0, 604800.0)
}

fn extract_ld_json(html: &str) -> Option<Value> {
    let mut rest = html;
    while let Some(idx) = rest.find("application/ld+json") {
        let after = &rest[idx..];
        let Some(open) = after.find('>') else {
            break;
        };
        let body = &after[open + 1..];
        let Some(close) = body.find("</script>") else {
            break;
        };
        if let Ok(v) = serde_json::from_str::<Value>(body[..close].trim()) {
            if matches!(s(&v, "@type"), "MusicRecording" | "MusicAlbum") {
                return Some(v);
            }
        }
        rest = &body[close + 9..];
    }
    None
}

pub async fn resolve_bandcamp(u: &url::Url) -> Result<Value> {
    let parts: Vec<_> = u
        .path_segments()
        .into_iter()
        .flatten()
        .filter(|p| !p.is_empty())
        .collect();
    if parts.len() != 2 || !["track", "album"].contains(&parts[0]) {
        return Err("Use o link de uma faixa ou álbum do Bandcamp.".into());
    }
    let mut clean = u.clone();
    clean.set_query(None);
    clean.set_fragment(None);
    let canonical = clean.to_string();
    let html = get_html(&canonical, 1_500_000).await?;
    let ld = extract_ld_json(&html).ok_or("Não foi possível ler os metadados do Bandcamp.")?;
    let kind = if parts[0] == "album" { "album" } else { "track" };
    let title = s(&ld, "name");
    let artist = ld["byArtist"]["name"]
        .as_str()
        .unwrap_or_else(|| u.host_str().unwrap_or("Bandcamp"));
    let duration = parse_iso_duration(s(&ld, "duration"));
    let hash = link_hash(&canonical);
    let mut track = json!({
        "id": format!("link:{hash}"),
        "source": "link",
        "sourceId": hash,
        "kind": kind,
        "title": title,
        "artist": artist,
        "duration": duration,
        "url": canonical,
        "addedAt": now()
    });
    if let Some(album) = ld["inAlbum"]["name"].as_str() {
        if !album.is_empty() {
            track["album"] = json!(album);
        }
    }
    let image = s(&ld, "image");
    if db::artwork_url(image) {
        track["artwork"] = json!(image);
    }
    db::validate_track(&track)?;
    Ok(track)
}

pub async fn bandcamp_collection(u: &url::Url) -> Result<Collection> {
    let mut clean = u.clone();
    clean.set_query(None);
    clean.set_fragment(None);
    let canonical = clean.to_string();
    let html = get_html(&canonical, 1_500_000).await?;
    let ld = extract_ld_json(&html).ok_or("Álbum do Bandcamp indisponível.")?;
    let name = s(&ld, "name").to_string();
    let artist = ld["byArtist"]["name"].as_str().unwrap_or("Bandcamp");
    let cover = if db::artwork_url(s(&ld, "image")) {
        s(&ld, "image").to_string()
    } else {
        String::new()
    };
    let rows = ld
        .pointer("/track/itemListElement")
        .and_then(Value::as_array)
        .ok_or("Nenhuma faixa encontrada neste álbum do Bandcamp.")?;
    let mut tracks = Vec::new();
    let mut skipped = 0;
    for row in rows.iter().take(1000) {
        let item = row.get("item").unwrap_or(row);
        let item_url = item["@id"].as_str().or_else(|| item["url"].as_str()).unwrap_or("");
        if !crate::links::public_url(item_url) {
            skipped += 1;
            continue;
        }
        let hash = link_hash(item_url);
        let mut t = json!({
            "id": format!("link:{hash}"),
            "source": "link",
            "sourceId": hash,
            "kind": "track",
            "title": s(item, "name"),
            "artist": artist,
            "album": name,
            "duration": parse_iso_duration(s(item, "duration")),
            "url": item_url,
            "addedAt": now()
        });
        if !cover.is_empty() {
            t["artwork"] = json!(cover);
        }
        if db::validate_track(&t).is_ok() {
            tracks.push(t);
        } else {
            skipped += 1;
        }
    }
    if tracks.is_empty() {
        return Err("Nenhuma faixa pública disponível neste álbum.".into());
    }
    Ok(Collection {
        artwork: cover,
        key: canonical,
        name,
        tracks,
        warning: String::new(),
        skipped,
    })
}

fn meta_content(html: &str, property: &str) -> Option<String> {
    let needle = format!("property=\"{property}\"");
    let idx = html.find(&needle)?;
    let window = &html[idx.saturating_sub(160)..(idx + 360).min(html.len())];
    let c = window.find("content=\"")? + 9;
    let rest = &window[c..];
    let end = rest.find('"')?;
    Some(
        rest[..end]
            .replace("&amp;", "&")
            .replace("&quot;", "\"")
            .replace("&#39;", "'")
            .replace("&#x27;", "'"),
    )
}

pub async fn resolve_tidal(u: &url::Url) -> Result<Value> {
    let parts: Vec<_> = u
        .path_segments()
        .into_iter()
        .flatten()
        .filter(|p| !p.is_empty() && *p != "browse")
        .collect();
    let pos = parts
        .iter()
        .position(|p| ["track", "album", "playlist"].contains(p))
        .ok_or("Use o link de uma música, álbum ou playlist do Tidal.")?;
    let entity = parts[pos];
    let id = parts.get(pos + 1).ok_or("Link do Tidal incompleto.")?;
    if id.is_empty()
        || id.len() > 64
        || !id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
    {
        return Err("Identificador do Tidal inválido.".into());
    }
    let canonical = format!("https://tidal.com/{entity}/{id}");
    let html = get_html(&canonical, 1_500_000).await?;
    let og_title = meta_content(&html, "og:title").unwrap_or_default();
    if og_title.is_empty() || og_title.starts_with("Not Found") {
        return Err("Faixa não encontrada no Tidal.".into());
    }
    let (title, artist) = if let Some((song, by)) = og_title.rsplit_once(" by ") {
        (song.trim().to_string(), by.trim().to_string())
    } else if let Some((who, song)) = og_title.split_once(" - ") {
        (song.trim().to_string(), who.trim().to_string())
    } else {
        (og_title, "Tidal".to_string())
    };
    let hash = link_hash(&canonical);
    let mut track = json!({
        "id": format!("link:{hash}"),
        "source": "link",
        "sourceId": hash,
        "kind": entity,
        "title": title,
        "artist": artist,
        "duration": 0.0,
        "url": canonical,
        "addedAt": now()
    });
    if let Some(img) = meta_content(&html, "og:image") {
        if db::artwork_url(&img) {
            track["artwork"] = json!(img);
        }
    }
    db::validate_track(&track)?;
    Ok(track)
}

fn clean_lyric_snippet(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    let mut in_tag = false;
    for ch in raw.chars() {
        if ch == '<' {
            in_tag = true;
        } else if ch == '>' {
            in_tag = false;
        } else if !in_tag {
            out.push(if ch == '\n' || ch == '\r' { ' ' } else { ch });
        }
    }
    out.split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(180)
        .collect()
}

pub fn parse_letras_jsonp(raw: &str) -> Result<Value> {
    let trimmed = raw.trim().trim_end_matches(';').trim();
    let inner = if let Some(rest) = trimmed.strip_prefix("LetrasSug(") {
        rest.strip_suffix(')').unwrap_or(rest)
    } else {
        trimmed
    };
    serde_json::from_str(inner).map_err(|_| "Resposta de letras inválida.".into())
}

pub async fn search_lyrics(
    query: &str,
    direct: &crate::direct_catalog::DirectCatalog,
) -> Result<Value> {
    let q = query.trim();
    if q.is_empty() || q.len() > 500 {
        return Err("Trecho da letra inválido.".into());
    }
    let mut res = crate::providers::client()
        .get("https://solr.sscdn.co/letras/m1/")
        .query(&[("q", q), ("wt", "json")])
        .timeout(Duration::from_secs(8))
        .send()
        .await
        .map_err(|_| "Não foi possível pesquisar nas letras agora.")?;
    if !res.status().is_success() {
        return Err("Serviço de busca por letras indisponível.".into());
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = res.chunk().await.map_err(|_| "Resposta incompleta.")? {
        if bytes.len() + chunk.len() > 1_000_000 {
            break;
        }
        bytes.extend_from_slice(&chunk);
    }
    let text = String::from_utf8(bytes).map_err(|_| "Codificação inválida.")?;
    let parsed = parse_letras_jsonp(&text)?;
    let docs = parsed
        .pointer("/response/docs")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let highlights = &parsed["highlighting"];

    let mut matched = Vec::new();
    let mut seed_genre = String::new();
    let mut seed_artist = String::new();
    let mut seen = std::collections::HashSet::new();

    for doc in docs.iter().filter(|d| s(d, "t") == "2").take(6) {
        let title = s(doc, "txt");
        let artist = s(doc, "art");
        if title.is_empty() || artist.is_empty() {
            continue;
        }
        let dedup_key = format!("{}|{}", title.to_lowercase(), artist.to_lowercase());
        if !seen.insert(dedup_key) {
            continue;
        }
        if seed_artist.is_empty() {
            seed_artist = artist.to_string();
            seed_genre = s(doc, "g")
                .split(',')
                .next()
                .unwrap_or("")
                .trim()
                .to_string();
        }
        let doc_id = s(doc, "id");
        let snippet = highlights[doc_id]["letra"]
            .as_array()
            .and_then(|a| a.first())
            .and_then(Value::as_str)
            .map(clean_lyric_snippet)
            .unwrap_or_default();

        // Resolve a playable Deezer track first (fast + rich metadata), fallback to YouTube search
        let search_req = json!({ "query": format!("{title} {artist}"), "kind": "track", "cursor": {} });
        if let Ok(dz) = search_deezer(&search_req).await {
            if let Some(first) = dz["items"].as_array().and_then(|a| a.first()).cloned() {
                let mut item = first;
                if !snippet.is_empty() {
                    item["lyricSnippet"] = json!(snippet);
                }
                matched.push(item);
                continue;
            }
        }
        if let Ok(yt) = direct.search("youtube", &search_req).await {
            if let Some(first) = yt["items"].as_array().and_then(|a| a.first()).cloned() {
                let mut item = first;
                if !snippet.is_empty() {
                    item["lyricSnippet"] = json!(snippet);
                }
                matched.push(item);
            }
        }
    }

    // Fallback: also query YouTube directly with "<query> letra" when Solr has few hits
    if matched.len() < 3 {
        let yt_req = json!({ "query": format!("{q} letra"), "kind": "track", "cursor": {} });
        if let Ok(yt) = direct.search("youtube", &yt_req).await {
            if let Some(rows) = yt["items"].as_array() {
                for row in rows.iter().take(5) {
                    if !matched.iter().any(|m| m["id"] == row["id"]) {
                        matched.push(row.clone());
                    }
                }
            }
        }
    }

    // Build lyric-inspired recommendations based on matched artist & musical style
    if !seed_artist.is_empty() {
        let rec_query = if !seed_genre.is_empty() {
            format!("{seed_artist} {seed_genre}")
        } else {
            seed_artist
        };
        let rec_req = json!({ "query": rec_query, "kind": "track", "cursor": {} });
        if let Ok(dz_rec) = search_deezer(&rec_req).await {
            if let Some(rows) = dz_rec["items"].as_array() {
                for row in rows.iter().take(6) {
                    let key = format!(
                        "{}|{}",
                        s(row, "title").to_lowercase(),
                        s(row, "artist").to_lowercase()
                    );
                    if seen.insert(key) && !matched.iter().any(|m| m["id"] == row["id"]) {
                        let mut r = row.clone();
                        r["recommended"] = json!(true);
                        matched.push(r);
                    }
                }
            }
        }
    }

    Ok(json!({ "items": matched, "next": Value::Null }))
}

fn norm_key(title: &str, artist: &str) -> String {
    let clean = |v: &str| -> String {
        v.to_lowercase()
            .chars()
            .filter(|c| c.is_alphanumeric())
            .take(48)
            .collect()
    };
    format!("{}::{}", clean(title), clean(artist))
}

async fn deezer_artist_radio(title: &str, artist: &str) -> Vec<Value> {
    let q = format!("{artist} {title}");
    let Ok(search) = get_json(
        "https://api.deezer.com/search/track",
        &[("q", q.trim()), ("limit", "3")],
        500_000,
    )
    .await
    else {
        return Vec::new();
    };
    let Some(artist_id) = search["data"]
        .as_array()
        .and_then(|a| a.first())
        .and_then(|r| r["artist"]["id"].as_u64())
    else {
        return Vec::new();
    };
    let Ok(radio) = get_json(
        &format!("https://api.deezer.com/artist/{artist_id}/radio"),
        &[("limit", "16")],
        800_000,
    )
    .await
    else {
        return Vec::new();
    };
    radio["data"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|r| deezer_item(r, "track"))
        .collect()
}

pub async fn style_recommendations(
    seeds: &[Value],
    exclude_ids: &[String],
    direct: &crate::direct_catalog::DirectCatalog,
) -> Result<Vec<Value>> {
    let Some(primary) = seeds.first() else {
        return Ok(Vec::new());
    };
    let mut excluded_ids: std::collections::HashSet<String> =
        exclude_ids.iter().cloned().collect();
    let mut excluded_keys: std::collections::HashSet<String> = std::collections::HashSet::new();
    for t in seeds {
        excluded_ids.insert(s(t, "id").to_string());
        excluded_keys.insert(norm_key(s(t, "title"), s(t, "artist")));
    }

    let seed_title = s(primary, "title").to_string();
    let seed_artist = s(primary, "artist").to_string();
    let mut yt_seed_id = if s(primary, "source") == "youtube" {
        s(primary, "sourceId").to_string()
    } else {
        s(primary, "playbackId").to_string()
    };

    if yt_seed_id.len() != 11 {
        let req = json!({ "query": format!("{seed_title} {seed_artist}"), "kind": "track", "cursor": {} });
        if let Ok(found) = direct.search("youtube", &req).await {
            if let Some(id) = found["items"]
                .as_array()
                .and_then(|a| a.first())
                .map(|v| s(v, "sourceId").to_string())
            {
                yt_seed_id = id;
            }
        }
    }

    let (yt_mix, dz_mix) = tokio::join!(
        async {
            if yt_seed_id.len() == 11 {
                crate::direct_catalog::youtube_radio_mix(&yt_seed_id)
                    .await
                    .unwrap_or_default()
            } else {
                Vec::new()
            }
        },
        deezer_artist_radio(&seed_title, &seed_artist)
    );

    let mut results = Vec::new();
    // Interleave YouTube Radio Mix (great for regional/Funk/Montagem/Trap/Electronic) and Deezer Artist Radio
    let max_len = yt_mix.len().max(dz_mix.len());
    for i in 0..max_len {
        for candidate in [yt_mix.get(i), dz_mix.get(i)].into_iter().flatten() {
            let cid = s(candidate, "id").to_string();
            let key = norm_key(s(candidate, "title"), s(candidate, "artist"));
            if excluded_ids.contains(&cid) || excluded_keys.contains(&key) {
                continue;
            }
            excluded_ids.insert(cid);
            excluded_keys.insert(key);
            let mut item = candidate.clone();
            item["recommended"] = json!(true);
            results.push(item);
            if results.len() >= 10 {
                return Ok(results);
            }
        }
    }
    Ok(results)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_apple_song_and_album_links_cleanly() {
        let song = url::Url::parse(
            "https://music.apple.com/br/album/random-access-memories/617154241?i=617154366",
        )
        .unwrap();
        assert_eq!(
            parse_apple_url(&song).unwrap(),
            ("br".into(), "track", "617154366".into())
        );
        let album = url::Url::parse(
            "https://music.apple.com/us/album/random-access-memories/617154241",
        )
        .unwrap();
        assert_eq!(
            parse_apple_url(&album).unwrap(),
            ("us".into(), "album", "617154241".into())
        );
    }

    #[test]
    fn parses_bandcamp_durations_and_subdomains_strictly() {
        assert_eq!(parse_iso_duration("P00H03M35S"), 215.0);
        assert_eq!(parse_iso_duration("PT4M12S"), 252.0);
        assert!(is_bandcamp("c418.bandcamp.com"));
        assert!(!is_bandcamp("bandcamp.com"));
        assert!(!is_bandcamp("evil.bandcamp.com.attacker.test"));
    }

    #[test]
    fn deezer_and_apple_items_pass_strict_track_validation() {
        let dz = deezer_item(
            &json!({
                "id": 916424,
                "title": "Harder, Better, Faster, Stronger",
                "duration": 224,
                "artist": { "name": "Daft Punk" },
                "album": {
                    "title": "Discovery",
                    "cover_big": "https://cdn-images.dzcdn.net/images/cover/abc/500x500.jpg"
                }
            }),
            "track",
        )
        .unwrap();
        assert_eq!(dz["source"], "link");
        assert_eq!(dz["duration"], 224.0);
        assert_eq!(dz["album"], "Discovery");

        let am = apple_item(
            &json!({
                "wrapperType": "track",
                "trackId": 617154366,
                "collectionId": 617154241,
                "trackName": "Get Lucky",
                "artistName": "Daft Punk",
                "collectionName": "Random Access Memories",
                "trackTimeMillis": 369629,
                "artworkUrl100": "https://is1-ssl.mzstatic.com/image/thumb/Music115/v4/test/100x100bb.jpg"
            }),
            "br",
        )
        .unwrap();
        assert_eq!(am["title"], "Get Lucky");
        assert!(s(&am, "artwork").contains("500x500bb.jpg"));
    }

    #[test]
    fn parses_letras_jsonp_and_strips_highlight_html() {
        let parsed = parse_letras_jsonp(
            r#"LetrasSug({"response":{"docs":[{"t":"2","txt":"Blinding Lights","art":"The Weeknd"}]}})"#,
        )
        .unwrap();
        assert_eq!(parsed["response"]["docs"][0]["txt"], "Blinding Lights");
        assert_eq!(
            clean_lyric_snippet("<b>I</b> <b>said</b>:\n<b>Ooh</b>, I'm blinded"),
            "I said: Ooh, I'm blinded"
        );
    }
}
