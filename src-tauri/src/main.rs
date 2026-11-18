#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
mod db;
mod media;
mod providers;
mod secrets;
mod catalog;
mod direct_catalog;
mod links;
mod audio;
mod corners;
mod desktop_backdrop;
mod collections;
mod lyrics;
mod offline;
mod updates;
mod jam;
mod accounts;
mod platforms;
use db::{s, Library, Result};
use serde_json::{json, Value};
use std::{
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::Instant,
};
use tauri::{
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    Emitter, LogicalSize, Manager,
};
use tauri_plugin_autostart::ManagerExt;
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Shortcut, ShortcutState};
use tauri_plugin_notification::NotificationExt;
use tauri_plugin_opener::OpenerExt;
fn native_environment(window:&tauri::WebviewWindow,pref:&Value){
    let is_glass=pref.get("uiStyle").and_then(|v|v.as_str()).unwrap_or("matte")=="glass";
    let desktop=is_glass && pref["appearance"]["background"]=="desktop";
    let target=window.clone();
    let _=window.run_on_main_thread(move || {
        let _=target.set_effects(None);
        if let Ok(hwnd)=target.hwnd(){
            let ok=desktop_backdrop::apply(hwnd.0,desktop);
            if desktop && !ok {
                use tauri::window::{Color,Effect,EffectsBuilder};
                let _=target.set_effects(EffectsBuilder::new().effect(Effect::Acrylic).color(Color(18,21,23,22)).build());
            }
            corners::apply(hwnd.0,target.scale_factor().unwrap_or(1.0));
        }
    });
}

