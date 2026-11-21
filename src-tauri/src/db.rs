use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};
use std::{
    path::Path,
    time::{SystemTime, UNIX_EPOCH},
};
pub type Result<T> = std::result::Result<T, String>;
pub fn now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}
pub fn s<'a>(v: &'a Value, key: &str) -> &'a str {
    v[key].as_str().unwrap_or("")
}
pub fn defaults() -> Value {
    json!({"uiStyle":"matte","transition":"fade","transitionSeconds":3,"volumeBoost":0,"limiter":true,"outputDevice":"default","jamEndpoint":"","autoUpdate":true,"autoplay":true,"theme":"dark","glass":20,"blur":24,"accent":"#52b79a","autoAccent":false,"reducedMotion":false,"performance":false,"volume":65,"repeat":"off","shuffle":false,"tray":true,"startup":false,"notifications":false,"notificationMode":"off","globalShortcuts":false,"coverCacheMB":128,"eq":[0,0,0,0,0],"onlineConsent":false,"catalogConsent":false,"onboardingDone":false})
}
pub fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 200
        && id
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"_:.-".contains(&c))
}
pub fn official_url(raw: &str) -> bool {
    url::Url::parse(raw).is_ok_and(|u| {
        u.scheme() == "https"
            && u.username().is_empty()
            && u.password().is_none()
            && u.port().is_none()
            && matches!(
                u.host_str(),
                Some(
                    "youtube.com"
                        | "www.youtube.com"
                        | "music.youtube.com"
                        | "youtu.be"
                        | "soundcloud.com"
                        | "www.soundcloud.com"
                        | "policies.google.com"
                        | "developers.google.com"
                        | "developers.soundcloud.com"
                )
            )
    })
}
pub fn artwork_url(raw: &str) -> bool {
    if let Some(name) = raw.strip_prefix("/covers/") {
        return name.ends_with(".svg")
            && name
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || b"-_.".contains(&c))
            && !name.contains("..");
    }
    if let Some(name) = raw.strip_prefix("glass://app/covers/") {
        return name.split_once('.').is_some_and(|(hash, ext)| {
            !hash.is_empty()
                && hash.bytes().all(|c| c.is_ascii_hexdigit())
                && ["jpg", "png", "webp"].contains(&ext)
        });
    }
    url::Url::parse(raw).is_ok_and(|u| {
        u.scheme() == "https"
            && u.username().is_empty()
            && u.password().is_none()
            && u.port().is_none()
            && matches!(
                u.host_str(),
                Some(
                    "i.ytimg.com"
                        | "i9.ytimg.com"
                        | "lh3.googleusercontent.com"
                        | "i1.sndcdn.com"
                        | "i2.sndcdn.com"
                        | "i.scdn.co"
                        | "mosaic.scdn.co"
                        | "image-cdn-fa.spotifycdn.com"
                        | "image-cdn-ak.spotifycdn.com"
                        | "cdn-images.dzcdn.net"
                        | "e-cdns-images.dzcdn.net"
                        | "cdns-images.dzcdn.net"
                        | "is1-ssl.mzstatic.com"
                        | "is2-ssl.mzstatic.com"
                        | "is3-ssl.mzstatic.com"
                        | "is4-ssl.mzstatic.com"
                        | "is5-ssl.mzstatic.com"
                        | "f4.bcbits.com"
                        | "resources.tidal.com"
                        | "akamai.sscdn.co"
                )
            )
    })
}
pub fn playlist_artwork_url(raw: &str) -> bool {
    if artwork_url(raw) {
        return true;
    }
    raw.len() <= 1_800_000
        && ["data:image/jpeg;base64,", "data:image/png;base64,", "data:image/webp;base64,"]
            .iter()
            .any(|prefix| {
                raw.strip_prefix(prefix)
                    .is_some_and(|d| !d.is_empty() && d.bytes().all(|c| c.is_ascii_alphanumeric() || b"+/=".contains(&c)))
            })
}
pub fn validate_track(t: &Value) -> Result<()> {
    let source = s(t, "source");
    let id = s(t, "sourceId");
    if !["local", "youtube", "soundcloud", "link"].contains(&source)
        || !valid_id(id)
        || s(t, "id") != format!("{source}:{id}")
        || !valid_id(s(t, "id"))
        || !["track", "artist", "playlist", "album"].contains(&s(t, "kind"))
    {
        return Err("Referência de faixa inválida.".into());
    }
    for key in ["title", "artist"] {
        if s(t, key).trim().is_empty() || s(t, key).len() > 2000 {
            return Err("Título ou artista inválido.".into());
        }
    }
    if !t["duration"]
        .as_f64()
        .is_some_and(|v| (0.0..=604800.0).contains(&v))
        || !t["addedAt"].as_f64().is_some_and(|v| v >= 0.0)
    {
        return Err("Duração inválida.".into());
    }
    if source == "youtube"
        && s(t, "kind") == "track"
        && !(id.len() == 11
            && id
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || b"_-".contains(&c)))
    {
        return Err("ID de vídeo inválido.".into());
    }
    if let Some(u) = t["url"].as_str() {
        if u.len() > 2048
            || !(official_url(u) || (source == "link" && crate::links::public_url(u)))
            || (source == "soundcloud"
                && !url::Url::parse(u)
                    .unwrap()
                    .host_str()
                    .is_some_and(|h| ["soundcloud.com", "www.soundcloud.com"].contains(&h)))
        {
            return Err("Link não autorizado.".into());
        }
    }
    if let Some(u) = t["artwork"].as_str() {
        if u.len() > 2048 || !artwork_url(u) {
            return Err("Capa não autorizada.".into());
        }
    }
    if let Some(id) = t.get("playbackId") {
        if source != "link" || s(t,"kind") != "track" || !id.as_str().is_some_and(|id|id.len()==11&&id.bytes().all(|b|b.is_ascii_alphanumeric()||b"_-".contains(&b))) {
            return Err("Referência de reprodução inválida.".into());
        }
    }
    if let Some(cs) = t.get("catalogSource") {
        if !cs.as_str().is_some_and(|v| {
            ["spotify", "deezer", "ytmusic", "youtube", "soundcloud", "local"].contains(&v)
        }) {
            return Err("Origem de catálogo inválida.".into());
        }
    }
    if let Some(sp) = t.get("streamProvider") {
        if !sp.as_str().is_some_and(|v| {
            ["ytmusic", "youtube", "soundcloud", "deezer", "local"].contains(&v)
        }) {
            return Err("Provedor de stream inválido.".into());
        }
    }
    if let Some(dms) = t.get("durationMs") {
        if !dms.as_f64().is_some_and(|v| (0.0..=604_800_000.0).contains(&v)) {
            return Err("Duração em ms inválida.".into());
        }
    }
    if let Some(isrc) = t.get("isrc") {
        if !isrc.as_str().is_some_and(|v| {
            (12..=15).contains(&v.len())
                && v.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
        }) {
            return Err("ISRC inválido.".into());
        }
    }
    if let Some(ext_id) = t.get("resolvedExternalId") {
        if !ext_id.as_str().is_some_and(|v| {
            !v.is_empty()
                && v.len() <= 200
                && v.bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"_:.-/".contains(&b))
        }) {
            return Err("ID externo de stream inválido.".into());
        }
    }
    if let Some(stream_url) = t.get("resolvedStreamUrl") {
        let valid = stream_url.as_str().is_some_and(|raw| {
            crate::links::public_url(raw)
                || url::Url::parse(raw).is_ok_and(|u| {
                    u.scheme() == "http"
                        && u.host_str() == Some("127.0.0.1")
                        && u.username().is_empty()
                        && u.password().is_none()
                        && (u.path().starts_with("/audio/")
                            || u.path().starts_with("/offline/")
                            || u.path().starts_with("/media/"))
                })
        });
        if !valid {
            return Err("URL de stream resolvida inválida.".into());
        }
    }
    if t.to_string().len() > 14000 {
        return Err("Metadados muito grandes.".into());
    }
    Ok(())
}

