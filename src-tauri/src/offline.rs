use crate::db::{s, Library, Result};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    fs::OpenOptions,
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};
use tokio::sync::OwnedMutexGuard;
use tokio_util::sync::CancellationToken;

const CHUNK: u64 = 1_048_576;

#[cfg(test)]
pub fn file(data: &Path, id: &str, ext: &str) -> PathBuf {
    data.join("offline")
        .join(format!("{:x}.{ext}", Sha256::digest(id.as_bytes())))
}

fn unique_file(data: &Path, id: &str, ext: &str) -> PathBuf {
    let hash = format!("{:x}", Sha256::digest(id.as_bytes()));
    data.join("offline").join(format!(
        "{}-{}.{}",
        &hash[..16],
        uuid::Uuid::new_v4().simple(),
        ext
    ))
}

pub fn owned_path(data: &Path, path: &str) -> bool {
    let p = Path::new(path);
    p.parent() == Some(data.join("offline").as_path())
        && p.file_name()
            .and_then(|v| v.to_str())
            .is_some_and(|name| name.len() < 80 && !name.contains(['/', '\\']))
}

pub fn is_cached(data: &Path, path: &str) -> bool {
    owned_path(data, path) && Path::new(path).is_file()
}

pub fn stats(data: &Path, db: &Library) -> (usize, u64) {
    let Ok(mut statement) = db.db.prepare("SELECT path FROM offline_tracks") else {
        return (0, 0);
    };
    let Ok(paths) = statement.query_map([], |row| row.get::<_, String>(0)) else {
        return (0, 0);
    };
    let mut count = 0usize;
    let mut total_bytes = 0u64;
    for path in paths.flatten() {
        if !owned_path(data, &path) {
            continue;
        }
        if let Ok(meta) = std::fs::metadata(path) {
            if meta.is_file() && meta.len() >= 512 {
                count += 1;
                total_bytes = total_bytes.saturating_add(meta.len());
            }
        }
    }
    (count, total_bytes)
}

pub fn list_entries(data: &Path, db: &Library) -> Value {
    let Ok(mut statement) = db.db.prepare(
        "SELECT track_id, path, size, duration, created FROM offline_tracks ORDER BY created DESC",
    ) else {
        return serde_json::json!({ "tracks": [], "totalTracks": 0, "totalBytes": 0 });
    };
    let Ok(rows) = statement.query_map([], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, i64>(2)?,
            row.get::<_, f64>(3)?,
            row.get::<_, i64>(4)?,
        ))
    }) else {
        return serde_json::json!({ "tracks": [], "totalTracks": 0, "totalBytes": 0 });
    };
    let mut tracks = Vec::new();
    let mut total_bytes = 0u64;
    for (track_id, path, db_size, duration, created) in rows.flatten() {
        if !owned_path(data, &path) {
            continue;
        }
        let (verified, actual_size) = match std::fs::metadata(&path) {
            Ok(meta) if meta.is_file() && meta.len() >= 512 => (true, meta.len()),
            _ => (false, db_size.max(0) as u64),
        };
        if verified {
            total_bytes = total_bytes.saturating_add(actual_size);
        }
        tracks.push(serde_json::json!({
            "trackId": track_id,
            "size": actual_size,
            "duration": duration,
            "createdAt": created,
            "verified": verified
        }));
    }
    let verified_count = tracks.iter().filter(|t| t["verified"] == true).count();
    serde_json::json!({
        "tracks": tracks,
        "totalTracks": verified_count,
        "totalBytes": total_bytes
    })
}

struct OperationState {
    generation: u64,
    token: CancellationToken,
}

struct DownloadEntry {
    gate: Arc<tokio::sync::Mutex<()>>,
    state: Mutex<OperationState>,
}

impl DownloadEntry {
    fn new() -> Self {
        Self {
            gate: Arc::new(tokio::sync::Mutex::new(())),
            state: Mutex::new(OperationState {
                generation: 0,
                token: CancellationToken::new(),
            }),
        }
    }

