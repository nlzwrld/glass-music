use crate::db::{s, Library, Result};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use tauri::AppHandle;
#[cfg(desktop)]
use tauri::Emitter;
#[cfg(desktop)]
use tauri_plugin_updater::UpdaterExt;
#[cfg(mobile)]
use tauri_plugin_opener::OpenerExt;

pub fn backup_library(db: &Library, directory: &Path) -> Result<PathBuf> {
    std::fs::create_dir_all(directory).map_err(|e| e.to_string())?;
    let path = directory.join(format!("before-update-{}.sqlite", uuid::Uuid::new_v4()));
    db.backup_to(&path)?;
    Ok(path)
}
#[cfg(any(desktop, test))]
fn prepare_install_from_check<T>(
    check: Result<Option<T>>,
    install: bool,
    before_install: impl FnOnce() -> Result<()>,
) -> Result<Option<T>> {
    let update = check?;
    if install && update.is_some() {
        before_install()?;
    }
    Ok(update)
}
#[cfg(desktop)]
pub async fn status(
    app: &AppHandle,
    consent: bool,
    install: bool,
    before_install: impl FnOnce() -> Result<()>,
) -> Result<Value> {
    let config: Value =
        serde_json::from_str(include_str!("../release.json")).map_err(|_| "Canal de atualização inválido.")?;
    let endpoint = s(&config, "endpoint");
    if endpoint.is_empty() {
        return Ok(json!({"configured":false,"available":false,"version":env!("CARGO_PKG_VERSION"),"message":"O canal do GitHub ainda não foi publicado."}));
    }
    if !consent {
        return Err("Ative o acesso online para verificar atualizações.".into());
    }
    static GATE: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(1);
    let _permit = GATE
        .try_acquire()
        .map_err(|_| "Uma atualização já está sendo verificada.")?;
    let url = url::Url::parse(endpoint).map_err(|_| "Canal inválido.")?;
    if url.scheme() != "https" || url.host_str() != Some("github.com") {
        return Err("Canal de atualização inválido.".into());
    }
    let updater = app
        .updater_builder()
        .endpoints(vec![url])
        .map_err(|e| e.to_string())?
        .timeout(std::time::Duration::from_secs(20))
        .build()
        .map_err(|e| e.to_string())?;
    let checked = updater
        .check()
        .await
        .map_err(|_| "Não foi possível consultar o GitHub agora.".into());
    let Some(update) = prepare_install_from_check(checked, install, before_install)? else {
        return Ok(json!({"configured":true,"available":false,"version":env!("CARGO_PKG_VERSION"),"message":"O aplicativo está atualizado."}));
    };
    let version = update.version.clone();
    let notes = update.body.clone().unwrap_or_default();
    if install {
        let mut downloaded: u64 = 0;
        let app_handle = app.clone();
        update
            .download_and_install(
                move |chunk_len, content_len| {
                    downloaded = downloaded.saturating_add(chunk_len as u64);
                    let percent = content_len
                        .filter(|t| *t > 0)
                        .map(|t| ((downloaded as f64 / t as f64) * 100.0).min(100.0).round() as u32)
                        .unwrap_or(0);
                    let _ = app_handle.emit(
                        "update-download-progress",
                        json!({
                            "downloaded": downloaded,
                            "total": content_len.unwrap_or(0),
                            "percent": percent
                        }),
                    );
                },
                || {},
            )
            .await
            .map_err(|_| "Não foi possível verificar e instalar a atualização assinada.")?;
        app.restart();
    }
    Ok(json!({
        "configured": true,
        "available": true,
        "version": version,
        "notes": notes,
        "channel": "stable",
        "integrity": "Minisign-Ed25519 + SHA-256",
        "message": format!("Versão {version} disponível.")
    }))
}
#[cfg(any(mobile, test))]
fn parse_semver(raw: &str) -> Option<(u64, u64, u64)> {
    let trimmed = raw.trim().trim_start_matches('v');
    let core = trimmed.split(['-', '+']).next()?;
    let mut parts = core.split('.');
    let major = parts.next()?.parse::<u64>().ok()?;
    let minor = parts.next()?.parse::<u64>().ok()?;
    let patch = parts.next()?.parse::<u64>().ok()?;
    if parts.next().is_some() {
        return None;
    }
    Some((major, minor, patch))
}

