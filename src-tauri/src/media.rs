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
    sync::{Arc, Mutex, OnceLock, mpsc::{sync_channel, SyncSender}},
    time::Duration,
};
use tiny_http::{Header, Request, Response, Server, StatusCode};
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
    let mut t = json!({"id":format!("local:{id}"),"source":"local","sourceId":id,"kind":"track","title":tag.and_then(|t|t.title()).map(|s|s.into_owned()).unwrap_or(fallback),"artist":tag.and_then(|t|t.artist()).map(|s|s.into_owned()).unwrap_or("Artista desconhecido".into()),"album":tag.and_then(|t|t.album()).map(|s|s.into_owned()).unwrap_or_default(),"duration":tagged.properties().duration().as_secs_f64(),"available":true,"addedAt":now()});
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
    let (audio_tx,audio_rx)=sync_channel::<(Request,String,bool)>(16);
    let audio_rx=Arc::new(Mutex::new(audio_rx));
    for _ in 0..4 {
        let receiver=audio_rx.clone();let audio=audio.clone();
        std::thread::spawn(move||loop {
            let next=receiver.lock().unwrap().recv();
            match next {Ok((req,ticket,allowed))=>audio.respond(req,&ticket,allowed),Err(_)=>break}
        });
    }
    for _ in 0..4 {
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
        let _ = req.respond(Response::from_string("Recurso indisponível").with_status_code(status));
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
            trim_cache(&dir, max);
            let p = dir.join(format!("{}.jpg", hash(url.as_bytes())));
            if !p.exists() {
                static COVERS:OnceLock<reqwest::blocking::Client>=OnceLock::new();
                if let Some(c) = COVERS.get().or_else(|| {
                    let client=reqwest::blocking::Client::builder().timeout(Duration::from_secs(8)).redirect(reqwest::redirect::Policy::none()).build().ok()?;
                    let _=COVERS.set(client);COVERS.get()
                }) {
                    if let Ok(r) = c.get(&url).send() {
                        let ok = r.status().is_success()
                            && r.headers()
                                .get("content-type")
                                .and_then(|h| h.to_str().ok())
                                .is_some_and(|t| t.starts_with("image/"));
                        if ok {
                            let mut bytes = Vec::new();
                            let _ = r.take(4_000_001).read_to_end(&mut bytes);
                            if bytes.len() <= 4_000_000 {
                                let _ = fs::write(&p, &bytes);
                            }
                        }
                    }
                }
            }
            Some(p)
        }
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
    let _ = file.seek(SeekFrom::Start(start));
    let size = end - start + 1;
    let mut headers = cors;
    headers.push(header("Content-Type", mime(&path)));
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
}