    fn cancel(&self) {
        let mut state = self.state.lock().unwrap();
        state.generation = state.generation.wrapping_add(1);
        state.token.cancel();
    }
}

#[derive(Clone, Default)]
pub struct Downloads {
    entries: Arc<Mutex<HashMap<String, Arc<DownloadEntry>>>>,
}

impl Downloads {
    fn entry(&self, id: &str) -> Arc<DownloadEntry> {
        self.entries
            .lock()
            .unwrap()
            .entry(id.to_string())
            .or_insert_with(|| Arc::new(DownloadEntry::new()))
            .clone()
    }

    pub async fn begin(&self, id: &str) -> DownloadOperation {
        let entry = self.entry(id);
        let gate = entry.gate.clone().lock_owned().await;
        let (generation, token) = {
            let mut state = entry.state.lock().unwrap();
            if state.token.is_cancelled() {
                state.token = CancellationToken::new();
            }
            (state.generation, state.token.clone())
        };
        DownloadOperation {
            entry,
            _gate: gate,
            generation,
            token,
        }
    }

    pub fn cancel(&self, id: &str) {
        if let Some(entry) = self.entries.lock().unwrap().get(id).cloned() {
            entry.cancel();
        }
    }

    pub fn cancel_all(&self) {
        let entries: Vec<_> = self.entries.lock().unwrap().values().cloned().collect();
        for entry in entries {
            entry.cancel();
        }
    }

    pub async fn removal(&self, id: &str) -> RemovalGuard {
        self.cancel(id);
        let entry = self.entry(id);
        let gate = entry.gate.clone().lock_owned().await;
        RemovalGuard { _entry: entry, _gate: gate }
    }
}

pub struct RemovalGuard {
    _entry: Arc<DownloadEntry>,
    _gate: OwnedMutexGuard<()>,
}

pub struct DownloadOperation {
    entry: Arc<DownloadEntry>,
    _gate: OwnedMutexGuard<()>,
    generation: u64,
    token: CancellationToken,
}

impl DownloadOperation {
    pub fn token(&self) -> CancellationToken {
        self.token.clone()
    }

    pub fn ensure_current(&self) -> Result<()> {
        let state = self.entry.state.lock().unwrap();
        if self.token.is_cancelled() || state.generation != self.generation {
            Err("Download cancelado.".into())
        } else {
            Ok(())
        }
    }
}

pub struct PendingDownload {
    temporary: PathBuf,
    path: PathBuf,
    size: u64,
    duration: f64,
}

impl PendingDownload {
    fn new(data: &Path, id: &str, ext: &str, duration: f64) -> Result<Self> {
        std::fs::create_dir_all(data.join("offline"))
            .map_err(|_| "Não foi possível criar a pasta offline.")?;
        Ok(Self {
            temporary: data
                .join("offline")
                .join(format!(".{}.part", uuid::Uuid::new_v4().simple())),
            path: unique_file(data, id, ext),
            size: 0,
            duration,
        })
    }

    pub fn publish(self) -> Result<PublishedDownload> {
        if self.path.exists() {
            return Err("Destino offline já existe.".into());
        }
        std::fs::rename(&self.temporary, &self.path)
            .map_err(|_| "Não foi possível concluir o download.")?;
        Ok(PublishedDownload {
            path: self.path.clone(),
            size: self.size,
            duration: self.duration,
            cleanup: true,
        })
    }
}

impl Drop for PendingDownload {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.temporary);
    }
}

pub struct PublishedDownload {
    path: PathBuf,
    size: u64,
    duration: f64,
    cleanup: bool,
}

impl PublishedDownload {
    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn keep(mut self) {
        self.cleanup = false;
    }
}

impl Drop for PublishedDownload {
    fn drop(&mut self) {
        if self.cleanup {
            let _ = std::fs::remove_file(&self.path);
        }
    }
}

