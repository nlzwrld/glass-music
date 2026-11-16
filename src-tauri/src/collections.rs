use crate::db::{self,s,now,Result};
use serde_json::{json,Value};
use sha2::{Digest,Sha256};
use std::collections::HashSet;
pub struct Collection{pub artwork:String,pub key:String,pub name:String,pub tracks:Vec<Value>,pub warning:String,pub skipped:usize}
pub fn artwork(v:&Value)->String {
 for path in ["/artwork_url","/thumbnail","/thumbnail_url","/album/images/0/url","/albumOfTrack/coverArt/sources/0/url","/coverArt/sources/0/url","/visualIdentity/image/0/url","/images/0/url","/picture_medium","/snippet/thumbnails/high/url"] {
  if let Some(url)=v.pointer(path).and_then(Value::as_str){if db::artwork_url(url){return url.to_string();}}
 }
 v["thumbnails"].as_array().into_iter().flatten().rev().filter_map(|v|v["url"].as_str()).find(|u|db::artwork_url(u)).unwrap_or("").to_string()
}
pub fn spotify_track(v:&Value)->Option<Value>{
 let id=v["id"].as_str().or_else(||v["uri"].as_str().and_then(|u|u.strip_prefix("spotify:track:")))?;
 if id.len()!=22||!id.bytes().all(|b|b.is_ascii_alphanumeric()){return None;}
 let url=format!("https://open.spotify.com/track/{id}");let hash=format!("{:x}",Sha256::digest(url.as_bytes()))[..32].to_string();
 let artist=v["artists"].as_array().map(|a|a.iter().filter_map(|v|v["name"].as_str()).collect::<Vec<_>>().join(", ")).filter(|v|!v.is_empty()).unwrap_or_else(||s(v,"subtitle").to_string());
 let mut t=json!({"id":format!("link:{hash}"),"source":"link","sourceId":hash,"kind":"track","title":v["name"].as_str().or(v["title"].as_str())?,"artist":if artist.is_empty(){"Spotify"}else{&artist},"duration":v["duration_ms"].as_f64().or(v["duration"].as_f64()).unwrap_or(0.0)/1000.0,"url":url,"addedAt":now()});
 let art=artwork(v);if !art.is_empty(){t["artwork"]=json!(art);}
 db::validate_track(&t).ok()?;Some(t)
}
pub fn youtube_track(v:&Value)->Option<Value>{
 let id=v["id"].as_str().or_else(||v.pointer("/snippet/resourceId/videoId").and_then(Value::as_str))?;
 let title=v["title"].as_str().or_else(||v.pointer("/snippet/title").and_then(Value::as_str))?;
 if ["Deleted video","Private video","[Deleted video]","[Private video]"].contains(&title){return None;}
 let artist=v["uploader"].as_str().or(v["channel"].as_str()).or_else(||v.pointer("/snippet/videoOwnerChannelTitle").and_then(Value::as_str)).unwrap_or("YouTube");
 let t=json!({"id":format!("youtube:{id}"),"source":"youtube","sourceId":id,"kind":"track","title":title,"artist":artist,"duration":v["duration"].as_f64().unwrap_or(0.0),"url":format!("https://www.youtube.com/watch?v={id}"),"artwork":format!("https://i.ytimg.com/vi/{id}/hqdefault.jpg"),"addedAt":now()});db::validate_track(&t).ok()?;Some(t)
}
pub fn soundcloud_id(v:&Value,kind:&str)->Option<String>{
 let prefix=format!("soundcloud:{kind}:");let id=v["urn"].as_str().and_then(|s|s.strip_prefix(&prefix)).map(str::to_string).or_else(||v["id"].as_u64().map(|n|n.to_string())).or_else(||v["id"].as_str().map(str::to_string))?;
 if id.is_empty()||id.len()>25||!id.bytes().all(|b|b.is_ascii_digit()){return None;}Some(id)
}
pub fn soundcloud_track(v:&Value)->Option<Value>{
 let id=soundcloud_id(v,"tracks")?;
 let url=v["permalink_url"].as_str().or(v["webpage_url"].as_str()).or(v["url"].as_str())?;
 let mut t=json!({"id":format!("soundcloud:{id}"),"source":"soundcloud","sourceId":id,"kind":"track","title":v["title"],"artist":v.pointer("/user/username").and_then(Value::as_str).or(v["uploader"].as_str()).unwrap_or("SoundCloud"),"duration":v["duration"].as_f64().unwrap_or(0.0)/if v.get("permalink_url").is_some(){1000.0}else{1.0},"url":url,"addedAt":now()});
 if let Some(art)=v["artwork_url"].as_str().or(v["thumbnail"].as_str()){if db::artwork_url(art){t["artwork"]=json!(art);}}
 db::validate_track(&t).ok()?;Some(t)
}
pub async fn get(url:&str)->Result<Value>{
 let response=crate::providers::client().get(url).send().await.map_err(|_|"Falha ao consultar a playlist.")?;read(response).await
}
pub async fn read(mut response:reqwest::Response)->Result<Value>{
 if !response.status().is_success(){return Err(match response.status().as_u16(){401=>"Reconecte sua conta.",403=>"A plataforma não permitiu acessar esta lista.",429=>"Limite temporário da plataforma. Tente mais tarde.",_=>"Não foi possível carregar a lista."}.into());}
 let mut bytes=vec![];while let Some(chunk)=response.chunk().await.map_err(|_|"Resposta incompleta.")?{if bytes.len()+chunk.len()>12_000_000{return Err("Lista muito grande.".into());}bytes.extend_from_slice(&chunk);}
 serde_json::from_slice(&bytes).map_err(|_|"Lista inválida.".into())
}
pub fn playlist_url(raw:&str)->Result<(String,String,String)>{
 if !crate::links::public_url(raw){return Err("Use um link público HTTPS de playlist.".into());}
 let u=url::Url::parse(raw).unwrap();let host=u.host_str().unwrap_or("");let parts:Vec<_>=u.path_segments().into_iter().flatten().filter(|p|!p.is_empty()).collect();
 if ["www.youtube.com","youtube.com","music.youtube.com","youtu.be"].contains(&host){
  let id=u.query_pairs().find(|(k,_)|k=="list").map(|(_,v)|v.into_owned()).ok_or("Use um link de playlist com list=.")?;
  if id.len()<5||id.len()>150||!id.bytes().all(|b|b.is_ascii_alphanumeric()||b"_-".contains(&b)){return Err("Playlist YouTube inválida.".into());}
  return Ok(("youtube".into(),id.clone(),format!("https://www.youtube.com/playlist?list={id}")));
 }
 if ["soundcloud.com","www.soundcloud.com"].contains(&host)&&parts.len()==3&&parts[1]=="sets"{return Ok(("soundcloud".into(),parts.join("/"),format!("https://soundcloud.com/{}",parts.join("/"))));}
 if host=="open.spotify.com"{if let Some(i)=parts.iter().position(|v|*v=="playlist"){if let Some(id)=parts.get(i+1){if id.len()==22&&id.bytes().all(|b|b.is_ascii_alphanumeric()){return Ok(("spotify".into(),id.to_string(),format!("https://open.spotify.com/playlist/{id}")));}}}}
 if ["deezer.com","www.deezer.com"].contains(&host){if let Some(i)=parts.iter().position(|v|*v=="playlist"){if let Some(id)=parts.get(i+1){if id.len()<=25&&!id.is_empty()&&id.bytes().all(|b|b.is_ascii_digit()){return Ok(("deezer".into(),id.to_string(),format!("https://www.deezer.com/playlist/{id}")));}}}}
 Err("Use o link completo de uma playlist YouTube, SoundCloud, Spotify ou Deezer.".into())
}
pub fn is_playlist(raw:&str)->bool{playlist_url(raw).is_ok()}
pub async fn fetch(raw:&str,direct:&crate::direct_catalog::DirectCatalog)->Result<Collection>{
 let (provider,id,url)=playlist_url(raw)?;let mut tracks=vec![];let mut skipped=0;let mut warning=String::new();let name;let mut cover;
 match provider.as_str(){
  "youtube"|"soundcloud"=>{
   let data=direct.collection(&url).await?;cover=artwork(&data);name=data["title"].as_str().unwrap_or("Playlist importada").to_string();let entries=data["entries"].as_array().ok_or("Playlist vazia ou privada.")?;
   if entries.len()>1000{warning="Primeiras 1000 faixas importadas; esta lista excede o limite por importação.".into();}
   for row in entries.iter().take(1000){let t=if provider=="youtube"{youtube_track(row)}else{soundcloud_track(row)};if let Some(t)=t{tracks.push(t);}else{skipped+=1;}}
  },
  "spotify"=>{
   let meta=crate::links::spotify_entity("playlist",&id).await?;cover=artwork(&meta);name=s(&meta,"name").to_string();
   let rows=meta["trackList"].as_array().ok_or("Esta playlist não está disponível publicamente. Conecte a conta para acessar listas privadas.")?;
   for row in rows.iter().take(1000){if let Some(t)=spotify_track(row){tracks.push(t);}else{skipped+=1;}}
   warning="Importadas as faixas que o Spotify disponibilizou publicamente. O embed pode limitar a lista; conecte a conta para sincronizar o conteúdo acessível completo.".into();
  },
  _=>{
   let meta=get(&format!("https://api.deezer.com/playlist/{id}")).await?;if meta.get("error").is_some(){return Err("Playlist Deezer indisponível.".into());}cover=artwork(&meta);name=s(&meta,"title").to_string();
   for index in (0..1000).step_by(100){let page=get(&format!("https://api.deezer.com/playlist/{id}/tracks?limit=100&index={index}")).await?;let rows=page["data"].as_array().ok_or("Lista Deezer inválida.")?;
    for row in rows{let tid=row["id"].as_u64().ok_or("Faixa Deezer inválida.")?;let link=format!("https://www.deezer.com/track/{tid}");let hash=format!("{:x}",Sha256::digest(link.as_bytes()))[..32].to_string();let mut t=json!({"id":format!("link:{hash}"),"source":"link","sourceId":hash,"kind":"track","title":row["title"],"artist":row["artist"]["name"],"duration":row["duration"],"url":link,"addedAt":now()});if let Some(art)=row.pointer("/album/cover_medium").and_then(Value::as_str){if db::artwork_url(art){t["artwork"]=json!(art);}}if db::validate_track(&t).is_ok(){tracks.push(t);}else{skipped+=1;}}
    if rows.len()<100||page["next"].is_null(){break;}if index==900{warning="Primeiras 1000 faixas importadas; esta lista excede o limite por importação.".into();}
   }
  }
 }
 let mut seen=HashSet::new();tracks.retain(|t|seen.insert(s(t,"id").to_string()));if tracks.is_empty(){return Err("Nenhuma faixa pública disponível nesta playlist.".into());}
 if cover.is_empty(){cover=tracks.iter().map(|t|s(t,"artwork")).find(|u|!u.is_empty()).unwrap_or("").to_string();}
 Ok(Collection{artwork:cover,key:url,name,tracks,warning,skipped})
}
#[cfg(test)]mod tests{use super::*;#[test]fn links_are_canonical_and_bounded(){assert_eq!(playlist_url("https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PLabc12345").unwrap().2,"https://www.youtube.com/playlist?list=PLabc12345");for bad in ["https://evil.example/playlist/x","https://youtube.com.evil.test/playlist?list=PL12345","https://127.0.0.1/playlist/x","https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC"]{assert!(playlist_url(bad).is_err());}}}

#[cfg(test)]mod api_tests{use super::*;#[test]fn current_soundcloud_urns_preserve_numeric_playback_identity(){let t=soundcloud_track(&json!({"urn":"soundcloud:tracks:290","permalink_url":"https://soundcloud.com/forss/city-ports","title":"City Ports","duration":142233,"user":{"username":"Forss"}})).unwrap();assert_eq!(t["sourceId"],"290");assert_eq!(t["duration"],142.233);assert!(soundcloud_id(&json!({"urn":"soundcloud:playlists:../x"}),"playlists").is_none());}}