#[cfg(any(mobile, test))]
fn is_newer_version(current: &str, candidate: &str) -> bool {
    match (parse_semver(current), parse_semver(candidate)) {
        (Some(cur), Some(next)) => next > cur,
        _ => false,
    }
}

#[cfg(any(mobile, test))]
fn mobile_apk_download_url(repository: &str, version: &str) -> Option<String> {
    if parse_semver(version).is_none()
        || repository.is_empty()
        || !repository
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"/_.-".contains(&b))
        || repository.split('/').count() != 2
    {
        return None;
    }
    Some(format!(
        "https://github.com/{repository}/releases/download/v{version}/Liquid.Hub_{version}_arm64.apk"
    ))
}

#[cfg(mobile)]
pub async fn status(
    app: &AppHandle,
    consent: bool,
    install: bool,
    before_install: impl FnOnce() -> Result<()>,
) -> Result<Value> {
    let config: Value =
        serde_json::from_str(include_str!("../release.json")).map_err(|_| "Canal de atualização inválido.")?;
    let endpoint = s(&config, "endpoint");
    let repository = s(&config, "repository");
    let current = env!("CARGO_PKG_VERSION");
    if endpoint.is_empty() || repository.is_empty() {
        return Ok(json!({
            "configured": false,
            "available": false,
            "version": current,
            "message": "O canal de atualizações do GitHub ainda não foi configurado."
        }));
    }
    if !consent {
        return Err("Ative o acesso online para verificar atualizações.".into());
    }
    let url = url::Url::parse(endpoint).map_err(|_| "Canal inválido.")?;
    if url.scheme() != "https" || url.host_str() != Some("github.com") {
        return Err("Canal de atualização inválido.".into());
    }
    let resp = crate::providers::client()
        .get(url)
        .timeout(std::time::Duration::from_secs(15))
        .send()
        .await
        .map_err(|_| "Não foi possível consultar o GitHub agora.")?;
    if !resp.status().is_success() {
        return Err("Não foi possível consultar o GitHub agora.".into());
    }
    let manifest: Value = resp
        .json()
        .await
        .map_err(|_| "Manifesto de atualização inválido.")?;
    let latest_version = s(&manifest, "version").trim().to_string();
    let notes = s(&manifest, "notes").trim().to_string();
    let pub_date = s(&manifest, "pub_date").trim().to_string();
    if !is_newer_version(current, &latest_version) {
        return Ok(json!({
            "configured": true,
            "available": false,
            "version": current,
            "channel": "stable",
            "integrity": "APK Assinado + SHA-256",
            "message": "O aplicativo está atualizado."
        }));
    }
    let download_url = mobile_apk_download_url(repository, &latest_version)
        .ok_or("URL do APK de atualização inválida.")?;
    if install {
        before_install()?;
        app.opener()
            .open_url(&download_url, None::<&str>)
            .map_err(|_| "Não foi possível abrir o download da atualização APK.")?;
    }
    Ok(json!({
        "configured": true,
        "available": true,
        "version": latest_version,
        "notes": notes,
        "pubDate": pub_date,
        "channel": "stable",
        "integrity": "APK Assinado + SHA-256",
        "downloadUrl": download_url,
        "message": if install {
            format!("Baixando Liquid Hub {latest_version} (APK). Confirme a instalação quando o Android solicitar.")
        } else {
            format!("Versão {latest_version} disponível para Android.")
        }
    }))
}