pub fn commit_pending(
    db: &Library,
    data: &Path,
    track: &Value,
    operation: &DownloadOperation,
    pending: PendingDownload,
) -> Result<Value> {
    operation.ensure_current()?;
    let pref = db.pref();
    if pref["onlineConsent"] != true || pref["onboardingDone"] != true {
        return Err("Download cancelado: acesso online desativado.".into());
    }
    operation.ensure_current()?;
    let id = s(track, "id");
    let previous = db.offline_path(id);
    let published = pending.publish()?;
    let new_path = published.path().to_path_buf();
    db.commit_offline(
        track,
        new_path.to_str().ok_or("Pasta inválida.")?,
        published.size,
        published.duration,
    )?;
    published.keep();
    if let Some((old, _)) = previous {
        if old != new_path.to_string_lossy() && owned_path(data, &old) {
            if let Err(error) = std::fs::remove_file(&old) {
                if error.kind() != std::io::ErrorKind::NotFound {
                    eprintln!("Liquid Hub: não foi possível remover o cache offline antigo de {id}: {error}");
                }
            }
        }
    }
    db.snapshot()
}

fn content_range(raw: &str) -> Option<(u64, u64, u64)> {
    let (range, total) = raw.strip_prefix("bytes ")?.split_once('/')?;
    let (a, b) = range.split_once('-')?;
    let start = a.parse().ok()?;
    let end = b.parse().ok()?;
    let total = total.parse().ok()?;
    if total == 0 || start > end || end >= total {
        return None;
    }
    Some((start, end, total))
}

async fn chunk(client: &reqwest::Client, stream: &Value, start: u64, end: u64) -> Result<(Vec<u8>, u64, bool)> {
    let url = url::Url::parse(s(stream, "url")).map_err(|_| "Áudio inválido.")?;
    let mut request = client.get(url).header("Range", format!("bytes={start}-{end}"));
    let agent = s(&stream["http_headers"], "User-Agent");
    if agent.len() < 512 && !agent.contains(['\r', '\n']) {
        request = request.header("User-Agent", agent);
    }
    let mut response = request
        .send()
        .await
        .map_err(|_| "Não foi possível baixar o áudio.")?;
    let metadata = response
        .headers()
        .get("content-range")
        .and_then(|v| v.to_str().ok())
        .and_then(content_range);
    if response.headers().contains_key("content-range") && metadata.is_none() {
        return Err("Arquivo parcial inválido.".into());
    }
    let expected = stream["filesize"].as_u64().or_else(|| {
        url::Url::parse(s(stream, "url"))
            .ok()?
            .query_pairs()
            .find(|(k, _)| k == "clen")
            .and_then(|(_, n)| n.parse::<u64>().ok())
    });
    let partial = metadata.is_some()
        || response.status().as_u16() == 206
        || expected.is_some_and(|n| {
            n > 0
                && response.content_length() == Some(end.min(n - 1).saturating_sub(start) + 1)
                && (start > 0 || n > CHUNK)
        });
    let total = if partial {
        let (a, b, total) = metadata
            .or_else(|| expected.map(|n| (start, end.min(n.saturating_sub(1)), n)))
            .ok_or("Arquivo parcial inválido.")?;
        if a != start || b > end || b < a || b >= total {
            return Err("Trecho de áudio inválido.".into());
        }
        total
    } else {
        if start != 0 || !response.status().is_success() {
            return Err("O serviço interrompeu o download.".into());
        }
        response.content_length().unwrap_or(0)
    };
    if !response.status().is_success() {
        return Err("O serviço interrompeu o download.".into());
    }
    if partial && total == 0 {
        return Err("Arquivo parcial inválido.".into());
    }
    if expected.is_some_and(|n| n != total) {
        return Err("Tamanho de áudio inconsistente.".into());
    }
    if total > 250_000_000 {
        return Err("Arquivo maior que 250 MB.".into());
    }
    let max = if partial { end - start + 1 } else { 250_000_000 };
    let mut bytes = Vec::new();
    while let Some(data) = response.chunk().await.map_err(|_| "Download interrompido.")? {
        if bytes.len() as u64 + data.len() as u64 > max {
            return Err("Arquivo maior que o esperado.".into());
        }
        bytes.extend_from_slice(&data);
    }
    if partial && bytes.len() as u64 != (end.min(total - 1) - start + 1) {
        return Err("Trecho de áudio incompleto.".into());
    }
    Ok((bytes, total, partial))
}

