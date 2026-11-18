use crate::db::{self, now, s, Result};
use serde_json::{json,Value};
use sha2::{Digest,Sha256};

pub fn public_url(raw:&str)->bool {
    url::Url::parse(raw).is_ok_and(|u| {
        let host=u.host_str().unwrap_or("");
        u.scheme()=="https" && raw.len()<=2048 && u.username().is_empty() && u.password().is_none() && u.port().is_none()
        && host.contains('.') && host.parse::<std::net::IpAddr>().is_err() && !host.ends_with(".local")
        && !host.ends_with(".localhost") && !host.ends_with(".internal") && host!="localhost"
    })
}
async fn fetch(url:&str, query:&[(&str,&str)])->Result<Value> {
    let mut response=crate::providers::client().get(url).query(query).send().await.map_err(|_|"Não foi possível consultar esse link.")?;
    if !response.status().is_success(){return Err("O serviço não liberou os dados desse link. Confira o endereço e tente novamente.".into());}
    let mut bytes=Vec::new();
    while let Some(chunk)=response.chunk().await.map_err(|_|"Resposta incompleta.")? {
        if bytes.len()+chunk.len()>1_000_000{return Err("Resposta muito grande.".into());} bytes.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&bytes).map_err(|_|"Resposta inválida do serviço.".into())
}
// Read public metadata only. Never execute the embed or use its preview audio.
pub async fn spotify_entity(kind:&str,id:&str)->Result<Value>{
    let mut response=crate::providers::client().get(format!("https://open.spotify.com/embed/{kind}/{id}")).send().await.map_err(|_|"Metadados indisponíveis.")?;
    if !response.status().is_success(){return Err("Metadados indisponíveis.".into());}
    let mut bytes=Vec::new();while let Some(chunk)=response.chunk().await.map_err(|_|"Resposta incompleta.")?{if bytes.len()+chunk.len()>1_000_000{return Err("Metadados muito grandes.".into());}bytes.extend_from_slice(&chunk);}
    let text=String::from_utf8(bytes).map_err(|_|"Metadados inválidos.")?;
    let start=text.find("<script id=\"__NEXT_DATA__\"").ok_or("Metadados indisponíveis.")?;
    let script=&text[start..];let start=script.find('>').ok_or("Metadados inválidos.")?+1;let end=script[start..].find("</script>").ok_or("Metadados inválidos.")?+start;
    let data:Value=serde_json::from_str(&script[start..end]).map_err(|_|"Metadados inválidos.")?;
    let entity=data.pointer("/props/pageProps/state/data/entity").ok_or("Metadados indisponíveis.")?;
    if entity["id"]!=id||entity["type"]!=kind{return Err("Faixa inválida.".into());}Ok(entity.clone())
}
pub async fn track_artwork(raw:&str)->Result<String>{
 if let Ok(u)=url::Url::parse(raw){if u.host_str()==Some("open.spotify.com"){let parts:Vec<_>=u.path_segments().into_iter().flatten().collect();if let Some(i)=parts.iter().position(|s|*s=="track"){if let Some(id)=parts.get(i+1).filter(|id|id.len()==22&&id.bytes().all(|b|b.is_ascii_alphanumeric())){let canonical=format!("https://open.spotify.com/track/{id}");let data=fetch("https://open.spotify.com/oembed",&[("url",canonical.as_str())]).await?;let url=s(&data,"thumbnail_url");return if db::artwork_url(url){Ok(url.to_string())}else{Err("Capa indisponível.".into())};}}return Err("Link de faixa inválido.".into());}}
 let data=resolve(raw).await?;let art=s(&data,"artwork");if db::artwork_url(art){Ok(art.into())}else{Err("Capa indisponível.".into())}
}
pub async fn resolve(raw:&str)->Result<Value> {
    if !public_url(raw){return Err("Use um link público HTTPS de música.".into());}
    let mut u=url::Url::parse(raw).unwrap();u.set_fragment(None);
    let host=u.host_str().unwrap_or("").to_string();
    if ["youtube.com","www.youtube.com","music.youtube.com","youtu.be","soundcloud.com","www.soundcloud.com"].contains(&host.as_str()) {return crate::providers::resolve(raw).await;}
    if ["music.apple.com","itunes.apple.com"].contains(&host.as_str()) {return crate::platforms::resolve_apple(&u).await;}
    if crate::platforms::is_bandcamp(&host) {return crate::platforms::resolve_bandcamp(&u).await;}
    if ["tidal.com","www.tidal.com","listen.tidal.com"].contains(&host.as_str()) {return crate::platforms::resolve_tidal(&u).await;}
    let parts:Vec<_>=u.path_segments().into_iter().flatten().filter(|p|!p.is_empty()).map(str::to_string).collect();
    let mut title=parts.last().map(|v|v.replace('-'," ")).unwrap_or_else(||host.clone());
    let mut artist=host.trim_start_matches("www.").to_string();let mut artwork=String::new();let mut duration=0.0;let mut kind="track";
    let mut album = String::new();
    let mut isrc = String::new();
    let mut catalog_source = "";
    if host=="open.spotify.com" {
        catalog_source = "spotify";
        let index=parts.iter().position(|v|["track","album","playlist","artist","episode","show"].contains(&v.as_str())).ok_or("Use o link completo compartilhado pelo Spotify.")?;
        let entity=parts.get(index+1).ok_or("Link do Spotify incompleto.")?;
        if entity.len()!=22 || !entity.bytes().all(|b|b.is_ascii_alphanumeric()){return Err("Link do Spotify inválido.".into());}
        u.set_query(None);let data=fetch("https://open.spotify.com/oembed",&[("url",u.as_str())]).await?;
        title=s(&data,"title").to_string();artist="Spotify".into();artwork=s(&data,"thumbnail_url").to_string();
        kind=match parts[index].as_str(){"playlist"=>"playlist","album"=>"album","artist"=>"artist",_=>"track"};
        if parts[index]=="track"{if let Ok(meta)=spotify_entity("track",entity).await{
            let joined_artists = meta["artists"]
                .as_array()
                .map(|arr| {
                    arr.iter()
                        .filter_map(|a| a["name"].as_str())
                        .collect::<Vec<_>>()
                        .join(", ")
                })
                .unwrap_or_default();
            if !joined_artists.is_empty() {
                artist = joined_artists;
            }
            if let Some(alb) = meta
                .pointer("/albumOfTrack/name")
                .and_then(Value::as_str)
                .or_else(|| meta.pointer("/album/name").and_then(Value::as_str))
            {
                album = alb.trim().to_string();
            }
            if let Some(code) = meta
                .pointer("/external_ids/isrc")
                .and_then(Value::as_str)
                .or_else(|| meta.pointer("/externalIds/isrc").and_then(Value::as_str))
            {
                if (12..=15).contains(&code.len()) && code.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-') {
                    isrc = code.to_uppercase();
                }
            }
            duration=meta["duration"].as_f64().or(meta["duration_ms"].as_f64()).unwrap_or(0.0)/1000.0;
        }}
    } else if host=="deezer.com" || host=="www.deezer.com" {
        catalog_source = "deezer";
        let index=parts.iter().position(|v|["track","album","playlist","artist"].contains(&v.as_str())).ok_or("Use o link completo de música, álbum ou playlist do Deezer.")?;
        let id=parts.get(index+1).ok_or("Link Deezer incompleto.")?;
        if id.len()>25||!id.bytes().all(|b|b.is_ascii_digit()){return Err("Link Deezer inválido.".into());}
        let data=fetch(&format!("https://api.deezer.com/{}/{}",parts[index],id),&[]).await?;
        if data.get("error").is_some(){return Err("Conteúdo do Deezer não encontrado.".into());}
        title=data["title"].as_str().or(data["name"].as_str()).unwrap_or("Deezer").to_string();
        artist=data["artist"]["name"].as_str().or(data["creator"]["name"].as_str()).unwrap_or("Deezer").to_string();
        album=data["album"]["title"].as_str().unwrap_or("").trim().to_string();
        if let Some(code) = data["isrc"].as_str() {
            if (12..=15).contains(&code.len()) && code.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-') {
                isrc = code.to_uppercase();
            }
        }
        artwork=data["album"]["cover_big"].as_str().or(data["album"]["cover_medium"].as_str()).or(data["cover_big"].as_str()).or(data["cover_medium"].as_str()).or(data["picture_big"].as_str()).or(data["picture_medium"].as_str()).unwrap_or("").to_string();
        duration=data["duration"].as_f64().unwrap_or(0.0).min(604800.0);kind=match parts[index].as_str(){"playlist"=>"playlist","album"=>"album","artist"=>"artist",_=>"track"};u.set_query(None);
    }
    let canonical=u.to_string();let id=format!("{:x}",Sha256::digest(canonical.as_bytes()))[..32].to_string();
    let mut track=json!({"id":format!("link:{id}"),"source":"link","sourceId":id,"kind":kind,"title":title,"artist":artist,"duration":duration,"durationMs":(duration * 1000.0).round(),"url":canonical,"addedAt":now()});
    if !catalog_source.is_empty() { track["catalogSource"] = json!(catalog_source); }
    if !album.is_empty() { track["album"] = json!(album); }
    if !isrc.is_empty() { track["isrc"] = json!(isrc); }
    if db::artwork_url(&artwork){track["artwork"]=json!(artwork);}
    db::validate_track(&track)?;Ok(track)
}

