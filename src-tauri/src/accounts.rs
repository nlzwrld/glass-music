use crate::{db::{self,s,now,Result},collections::{self,Collection}};
use serde::{Serialize,Deserialize};use serde_json::{json,Value};
use std::{collections::HashMap,path::{Path,PathBuf},sync::{Mutex,atomic::{AtomicBool,Ordering}},time::Duration};
use base64::{Engine,engine::general_purpose::URL_SAFE_NO_PAD};use sha2::{Digest,Sha256};
#[derive(Clone,Default,Serialize,Deserialize)]#[serde(rename_all="camelCase",default)]pub struct Client{pub client_id:String,pub client_secret:String}
#[derive(Clone,Default,Serialize,Deserialize)]#[serde(rename_all="camelCase",default)]struct Session{access:String,refresh:String,expires:i64,name:String,user_id:String,last_sync:i64}
#[derive(Default,Serialize,Deserialize)]#[serde(default)]struct Vault{clients:HashMap<String,Client>,sessions:HashMap<String,Session>}
pub struct Accounts{path:PathBuf,vault:Mutex<Vault>,pub gate:tokio::sync::Mutex<()>,cancel:AtomicBool}
fn provider(id:&str)->Result<(&'static str,&'static str,&'static str,&'static str)>{match id{
 "spotify"=>Ok(("https://accounts.spotify.com/authorize","https://accounts.spotify.com/api/token","playlist-read-private playlist-read-collaborative user-library-read","https://api.spotify.com/v1/")),
 "youtube"=>Ok(("https://accounts.google.com/o/oauth2/v2/auth","https://oauth2.googleapis.com/token","https://www.googleapis.com/auth/youtube.readonly","https://www.googleapis.com/youtube/v3/")),
 "soundcloud"=>Ok(("https://secure.soundcloud.com/authorize","https://secure.soundcloud.com/oauth/token","","https://api.soundcloud.com/")),_=>Err("Conta inválida.".into())}}