fn valid_audio_signature(ext: &str, bytes: &[u8]) -> bool {
    match ext {
        "m4a" => bytes.len() >= 12 && &bytes[4..8] == b"ftyp",
        "webm" => bytes.starts_with(&[0x1a, 0x45, 0xdf, 0xa3]),
        _ => false,
    }
}

pub async fn download_with_progress<F>(
    data: &Path,
    id: &str,
    stream: &Value,
    token: &CancellationToken,
    mut on_progress: F,
) -> Result<PendingDownload>
where
    F: FnMut(u64, u64),
{
    if !crate::audio::valid_cdn(s(stream, "url"))
        || s(stream, "vcodec") != "none"
        || s(stream, "acodec") == "none"
        || s(stream, "protocol") != "https"
    {
        return Err("Esta faixa não oferece um áudio compatível para salvar.".into());
    }
    let ext = match s(stream, "ext") {
        "m4a" => "m4a",
        "webm" => "webm",
        _ => return Err("Esta faixa não oferece um áudio compatível para salvar.".into()),
    };
    let mut pending = PendingDownload::new(
        data,
        id,
        ext,
        stream["duration"].as_f64().unwrap_or(0.0),
    )?;
    let temporary = pending.temporary.clone();
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(60))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| "Falha no download.")?;
    if token.is_cancelled() {
        return Err("Download cancelado.".into());
    }
    let result: Result<u64> = tokio::select! {
        biased;
        _ = token.cancelled() => Err("Download cancelado.".into()),
        result = async {
            let (first, total, partial) = chunk(&client, stream, 0, CHUNK - 1).await?;
            let mut output = std::io::BufWriter::new(
                OpenOptions::new().write(true).create_new(true).open(&temporary).map_err(|_| "Não foi possível salvar o áudio.")?,
            );
            output
                .write_all(&first)
                .map_err(|_| "Sem espaço para salvar o áudio.")?;
            let mut bytes = first.len() as u64;
            on_progress(bytes, total.max(bytes));
            while partial && bytes < total {
                let start = bytes;
                let end = (start + CHUNK - 1).min(total - 1);
                let (data, reported, partial) = chunk(&client, stream, start, end).await?;
                if !partial || reported != total {
                    return Err("O arquivo foi alterado durante o download.".into());
                }
                bytes += data.len() as u64;
                output
                    .write_all(&data)
                    .map_err(|_| "Sem espaço para salvar o áudio.")?;
                on_progress(bytes, total.max(bytes));
            }
            if bytes < 512 || (total > 0 && bytes != total) {
                return Err("O arquivo recebido está incompleto.".into());
            }
            output
                .flush()
                .map_err(|_| "Não foi possível concluir o arquivo.")?;
            drop(output);
            let mut input = std::fs::File::open(&temporary).map_err(|_| "Não foi possível validar o áudio.")?;
            let mut signature = [0u8; 12];
            let read = input.read(&mut signature).map_err(|_| "Não foi possível validar o áudio.")?;
            if !valid_audio_signature(ext, &signature[..read]) {
                return Err("O conteúdo recebido não corresponde ao formato de áudio.".into());
            }
            Ok(bytes)
        } => result,
    };
    pending.size = result?;
    Ok(pending)
}

