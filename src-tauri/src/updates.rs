use crate::db::{s,Library,Result};
use serde_json::{json,Value};
use std::path::{Path,PathBuf};
use tauri::AppHandle;
use tauri_plugin_updater::UpdaterExt;

pub fn backup_library(db:&Library,directory:&Path)->Result<PathBuf>{
 std::fs::create_dir_all(directory).map_err(|e|e.to_string())?;
 let path=directory.join(format!("before-update-{}.sqlite",uuid::Uuid::new_v4()));
 db.backup_to(&path)?;
 Ok(path)
}
fn prepare_install_from_check<T>(check:Result<Option<T>>,install:bool,before_install:impl FnOnce()->Result<()>) -> Result<Option<T>>{
 let update=check?;
 if install&&update.is_some(){before_install()?;}
 Ok(update)
}
pub async fn status(app:&AppHandle,consent:bool,install:bool,before_install:impl FnOnce()->Result<()>)->Result<Value>{
 let config:Value=serde_json::from_str(include_str!("../release.json")).map_err(|_|"Canal de atualização inválido.")?;let endpoint=s(&config,"endpoint");
 if endpoint.is_empty(){return Ok(json!({"configured":false,"available":false,"version":env!("CARGO_PKG_VERSION"),"message":"O canal do GitHub ainda não foi publicado."}));}
 if !consent{return Err("Ative o acesso online para verificar atualizações.".into());}
 static GATE:tokio::sync::Semaphore=tokio::sync::Semaphore::const_new(1);let _permit=GATE.try_acquire().map_err(|_|"Uma atualização já está sendo verificada.")?;
 let url=url::Url::parse(endpoint).map_err(|_|"Canal inválido.")?;if url.scheme()!="https"||url.host_str()!=Some("github.com"){return Err("Canal de atualização inválido.".into());}
 let updater=app.updater_builder().endpoints(vec![url]).map_err(|e|e.to_string())?.timeout(std::time::Duration::from_secs(20)).build().map_err(|e|e.to_string())?;
 let checked=updater.check().await.map_err(|_|"Não foi possível consultar o GitHub agora.".into());
 let Some(update)=prepare_install_from_check(checked,install,before_install)?else{return Ok(json!({"configured":true,"available":false,"version":env!("CARGO_PKG_VERSION"),"message":"O aplicativo está atualizado."}));};
 let version=update.version.clone();if install{update.download_and_install(|_,_|{},||{}).await.map_err(|_|"Não foi possível verificar e instalar a atualização assinada.")?;app.restart();}
 Ok(json!({"configured":true,"available":true,"version":version,"message":format!("Versão {version} disponível.")}))
}

#[cfg(test)]
mod tests{
 use super::*;
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
