use crate::db::{Library, Result};
#[cfg(desktop)]
use crate::db::s;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use tauri::AppHandle;
#[cfg(desktop)]
use tauri_plugin_updater::UpdaterExt;

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
    if install {
        update
            .download_and_install(|_, _| {}, || {})
            .await
            .map_err(|_| "Não foi possível verificar e instalar a atualização assinada.")?;
        app.restart();
    }
    Ok(json!({"configured":true,"available":true,"version":version,"message":format!("Versão {version} disponível.")}))
}
#[cfg(mobile)]
pub async fn status(
    _app: &AppHandle,
    _consent: bool,
    _install: bool,
    _before_install: impl FnOnce() -> Result<()>,
) -> Result<Value> {
    Ok(json!({
        "configured": false,
        "available": false,
        "version": env!("CARGO_PKG_VERSION"),
        "message": "Atualizações no Android Beta são distribuídas pelo canal APK/Play Store."
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
}