fn client_ok(id:&str,c:&Client)->bool{!c.client_id.is_empty()&&(id!="soundcloud"||!c.client_secret.is_empty())}
impl Accounts{
 pub fn load(dir:&Path)->Result<Self>{let path=dir.join("accounts.dpapi");let vault=if path.exists(){let raw=std::fs::read(&path).map_err(|_|"Não foi possível ler as conexões.")?;serde_json::from_slice(&crate::secrets::protect(&raw,false)?).map_err(|_|"Conexões salvas inválidas.")?}else{Vault::default()};Ok(Self{path,vault:Mutex::new(vault),gate:tokio::sync::Mutex::new(()),cancel:AtomicBool::new(false)})}
 fn save(&self,vault:&Vault)->Result<()>{let bytes=crate::secrets::protect(&serde_json::to_vec(vault).map_err(|_|"Conexões inválidas.")?,true)?;let pending=self.path.with_extension("pending");std::fs::write(&pending,bytes).map_err(|_|"Não foi possível salvar a conexão.")?;std::fs::rename(pending,&self.path).map_err(|_|"Não foi possível salvar a conexão.".into())}
 pub fn status(&self)->Value{let vault=self.vault.lock().unwrap();json!(["youtube","soundcloud","spotify"].map(|id|{let session=vault.sessions.get(id);let ready=vault.clients.get(id).is_some_and(|c|client_ok(id,c));json!({"provider":id,"configured":ready,"connected":session.is_some(),"name":session.map(|s|s.name.as_str()).unwrap_or(""),"lastSync":session.map(|s|s.last_sync).unwrap_or(0),"reason":if ready{""}else{"O cadastro do Glass nesta plataforma ainda precisa ser ativado."}})}))}
 pub fn configure(&self,value:Value)->Result<Value>{let clients:HashMap<String,Client>=serde_json::from_value(value).map_err(|_|"Arquivo de cadastro inválido.")?;if clients.len()>3{return Err("Cadastro inválido.".into());}for(id,c)in &clients{provider(id)?;if c.client_id.len()>500||c.client_secret.len()>1000||c.client_id.contains(['\r','\n'])||c.client_secret.contains(['\r','\n']){return Err("Cadastro inválido.".into());}}
  let mut vault=self.vault.lock().unwrap();for(id,c)in clients{if vault.clients.get(&id).is_some_and(|old|old.client_id!=c.client_id){vault.sessions.remove(&id);}vault.clients.insert(id,c);}self.save(&vault)?;drop(vault);Ok(self.status())}
 pub fn ensure_active(&self,id:&str)->Result<()>{if self.cancel.load(Ordering::Acquire)||!self.vault.lock().unwrap().sessions.contains_key(id){return Err("Sincronização cancelada.".into());}Ok(())}
 pub fn cancel(&self){self.cancel.store(true,Ordering::Release);}
 pub fn disconnect(&self,id:&str)->Result<Value>{provider(id)?;self.cancel();let mut vault=self.vault.lock().unwrap();vault.sessions.remove(id);self.save(&vault)?;drop(vault);Ok(self.status())}
 fn client(&self,id:&str)->Result<Client>{provider(id)?;let v=self.vault.lock().unwrap();let c=v.clients.get(id).filter(|c|client_ok(id,c)).ok_or("A conexão oficial precisa do cadastro do Glass nesta plataforma. Isso é configurado uma vez para o aplicativo.")?;Ok(c.clone())}
 pub async fn connect(&self,id:&str,app:&tauri::AppHandle)->Result<Value>{
  use tauri_plugin_opener::OpenerExt;let _guard=self.gate.try_lock().map_err(|_|"Há outra conexão ou sincronização em andamento.")?;
  let c=self.client(id)?;let(auth,token,scope,_)=provider(id)?;self.cancel.store(false,Ordering::Release);
  // A single registered loopback callback for every provider. Never listen externally.
  let server=tiny_http::Server::http("127.0.0.1:43871").map_err(|_|"A porta de autorização está ocupada. Tente novamente.")?;
  let redirect="http://127.0.0.1:43871/callback";
  let state=format!("{}{}",uuid::Uuid::new_v4().simple(),uuid::Uuid::new_v4().simple());let verifier=format!("{}{}",uuid::Uuid::new_v4().simple(),uuid::Uuid::new_v4().simple());let challenge=URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
  let mut url=url::Url::parse(auth).unwrap();{let mut q=url.query_pairs_mut();q.append_pair("client_id",&c.client_id).append_pair("redirect_uri",redirect).append_pair("response_type","code").append_pair("state",&state).append_pair("code_challenge",&challenge).append_pair("code_challenge_method","S256");if !scope.is_empty(){q.append_pair("scope",scope);}if id=="youtube"{q.append_pair("access_type","offline").append_pair("prompt","consent");}}
  app.opener().open_url(url.as_str(),None::<&str>).map_err(|_|"Não foi possível abrir a autorização no navegador.")?;
  let start=std::time::Instant::now();let code=loop{
   if self.cancel.load(Ordering::Acquire){return Err("Conexão cancelada.".into());}if start.elapsed()>Duration::from_secs(300){return Err("A autorização expirou. Tente conectar novamente.".into());}
   if let Some(req)=server.recv_timeout(Duration::from_millis(80)).map_err(|_|"Falha no retorno da autorização.")?{
    let host_ok=req.headers().iter().any(|h|h.field.equiv("Host")&&h.value.as_str()=="127.0.0.1:43871");
    if req.method()!=&tiny_http::Method::Get||!host_ok{let _=req.respond(tiny_http::Response::empty(400));continue;}
    let result=callback_code(req.url(),&state);
    if req.url().starts_with("/callback?"){
     let success=result.is_ok();let body=if success{"Conta autorizada. Volte ao Glass Music."}else{"Autorização recusada ou inválida. Volte ao Glass Music."};let mut response=tiny_http::Response::from_string(body).with_status_code(if success{200}else{400});if let Ok(h)=tiny_http::Header::from_bytes("Cache-Control","no-store"){response.add_header(h);}let _=req.respond(response);break result?;
    }else{let _=req.respond(tiny_http::Response::empty(404));}
   }
   tokio::task::yield_now().await;
  };
  let mut form=vec![("grant_type","authorization_code"),("client_id",c.client_id.as_str()),("code",code.as_str()),("code_verifier",verifier.as_str()),("redirect_uri",redirect)];if !c.client_secret.is_empty(){form.push(("client_secret",&c.client_secret));}
  let data=collections::read(crate::providers::client().post(token).form(&form).send().await.map_err(|_|"Não foi possível concluir a autorização.")?).await?;
  let session=token_session(data,None)?;if self.cancel.load(Ordering::Acquire){return Err("Conexão cancelada.".into());}
  let mut vault=self.vault.lock().unwrap();vault.sessions.insert(id.to_string(),session);self.save(&vault)?;drop(vault);Ok(self.status())
 }
 async fn token(&self,id:&str)->Result<String>{
  let c=self.client(id)?;let session=self.vault.lock().unwrap().sessions.get(id).cloned().ok_or("Conecte a conta primeiro.")?;
  if session.expires>now()+60000{return Ok(session.access);}
  if session.refresh.is_empty(){return Err("A autorização expirou. Reconecte sua conta.".into());}
  let mut form=vec![("grant_type","refresh_token"),("client_id",c.client_id.as_str()),("refresh_token",session.refresh.as_str())];if !c.client_secret.is_empty(){form.push(("client_secret",&c.client_secret));}
  let data=collections::read(crate::providers::client().post(provider(id)?.1).form(&form).send().await.map_err(|_|"Falha ao renovar a conexão.")?).await?;
  let next=token_session(data,Some(session))?;let access=next.access.clone();let mut vault=self.vault.lock().unwrap();vault.sessions.insert(id.to_string(),next);self.save(&vault)?;Ok(access)
 }
 async fn api(&self,id:&str,path:&str)->Result<Value>{
  if self.cancel.load(Ordering::Acquire){return Err("Sincronização cancelada.".into());}
  let token=self.token(id).await?;let base=provider(id)?.3;let url=if path.starts_with("https://"){let u=url::Url::parse(path).map_err(|_|"Página inválida.")?;let b=url::Url::parse(base).unwrap();if u.origin()!=b.origin()||!u.path().starts_with(b.path())||u.username()!=""||u.password().is_some(){return Err("Destino de paginação inválido.".into());}path.to_string()}else{if path.starts_with('/')||path.contains("://"){return Err("Página inválida.".into());}format!("{base}{path}")};
  let auth=if id=="soundcloud"{format!("OAuth {token}")}else{format!("Bearer {token}")};collections::read(crate::providers::client().get(url).header("Authorization",auth).send().await.map_err(|_|"Não foi possível sincronizar agora.")?).await
 }
 async fn pages(&self,id:&str,first:&str,field:&str,limit:usize)->Result<Vec<Value>>{
  let mut path=first.to_string();let mut items=vec![];let mut seen=std::collections::HashSet::new();
  for _ in 0..200{if !seen.insert(path.clone()){return Err("Paginação repetida pela plataforma.".into());}let data=self.api(id,&path).await?;let rows=data[field].as_array().ok_or("Lista da conta inválida.")?;if items.len()+rows.len()>limit{return Err("Lista da conta excede o limite desta sincronização. Importe por playlist.".into());}items.extend(rows.iter().cloned());
   if let Some(token)=data["nextPageToken"].as_str(){let mut u=url::Url::parse(&format!("{}{first}",provider(id)?.3)).unwrap();u.query_pairs_mut().append_pair("pageToken",token);path=u.to_string();}
   else if let Some(next)=data["next"].as_str().or(data["next_href"].as_str()){path=next.to_string();}else{return Ok(items);}
  }Err("Muitas páginas na conta. Importe listas separadamente.".into())
 }
 pub async fn sync(&self,id:&str)->Result<Vec<(Collection,bool)>>{
  self.client(id)?;self.cancel.store(false,Ordering::Release);let mut lists=vec![];
  let(name,user)=match id{
   "spotify"=>{let me=self.api(id,"me").await?;(me["display_name"].as_str().unwrap_or("Spotify").to_string(),s(&me,"id").to_string())},
   "soundcloud"=>{let me=self.api(id,"me").await?;(s(&me,"username").to_string(),collections::soundcloud_id(&me,"users").ok_or("Identidade SoundCloud inválida.")?)},
   "youtube"=>{let me=self.api(id,"channels?part=snippet&mine=true").await?;let ch=me["items"].as_array().and_then(|a|a.first()).ok_or("Esta conta não tem um canal do YouTube acessível.")?;(s(&ch["snippet"],"title").to_string(),s(ch,"id").to_string())},_=>return Err("Conta inválida.".into())};
  if user.is_empty(){return Err("A plataforma não retornou a identidade da conta.".into());}
  let prefix=format!("account:{id}:{user}:");
  let make=|key:&str,title:String,tracks:Vec<Value>|Collection{artwork:tracks.iter().map(|t|s(t,"artwork")).find(|u|!u.is_empty()).unwrap_or("").into(),key:format!("{prefix}{key}"),name:title,tracks,warning:String::new(),skipped:0};
  match id{
   "spotify"=>{
    let likes=self.pages(id,"me/tracks?limit=50","items",1000).await?;let tracks:Vec<_>=likes.iter().filter_map(|v|collections::spotify_track(&v["track"])).collect();lists.push((make("likes","Spotify · Curtidas".into(),tracks),true));
    for list in self.pages(id,"me/playlists?limit=50","items",100).await?{let pid=s(&list,"id");if pid.len()!=22{continue;}let rows=self.pages(id,&format!("playlists/{pid}/items?limit=50"),"items",1000).await?;let tracks=rows.iter().filter_map(|v|collections::spotify_track(v.get("item").or(v.get("track")).unwrap_or(&Value::Null))).collect();lists.push((make(pid,format!("Spotify · {}",s(&list,"name")),tracks),false));}
   },
   "youtube"=>{
    let liked=self.pages(id,"videos?part=snippet&myRating=like&maxResults=50","items",1000).await?;let tracks=liked.iter().filter_map(|v|{let mut t=v.clone();t["title"]=v["snippet"]["title"].clone();t["channel"]=v["snippet"]["channelTitle"].clone();collections::youtube_track(&t)}).collect();lists.push((make("likes","YouTube · Curtidas".into(),tracks),true));
    for list in self.pages(id,"playlists?part=snippet&mine=true&maxResults=50","items",100).await?{let pid=s(&list,"id");if !db::valid_id(pid){continue;}let rows=self.pages(id,&format!("playlistItems?part=snippet&playlistId={pid}&maxResults=50"),"items",1000).await?;let tracks=rows.iter().filter_map(|v|{let mut t=v.clone();t["id"]=v["snippet"]["resourceId"]["videoId"].clone();collections::youtube_track(&t)}).collect();lists.push((make(pid,format!("YouTube · {}",s(&list["snippet"],"title")),tracks),false));}
   },
   _=>{
    let likes=self.pages(id,"me/likes/tracks?limit=100&linked_partitioning=true","collection",1000).await?;let tracks=likes.iter().filter_map(|v|collections::soundcloud_track(v.get("track").unwrap_or(v))).collect();lists.push((make("likes","SoundCloud · Curtidas".into(),tracks),true));
    for list in self.pages(id,"me/playlists?limit=100&linked_partitioning=true&show_tracks=false","collection",100).await?{let pid=collections::soundcloud_id(&list,"playlists").ok_or("Playlist SoundCloud inválida.")?;let rows=self.pages(id,&format!("playlists/soundcloud:playlists:{pid}/tracks?limit=100&linked_partitioning=true"),"collection",1000).await?;let tracks=rows.iter().filter_map(collections::soundcloud_track).collect();lists.push((make(&pid,format!("SoundCloud · {}",s(&list,"title")),tracks),false));}
   }
  }
  self.ensure_active(id)?;let mut vault=self.vault.lock().unwrap();if let Some(session)=vault.sessions.get_mut(id){session.name=name;session.user_id=user;}self.save(&vault)?;Ok(lists)
 }
 pub fn synced(&self,id:&str)->Result<()>{let mut v=self.vault.lock().unwrap();if let Some(s)=v.sessions.get_mut(id){s.last_sync=now();}self.save(&v)}
}
fn callback_code(raw:&str,state:&str)->Result<String>{
 let u=url::Url::parse(&format!("http://127.0.0.1:43871{raw}")).map_err(|_|"Retorno inválido.")?;if u.path()!="/callback"||raw.len()>8192{return Err("Retorno inválido.".into());}
 let pairs:Vec<_>=u.query_pairs().into_owned().collect();let params:HashMap<_,_>=pairs.iter().cloned().collect();if params.len()!=pairs.len(){return Err("Retorno ambíguo.".into());}if params.get("state").map(String::as_str)!=Some(state){return Err("A autorização não corresponde à solicitação.".into());}if params.contains_key("error"){return Err("Autorização recusada pela conta.".into());}params.get("code").filter(|s|!s.is_empty()&&s.len()<4096).cloned().ok_or("Código de autorização ausente.".into())
}
fn token_session(data:Value,old:Option<Session>)->Result<Session>{let mut next=old.unwrap_or_default();next.access=data["access_token"].as_str().filter(|s|!s.is_empty()&&s.len()<16000).ok_or("A plataforma não retornou uma autorização válida.")?.to_string();if let Some(refresh)=data["refresh_token"].as_str(){if refresh.is_empty()||refresh.len()>16000{return Err("Renovação inválida.".into());}next.refresh=refresh.to_string();}next.expires=now()+data["expires_in"].as_i64().unwrap_or(3600).clamp(60,86400)*1000;Ok(next)}
#[cfg(test)]mod tests{use super::*;#[test]fn callback_requires_state_and_code(){assert_eq!(callback_code("/callback?state=ok&code=abc","ok").unwrap(),"abc");for raw in ["/callback?state=wrong&code=abc","/callback?state=ok&error=access_denied","/other?state=ok&code=abc","/callback?state=bad&state=ok&code=abc"]{assert!(callback_code(raw,"ok").is_err());}}#[test]fn refresh_rotation_preserves_only_when_omitted(){let old=Session{refresh:"old".into(),..Default::default()};let new=token_session(json!({"access_token":"a","refresh_token":"new","expires_in":3600}),Some(old)).unwrap();assert_eq!(new.refresh,"new");let preserved=token_session(json!({"access_token":"b"}),Some(new)).unwrap();assert_eq!(preserved.refresh,"new");}}