fn words(text:&str)->Vec<String>{
    let clean=if let Some((head,_))=text.split_once(" (feat.").or_else(||text.split_once(" (ft.")).or_else(||text.split_once(" [feat.")) {head} else {text};
    let normalized:String=clean.to_lowercase().chars().map(|c|match c{'á'|'à'|'â'|'ã'|'ä'=>'a','é'|'è'|'ê'|'ë'=>'e','í'|'ì'|'î'|'ï'=>'i','ó'|'ò'|'ô'|'õ'|'ö'=>'o','ú'|'ù'|'û'|'ü'=>'u','ç'=>'c',c if c.is_alphanumeric()=>c,_=>' '}).collect();
    normalized.split_whitespace().filter(|v|!matches!(*v,"official"|"audio"|"video"|"music"|"lyrics"|"lyric"|"hd"|"4k"|"remastered"|"remaster"|"oficial"|"clipe"|"topic"|"vevo"|"visualizer"|"feat"|"ft")).map(str::to_string).collect()
}
fn primary_artist(raw:&str)->&str{
    raw.split([',','&',';','/']).next().map(str::trim).filter(|s|!s.is_empty()).unwrap_or(raw)
}
fn coverage(wanted:&[String],found:&[String])->f64{if wanted.is_empty(){0.0}else{wanted.iter().filter(|w|found.contains(w)).count() as f64/wanted.len() as f64}}
fn match_score(reference:&Value,candidate:&Value)->Option<f64>{
    if db::validate_track(candidate).is_err()||candidate["source"]!="youtube"||candidate["kind"]!="track"{return None;}
    let title=words(s(reference,"title"));let found=words(s(candidate,"title"));let mut all=found.clone();all.extend(words(s(candidate,"artist")));
    let title_score=coverage(&title,&all);if title_score<0.75{return None;}
    let mut original=title.clone();original.extend(words(s(reference,"artist")));
    for version in ["live","remix","cover","karaoke","instrumental","nightcore","sped","slowed","acoustic","acustico"]{if found.iter().any(|w|w==version)&&!original.iter().any(|w|w==version){return None;}}
    let artist=s(reference,"artist");let artist_score=if ["Spotify","Deezer","Apple Music","Tidal","Bandcamp"].contains(&artist){0.5}else{
        let full=coverage(&words(artist),&all);
        let primary=coverage(&words(primary_artist(artist)),&all);
        let score=full.max(primary*0.9);
        if score<0.6{return None;}
        score
    };
    let duration=reference["duration"].as_f64().unwrap_or(0.0);let actual=candidate["duration"].as_f64().unwrap_or(0.0);
    if duration>0.0&&(actual<=0.0||(duration-actual).abs()>14.0_f64.max(duration*0.14)){return None;}
    let topic_bonus=if s(candidate,"artist").ends_with(" - Topic"){0.8}else{0.0};
    Some(title_score*8.0+artist_score*5.0+topic_bonus+(if duration>0.0{1.0}else{0.0})-found.len().saturating_sub(title.len()) as f64*0.015)
}
fn strip_edition(raw:&str)->String{
    let mut out=raw.to_string();
    for sep in [" - "," ("," ["]{
        if let Some((left,right))=out.split_once(sep){
            let low=right.to_lowercase();
            if ["deluxe","remaster","bonus","radio edit","version","versão","versao","explicit","clean","mono","stereo"].iter().any(|k|low.contains(k)){
                out=left.to_string();
            }
        }
    }
    out
}
fn relaxed_score(reference:&Value,candidate:&Value)->Option<f64>{
    if db::validate_track(candidate).is_err()||candidate["source"]!="youtube"||candidate["kind"]!="track"{return None;}
    let clean_ref=strip_edition(s(reference,"title"));
    let title=words(&clean_ref);
    let found=words(s(candidate,"title"));
    let mut all=found.clone();all.extend(words(s(candidate,"artist")));
    if title.is_empty(){return None;}
    let title_score=coverage(&title,&all);
    if title_score<0.55{return None;}
    let artist=s(reference,"artist");
    let artist_score=if ["Spotify","Deezer","Apple Music","Tidal","Bandcamp","YouTube","SoundCloud"].contains(&artist){
        0.4
    }else{
        let full=coverage(&words(artist),&all);
        let prim=coverage(&words(primary_artist(artist)),&all);
        let sc=full.max(prim);
        // Allow label channels (GR6, KondZilla, Love Funk, etc.) when title match is very strong (>= 0.85)
        if sc<0.35 && title_score<0.85 {return None;}
        sc
    };
    let duration=reference["duration"].as_f64().unwrap_or(0.0);
    let actual=candidate["duration"].as_f64().unwrap_or(0.0);
    if duration>0.0 && actual>0.0 && (duration-actual).abs()>95.0_f64.max(duration*0.45){return None;}
    let dur_bonus=if duration>0.0&&actual>0.0{1.0-((duration-actual).abs()/120.0).min(1.0)}else{0.3};
    Some(title_score*7.0+artist_score*4.0+dur_bonus)
}
pub async fn find_playable_youtube_id(
    title:&str,
    artist:&str,
    duration:f64,
    exclude_id:&str,
    catalog:&str,
    direct:&crate::direct_catalog::DirectCatalog,
)->Result<(String,Option<Value>)>{
    let reference=json!({"title":title,"artist":artist,"duration":duration});
    let prim=primary_artist(artist);
    let clean_t=strip_edition(title);
    let q1=format!("{} {}",title,if ["Spotify","Deezer","Apple Music","Tidal","Bandcamp","YouTube","SoundCloud"].contains(&artist){""}else{prim}).trim().to_string();
    let q2=format!("{clean_t} {prim} audio").trim().to_string();
    let mut queries=vec![q1];
    if !q2.is_empty() && queries[0].to_lowercase()!=q2.to_lowercase() {queries.push(q2);}
    let mut ranked:Vec<(f64,String)>=Vec::new();
    for q in queries{
        if q.is_empty()||q.len()>800{continue;}
        let req=json!({"query":q,"kind":"track"});
        let res=if catalog.is_empty(){direct.search("youtube",&req).await}else{crate::catalog::search(catalog,"youtube",&req).await};
        let Ok(val)=res else{continue;};
        let items=val["items"].as_array().cloned().unwrap_or_default();
        for c in &items{
            let cid=s(c,"sourceId");
            if cid.is_empty()||cid==exclude_id||ranked.iter().any(|(_,id)|id==cid){continue;}
            if let Some(sc)=match_score(&reference,c){ranked.push((sc+20.0,cid.to_string()));}
            else if let Some(sc)=relaxed_score(&reference,c){ranked.push((sc,cid.to_string()));}
        }
        if ranked.iter().any(|(sc,_)|*sc>=25.0){break;}
    }
    ranked.sort_by(|a,b|b.0.total_cmp(&a.0));
    if ranked.is_empty(){
        return Err("Não encontrei uma versão compatível desta música.".into());
    }
    if catalog.is_empty() && direct.available() {
        for (_,cid) in ranked.iter().take(4){
            if let Ok(stream)=direct.audio(cid).await{
                return Ok((cid.clone(),Some(stream)));
            }
        }
    }
    Ok((ranked[0].1.clone(),None))
}
pub async fn playback(mut track:Value,catalog:&str,direct:&crate::direct_catalog::DirectCatalog)->Result<Value>{
    db::validate_track(&track)?;if track["source"]!="link"||track["kind"]!="track"{return Err("Use o link de uma faixa para tocar no Liquid Hub.".into());}
    if let Some(existing)=track["playbackId"].as_str(){
        if catalog.is_empty() && direct.available() {
            if direct.audio(existing).await.is_ok(){return Ok(track);}
        } else {
            return Ok(track);
        }
    }
    let host=url::Url::parse(s(&track,"url")).ok().and_then(|u|u.host_str().map(str::to_string)).unwrap_or_default();
    if !crate::platforms::supported_link_host(&host){return Err("Este link ainda não tem áudio compatível. Use um link do Spotify, Deezer, Apple Music, Bandcamp, Tidal, YouTube ou SoundCloud.".into());}
    if ["Spotify","Deezer","Apple Music","Tidal"].contains(&s(&track,"artist")){if let Ok(fresh)=resolve(s(&track,"url")).await{track["artist"]=fresh["artist"].clone();if track["duration"].as_f64().unwrap_or(0.0)<=0.0{track["duration"]=fresh["duration"].clone();}}}
    let (vid,_)=find_playable_youtube_id(
        s(&track,"title"),
        s(&track,"artist"),
        track["duration"].as_f64().unwrap_or(0.0),
        "",
        catalog,
        direct,
    ).await?;
    track["playbackId"]=json!(vid);track["reason"]=json!("Áudio via YouTube");db::validate_track(&track)?;Ok(track)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test] fn link_import_only_accepts_public_https(){for raw in ["file:///C:/x","https://127.0.0.1/x","https://[::1]/x","https://localhost/x","https://a.local/x","https://user:pass@spotify.com/x","https://spotify.com:8080/x"]{assert!(!public_url(raw),"{raw}");} assert!(public_url("https://open.spotify.com/track/abc"));}
    #[test] fn matching_rejects_wrong_artist_duration_and_unrequested_versions(){
        let reference=json!({"title":"Never Gonna Give You Up","artist":"Rick Astley","duration":213.5});
        let mut candidate=json!({"id":"youtube:dQw4w9WgXcQ","source":"youtube","sourceId":"dQw4w9WgXcQ","kind":"track","title":"Rick Astley - Never Gonna Give You Up (Official Music Video)","artist":"Rick Astley","duration":212,"addedAt":0});
        assert!(match_score(&reference,&candidate).is_some());
        candidate["title"]=json!("Never Gonna Give You Up");candidate["artist"]=json!("Other Artist");assert!(match_score(&reference,&candidate).is_none());
        candidate["artist"]=json!("Rick Astley");candidate["duration"]=json!(400);assert!(match_score(&reference,&candidate).is_none());
        candidate["duration"]=json!(212);candidate["title"]=json!("Rick Astley - Never Gonna Give You Up remix");assert!(match_score(&reference,&candidate).is_none());
    }
    #[test] fn playback_ids_cannot_change_source_or_inject_urls(){let t=json!({"id":"link:abc","source":"link","sourceId":"abc","kind":"track","title":"x","artist":"y","duration":0,"addedAt":0,"playbackId":"https://example.com"});assert!(db::validate_track(&t).is_err());}
}