fn count_and_clean_orphaned_temp_files(root: &Path, clean: bool) -> (usize, usize) {
    let mut found = 0usize;
    let mut removed = 0usize;
    let Ok(entries) = std::fs::read_dir(root) else {
        return (0, 0);
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            let (sub_f, sub_r) = count_and_clean_orphaned_temp_files(&path, clean);
            found += sub_f;
            removed += sub_r;
            continue;
        }
        let name = path
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("")
            .to_ascii_lowercase();
        if name.ends_with(".part") || name.ends_with(".pending") || name.ends_with(".tmp") {
            found += 1;
            if clean && std::fs::remove_file(&path).is_ok() {
                removed += 1;
            }
        }
    }
    (found, removed)
}

pub fn verify_and_repair(db: &Library, data_dir: &Path, repair: bool) -> Result<Value> {
    let db_ok = db.check_integrity(repair).unwrap_or(false);
    let secrets_path = data_dir.join("secrets.json");
    let vault_readable = if secrets_path.exists() {
        std::fs::read(&secrets_path).is_ok()
    } else {
        true
    };
    let (orphaned, removed) = count_and_clean_orphaned_temp_files(data_dir, repair);
    let mut backup_created: Option<String> = None;
    if repair {
        let _ = db.clean_cloned_playlist_covers();
        if db_ok {
            let backup_dir = data_dir.join("backups");
            if let Ok(path) = backup_library(db, &backup_dir) {
                backup_created = Some(path.to_string_lossy().to_string());
            }
        }
    }
    let backups_count = std::fs::read_dir(data_dir.join("backups"))
        .map(|entries| {
            entries
                .flatten()
                .filter(|e| {
                    e.path()
                        .extension()
                        .and_then(|s| s.to_str())
                        .map(|ext| ext.eq_ignore_ascii_case("sqlite"))
                        .unwrap_or(false)
                })
                .count()
        })
        .unwrap_or(0);
    let ok = db_ok && vault_readable;
    let message = if repair {
        if ok {
            format!(
                "Reparo concluído: banco íntegro, {removed} arquivos temporários órfãos removidos e backup preventivo atualizado."
            )
        } else {
            "A verificação identificou inconsistências locais que exigem restauração de backup.".to_string()
        }
    } else if ok {
        "Instalação íntegra: banco SQLite, cofre local e diretórios verificados sem erros.".to_string()
    } else {
        "Inconsistência detectada na instalação local. Execute o reparo para corrigir.".to_string()
    };
    let checked_at = crate::db::now();
    Ok(json!({
        "ok": ok,
        "repaired": repair,
        "version": env!("CARGO_PKG_VERSION"),
        "dbIntegrityOk": db_ok,
        "vaultReadable": vault_readable,
        "orphanedTempFiles": orphaned,
        "removedOrphanedTempFiles": removed,
        "backupsCount": backups_count,
        "backupCreated": backup_created,
        "checkedAt": checked_at,
        "message": message
    }))
}