struct State {
    db: Arc<Mutex<Library>>,
    secrets: Mutex<secrets::Secrets>,
    search: Mutex<providers::SearchState>,
    data: PathBuf,
    base: String,
    shortcuts: AtomicBool,
    catalog_url: String,
    direct: direct_catalog::DirectCatalog,
    audio: Arc<audio::AudioStreams>,
    accounts: accounts::Accounts,
}
fn status(st: &State) -> Value {
    let keys = st.secrets.lock().unwrap();
    let ready = !st.catalog_url.is_empty() || st.direct.available();
    let mode = if !st.catalog_url.is_empty() { "hosted" } else if ready { "direct" } else { "unavailable" };
    json!({"youtube":ready,"soundcloud":ready,"catalogConfigured":ready,"catalogMode":mode,"encrypted":true,"brokerUrl":keys.broker_url,"version":env!("CARGO_PKG_VERSION"),"gpu":true,"shortcuts":st.shortcuts.load(Ordering::Relaxed)})
}
fn shortcuts(app: &tauri::AppHandle, enabled: bool) -> bool {
    let _ = app.global_shortcut().unregister_all();
    if !enabled {
        return false;
    }
    let mut good = true;
    for (code, command) in [
        (Code::MediaPlayPause, "playPause"),
        (Code::MediaTrackNext, "next"),
        (Code::MediaTrackPrevious, "previous"),
    ] {
        good &= app
            .global_shortcut()
            .on_shortcut(Shortcut::new(None, code), move |app, _, event| {
                if event.state == ShortcutState::Pressed {
                    let _ = app.emit_to("main", "media", command);
                }
            })
            .is_ok();
    }
    good
}
fn close(app: &tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = app.emit_to("main", "media", "pauseVideo");
        let tray = app.state::<State>().db.lock().unwrap().pref()["tray"] == true;
        if tray {
            let _ = w.hide();
            let _ = app.emit_to("main", "glass-visual-visible", false);
        } else {
            app.exit(0);
        }
    }
}
fn main_window_size(window: &tauri::WebviewWindow) -> LogicalSize<f64> {
    if let Ok(Some(monitor)) = window.current_monitor() {
        let size = monitor.size().to_logical::<f64>(monitor.scale_factor());
        return LogicalSize::new((size.width - 40.0).clamp(920.0, 1672.0), (size.height - 80.0).clamp(650.0, 941.0));
    }
    LogicalSize::new(1366.0, 768.0)
}
#[tauri::command]
async fn call(
    action: String,
    payload: Option<Value>,
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    st: tauri::State<'_, State>,
) -> Result<Value> {
    if window.label() != "main" && !(window.label()=="lyrics"&&["bootstrap","lyrics","lyricsControl","closeLyrics"].contains(&action.as_str())) {
        return Err("Janela sem permissão.".into());
    }
    let p = payload.unwrap_or(Value::Null);
    if p.to_string().len() > 8_000_000 {
        return Err("Solicitação muito grande.".into());
    }
    match action.as_str(){
    "bootstrap"=>{let data_snap={let db=st.db.lock().unwrap();let pref=db.pref();if pref["onlineConsent"]==true&&pref["onboardingDone"]==true{direct_catalog::warm_visitor();}db.snapshot()?};let mut data=data_snap;data["_resourceBase"]=json!(st.base);Ok(data)},
    "library"=>{let old=if p["action"]=="removeTrack"{st.db.lock().unwrap().offline_path(s(&p,"id"))}else{None};let v=st.db.lock().unwrap().command(&p)?;if let Some((path,_))=old{if offline::owned_path(&st.data,&path){let _=std::fs::remove_file(path);}}Ok(v)},
    "preferences"=>{db::validate_prefs(&p)?;let old=st.db.lock().unwrap().pref();if old["startup"]!=p["startup"]{if p["startup"]==true{app.autolaunch().enable()}else{app.autolaunch().disable()}.map_err(|_|"Não foi possível alterar a inicialização do Windows.")?;}if old["globalShortcuts"]!=p["globalShortcuts"]{st.shortcuts.store(shortcuts(&app,p["globalShortcuts"]==true),Ordering::Relaxed);}if old["appearance"]["background"]!=p["appearance"]["background"]||old["uiStyle"]!=p["uiStyle"]{native_environment(&window,&p);}st.db.lock().unwrap().set_pref(&p)?;if old["onlineConsent"]!=p["onlineConsent"]||old["catalogConsent"]!=p["catalogConsent"]||old["onboardingDone"]!=p["onboardingDone"]{let mut search=st.search.lock().unwrap();search.cache.clear();st.audio.clear();st.accounts.cancel();for token in search.requests.values(){token.cancel();}if p["onlineConsent"]==true&&p["onboardingDone"]==true{direct_catalog::warm_visitor();}}Ok(p)},
    "integrations"=>Ok(status(&st)),
    "credentials"=>{let mut keys=st.secrets.lock().unwrap();let mut next=keys.clone();next.update(&p)?;next.save(&st.data.join("credentials.dpapi"))?;*keys=next;drop(keys);st.search.lock().unwrap().cache.clear();Ok(status(&st))},
    "search"=>{
      providers::validate_search(&p)?;let id=s(&p,"requestId").to_string();let key=json!([p["query"],p["kind"],p["source"],p["cursor"]]).to_string();
      {let cache=st.search.lock().unwrap();if let Some((at,v))=cache.cache.get(&key){if at.elapsed().as_secs()<300{return Ok(v.clone());}}}
      let token=tokio_util::sync::CancellationToken::new();{let mut search=st.search.lock().unwrap();if search.requests.len()>=30{return Err("Muitas consultas simultâneas.".into());}if let Some(prev)=search.requests.insert(id.clone(),token.clone()){prev.cancel();}}
      let snap=st.db.lock().unwrap().snapshot()?;let consent=snap["preferences"]["onlineConsent"]==true&&snap["preferences"]["catalogConsent"]==true&&snap["preferences"]["onboardingDone"]==true;let local=snap["tracks"].as_array().unwrap().iter().filter(|t|s(t,"source")=="local").cloned().collect();
      let result=tokio::select!{_ = token.cancelled()=>Err("Pesquisa cancelada.".into()),r=providers::search(&p,local,consent,&st.catalog_url,&st.direct)=>r};
      let mut search=st.search.lock().unwrap();search.requests.remove(&id);if let Ok(ref v)=result{if v["notices"].as_array().is_some_and(|a|a.is_empty()){if search.cache.len()>=80{search.cache.clear();}search.cache.insert(key,(Instant::now(),v.clone()));}}result
    },
    "discover"=>{
      let pref=st.db.lock().unwrap().pref();if pref["onlineConsent"]!=true||pref["catalogConsent"]!=true||pref["onboardingDone"]!=true{return Err("Ative as integrações nas Configurações para ver os catálogos online.".into());}
      let id=s(&p,"requestId").to_string();if !db::valid_id(&id){return Err("Solicitação inválida.".into());}
      {let search=st.search.lock().unwrap();if let Some((at,v))=search.cache.get("catalog:discover"){if at.elapsed().as_secs()<300{return Ok(v.clone());}}}
      let token=tokio_util::sync::CancellationToken::new();{let mut search=st.search.lock().unwrap();if search.requests.len()>=30{return Err("Muitas consultas simultâneas.".into());}if let Some(prev)=search.requests.insert(id.clone(),token.clone()){prev.cancel();}}
      let result=tokio::select!{_ = token.cancelled()=>Err("Consulta cancelada.".into()),r=async { if st.catalog_url.is_empty() { st.direct.discover().await } else { catalog::discover(&st.catalog_url).await } }=>r};
      let mut search=st.search.lock().unwrap();search.requests.remove(&id);if let Ok(ref v)=result{if v["notices"].as_array().is_some_and(|a|a.is_empty()){if search.cache.len()>=80{search.cache.clear();}search.cache.insert("catalog:discover".into(),(Instant::now(),v.clone()));}}result
    },
    "cancelSearch"=>{if let Some(t)=st.search.lock().unwrap().requests.remove(p.as_str().unwrap_or("")){t.cancel();}Ok(Value::Null)},
    "accounts"=>Ok(st.accounts.status()),
    "cancelAccount"=>{st.accounts.cancel();Ok(Value::Null)},
    "configureAccounts"=>{if let Some(file)=rfd::AsyncFileDialog::new().set_title("Cadastro OAuth do Glass Music").add_filter("Cadastro JSON",&["json"]).pick_file().await{if std::fs::metadata(file.path()).map_err(|_|"Arquivo indisponível.")?.len()>16000{return Err("Arquivo de cadastro muito grande.".into());}let bytes=std::fs::read(file.path()).map_err(|_|"Arquivo indisponível.")?;let config=serde_json::from_slice(&bytes).map_err(|_|"Cadastro JSON inválido.")?;let _guard=st.accounts.gate.try_lock().map_err(|_|"Há uma conexão em andamento.")?;st.accounts.configure(config)}else{Ok(st.accounts.status())}},
    "connectAccount"=>{let pref=st.db.lock().unwrap().pref();if pref["onlineConsent"]!=true||pref["catalogConsent"]!=true||pref["onboardingDone"]!=true{return Err("Ative o acesso online antes de conectar uma conta.".into());}st.accounts.connect(p.as_str().ok_or("Conta inválida.")?,&app).await},
    "disconnectAccount"=>{st.accounts.cancel();let _guard=st.accounts.gate.lock().await;st.accounts.disconnect(p.as_str().ok_or("Conta inválida.")?)},
    "syncAccount"=>{
      let pref=st.db.lock().unwrap().pref();if pref["onlineConsent"]!=true||pref["catalogConsent"]!=true||pref["onboardingDone"]!=true{return Err("Ative o acesso online antes de sincronizar.".into());}
      let provider=p.as_str().ok_or("Conta inválida.")?;let _guard=st.accounts.gate.try_lock().map_err(|_|"Há outra sincronização em andamento.")?;let lists=st.accounts.sync(provider).await?;st.accounts.ensure_active(provider)?;let pref=st.db.lock().unwrap().pref();if pref["onlineConsent"]!=true||pref["catalogConsent"]!=true||pref["onboardingDone"]!=true{return Err("Sincronização cancelada: acesso online desativado.".into());}
      let mut count=0;let mut tracks=0;for(list,liked)in lists{if list.tracks.is_empty(){continue;}let pid=st.db.lock().unwrap().merge_collection(&list.key,&list.name,&list.tracks,liked)?;st.db.lock().unwrap().collection_artwork(&pid,&list.artwork)?;count+=1;tracks+=list.tracks.len();}
      st.accounts.synced(provider)?;let snapshot=st.db.lock().unwrap().snapshot()?;Ok(json!({"snapshot":snapshot,"playlists":count,"tracks":tracks,"accounts":st.accounts.status()}))
    },
    "playlistMeta"=>{
      let id=s(&p,"id");if !db::valid_id(id){return Err("Playlist inválida.".into());}
      let db=st.db.lock().unwrap();
      if let Some(art)=p["artwork"].as_str(){if !art.is_empty(){db.collection_artwork(id,art)?;}}
      if p.get("description").is_some(){db.collection_description(id,s(&p,"description"))?;}
      db.snapshot()
    },
    "recommendations"=>{
      let pref=st.db.lock().unwrap().pref();if pref["onlineConsent"]!=true||pref["onboardingDone"]!=true{return Ok(json!([]));}
      let seeds=p["seeds"].as_array().cloned().unwrap_or_default();
      let exclude:Vec<String>=p["excludeIds"].as_array().into_iter().flatten().filter_map(|v|v.as_str().map(str::to_string)).take(2500).collect();
      let items=platforms::style_recommendations(&seeds,&exclude,&st.direct).await?;
      Ok(json!(items))
    },
    "previewCollection"=>{
      let pref=st.db.lock().unwrap().pref();if pref["onlineConsent"]!=true||pref["onboardingDone"]!=true{return Err("Ative o acesso online para abrir este álbum ou playlist.".into());}
      let url=p.as_str().ok_or("Link inválido.")?;
      let list=collections::fetch(url,&st.direct).await?;
      Ok(json!({"name":list.name,"artwork":list.artwork,"url":list.key,"tracks":list.tracks,"warning":list.warning,"skipped":list.skipped}))
    },
    "importLink"=>{
      let pref=st.db.lock().unwrap().pref();if pref["onlineConsent"]!=true||pref["onboardingDone"]!=true{return Err("Ative o acesso online após ler os termos.".into());}
      let url=s(&p,"url");if collections::is_playlist(url)||p["playlist"]==true{
       let list=collections::fetch(url,&st.direct).await?;let pref=st.db.lock().unwrap().pref();if pref["onlineConsent"]!=true{return Err("Importação cancelada: acesso online desativado.".into());}
       let id=st.db.lock().unwrap().merge_collection(&list.key,&list.name,&list.tracks,false)?;st.db.lock().unwrap().collection_artwork(&id,&list.artwork)?;let snapshot=st.db.lock().unwrap().snapshot()?;Ok(json!({"snapshot":snapshot,"playlistId":id,"count":list.tracks.len(),"warning":list.warning,"skipped":list.skipped}))
      }else{
       let track=links::resolve(url).await?;let pref=st.db.lock().unwrap().pref();if pref["onlineConsent"]!=true||pref["onboardingDone"]!=true{return Err("Importação cancelada: acesso online desativado.".into());}if track["kind"]!="track"{return Err("Use o link de uma faixa, álbum ou playlist.".into());}st.db.lock().unwrap().save(&track,None)?;let snapshot=st.db.lock().unwrap().snapshot()?;Ok(json!({"snapshot":snapshot,"track":track,"warning":""}))
      }
    },
    "resolveLink"=>{if {let pref=st.db.lock().unwrap().pref();pref["onlineConsent"]!=true||pref["onboardingDone"]!=true}{return Err("Ative as integrações após ler os termos.".into());}links::resolve(p.as_str().ok_or("Link inválido")?).await},
    "linkPlayback"=>{
      let pref=st.db.lock().unwrap().pref();if pref["onlineConsent"]!=true||pref["catalogConsent"]!=true||pref["onboardingDone"]!=true{return Err("Ative o acesso online para localizar o áudio desta música.".into());}
      let id=s(&p,"requestId").to_string();if !db::valid_id(&id){return Err("Solicitação inválida.".into());}
      let token=tokio_util::sync::CancellationToken::new();{let mut search=st.search.lock().unwrap();if search.requests.len()>=30{return Err("Muitas consultas simultâneas.".into());}if let Some(old)=search.requests.insert(id.clone(),token.clone()){old.cancel();}}
      let result=tokio::select!{_ = token.cancelled()=>Err("Reprodução cancelada.".into()),r=links::playback(p["track"].clone(),&st.catalog_url,&st.direct)=>r};st.search.lock().unwrap().requests.remove(&id);result
    },
    "offlineSource"=>{let id=p.as_str().ok_or("Faixa inválida.")?;let db=st.db.lock().unwrap();if let Some((path,duration))=db.offline_path(id){if offline::owned_path(&st.data,&path)&&std::path::Path::new(&path).is_file(){return Ok(json!({"url":format!("{}/offline/{}",st.base,url::form_urlencoded::byte_serialize(id.as_bytes()).collect::<String>()),"duration":duration}));}db.remove_offline(id)?;}Ok(Value::Null)},
    "downloadOffline"=>{
      static DOWNLOAD:tokio::sync::Semaphore=tokio::sync::Semaphore::const_new(2);let _permit=DOWNLOAD.acquire().await.map_err(|_|"Serviço de download indisponível.")?;
      let pref=st.db.lock().unwrap().pref();if pref["onlineConsent"]!=true||pref["onboardingDone"]!=true{return Err("Ative o acesso online para baixar.".into());}db::validate_track(&p)?;
      if !["youtube","link"].contains(&s(&p,"source")){return Err("Esta origem não disponibiliza download neste app.".into());}
      let track=if p["source"]=="link"{links::playback(p.clone(),&st.catalog_url,&st.direct).await?}else{p.clone()};
      let stream=st.direct.audio(track["playbackId"].as_str().unwrap_or(s(&track,"sourceId"))).await?;
      let(path,size,duration)=offline::download(&st.data,s(&track,"id"),&stream).await?;
      let db=st.db.lock().unwrap();if db.pref()["onlineConsent"]!=true{let _=std::fs::remove_file(path);return Err("Download cancelado: acesso online desativado.".into());}db.save(&track,None)?;db.save_offline(s(&track,"id"),path.to_str().ok_or("Pasta inválida.")?,size,duration)?;db.snapshot()
    },
    "removeOffline"=>{let id=p.as_str().ok_or("Faixa inválida.")?;let db=st.db.lock().unwrap();if let Some((path,_))=db.offline_path(id){if offline::owned_path(&st.data,&path){let _=std::fs::remove_file(path);}db.remove_offline(id)?;}db.snapshot()},
    "importAudio"=>{
      if let Some(files)=rfd::AsyncFileDialog::new().set_title("Importar arquivos de áudio").add_filter("Áudio",&["mp3","flac","wav","m4a","ogg","opus","aac","webm"]).pick_files().await{
        let db=st.db.lock().unwrap();
        for file in files.iter().take(500){
          let _=media::import_file(&db,file.path(),&st.data);
        }
        db.snapshot()
      }else{
        st.db.lock().unwrap().snapshot()
      }
    },
    "exportLibrary"=>{let v=st.db.lock().unwrap().export(p.as_str())?;if let Some(file)=rfd::AsyncFileDialog::new().set_file_name("Glass Music - biblioteca.json").add_filter("Biblioteca JSON",&["json"]).save_file().await{std::fs::write(file.path(),serde_json::to_vec_pretty(&v).map_err(|e|e.to_string())?).map_err(|e|e.to_string())?;Ok(json!(true))}else{Ok(json!(false))}},
    "importLibrary"=>{if let Some(file)=rfd::AsyncFileDialog::new().add_filter("Biblioteca JSON",&["json"]).pick_file().await{if std::fs::metadata(file.path()).map_err(|e|e.to_string())?.len()>8_000_000{return Err("Biblioteca maior que 8 MB.".into());}let v:Value=serde_json::from_slice(&std::fs::read(file.path()).map_err(|e|e.to_string())?).map_err(|_|"JSON inválido")?;let snap=st.db.lock().unwrap().import(&v)?;st.search.lock().unwrap().cache.clear();Ok(snap)}else{Ok(Value::Null)}},
    "audioSource"=>{
      let pref=st.db.lock().unwrap().pref();if pref["onlineConsent"]!=true||pref["onboardingDone"]!=true{return Err("Ative o acesso online antes de reproduzir.".into());}
      let video=s(&p,"videoId");let id=s(&p,"requestId").to_string();
      let title=s(&p,"title");let artist=s(&p,"artist");let duration=p["duration"].as_f64().unwrap_or(0.0);
      if !db::valid_id(&id){return Err("Solicitação inválida.".into());}
      let valid_video=video.len()==11&&video.bytes().all(|b|b.is_ascii_alphanumeric()||b"_-".contains(&b));
      if valid_video {
        if let Some((ticket,dur))=st.audio.cached(video){return Ok(json!({"url":format!("{}/audio/{ticket}",st.base),"duration":dur}));}
      } else if title.is_empty() {
        return Err("Referência de música inválida.".into());
      }
      let token=tokio_util::sync::CancellationToken::new();{let mut search=st.search.lock().unwrap();if search.requests.len()>=30{return Err("Muitas consultas simultâneas.".into());}if let Some(old)=search.requests.insert(id.clone(),token.clone()){old.cancel();}}
      let primary_future=async {
        if valid_video {
          if let Ok(v)=st.direct.audio(video).await { return Ok((video.to_string(),v)); }
        }
        if !title.is_empty() {
          let (rescued_id,maybe_stream)=links::find_playable_youtube_id(title,artist,duration,video,&st.catalog_url,&st.direct).await?;
          let stream=match maybe_stream { Some(s)=>s, None=>st.direct.audio(&rescued_id).await? };
          return Ok((rescued_id,stream));
        }
        Err("A plataforma não disponibilizou áudio para esta faixa.".into())
      };
      let result:Result<(String,Value)>=tokio::select!{_ = token.cancelled()=>Err("Reprodução cancelada.".into()),r=primary_future=>r};
      st.search.lock().unwrap().requests.remove(&id);
      let (resolved_video,value)=result?;if token.is_cancelled(){return Err("Reprodução cancelada.".into());}
      let (ticket,dur)=st.audio.register(&resolved_video,&value)?;
      Ok(json!({"url":format!("{}/audio/{ticket}",st.base),"duration":dur,"videoId":resolved_video}))
    },
    "playerUrl"=>Ok(json!(format!("{}/embed/index.html",st.base))),
    "external"=>{let url=p.as_str().ok_or("Link inválido")?;if !db::official_url(url)&&!links::public_url(url){return Err("Link não autorizado.".into());}app.opener().open_url(url,None::<&str>).map_err(|_|"Não foi possível abrir o navegador.")?;Ok(Value::Null)},
    "lyrics"=>{
      let pref=st.db.lock().unwrap().pref();if pref["onlineConsent"]!=true||pref["onboardingDone"]!=true{return Err("Ative o acesso online para carregar letras.".into());}
      db::validate_track(&p)?;let result=lyrics::fetch(&p).await?;
      if st.db.lock().unwrap().pref()["onlineConsent"]!=true{return Err("Acesso online desativado.".into());}Ok(result)
    },
    "trackArtwork"=>{
      let id=p.as_str().filter(|id|db::valid_id(id)).ok_or("Faixa inválida.")?;
      let snapshot=st.db.lock().unwrap().snapshot()?;
      if snapshot["preferences"]["onlineConsent"]!=true||snapshot["preferences"]["onboardingDone"]!=true{return Ok(Value::Null);}
      let track=snapshot["tracks"].as_array().unwrap().iter().find(|t|t["id"]==id).ok_or("Faixa não encontrada.")?;
      if !s(track,"artwork").is_empty(){return Ok(track["artwork"].clone());}
      if track["source"]=="local"{return Ok(Value::Null);}
      let art=links::track_artwork(s(track,"url")).await?;
      let db=st.db.lock().unwrap();if db.pref()["onlineConsent"]!=true{return Ok(Value::Null);}
      let fresh=db.snapshot()?;if let Some(current)=fresh["tracks"].as_array().unwrap().iter().find(|t|t["id"]==id){let _=current;db.set_track_artwork(id,&art)?;return Ok(json!(art));}Ok(Value::Null)
    },
    "playlistArtwork"=>{
      let id=p.as_str().filter(|id|db::valid_id(id)).ok_or("Playlist inválida.")?;
      let snapshot=st.db.lock().unwrap().snapshot()?;
      let list=snapshot["playlists"].as_array().and_then(|lists|lists.iter().find(|v|v["id"]==id)).ok_or("Playlist não encontrada.")?;
      if let Some(url)=list["artwork"].as_str(){if db::artwork_url(url){return Ok(json!(url));}}
      let tracks=snapshot["tracks"].as_array().unwrap();let ids=list["trackIds"].as_array().unwrap();
      if let Some(url)=tracks.iter().filter(|t|ids.contains(&t["id"])).map(|t|s(t,"artwork")).find(|u|!u.is_empty()){
       st.db.lock().unwrap().collection_artwork(id,url)?;return Ok(json!(url));
      }
      if snapshot["preferences"]["onlineConsent"]!=true||snapshot["preferences"]["onboardingDone"]!=true{return Ok(Value::Null);}
      if let Some(track)=ids.iter().filter_map(|tid|tracks.iter().find(|t|t["id"]==*tid)).find(|t|t["source"]!="local"&&t["url"].is_string()){
       if let Ok(fresh)=links::resolve(s(track,"url")).await{
        let url=s(&fresh,"artwork");if db::artwork_url(url){let mut repaired=track.clone();repaired["artwork"]=json!(url);let db=st.db.lock().unwrap();db.save(&repaired,None)?;db.collection_artwork(id,url)?;return Ok(json!(url));}
       }
      }
      Ok(Value::Null)
    },
    "openLyrics"=>{if let Some(w)=app.get_webview_window("lyrics"){let _=w.show();let _=w.set_focus();}else{tauri::WebviewWindowBuilder::new(&app,"lyrics",tauri::WebviewUrl::App("index.html?view=lyrics".into())).title("Letras · Glass Music").use_https_scheme(true).inner_size(460.0,700.0).min_inner_size(340.0,460.0).always_on_top(true).build().map_err(|e|e.to_string())?;}Ok(Value::Null)},
    "closeLyrics"=>{if let Some(w)=app.get_webview_window("lyrics"){let _=w.close();}Ok(Value::Null)},
    "lyricsState"=>{if let Some(w)=app.get_webview_window("lyrics"){if p.to_string().len()<4_000_000{let _=w.emit("lyrics-state",&p);}}Ok(Value::Null)},
    "lyricsControl"=>{let action=s(&p,"action");if action=="seek"&&!p["position"].as_f64().is_some_and(|n|n>=0.0&&n<=604800.0){return Err("Posição inválida.".into());}if !["seek","toggle"].contains(&action){return Err("Controle inválido.".into());}let _=app.emit_to("main","lyrics-control",&p);Ok(Value::Null)},
    "windowShape"=>{let mut v=corners::inspect(window.hwnd().map_err(|e|e.to_string())?.0);v["frameworkMaximized"]=json!(window.is_maximized().unwrap_or(false));v["clippedDesktopBackdrop"]=json!(desktop_backdrop::enabled());Ok(v)},
    "visualState"=>Ok(json!(window.hwnd().map(|h|corners::visible(h.0)).unwrap_or(true))),
    "window"=>{match p.as_str().unwrap_or(""){
      "minimize"=>{let _=app.emit_to("main","media","pauseVideo");window.minimize().map_err(|e|e.to_string())?;let _=app.emit_to("main","glass-visual-visible",false);},
      "maximize"=>{if window.is_maximized().unwrap_or(false){window.unmaximize()}else{window.maximize()}.map_err(|e|e.to_string())?;},
      "close"=>close(&app),
      "mini"=>{let _=window.unmaximize();window.set_min_size(Some(LogicalSize::new(440,680))).map_err(|e|e.to_string())?;window.set_size(LogicalSize::new(440,680)).map_err(|e|e.to_string())?;window.set_always_on_top(true).map_err(|e|e.to_string())?;},
      "restore"=>{window.unminimize().map_err(|e|e.to_string())?;window.show().map_err(|e|e.to_string())?;let _=app.emit_to("main","glass-visual-visible",true);window.set_always_on_top(false).map_err(|e|e.to_string())?;window.set_size(main_window_size(&window)).map_err(|e|e.to_string())?;window.set_min_size(Some(LogicalSize::new(920,650))).map_err(|e|e.to_string())?;let _=window.center();},_=>return Err("Ação de janela inválida.".into())}if let Ok(hwnd)=window.hwnd(){corners::apply(hwnd.0,window.scale_factor().unwrap_or(1.0));}Ok(Value::Null)},
    "clearCache"=>{st.search.lock().unwrap().cache.clear();media::clear_covers(&st.data);window.clear_all_browsing_data().map_err(|e|e.to_string())?;Ok(Value::Null)},
    "jam"=>{let pref=st.db.lock().unwrap().pref();jam::call(&p,db::s(&pref,"jamEndpoint"),pref["onlineConsent"]==true&&pref["onboardingDone"]==true).await},
    "updateStatus"=>{let pref=st.db.lock().unwrap().pref();if p["install"]==true{let backup=st.data.join("backups");std::fs::create_dir_all(&backup).map_err(|e|e.to_string())?;let path=backup.join(format!("before-update-{}.sqlite",uuid::Uuid::new_v4()));st.db.lock().unwrap().db.execute("VACUUM main INTO ?",[path.to_str().ok_or("Pasta inválida.")?]).map_err(|e|e.to_string())?;}updates::status(&app,pref["onlineConsent"]==true&&pref["onboardingDone"]==true,p["install"]==true).await},
    "checkUpdates"=>{let pref=st.db.lock().unwrap().pref();let value=updates::status(&app,pref["onlineConsent"]==true,false).await?;Ok(value["message"].clone())},
    "notify"=>{if st.db.lock().unwrap().pref()["notifications"]==true{let title=s(&p,"title").chars().take(100).collect::<String>();let artist=s(&p,"artist").chars().take(100).collect::<String>();let _=app.notification().builder().title(title).body(artist).show();}Ok(Value::Null)},
    _=>Err("Operação não autorizada.".into())
  }
}
fn main() {
    let builder=tauri::Builder::default();
    let builder=if std::env::var_os("GLASS_TEST_DATA").is_none(){builder.plugin(tauri_plugin_single_instance::init(|app, _, _| {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.show();
                let _ = w.unminimize();
                let _ = w.set_focus();
                let _ = app.emit_to("main", "glass-visual-visible", true);
            }
        }))}else{builder};
    builder.plugin(tauri_plugin_updater::Builder::new().build()).plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(
            tauri_plugin_autostart::Builder::new()
                .app_name("Glass Music")
                .build(),
        )
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .invoke_handler(tauri::generate_handler![call])
        .setup(|app| {
            if let Some(window) = app.get_webview_window("main") {
                window.set_size(main_window_size(&window))?;
                let _ = window.center();
                if let Ok(hwnd)=window.hwnd(){corners::attach(hwnd.0);}
            }
            let data = std::env::var_os("GLASS_TEST_DATA")
                .map(PathBuf::from)
                .unwrap_or(app.path().app_data_dir()?);
            std::fs::create_dir_all(&data)?;
            let db = Library::open(&data.join("library.sqlite"))?;
            media::seed(&db, &app.path().resource_dir()?)?;
            let pref = db.pref();
            if let Some(window)=app.get_webview_window("main"){native_environment(&window,&pref);}
            let keys = secrets::Secrets::load(&data.join("credentials.dpapi"))?;
            let db = Arc::new(Mutex::new(db));
            let audio = Arc::new(audio::AudioStreams::new());
            let base = media::serve(db.clone(), data.clone(), audio.clone())?;
            let accounts=accounts::Accounts::load(&data)?;
            app.manage(State {
                accounts,
                db,
                secrets: Mutex::new(keys),
                search: Mutex::new(providers::SearchState::new()),
                data,
                base,
                audio,
                shortcuts: AtomicBool::new(false),
                catalog_url: catalog::configured_url()?,
                direct: direct_catalog::DirectCatalog::new(app.path().resource_dir()?),
            });
            let menu = Menu::with_items(
                app,
                &[
                    &MenuItem::with_id(app, "show", "Abrir Glass Music", true, None::<&str>)?,
                    &MenuItem::with_id(
                        app,
                        "playPause",
                        "Reproduzir / pausar",
                        true,
                        None::<&str>,
                    )?,
                    &MenuItem::with_id(app, "next", "Próxima música", true, None::<&str>)?,
                    &MenuItem::with_id(app, "quit", "Sair", true, None::<&str>)?,
                ],
            )?;
            TrayIconBuilder::new()
                .icon(app.default_window_icon().unwrap().clone())
                .tooltip("Glass Music")
                .menu(&menu)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "quit" => app.exit(0),
                    "show" => {
                        if let Some(w) = app.get_webview_window("main") {
                            let _ = w.show();
                            let _ = w.unminimize();
                            let _ = w.set_focus();
                let _ = app.emit_to("main", "glass-visual-visible", true);
                        }
                    }
                    "playPause" | "next" => {
                        let _ = app.emit_to("main", "media", event.id.as_ref());
                    }
                    _ => {}
                })
                .build(app)?;
            if pref["globalShortcuts"] == true {
                app.state::<State>()
                    .shortcuts
                    .store(shortcuts(app.handle(), true), Ordering::Relaxed);
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            match event {
                tauri::WindowEvent::Resized(size) => {if size.width>0&&size.height>0{if let Ok(hwnd)=window.hwnd(){corners::apply(hwnd.0,window.scale_factor().unwrap_or(1.0));}}let visible=window.hwnd().map(|h|corners::visible(h.0)).unwrap_or(true);let _=window.emit("glass-visual-visible",visible);},
                tauri::WindowEvent::Moved(_) | tauri::WindowEvent::ThemeChanged(_) | tauri::WindowEvent::ScaleFactorChanged { .. } => {if let Ok(hwnd)=window.hwnd(){corners::apply(hwnd.0,window.scale_factor().unwrap_or(1.0));}},
                tauri::WindowEvent::Focused(_) => {if let Ok(hwnd)=window.hwnd(){corners::apply(hwnd.0,window.scale_factor().unwrap_or(1.0));}let visible=window.hwnd().map(|h|corners::visible(h.0)).unwrap_or(true);let _=window.emit("glass-visual-visible",visible);},
                _=>{}
            }
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                close(window.app_handle());
            }
        })
        .run(tauri::generate_context!())
        .expect("Falha ao iniciar Glass Music");
}
