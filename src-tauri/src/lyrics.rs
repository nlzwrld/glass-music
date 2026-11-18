use crate::db::{s,Result,now};
use serde_json::{json,Value};
use std::{collections::HashMap,sync::{Mutex,OnceLock},time::Duration};
static CACHE:OnceLock<Mutex<HashMap<String,(i64,Value)>>>=OnceLock::new();
static GATE:tokio::sync::Mutex<()>=tokio::sync::Mutex::const_new(());
static COOLDOWN:Mutex<i64>=Mutex::new(0);
fn normalized(raw:&str)->String {raw.to_lowercase().chars().filter(|c|c.is_alphanumeric()).collect()}
fn metadata(track:&Value)->(String,String) {
 let mut title=s(track,"title").to_string();
 let mut artist=s(track,"artist").replace(" - Topic","").replace("VEVO","");
 for marker in [" (Official", " (OFFICIAL", " (Vídeo", " (Video", " (Audio", " [Official", " [OFFICIAL", " (Lyrics", " (Letra", " | "] {
  if let Some(index)=title.find(marker){title.truncate(index);}
 }
 if let Some((left,right))=title.split_once(" - "){
  let a=normalized(&artist);let l=normalized(left);
  if a.contains(&l)||l.contains(&a)||["youtube","spotify","deezer"].contains(&a.as_str()) {artist=left.trim().into();title=right.trim().into();}
 }
 (title.trim().chars().take(240).collect(),artist.trim().chars().take(160).collect())
}
async fn request(endpoint:&str,query:&[(String,String)])->Result<Option<Value>> {
 if now()<*COOLDOWN.lock().unwrap(){return Err("Letras temporariamente indisponíveis. Tente mais tarde.".into());}
 let mut response=crate::providers::client().get(format!("https://lrclib.net/api/{endpoint}"))
  .header("User-Agent",format!("Liquid Hub v{} (Windows desktop)",env!("CARGO_PKG_VERSION")))
  .timeout(Duration::from_secs(9)).query(query).send().await.map_err(|_|"Não foi possível carregar a letra.")?;
 if response.status().as_u16()==404{return Ok(None);}
 if [429,503].contains(&response.status().as_u16()){
  let wait=response.headers().get("Retry-After").and_then(|v|v.to_str().ok()).and_then(|v|v.parse::<i64>().ok()).unwrap_or(60).clamp(1,86400);
  *COOLDOWN.lock().unwrap()=now()+wait*1000+500;return Err("Letras temporariamente indisponíveis. Tente mais tarde.".into());
 }
 if !response.status().is_success(){return Err("Serviço de letras indisponível.".into());}
 let mut bytes=Vec::new();while let Some(chunk)=response.chunk().await.map_err(|_|"Letra incompleta.")?{
  if bytes.len()+chunk.len()>1_000_000{return Err("Letra muito grande.".into());}bytes.extend_from_slice(&chunk);
 }
 serde_json::from_slice(&bytes).map(Some).map_err(|_|"Resposta de letras inválida.".into())
}
fn compatible(v:&Value,title:&str,artist:&str,duration:f64)->bool {
 let name=normalized(s(v,"trackName"));let expected=normalized(title);
 let who=normalized(s(v,"artistName"));let wanted=normalized(artist);
 !expected.is_empty()&&!wanted.is_empty()&&!who.is_empty()&&name==expected&&who==wanted
 && (duration<=0.0||(v["duration"].as_f64().unwrap_or(0.0)-duration).abs()<=4.0)
}
pub async fn fetch(track:&Value)->Result<Value>{
 let (title,artist)=metadata(track);if title.is_empty()||artist.is_empty(){return Ok(Value::Null);}
 let duration=track["duration"].as_f64().filter(|v|v.is_finite()&&*v>0.0).unwrap_or(0.0);
 let key=format!("{}|{}|{}",normalized(&title),normalized(&artist),duration.round());
 let cache=CACHE.get_or_init(||Mutex::new(HashMap::new()));
 if let Some((at,result))=cache.lock().unwrap().get(&key).cloned(){if now()-at<3_600_000{return Ok(result);}}
 let _guard=GATE.lock().await;
 if let Some((at,result))=cache.lock().unwrap().get(&key).cloned(){if now()-at<3_600_000{return Ok(result);}}
 let mut query=vec![("track_name".into(),title.clone()),("artist_name".into(),artist.clone())];
 if (1.0..=3600.0).contains(&duration){query.push(("duration".into(),duration.round().to_string()));}
 let mut result=request("get",&query).await?;
 if result.as_ref().is_none_or(|v|!compatible(v,&title,&artist,duration)){
  tokio::time::sleep(Duration::from_millis(300)).await;
  query.retain(|(k,_)|k!="duration");
  result=request("search",&query).await?.and_then(|v|v.as_array().and_then(|rows|rows.iter().filter(|v|compatible(v,&title,&artist,duration)).max_by_key(|v|(!s(v,"syncedLyrics").is_empty()) as i32).cloned()));
 }
 let result=result.map(|v|json!({"id":v["id"],"title":v["trackName"],"artist":v["artistName"],"syncedLyrics":v["syncedLyrics"],"plainLyrics":v["plainLyrics"],"instrumental":v["instrumental"],"provider":"LRCLIB"})).unwrap_or(Value::Null);
 let mut cache=cache.lock().unwrap();if cache.len()>=128{cache.clear();}cache.insert(key,(now(),result.clone()));Ok(result)
}
#[cfg(test)]mod tests{
 use super::*;
 #[test]fn versions_must_match_before_syncing(){
  let v=json!({"trackName":"Example","artistName":"Artist","duration":200});
  assert!(compatible(&v,"Example","Artist",202.0));assert!(!compatible(&v,"Example","Other",200.0));assert!(!compatible(&v,"Example","Artist",215.0));
 }
 #[test]fn youtube_titles_are_normalized(){assert_eq!(metadata(&json!({"title":"Artist - Example (Official Music Video)","artist":"ArtistVEVO"})),("Example".into(),"Artist".into()));}
}