#[derive(Clone, Debug)]
pub struct StreamMapping {
    pub source_track_id: String,
    pub catalog_source: String,
    pub resolved_provider: String,
    pub resolved_id: String,
    pub resolved_url: Option<String>,
    pub duration_delta: f64,
    pub score: f64,
    pub updated_at: i64,
}

pub fn canonical_mapping_key(track: &Value) -> String {
    if let Some(raw_url) = track["url"].as_str() {
        if let Ok(u) = url::Url::parse(raw_url) {
            if u.host_str() == Some("open.spotify.com") {
                let parts: Vec<_> = u.path_segments().into_iter().flatten().collect();
                if let Some(idx) = parts.iter().position(|p| *p == "track") {
                    if let Some(sp_id) = parts.get(idx + 1) {
                        if sp_id.len() == 22 && sp_id.bytes().all(|b| b.is_ascii_alphanumeric()) {
                            return format!("spotify:track:{sp_id}");
                        }
                    }
                }
            }
        }
    }
    s(track, "id").to_string()
}
pub fn validate_prefs(p: &Value) -> Result<()> {
    if !["dark", "light", "system"].contains(&s(p, "theme"))
        || !["off", "all", "one"].contains(&s(p, "repeat"))
    {
        return Err("Preferência inválida.".into());
    }
    if p.get("uiStyle").is_some() && !["matte", "glass"].contains(&s(p, "uiStyle")) {
        return Err("Estilo inválido.".into());
    }
    if p.get("notificationMode").is_some()
        && !["off", "background", "always"].contains(&s(p, "notificationMode"))
    {
        return Err("Modo de notificação inválido.".into());
    }
    if p.get("transition").is_some()&&! ["off","fade","crossfade"].contains(&s(p,"transition")){return Err("Transição inválida.".into());}
    for(key,lo,hi)in [("transitionSeconds",0.5,10.0),("volumeBoost",0.0,12.0)]{if p.get(key).is_some()&&!p[key].as_f64().is_some_and(|n|n.is_finite()&&n>=lo&&n<=hi){return Err("Áudio fora dos limites.".into());}}
    for key in ["limiter","autoUpdate","autoplay"]{if p.get(key).is_some()&&!p[key].is_boolean(){return Err("Preferência inválida.".into());}}
    if p.get("outputDevice").is_some()&&(!p["outputDevice"].is_string()||s(p,"outputDevice").len()>300){return Err("Dispositivo inválido.".into());}
    if p.get("jamEndpoint").is_some(){crate::jam::validate_endpoint(s(p,"jamEndpoint"))?;}
    let accent = s(p, "accent");
    if accent.len() != 7
        || !accent.starts_with('#')
        || !accent[1..].bytes().all(|c| c.is_ascii_hexdigit())
    {
        return Err("Cor inválida.".into());
    }
    for (key, max) in [
        ("glass", 100.0),
        ("blur", 48.0),
        ("volume", 100.0),
        ("coverCacheMB", 512.0),
    ] {
        if !p[key].as_f64().is_some_and(|v| v >= 0.0 && v <= max) {
            return Err("Valor fora dos limites.".into());
        }
    }
    for key in [
        "autoAccent",
        "reducedMotion",
        "performance",
        "shuffle",
        "tray",
        "startup",
        "notifications",
        "globalShortcuts",
        "onlineConsent",
        "catalogConsent",
        "onboardingDone",
    ] {
        if !p[key].is_boolean() {
            return Err("Preferência inválida.".into());
        }
    }
    if !p["eq"].as_array().is_some_and(|a| {
        a.len() == 5
            && a.iter()
                .all(|v| v.as_f64().is_some_and(|n| (-12.0..=12.0).contains(&n)))
    }) {
        return Err("Equalizador inválido.".into());
    }
    if let Some(a) = p.get("appearance") {
        if !a.is_object() { return Err("Aparência inválida.".into()); }
        if a.get("material").is_some() && !["floating","frosted","clear","subtle"].contains(&s(a,"material")) { return Err("Material inválido.".into()); }
        for (key,lo,hi) in [("blur",0.0,24.0),("refraction",0.0,12.0),("opacity",0.0,0.14),("saturation",0.5,2.0),("specular",0.0,1.0),("chromatic",0.0,0.2),("thickness",3.0,30.0),("ior",1.0,2.0),("fresnel",0.0,1.0),("edge",0.0,1.0),("scale",90.0,125.0)] {
            if !a[key].as_f64().is_some_and(|v| v>=lo&&v<=hi) { return Err("Aparência fora dos limites.".into()); }
        }
        if !["auto","economy","balanced","high"].contains(&s(a,"quality")) || !["dynamic","ambient","desktop","custom","solid"].contains(&s(a,"background")) || !a["sidebarCompact"].is_boolean() || (a.get("audioReactive").is_some() && !a["audioReactive"].is_boolean()) { return Err("Aparência inválida.".into()); }
        for (key,lo,hi) in [("backgroundMotion",0.0,1.0),("gradientIntensity",0.1,1.0)] {
            if a.get(key).is_some()&&!a[key].as_f64().is_some_and(|n|n>=lo&&n<=hi){return Err("Movimento de fundo inválido.".into());}
        }
        for key in ["tint","solidColor"] { let color=s(a,key);if color.len()!=7||!color.starts_with('#')||!color[1..].bytes().all(|c|c.is_ascii_hexdigit()){return Err("Cor inválida.".into());} }
        let img=s(a,"customImage");
        if img.len()>2_800_000 || (!img.is_empty() && !["data:image/jpeg;base64,","data:image/png;base64,","data:image/webp;base64,"].iter().any(|prefix|img.strip_prefix(prefix).is_some_and(|data|data.bytes().all(|c|c.is_ascii_alphanumeric()||b"+/=".contains(&c))))) {return Err("Imagem de fundo inválida.".into());}
    }
    Ok(())
}
pub struct Library {
    pub db: Connection,
}
impl Library {
    pub fn open(path: &Path) -> Result<Self> {
        let db = Connection::open(path).map_err(|e| e.to_string())?;
        db.execute_batch("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS tracks(id TEXT PRIMARY KEY,data TEXT NOT NULL,local_path TEXT,refreshed INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS playlists(id TEXT PRIMARY KEY,name TEXT NOT NULL,created INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS playlist_tracks(playlist_id TEXT REFERENCES playlists(id) ON DELETE CASCADE,track_id TEXT REFERENCES tracks(id) ON DELETE CASCADE,position INTEGER NOT NULL,PRIMARY KEY(playlist_id,track_id));
      CREATE TABLE IF NOT EXISTS offline_tracks(track_id TEXT PRIMARY KEY REFERENCES tracks(id) ON DELETE CASCADE,path TEXT NOT NULL,size INTEGER NOT NULL,duration REAL NOT NULL,created INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS likes(track_id TEXT PRIMARY KEY REFERENCES tracks(id) ON DELETE CASCADE);
      CREATE TABLE IF NOT EXISTS history(track_id TEXT REFERENCES tracks(id) ON DELETE CASCADE,played INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS history_played ON history(played DESC);
      CREATE TABLE IF NOT EXISTS track_stream_mappings(
        source_track_id TEXT PRIMARY KEY,
        catalog_source TEXT NOT NULL,
        resolved_provider TEXT NOT NULL,
        resolved_id TEXT NOT NULL,
        resolved_url TEXT,
        duration_delta REAL NOT NULL DEFAULT 0,
        score REAL NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_stream_mappings_updated ON track_stream_mappings(updated_at DESC);
      CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,value TEXT NOT NULL); PRAGMA user_version=1;").map_err(|e|e.to_string())?;
        let _ = db.execute(
            "DELETE FROM track_stream_mappings WHERE updated_at < ?",
            params![now() - 30 * 86_400_000],
        );
        let this = Self { db };
        let expired = this.query(
            "SELECT data FROM tracks WHERE refreshed < ?",
            params![now() - 28 * 86400000],
        )?;
        for mut t in expired {
            if s(&t, "source") != "local" {
                t["title"] = json!(if s(&t, "source") == "youtube" {
                    "Vídeo do YouTube"
                } else {
                    "Faixa do SoundCloud"
                });
                t["artist"] = t["source"].clone();
                t["duration"] = json!(0);
                if let Some(o) = t.as_object_mut() {
                    o.remove("artwork");
                }
                this.db
                    .execute(
                        "UPDATE tracks SET data=? WHERE id=?",
                        params![t.to_string(), s(&t, "id")],
                    )
                    .map_err(|e| e.to_string())?;
            }
        }
        let _ = this.clean_cloned_playlist_covers();
        Ok(this)
    }

    pub fn clean_cloned_playlist_covers(&self) -> Result<usize> {
        let mut cleaned = 0usize;
        // 1. Strip known Spotify playlist-only cover hosts/prefixes from individual link tracks
        let all_links = self.query(
            "SELECT data FROM tracks WHERE json_extract(data,'$.source')='link' AND json_extract(data,'$.artwork') IS NOT NULL",
            [],
        )?;
        for t in &all_links {
            let art = s(t, "artwork");
            let is_playlist_only_cover = art.contains("://mosaic.scdn.co/")
                || art.contains("://image-cdn-fa.spotifycdn.com/")
                || art.contains("://image-cdn-ak.spotifycdn.com/")
                || art.contains("/image/ab67706");
            if is_playlist_only_cover {
                self.db
                    .execute(
                        "UPDATE tracks SET data=json_remove(data,'$.artwork') WHERE id=?",
                        [s(t, "id")],
                    )
                    .map_err(|e| e.to_string())?;
                cleaned += 1;
            }
        }

        // 2. Strip playlist cover cloned across multiple artists inside the same playlist
        let playlists = self.query(
            "SELECT json_object('id',id,'artwork',(SELECT value FROM settings WHERE key='playlist-artwork:'||playlists.id)) FROM playlists",
            [],
        )?;
        for pl in playlists {
            let pid = s(&pl, "id");
            let p_art = s(&pl, "artwork");
            if pid.is_empty() || p_art.is_empty() {
                continue;
            }
            let members = self.query(
                "SELECT t.data FROM playlist_tracks pt JOIN tracks t ON t.id=pt.track_id WHERE pt.playlist_id=?",
                [pid],
            )?;
            let matching: Vec<&Value> = members
                .iter()
                .filter(|t| s(t, "source") == "link" && s(t, "artwork") == p_art)
                .collect();
            if matching.len() < 2 {
                continue;
            }
            let distinct_artists: std::collections::HashSet<String> = matching
                .iter()
                .map(|t| s(t, "artist").trim().to_lowercase())
                .filter(|a| !a.is_empty())
                .collect();
            if distinct_artists.len() >= 2 {
                for t in matching {
                    self.db
                        .execute(
                            "UPDATE tracks SET data=json_remove(data,'$.artwork') WHERE id=?",
                            [s(t, "id")],
                        )
                        .map_err(|e| e.to_string())?;
                    cleaned += 1;
                }
            }
        }
        Ok(cleaned)
    }
    fn query<P: rusqlite::Params>(&self, sql: &str, params: P) -> Result<Vec<Value>> {
        let mut stmt = self.db.prepare(sql).map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(params, |r| r.get::<_, String>(0))
            .map_err(|e| e.to_string())?;
        rows.map(|r| {
            serde_json::from_str(&r.map_err(|e| e.to_string())?).map_err(|e| e.to_string())
        })
        .collect()
    }
    pub fn path(&self, id: &str) -> Option<String> {
        self.db
            .query_row("SELECT local_path FROM tracks WHERE id=?", [id], |r| {
                r.get::<_, Option<String>>(0)
            })
            .optional()
            .ok()
            .flatten()
            .flatten()
    }
    pub fn pref(&self) -> Value {
        let saved = self
            .db
            .query_row(
                "SELECT value FROM settings WHERE key='preferences'",
                [],
                |r| r.get::<_, String>(0),
            )
            .ok()
            .and_then(|s| serde_json::from_str::<Value>(&s).ok());
        let mut p = defaults();
        if let Some(o) = saved.and_then(|v| v.as_object().cloned()) {
            p.as_object_mut().unwrap().extend(o);
        }
        p
    }
    pub fn set_pref(&self, p: &Value) -> Result<()> {
        validate_prefs(p)?;
        self.db.execute("INSERT INTO settings VALUES('preferences',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",[p.to_string()]).map_err(|e|e.to_string())?;
        Ok(())
    }
    pub fn save(&self, t: &Value, path: Option<&str>) -> Result<()> {
        validate_track(t)?;
        let mut t = t.clone();
        if let Some(obj) = t.as_object_mut() {
            obj.remove("lyricSnippet");
            obj.remove("recommended");
        }
        if s(&t,"artwork").is_empty(){if let Ok(Some(art))=self.db.query_row("SELECT json_extract(data,'$.artwork') FROM tracks WHERE id=?",[s(&t,"id")],|row|row.get::<_,Option<String>>(0)){if artwork_url(&art){t["artwork"]=json!(art);}}}
        if s(&t, "source") == "local" && path.is_none() && self.path(s(&t, "id")).is_none() {
            t["available"] = json!(false);
            t["reason"] = json!("Importe novamente o arquivo neste computador.");
        }
        self.db.execute("INSERT INTO tracks VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data,local_path=COALESCE(excluded.local_path,tracks.local_path),refreshed=excluded.refreshed",params![s(&t,"id"),t.to_string(),path,now()]).map_err(|e|e.to_string())?;
        Ok(())
    }
    pub fn get_stream_mapping(&self, key: &str) -> Option<StreamMapping> {
        let cutoff = now() - 30 * 86_400_000;
        self.db
            .query_row(
                "SELECT source_track_id, catalog_source, resolved_provider, resolved_id, resolved_url, duration_delta, score, updated_at
                 FROM track_stream_mappings
                 WHERE source_track_id = ? AND updated_at >= ?",
                params![key, cutoff],
                |r| {
                    Ok(StreamMapping {
                        source_track_id: r.get(0)?,
                        catalog_source: r.get(1)?,
                        resolved_provider: r.get(2)?,
                        resolved_id: r.get(3)?,
                        resolved_url: r.get(4)?,
                        duration_delta: r.get(5)?,
                        score: r.get(6)?,
                        updated_at: r.get(7)?,
                    })
                },
            )
            .optional()
            .ok()
            .flatten()
    }

    pub fn save_stream_mapping(&self, m: &StreamMapping) -> Result<()> {
        if !valid_id(&m.source_track_id)
            || !["spotify", "deezer", "ytmusic", "youtube", "soundcloud", "local"]
                .contains(&m.catalog_source.as_str())
            || !["ytmusic", "youtube", "soundcloud", "deezer"].contains(&m.resolved_provider.as_str())
            || m.resolved_id.is_empty()
            || m.resolved_id.len() > 200
        {
            return Err("Mapeamento de stream inválido.".into());
        }
        self.db
            .execute(
                "INSERT INTO track_stream_mappings(source_track_id, catalog_source, resolved_provider, resolved_id, resolved_url, duration_delta, score, updated_at)
                 VALUES(?, ?, ?, ?, ?, ?, ?, ?)
                 ON CONFLICT(source_track_id) DO UPDATE SET
                   catalog_source = excluded.catalog_source,
                   resolved_provider = excluded.resolved_provider,
                   resolved_id = excluded.resolved_id,
                   resolved_url = excluded.resolved_url,
                   duration_delta = excluded.duration_delta,
                   score = excluded.score,
                   updated_at = excluded.updated_at",
                params![
                    m.source_track_id,
                    m.catalog_source,
                    m.resolved_provider,
                    m.resolved_id,
                    m.resolved_url,
                    m.duration_delta,
                    m.score,
                    m.updated_at
                ],
            )
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn invalidate_stream_mapping(&self, key: &str) -> Result<()> {
        self.db
            .execute(
                "DELETE FROM track_stream_mappings WHERE source_track_id = ?",
                [key],
            )
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn snapshot(&self) -> Result<Value> {
        let mut tracks = self.query(
            "SELECT CASE WHEN EXISTS(SELECT 1 FROM offline_tracks WHERE track_id=tracks.id) THEN json_set(data,'$.offline',json('true')) ELSE json_remove(data,'$.offline') END FROM tracks ORDER BY refreshed DESC LIMIT 20000",
            [],
        )?;
        let mut mappings = std::collections::HashMap::new();
        if let Ok(mut stmt) = self.db.prepare(
            "SELECT source_track_id, resolved_provider, resolved_id, resolved_url FROM track_stream_mappings",
        ) {
            if let Ok(rows) = stmt.query_map([], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, Option<String>>(3)?,
                ))
            }) {
                for row in rows.flatten() {
                    mappings.insert(row.0, (row.1, row.2, row.3));
                }
            }
        }
        if !mappings.is_empty() {
            for t in &mut tracks {
                let key = canonical_mapping_key(t);
                if let Some((prov, rid, rurl)) = mappings
                    .get(&key)
                    .or_else(|| mappings.get(s(t, "id")))
                {
                    t["streamProvider"] = json!(prov);
                    t["resolvedExternalId"] = json!(rid);
                    if let Some(u) = rurl {
                        if crate::links::public_url(u) {
                            t["resolvedStreamUrl"] = json!(u);
                        }
                    }
                    if s(t, "source") == "link"
                        && ["ytmusic", "youtube"].contains(&prov.as_str())
                        && rid.len() == 11
                        && rid.bytes().all(|b| b.is_ascii_alphanumeric() || b"_-".contains(&b))
                    {
                        t["playbackId"] = json!(rid);
                    }
                }
            }
        }
        let playlists=self.query("SELECT json_object('id',id,'name',name,'createdAt',created,'artwork',(SELECT value FROM settings WHERE key='playlist-artwork:'||playlists.id),'description',(SELECT value FROM settings WHERE key='playlist-desc:'||playlists.id),'trackIds',json(COALESCE((SELECT json_group_array(track_id) FROM (SELECT track_id FROM playlist_tracks WHERE playlist_id=playlists.id ORDER BY position)),'[]'))) FROM playlists ORDER BY created DESC",[])?;
        let likes = self.query("SELECT json_quote(track_id) FROM likes", [])?;
        let history=self.query("SELECT json_object('id',track_id,'playedAt',played) FROM history ORDER BY played DESC,rowid DESC LIMIT 500",[])?;
        Ok(
            json!({"tracks":tracks,"playlists":playlists,"likes":likes,"history":history,"preferences":self.pref()}),
        )
    }
    pub fn backup_to(&self, path: &Path) -> Result<()> {
        self.db
            .execute(
                "VACUUM main INTO ?",
                [path.to_str().ok_or("Pasta inválida.")?],
            )
            .map_err(|e| e.to_string())?;
        Ok(())
    }
    pub fn transact<T>(&self, f: impl FnOnce() -> Result<T>) -> Result<T> {
        self.db
            .execute_batch("BEGIN IMMEDIATE")
            .map_err(|e| e.to_string())?;
        match f() {
            Ok(v) => {
                self.db.execute_batch("COMMIT").map_err(|e| e.to_string())?;
                Ok(v)
            }
            Err(e) => {
                let _ = self.db.execute_batch("ROLLBACK");
                Err(e)
            }
        }
    }
    pub fn command(&self, c: &Value) -> Result<Value> {
        self.transact(||{
      let action=s(c,"action"); let id=s(c,"id"); let tid=s(c,"trackId");
      if c.get("track").is_some(){self.save(&c["track"],None)?;}
      let name=s(c,"name").trim(); if ["create","rename"].contains(&action) && (name.is_empty()||name.chars().count()>100){return Err("Escolha um nome de até 100 caracteres.".into());}
      let q=|sql:&str,p:&[&dyn rusqlite::ToSql]|self.db.execute(sql,p).map_err(|e|e.to_string());
      match action {
        "save"=>{validate_track(&c["track"])?;},
        "like"=>{let tid=s(&c["track"],"id"); if q("DELETE FROM likes WHERE track_id=?",&[&tid])?==0{q("INSERT INTO likes VALUES(?)",&[&tid])?;}},
        "history"=>{q("INSERT INTO history VALUES(?,?)",&[&s(&c["track"],"id"),&now()])?;q("DELETE FROM history WHERE rowid NOT IN (SELECT rowid FROM history ORDER BY played DESC,rowid DESC LIMIT 500)",&[])?;},
        "create"=>{q("INSERT INTO playlists VALUES(?,?,?)",&[&uuid::Uuid::new_v4().to_string(),&name,&now()])?;},
        "rename"=>{q("UPDATE playlists SET name=? WHERE id=?",&[&name,&id])?;},
        "delete"=>{q("DELETE FROM playlists WHERE id=?",&[&id])?;},
        "add"=>{q("INSERT OR IGNORE INTO playlist_tracks SELECT ?,?,COALESCE(MAX(position),-1)+1 FROM playlist_tracks WHERE playlist_id=?",&[&id,&s(&c["track"],"id"),&id])?;},
        "move"=>{let target=s(c,"targetId");if target==id||self.query("SELECT json_quote(id) FROM playlists WHERE id=?",[target])?.is_empty()||self.query("SELECT json_quote(track_id) FROM playlist_tracks WHERE playlist_id=? AND track_id=?",[id,tid])?.is_empty(){return Err("Escolha outra playlist válida para mover a faixa.".into());}q("INSERT OR IGNORE INTO playlist_tracks SELECT ?,?,COALESCE(MAX(position),-1)+1 FROM playlist_tracks WHERE playlist_id=?",&[&target,&tid,&target])?;q("DELETE FROM playlist_tracks WHERE playlist_id=? AND track_id=?",&[&id,&tid])?;},
        "remove"=>{q("DELETE FROM playlist_tracks WHERE playlist_id=? AND track_id=?",&[&id,&tid])?;},
        "removeTrack"=>{q("DELETE FROM tracks WHERE id=?",&[&id])?;},
        "clearHistory"=>{q("DELETE FROM history",&[])?;},
        "reorder"=>{let ids=c["trackIds"].as_array().ok_or("Ordem inválida")?;let current=self.query("SELECT json_quote(track_id) FROM playlist_tracks WHERE playlist_id=?",[id])?;let unique:std::collections::HashSet<_>=ids.iter().filter_map(Value::as_str).collect();if ids.len()!=current.len()||unique.len()!=current.len()||ids.iter().any(|v|!current.contains(v)){return Err("A ordem precisa conter cada faixa uma vez.".into());}for(i,tid)in ids.iter().enumerate(){q("UPDATE playlist_tracks SET position=? WHERE playlist_id=? AND track_id=?",&[&(i as i64),&id,&tid.as_str().unwrap()])?;}},
        _=>return Err("Operação não autorizada.".into())
      } Ok(())
    })?;
        self.snapshot()
    }
    pub fn offline_path(&self,id:&str)->Option<(String,f64)>{self.db.query_row("SELECT path,duration FROM offline_tracks WHERE track_id=?",[id],|r|Ok((r.get(0)?,r.get(1)?))).optional().ok().flatten()}
    pub fn save_offline(&self,id:&str,path:&str,size:u64,duration:f64)->Result<()>{self.db.execute("INSERT INTO offline_tracks VALUES(?,?,?,?,?) ON CONFLICT(track_id) DO UPDATE SET path=excluded.path,size=excluded.size,duration=excluded.duration,created=excluded.created",params![id,path,size as i64,duration,now()]).map_err(|e|e.to_string())?;Ok(())}
    pub fn commit_offline(&self, track:&Value, path:&str, size:u64, duration:f64)->Result<()>{
        validate_track(track)?;
        if path.is_empty()||path.len()>1024||size<512||size>250_000_000||!duration.is_finite()||!(0.0..=604800.0).contains(&duration){
            return Err("Metadados offline inválidos.".into());
        }
        self.transact(||{
            self.save(track,None)?;
            self.save_offline(s(track,"id"),path,size,duration)
        })
    }
    pub fn remove_offline(&self,id:&str)->Result<()>{self.db.execute("DELETE FROM offline_tracks WHERE track_id=?",[id]).map_err(|e|e.to_string())?;Ok(())}
    pub fn set_track_artwork(&self,id:&str,url:&str)->Result<()> {
        if !artwork_url(url){return Err("Capa inválida.".into());}
        self.db.execute("UPDATE tracks SET data=json_set(data,'$.artwork',?) WHERE id=?",params![url,id]).map_err(|e|e.to_string())?;Ok(())
    }
    pub fn collection_artwork(&self,id:&str,url:&str)->Result<()> {
        if !valid_id(id)||!playlist_artwork_url(url){return Ok(());}
        self.db.execute("INSERT OR REPLACE INTO settings VALUES(?,?)",params![format!("playlist-artwork:{id}"),url]).map_err(|e|e.to_string())?;Ok(())
    }
    pub fn collection_description(&self,id:&str,desc:&str)->Result<()> {
        if !valid_id(id){return Ok(());}
        let clean:String=desc.trim().chars().take(300).collect();
        if clean.is_empty(){
            self.db.execute("DELETE FROM settings WHERE key=?",[format!("playlist-desc:{id}")]).map_err(|e|e.to_string())?;
        }else{
            self.db.execute("INSERT OR REPLACE INTO settings VALUES(?,?)",params![format!("playlist-desc:{id}"),clean]).map_err(|e|e.to_string())?;
        }
        Ok(())
    }
    fn prepare_collection(key:&str,name:&str,tracks:&[Value])->Result<(String,String)>{
        use sha2::{Digest,Sha256};
        if key.len()>2048||name.trim().is_empty()||tracks.len()>1000{return Err("Playlist inválida ou maior que 1000 faixas.".into());}
        for t in tracks{validate_track(t)?;}
        Ok((format!("remote-{:x}",Sha256::digest(key.as_bytes())),name.chars().take(100).collect()))
    }
    fn merge_collection_inner(&self,id:&str,name:&str,tracks:&[Value],liked:bool,artwork:Option<&str>)->Result<()>{
        self.db.execute("INSERT INTO playlists VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name",params![id,name,now()]).map_err(|e|e.to_string())?;
        for t in tracks{
            self.save(t,None)?;
            self.db.execute("INSERT OR IGNORE INTO playlist_tracks SELECT ?,?,COALESCE(MAX(position),-1)+1 FROM playlist_tracks WHERE playlist_id=?",params![id,s(t,"id"),id]).map_err(|e|e.to_string())?;
            if liked{self.db.execute("INSERT OR IGNORE INTO likes VALUES(?)",[s(t,"id")]).map_err(|e|e.to_string())?;}
        }
        if let Some(artwork)=artwork{self.collection_artwork(id,artwork)?;}
        Ok(())
    }
    pub fn merge_collection(&self,key:&str,name:&str,tracks:&[Value],liked:bool)->Result<String>{
        let(id,name)=Self::prepare_collection(key,name,tracks)?;
        self.transact(||self.merge_collection_inner(&id,&name,tracks,liked,None))?;
        Ok(id)
    }
    pub fn merge_account_snapshot(&self,lists:&[(crate::collections::Collection,bool)])->Result<()>{
        if lists.len()>100{return Err("Número de playlists excede o limite da sincronização.".into());}
        let prepared=lists.iter().map(|(list,liked)|{
            let(id,name)=Self::prepare_collection(&list.key,&list.name,&list.tracks)?;
            Ok((id,name,list,*liked))
        }).collect::<Result<Vec<_>>>()?;
        self.transact(||{
            for(id,name,list,liked)in prepared{
                self.merge_collection_inner(&id,&name,&list.tracks,liked,Some(&list.artwork))?;
            }
            Ok(())
        })
    }
    pub fn export(&self, playlist: Option<&str>) -> Result<Value> {
        let mut snap = self.snapshot()?;
        if let Some(id) = playlist {
            snap["playlists"]
                .as_array_mut()
                .unwrap()
                .retain(|p| s(p, "id") == id);
            let ids: Vec<Value> = snap["playlists"]
                .as_array()
                .unwrap()
                .iter()
                .flat_map(|p| p["trackIds"].as_array().unwrap().clone())
                .collect();
            snap["tracks"]
                .as_array_mut()
                .unwrap()
                .retain(|t| ids.contains(&t["id"]));
            snap["likes"]
                .as_array_mut()
                .unwrap()
                .retain(|v| ids.contains(v));
        }
        Ok(
            json!({"format":"liquid-hub","version":1,"tracks":snap["tracks"],"playlists":snap["playlists"],"likes":snap["likes"]}),
        )
    }
    pub fn import(&self, v: &Value) -> Result<Value> {
        if !["liquid-hub", "glass-music"].contains(&s(v, "format")) || v["version"] != 1 {
            return Err("Formato de biblioteca inválido.".into());
        }
        let tracks = v["tracks"].as_array().ok_or("Faixas ausentes")?;
        let lists = v["playlists"].as_array().ok_or("Playlists ausentes")?;
        let likes = v["likes"].as_array().ok_or("Curtidas ausentes")?;
        if tracks.len() > 20000 || lists.len() > 1000 || likes.len() > 20000 {
            return Err("Biblioteca muito grande.".into());
        }
        let ids: std::collections::HashSet<&str> = tracks.iter().map(|t| s(t, "id")).collect();
        for t in tracks {
            validate_track(t)?;
        }
        for p in lists {
            let name = s(p, "name");
            let tids = p["trackIds"].as_array().ok_or("Playlist inválida")?;
            if name.trim().is_empty()
                || name.chars().count() > 100
                || tids.len() > 10000
                || tids.iter().any(|v| !ids.contains(v.as_str().unwrap_or("")))
            {
                return Err("Playlist ou referência inválida.".into());
            }
        }
        if likes
            .iter()
            .any(|v| !ids.contains(v.as_str().unwrap_or("")))
        {
            return Err("Curtida sem referência.".into());
        }
        self.transact(|| {
            for t in tracks {
                self.save(t, None)?;
            }
            for p in lists {
                let id = uuid::Uuid::new_v4().to_string();
                self.db
                    .execute(
                        "INSERT INTO playlists VALUES(?,?,?)",
                        params![id, s(p, "name"), now()],
                    )
                    .map_err(|e| e.to_string())?;
                self.collection_artwork(&id,s(p,"artwork"))?;
                for (i, t) in p["trackIds"].as_array().unwrap().iter().enumerate() {
                    self.db
                        .execute(
                            "INSERT OR IGNORE INTO playlist_tracks VALUES(?,?,?)",
                            params![id, t.as_str(), i as i64],
                        )
                        .map_err(|e| e.to_string())?;
                }
            }
            for tid in likes {
                self.db
                    .execute("INSERT OR IGNORE INTO likes VALUES(?)", [tid.as_str()])
                    .map_err(|e| e.to_string())?;
            }
            Ok(())
        })?;
        self.snapshot()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn track(id: &str) -> Value {
        json!({"id":format!("local:{id}"),"source":"local","sourceId":id,"kind":"track","title":id,"artist":"Teste","duration":3,"addedAt":now()})
    }
    fn collection(key:&str,name:&str,tracks:Vec<Value>)->crate::collections::Collection{
        crate::collections::Collection{artwork:"https://i.scdn.co/image/account-test".into(),key:key.into(),name:name.into(),tracks,warning:String::new(),skipped:0}
    }
    #[test]
    fn move_is_atomic_deduplicated_and_preserves_other_tracks(){
      let db=Library::open(Path::new(":memory:")).unwrap();
      let a=db.merge_collection("move:a","A",&[track("a"),track("b")],false).unwrap();
      let b=db.merge_collection("move:b","B",&[track("c"),track("a")],false).unwrap();
      let before=db.snapshot().unwrap();assert!(db.command(&json!({"action":"move","id":a,"targetId":"missing","trackId":"local:a"})).is_err());assert_eq!(db.snapshot().unwrap(),before);
      db.command(&json!({"action":"move","id":a,"targetId":b,"trackId":"local:a"})).unwrap();let after=db.snapshot().unwrap();let lists=after["playlists"].as_array().unwrap();
      assert_eq!(lists.iter().find(|p|p["id"]==a).unwrap()["trackIds"],json!(["local:b"]));assert_eq!(lists.iter().find(|p|p["id"]==b).unwrap()["trackIds"],json!(["local:c","local:a"]));assert_eq!(after["tracks"],before["tracks"]);
      assert!(db.command(&json!({"action":"move","id":a,"targetId":b,"trackId":"local:a"})).is_err());assert_eq!(db.snapshot().unwrap(),after);
    }
    #[test]
    fn repaired_artwork_keeps_order_and_survives_stale_metadata(){
      let db=Library::open(Path::new(":memory:")).unwrap();db.save(&track("a"),Some("C:/a.wav")).unwrap();let before=db.snapshot().unwrap();let url="https://i.scdn.co/image/ab67616d00001e02test";
      db.set_track_artwork("local:a",url).unwrap();assert_eq!(db.snapshot().unwrap()["tracks"][0]["artwork"],url);db.save(&track("a"),None).unwrap();assert_eq!(db.snapshot().unwrap()["tracks"][0]["artwork"],url);assert_eq!(before["tracks"][0]["id"],db.snapshot().unwrap()["tracks"][0]["id"]);assert!(db.set_track_artwork("local:a","https://evil.example/image").is_err());
    }
    #[test]
    fn remote_merge_is_idempotent_and_validates_before_writing(){
        let db=Library::open(Path::new(":memory:")).unwrap();
        let id=db.merge_collection("remote:test","Lista",&[track("a"),track("b")],true).unwrap();
        let again=db.merge_collection("remote:test","Lista",&[track("a"),track("c")],true).unwrap();assert_eq!(id,again);
        let snap=db.snapshot().unwrap();assert_eq!(snap["playlists"].as_array().unwrap().len(),1);assert_eq!(snap["playlists"][0]["trackIds"],json!(["local:a","local:b","local:c"]));assert_eq!(snap["likes"].as_array().unwrap().len(),3);
        let mut bad=track("x");bad["source"]=json!("invalid");assert!(db.merge_collection("remote:test","Bad",&[track("d"),bad],false).is_err());assert_eq!(db.snapshot().unwrap(),snap);
    }
    #[test]
    fn account_snapshot_is_additive_supports_empty_lists_and_preserves_local_order(){
        let db=Library::open(Path::new(":memory:")).unwrap();
        db.merge_account_snapshot(&[(collection("account:p:user:empty","Vazia",vec![]),false)]).unwrap();
        let empty=db.snapshot().unwrap();
        assert_eq!(empty["playlists"][0]["trackIds"],json!([]));

        let id=db.merge_collection("account:p:user:list","Conta",&[track("a"),track("b")],true).unwrap();
        db.command(&json!({"action":"add","id":id,"track":track("local-extra")})).unwrap();
        db.command(&json!({"action":"reorder","id":id,"trackIds":["local:b","local:a","local:local-extra"]})).unwrap();
        db.merge_account_snapshot(&[(collection("account:p:user:list","Conta",vec![track("b")]),false)]).unwrap();
        let snap=db.snapshot().unwrap();
        let list=snap["playlists"].as_array().unwrap().iter().find(|p|p["id"]==id).unwrap();
        assert_eq!(list["trackIds"],json!(["local:b","local:a","local:local-extra"]));
        assert!(snap["likes"].as_array().unwrap().contains(&json!("local:a")));

        db.merge_account_snapshot(&[(collection("account:p:user:list","Conta",vec![]),false)]).unwrap();
        assert_eq!(db.snapshot().unwrap()["playlists"].as_array().unwrap().iter().find(|p|p["id"]==id).unwrap()["trackIds"],list["trackIds"]);
    }
    #[test]
    fn account_snapshot_validates_every_list_and_rolls_back_tracks_and_artwork(){
        let db=Library::open(Path::new(":memory:")).unwrap();
        let before=db.snapshot().unwrap();
        let mut bad=track("bad");bad["source"]=json!("invalid");
        let lists=vec![(collection("account:p:user:good","Boa",vec![track("good")]),true),(collection("account:p:user:bad","Ruim",vec![bad]),false)];
        assert!(db.merge_account_snapshot(&lists).is_err());
        assert_eq!(db.snapshot().unwrap(),before);
    }
    #[test]
    fn offline_commit_rolls_back_track_metadata_and_preserves_previous_record(){
        let db=Library::open(Path::new(":memory:")).unwrap();
        db.save(&track("a"),None).unwrap();
        db.save_offline("local:a","C:/old.webm",512,3.0).unwrap();
        db.db.execute("CREATE TRIGGER reject_offline_update BEFORE UPDATE ON offline_tracks BEGIN SELECT RAISE(ABORT,'blocked'); END",[]).unwrap();
        let mut replacement=track("a");replacement["title"]=json!("new title");
        assert!(db.commit_offline(&replacement,"C:/new.webm",1024,3.0).is_err());
        assert_eq!(db.offline_path("local:a"),Some(("C:/old.webm".into(),3.0)));
        assert_eq!(db.snapshot().unwrap()["tracks"][0]["title"],"a");
    }
    #[test]
    fn upgrade_preserves_preferences_without_granting_catalog_consent() {
        let db = Library::open(Path::new(":memory:")).unwrap();
        let mut old = defaults();
        old.as_object_mut().unwrap().remove("catalogConsent");
        old["onlineConsent"] = json!(true);
        old["volume"] = json!(23);
        db.db.execute("INSERT OR REPLACE INTO settings VALUES('preferences',?)", [old.to_string()]).unwrap();
        let upgraded = db.pref();
        assert_eq!(upgraded["onlineConsent"], true);
        assert_eq!(upgraded["volume"], 23);
        assert_eq!(upgraded["catalogConsent"], false);
        validate_prefs(&upgraded).unwrap();
        db.set_pref(&upgraded).unwrap();
    }
    #[test]
    fn persistence_order_and_rollback() {
        let db = Library::open(Path::new(":memory:")).unwrap();
        db.save(&track("a"), Some("C:/music/a.wav")).unwrap();
        db.save(&track("b"), None).unwrap();
        let snap = db
            .command(&json!({"action":"create","name":"Teste"}))
            .unwrap();
        let id = s(&snap["playlists"][0], "id");
        for name in ["a", "b"] {
            db.command(&json!({"action":"add","id":id,"track":track(name)}))
                .unwrap();
        }
        assert!(db
            .command(&json!({"action":"reorder","id":id,"trackIds":["local:a","local:a"]}))
            .is_err());
        assert_eq!(
            db.snapshot().unwrap()["playlists"][0]["trackIds"],
            json!(["local:a", "local:b"])
        );
        db.command(&json!({"action":"reorder","id":id,"trackIds":["local:b","local:a"]}))
            .unwrap();
        assert_eq!(
            db.snapshot().unwrap()["playlists"][0]["trackIds"][0],
            "local:b"
        );
        let export = db.export(None).unwrap();
        let fresh = Library::open(Path::new(":memory:")).unwrap();
        fresh.import(&export).unwrap();
        assert_eq!(fresh.snapshot().unwrap()["tracks"][0]["available"], false);
    }
    #[test]
    fn import_is_atomic_and_validated() {
        let db = Library::open(Path::new(":memory:")).unwrap();
        let v = json!({"format":"glass-music","version":1,"tracks":[track("a")],"playlists":[],"likes":["missing"]});
        assert!(db.import(&v).is_err());
        assert_eq!(db.snapshot().unwrap()["tracks"], json!([]));
    }
    #[test]
    fn allowlist_rejects_host_confusion() {
        assert!(!official_url("https://youtube.com.evil.test/a"));
        assert!(!official_url("https://user@youtube.com/a"));
        assert!(!artwork_url("file:///C:/secret"));
        assert!(!artwork_url("/covers/../secrets.svg"));
        assert!(official_url("https://www.youtube.com/watch?v=M7lc1UVf-VE"));
    }
    #[test]
    fn removing_demo_music_preserves_personal_tracks_and_playlists() {
        let db=Library::open(Path::new(":memory:")).unwrap();
        for id in ["glass-prisma","glass-mare","glass-orbita","my-song"] {
            db.command(&json!({"action":"history","track":track(id)})).unwrap();
        }
        let snap=db.command(&json!({"action":"create","name":"Personal"})).unwrap();
        let id=s(&snap["playlists"][0],"id");
        db.command(&json!({"action":"add","id":id,"track":track("my-song")})).unwrap();
        crate::media::seed(&db,Path::new(".")).unwrap();
        let snap=db.snapshot().unwrap();
        assert_eq!(snap["tracks"].as_array().unwrap().len(),1);
        assert_eq!(snap["tracks"][0]["id"],"local:my-song");
        assert_eq!(snap["history"].as_array().unwrap().len(),1);
        assert_eq!(snap["playlists"][0]["trackIds"],json!(["local:my-song"]));
        crate::media::seed(&db,Path::new(".")).unwrap();
        assert_eq!(db.snapshot().unwrap()["tracks"],snap["tracks"]);
    }
    #[test]
    fn history_is_bounded() {
        let db = Library::open(Path::new(":memory:")).unwrap();
        for _ in 0..505 {
            db.command(&json!({"action":"history","track":track("a")}))
                .unwrap();
        }
        assert_eq!(
            db.snapshot().unwrap()["history"].as_array().unwrap().len(),
            500
        );
    }
    #[test]
    fn cleans_cloned_playlist_cover_from_multi_artist_playlist_tracks() {
        let db = Library::open(Path::new(":memory:")).unwrap();
        let pl_cover = "https://i.scdn.co/image/ab67616d0000b273playlistcover";
        let mosaic_cover = "https://mosaic.scdn.co/640/ab67616d00001e02a";
        let t1 = json!({"id":"link:1","source":"link","sourceId":"1","kind":"track","title":"Song 1","artist":"Artist A","duration":180,"url":"https://open.spotify.com/track/1111111111111111111111","artwork":pl_cover,"addedAt":now()});
        let t2 = json!({"id":"link:2","source":"link","sourceId":"2","kind":"track","title":"Song 2","artist":"Artist B","duration":200,"url":"https://open.spotify.com/track/2222222222222222222222","artwork":pl_cover,"addedAt":now()});
        let t3 = json!({"id":"link:3","source":"link","sourceId":"3","kind":"track","title":"Song 3","artist":"Artist C","duration":190,"url":"https://open.spotify.com/track/3333333333333333333333","artwork":mosaic_cover,"addedAt":now()});
        let pid = db.merge_collection("https://open.spotify.com/playlist/test","Mix",&[t1,t2,t3],false).unwrap();
        db.collection_artwork(&pid, pl_cover).unwrap();

        // Single-artist album should keep its shared album cover!
        let album_cover = "https://i.scdn.co/image/ab67616d0000b273albumcover";
        let a1 = json!({"id":"link:a1","source":"link","sourceId":"a1","kind":"track","title":"Track 1","artist":"Daft Punk","album":"Discovery","duration":200,"url":"https://open.spotify.com/track/4444444444444444444444","artwork":album_cover,"addedAt":now()});
        let a2 = json!({"id":"link:a2","source":"link","sourceId":"a2","kind":"track","title":"Track 2","artist":"Daft Punk","album":"Discovery","duration":210,"url":"https://open.spotify.com/track/5555555555555555555555","artwork":album_cover,"addedAt":now()});
        let aid = db.merge_collection("https://open.spotify.com/album/disc","Discovery",&[a1,a2],false).unwrap();
        db.collection_artwork(&aid, album_cover).unwrap();

        let cleaned = db.clean_cloned_playlist_covers().unwrap();
        assert_eq!(cleaned, 3);
        let snap = db.snapshot().unwrap();
        let tracks = snap["tracks"].as_array().unwrap();
        for id in ["link:1", "link:2", "link:3"] {
            let tr = tracks.iter().find(|t| t["id"] == id).unwrap();
            assert!(tr.get("artwork").is_none(), "{id} should have cloned artwork removed");
        }
        for id in ["link:a1", "link:a2"] {
            let tr = tracks.iter().find(|t| t["id"] == id).unwrap();
            assert_eq!(tr["artwork"], album_cover, "{id} album artwork must be preserved");
        }
    }

    #[test]
    fn persists_hydrates_and_invalidates_stream_mappings() {
        let db = Library::open(Path::new(":memory:")).unwrap();
        let sp = json!({
            "id": "link:sp1234567890",
            "source": "link",
            "sourceId": "sp1234567890",
            "kind": "track",
            "title": "Blinding Lights",
            "artist": "The Weeknd",
            "duration": 200.04,
            "durationMs": 200040,
            "catalogSource": "spotify",
            "url": "https://open.spotify.com/track/0VjIjW4GlUZAMYd2vXMi3b",
            "addedAt": now()
        });
        db.save(&sp, None).unwrap();
        let key = canonical_mapping_key(&sp);
        assert_eq!(key, "spotify:track:0VjIjW4GlUZAMYd2vXMi3b");

        db.save_stream_mapping(&StreamMapping {
            source_track_id: key.clone(),
            catalog_source: "spotify".into(),
            resolved_provider: "ytmusic".into(),
            resolved_id: "4NRXx6U8ABQ".into(),
            resolved_url: Some("https://music.youtube.com/watch?v=4NRXx6U8ABQ".into()),
            duration_delta: 0.04,
            score: 98.5,
            updated_at: now(),
        })
        .unwrap();

        let snap = db.snapshot().unwrap();
        let hydrated = &snap["tracks"][0];
        assert_eq!(hydrated["streamProvider"], "ytmusic");
        assert_eq!(hydrated["resolvedExternalId"], "4NRXx6U8ABQ");
        assert_eq!(hydrated["playbackId"], "4NRXx6U8ABQ");

        db.invalidate_stream_mapping(&key).unwrap();
        assert!(db.get_stream_mapping(&key).is_none());
    }
}