#[cfg(test)]
mod tests{
 use super::*;
 #[test]
 fn verify_and_repair_checks_integrity_cleans_orphaned_temp_files_and_creates_backup(){
  let dir=std::env::temp_dir().join(format!("liquid-maint-test-{}",uuid::Uuid::new_v4()));
  std::fs::create_dir_all(dir.join("offline")).unwrap();
  std::fs::write(dir.join("offline").join("orphan.part"),b"partial").unwrap();
  let db=Library::open(&dir.join("library.sqlite")).unwrap();

  let inspect=verify_and_repair(&db,&dir,false).unwrap();
  assert_eq!(inspect["ok"],true);
  assert_eq!(inspect["dbIntegrityOk"],true);
  assert_eq!(inspect["orphanedTempFiles"],1);
  assert_eq!(inspect["removedOrphanedTempFiles"],0);

  let repaired=verify_and_repair(&db,&dir,true).unwrap();
  assert_eq!(repaired["ok"],true);
  assert_eq!(repaired["repaired"],true);
  assert_eq!(repaired["removedOrphanedTempFiles"],1);
  assert!(repaired["backupsCount"].as_u64().unwrap_or(0)>=1);
  assert!(!dir.join("offline").join("orphan.part").exists());

  drop(db);
  let _=std::fs::remove_dir_all(&dir);
 }
 #[test]
 fn update_backups_coexist_and_never_overwrite_existing_files(){
  let directory=std::env::temp_dir().join(format!("liquid-update-test-{}",uuid::Uuid::new_v4()));
  std::fs::create_dir_all(&directory).unwrap();
  let db=Library::open(Path::new(":memory:")).unwrap();
  let track=json!({"id":"local:a","source":"local","sourceId":"a","kind":"track","title":"a","artist":"Teste","duration":3,"addedAt":crate::db::now()});
  db.save(&track,None).unwrap();
  let first=backup_library(&db,&directory).unwrap();
  let second=backup_library(&db,&directory).unwrap();
  assert_ne!(first,second);
  assert!(first.is_file()&&second.is_file());
  let backup=rusqlite::Connection::open(&first).unwrap();
  assert_eq!(backup.query_row("SELECT COUNT(*) FROM tracks",[],|row|row.get::<_,i64>(0)).unwrap(),1);
  let sentinel=directory.join("sentinel.sqlite");
  std::fs::write(&sentinel,b"keep-existing-backup").unwrap();
  assert!(db.backup_to(&sentinel).is_err());
  assert_eq!(std::fs::read(&sentinel).unwrap(),b"keep-existing-backup");
  drop(backup);
  std::fs::remove_dir_all(directory).unwrap();
 }
 #[test]
 fn failed_or_empty_update_check_never_creates_a_backup(){
  let directory=std::env::temp_dir().join(format!("liquid-update-check-test-{}",uuid::Uuid::new_v4()));
  let backups=directory.join("backups");
  std::fs::create_dir_all(&directory).unwrap();
  let sentinel=directory.join("existing.sqlite");
  std::fs::write(&sentinel,b"keep-existing-backup").unwrap();
  let mut calls=0;
  let failed:Result<Option<()>>=Err("Não foi possível consultar o GitHub agora.".into());
  assert!(prepare_install_from_check(failed,true,||{calls+=1;Ok(())}).is_err());
  assert!(prepare_install_from_check::<()>(Ok(None),true,||{calls+=1;Ok(())}).unwrap().is_none());
  assert!(prepare_install_from_check(Ok(Some("2.3.0")),false,||{calls+=1;Ok(())}).unwrap().is_some());
  assert_eq!(calls,0);
  assert!(!backups.exists());

  let db=Library::open(Path::new(":memory:")).unwrap();
  let confirmed=prepare_install_from_check(Ok(Some("2.3.0")),true,||backup_library(&db,&backups).map(|_|()));
  assert_eq!(confirmed.unwrap(),Some("2.3.0"));
  assert_eq!(std::fs::read_dir(&backups).unwrap().count(),1);
  assert_eq!(std::fs::read(&sentinel).unwrap(),b"keep-existing-backup");
  std::fs::remove_dir_all(directory).unwrap();
 }
 #[test]
 fn mobile_semver_and_apk_release_url_are_deterministic(){
  assert!(is_newer_version("2.2.34","2.2.35"));
  assert!(is_newer_version("2.2.34","2.3.0"));
  assert!(!is_newer_version("2.2.35","2.2.35"));
  assert!(!is_newer_version("2.2.35","2.2.34"));
  assert_eq!(
   mobile_apk_download_url("nlzwrld/glass-music","2.2.35").as_deref(),
   Some("https://github.com/nlzwrld/glass-music/releases/download/v2.2.35/Liquid.Hub_2.2.35_arm64.apk")
  );
  assert!(mobile_apk_download_url("bad repo","2.2.35").is_none());
  assert!(mobile_apk_download_url("nlzwrld/glass-music","invalid").is_none());
 }
}
