use crate::db::{s,Result};
use serde_json::{json,Value};
use tauri::AppHandle;
use tauri_plugin_updater::UpdaterExt;
pub async fn status(app:&AppHandle,consent:bool,install:bool)->Result<Value>{
 let config:Value=serde_json::from_str(include_str!("../release.json")).map_err(|_|"Canal de atualização inválido.")?;let endpoint=s(&config,"endpoint");
 if endpoint.is_empty(){return Ok(json!({"configured":false,"available":false,"version":env!("CARGO_PKG_VERSION"),"message":"O canal do GitHub ainda não foi publicado."}));}
 if !consent{return Err("Ative o acesso online para verificar atualizações.".into());}
 static GATE:tokio::sync::Semaphore=tokio::sync::Semaphore::const_new(1);let _permit=GATE.try_acquire().map_err(|_|"Uma atualização já está sendo verificada.")?;
 let url=url::Url::parse(endpoint).map_err(|_|"Canal inválido.")?;if url.scheme()!="https"||url.host_str()!=Some("github.com"){return Err("Canal de atualização inválido.".into());}
 let updater=app.updater_builder().endpoints(vec![url]).map_err(|e|e.to_string())?.timeout(std::time::Duration::from_secs(20)).build().map_err(|e|e.to_string())?;
 let Some(update)=updater.check().await.map_err(|_|"Não foi possível consultar o GitHub agora.")?else{return Ok(json!({"configured":true,"available":false,"version":env!("CARGO_PKG_VERSION"),"message":"O aplicativo está atualizado."}));};
 let version=update.version.clone();if install{update.download_and_install(|_,_|{},||{}).await.map_err(|_|"Não foi possível verificar e instalar a atualização assinada.")?;}
 Ok(json!({"configured":true,"available":true,"version":version,"message":format!("Versão {version} disponível. A atualização automática será instalada quando a reprodução estiver parada.")}))
}