#[cfg(test)]mod storage_tests{
 use super::*;
 #[test]fn account_tokens_are_encrypted_and_status_does_not_expose_them(){
  let dir=std::env::temp_dir().join(format!("glass-account-test-{}",uuid::Uuid::new_v4()));std::fs::create_dir(&dir).unwrap();
  let accounts=Accounts::load(&dir).unwrap();accounts.configure(json!({"spotify":{"clientId":"test-app-id"}})).unwrap();
  {let mut v=accounts.vault.lock().unwrap();v.sessions.insert("spotify".into(),Session{access:"secret-access-fixture-190".into(),refresh:"secret-refresh-fixture-190".into(),..Default::default()});accounts.save(&v).unwrap();}
  let raw=std::fs::read(dir.join("accounts.dpapi")).unwrap();assert!(!String::from_utf8_lossy(&raw).contains("secret-access-fixture-190"));
  let restored=Accounts::load(&dir).unwrap();let status=restored.status();assert!(status.as_array().unwrap().iter().any(|v|v["provider"]=="spotify"&&v["connected"]==true));assert!(!status.to_string().contains("secret-"));
  restored.disconnect("spotify").unwrap();assert!(Accounts::load(&dir).unwrap().status().as_array().unwrap().iter().all(|v|v["connected"]==false));
  std::fs::remove_file(dir.join("accounts.dpapi")).unwrap();std::fs::remove_dir(dir).unwrap();
 }
}