#[allow(dead_code)]
pub async fn download(
    data: &Path,
    id: &str,
    stream: &Value,
    token: &CancellationToken,
) -> Result<PendingDownload> {
    download_with_progress(data, id, stream, token, |_, _| {}).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn temp_dir() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("liquid-offline-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn pending_fixture(data: &Path, id: &str, ext: &str) -> PendingDownload {
        let mut pending = PendingDownload::new(data, id, ext, 3.0).unwrap();
        let mut bytes = if ext == "m4a" {
            vec![0, 0, 0, 24, b'f', b't', b'y', b'p', b'M', b'4', b'A', b' ']
        } else {
            vec![0x1a, 0x45, 0xdf, 0xa3]
        };
        bytes.resize(512, 0);
        std::fs::write(&pending.temporary, &bytes).unwrap();
        pending.size = bytes.len() as u64;
        pending
    }

    fn track(id: &str) -> Value {
        json!({"id":format!("local:{id}"),"source":"local","sourceId":id,"kind":"track","title":id,"artist":"Teste","duration":3,"addedAt":crate::db::now()})
    }

    fn allow_downloads(db: &Library) {
        let mut pref = db.pref();
        pref["onlineConsent"] = json!(true);
        pref["onboardingDone"] = json!(true);
        db.set_pref(&pref).unwrap();
    }

    #[test]
    fn offline_paths_are_confined() {
        let root = Path::new("C:/app");
        let p = file(root, "youtube:test", "webm");
        assert!(owned_path(root, p.to_str().unwrap()));
        assert!(!owned_path(root, "C:/personal/song.mp3"));
    }

    #[test]
    fn stats_count_only_referenced_legacy_files_not_orphans() {
        let root = temp_dir();
        let db = Library::open(Path::new(":memory:")).unwrap();
        db.save(&track("legacy"), None).unwrap();
        let legacy = file(&root, "local:legacy", "webm");
        std::fs::create_dir_all(legacy.parent().unwrap()).unwrap();
        std::fs::write(&legacy, vec![1u8; 512]).unwrap();
        let orphan = root.join("offline").join("orphan.m4a");
        std::fs::write(&orphan, vec![2u8; 2048]).unwrap();
        db.save_offline("local:legacy", legacy.to_str().unwrap(), 512, 3.0).unwrap();
        assert_eq!(stats(&root, &db), (1, 512));
        db.remove_offline("local:legacy").unwrap();
        assert_eq!(stats(&root, &db), (0, 0));
        assert!(legacy.is_file() && orphan.is_file());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn range_metadata_is_bounded() {
        assert_eq!(content_range("bytes 0-1023/4096"), Some((0, 1023, 4096)));
        for invalid in ["0-1023", "bytes 0-0/0", "bytes 4-2/10", "bytes 0-10/10"] {
            assert!(content_range(invalid).is_none());
        }
    }

    #[test]
    fn audio_signatures_and_temporary_paths_are_specific() {
        assert!(valid_audio_signature("webm", &[0x1a, 0x45, 0xdf, 0xa3]));
        assert!(valid_audio_signature("m4a", &[0, 0, 0, 24, b'f', b't', b'y', b'p', 0, 0, 0, 0]));
        assert!(!valid_audio_signature("m4a", &[0x1a, 0x45, 0xdf, 0xa3]));
        assert!(!valid_audio_signature("webm", b"not audio"));
        let root = temp_dir();
        let first = pending_fixture(&root, "youtube:same", "webm");
        let second = pending_fixture(&root, "youtube:same", "webm");
        assert_ne!(first.temporary, second.temporary);
        assert_ne!(first.path, second.path);
        assert!(owned_path(&root, first.path.to_str().unwrap()));
        drop(first);
        drop(second);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn per_id_gates_serialize_only_the_same_track() {
        let downloads = Downloads::default();
        let first = downloads.begin("local:a").await;
        let other = downloads.begin("local:b").await;
        drop(other);
        let waiting = downloads.clone();
        let (sent, mut received) = tokio::sync::oneshot::channel();
        let task = tokio::spawn(async move {
            let operation = waiting.begin("local:a").await;
            let _ = sent.send(());
            drop(operation);
        });
        tokio::task::yield_now().await;
        assert!(matches!(
            received.try_recv(),
            Err(tokio::sync::oneshot::error::TryRecvError::Empty)
        ));
        drop(first);
        received.await.unwrap();
        task.await.unwrap();
    }

    #[tokio::test]
    async fn cancelled_download_cannot_recreate_removed_track() {
        let root = temp_dir();
        let db = Library::open(Path::new(":memory:")).unwrap();
        allow_downloads(&db);
        let downloads = Downloads::default();
        let operation = downloads.begin("local:a").await;
        let pending = pending_fixture(&root, "local:a", "webm");
        let temporary = pending.temporary.clone();
        let final_path = pending.path.clone();
        downloads.cancel("local:a");
        assert!(commit_pending(&db, &root, &track("a"), &operation, pending).is_err());
        assert!(!temporary.exists());
        assert!(!final_path.exists());
        drop(operation);
        let removal = downloads.removal("local:a").await;
        db.command(&json!({"action":"removeTrack","id":"local:a"})).unwrap();
        drop(removal);
        assert!(db.snapshot().unwrap()["tracks"].as_array().unwrap().is_empty());
        assert!(db.offline_path("local:a").is_none());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn failed_commit_removes_only_new_file_and_preserves_old_cache() {
        let root = temp_dir();
        let db = Library::open(Path::new(":memory:")).unwrap();
        allow_downloads(&db);
        db.save(&track("a"), None).unwrap();
        let old = file(&root, "local:a", "webm");
        std::fs::create_dir_all(old.parent().unwrap()).unwrap();
        std::fs::write(&old, vec![7u8; 512]).unwrap();
        db.save_offline("local:a", old.to_str().unwrap(), 512, 3.0).unwrap();
        db.db.execute("CREATE TRIGGER reject_offline_update BEFORE UPDATE ON offline_tracks BEGIN SELECT RAISE(ABORT,'blocked'); END", []).unwrap();
        let downloads = Downloads::default();
        let operation = downloads.begin("local:a").await;
        let pending = pending_fixture(&root, "local:a", "webm");
        let new_path = pending.path.clone();
        assert!(commit_pending(&db, &root, &track("a"), &operation, pending).is_err());
        assert!(!new_path.exists());
        assert_eq!(std::fs::read(&old).unwrap(), vec![7u8; 512]);
        assert_eq!(db.offline_path("local:a").unwrap().0, old.to_string_lossy());
        drop(operation);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn successful_commit_swaps_record_before_deleting_old_cache() {
        let root = temp_dir();
        let db = Library::open(Path::new(":memory:")).unwrap();
        allow_downloads(&db);
        db.save(&track("a"), None).unwrap();
        let old = file(&root, "local:a", "webm");
        std::fs::create_dir_all(old.parent().unwrap()).unwrap();
        std::fs::write(&old, vec![7u8; 512]).unwrap();
        db.save_offline("local:a", old.to_str().unwrap(), 512, 3.0).unwrap();
        let downloads = Downloads::default();
        let operation = downloads.begin("local:a").await;
        let pending = pending_fixture(&root, "local:a", "webm");
        let new_path = pending.path.clone();
        let snapshot = commit_pending(&db, &root, &track("a"), &operation, pending).unwrap();
        assert_eq!(snapshot["tracks"][0]["offline"], true);
        assert_eq!(db.offline_path("local:a").unwrap().0, new_path.to_string_lossy());
        assert!(new_path.is_file());
        assert!(!old.exists());
        drop(operation);
        std::fs::remove_dir_all(root).unwrap();
    }
}
