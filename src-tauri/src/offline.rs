use crate::db::{s,Result};
use serde_json::Value;
use std::{path::{Path,PathBuf},io::Write};
use sha2::{Digest,Sha256};
const CHUNK:u64=1_048_576;
pub fn file(data:&Path,id:&str,ext:&str)->PathBuf{data.join("offline").join(format!("{:x}.{ext}",Sha256::digest(id.as_bytes())))}
pub fn owned_path(data:&Path,path:&str)->bool{let p=Path::new(path);p.parent()==Some(data.join("offline").as_path())&&p.file_name().and_then(|v|v.to_str()).is_some_and(|name|name.len()<80&&!name.contains(['/', '\\']))}
fn content_range(raw:&str)->Option<(u64,u64,u64)>{let(range,total)=raw.strip_prefix("bytes ")?.split_once('/')?;let(a,b)=range.split_once('-')?;Some((a.parse().ok()?,b.parse().ok()?,total.parse().ok()?))}
async fn chunk(client:&reqwest::Client,stream:&Value,start:u64,end:u64)->Result<(Vec<u8>,u64,bool)>{
 let url=url::Url::parse(s(stream,"url")).map_err(|_|"Áudio inválido.")?;
 let mut request=client.get(url).header("Range",format!("bytes={start}-{end}"));let agent=s(&stream["http_headers"],"User-Agent");if agent.len()<512&&!agent.contains(['\r','\n']){request=request.header("User-Agent",agent);}
 let mut response=request.send().await.map_err(|_|"Não foi possível baixar o áudio.")?;
 let metadata=response.headers().get("content-range").and_then(|v|v.to_str().ok()).and_then(content_range);
 let expected=stream["filesize"].as_u64().or_else(||url::Url::parse(s(stream,"url")).ok()?.query_pairs().find(|(k,_)|k=="clen").and_then(|(_,n)|n.parse::<u64>().ok()));
 let partial=metadata.is_some()||response.status().as_u16()==206||expected.is_some_and(|n|n>0&&response.content_length()==Some(end.min(n-1).saturating_sub(start)+1)&&(start>0||n>CHUNK));
 let total=if partial{let(a,b,total)=metadata.or_else(||expected.map(|n|(start,end.min(n.saturating_sub(1)),n))).ok_or("Arquivo parcial inválido.")?;if a!=start||b>end||b<a{return Err("Trecho de áudio inválido.".into());}total}else{if start!=0||!response.status().is_success(){return Err("O serviço interrompeu o download.".into());}response.content_length().unwrap_or(0)};
 if !response.status().is_success(){return Err("O serviço interrompeu o download.".into());}
 if expected.is_some_and(|n|n!=total){return Err("Tamanho de áudio inconsistente.".into());}
 if total>250_000_000{return Err("Arquivo maior que 250 MB.".into());}let max=if partial{end-start+1}else{250_000_000};let mut bytes=Vec::new();while let Some(data)=response.chunk().await.map_err(|_|"Download interrompido.")?{if bytes.len() as u64+data.len() as u64>max{return Err("Arquivo maior que o esperado.".into());}bytes.extend_from_slice(&data);}
 if partial&&bytes.len() as u64!=(end.min(total-1)-start+1){return Err("Trecho de áudio incompleto.".into());}Ok((bytes,total,partial))
}
pub async fn download(data:&Path,id:&str,stream:&Value)->Result<(PathBuf,u64,f64)>{
 if !crate::audio::valid_cdn(s(stream,"url"))||s(stream,"vcodec")!="none"||s(stream,"acodec")=="none"||s(stream,"protocol")!="https"{return Err("Esta faixa não oferece um áudio compatível para salvar.".into());}
 let ext=if s(stream,"ext")=="m4a"{"m4a"}else{"webm"};let path=file(data,id,ext);let temporary=path.with_extension("part");std::fs::create_dir_all(data.join("offline")).map_err(|_|"Não foi possível criar a pasta offline.")?;
 let client=reqwest::Client::builder().timeout(std::time::Duration::from_secs(60)).redirect(reqwest::redirect::Policy::none()).build().map_err(|_|"Falha no download.")?;
 let result=async{let(first,total,partial)=chunk(&client,stream,0,CHUNK-1).await?;let mut output=std::io::BufWriter::new(std::fs::File::create(&temporary).map_err(|_|"Não foi possível salvar o áudio.")?);output.write_all(&first).map_err(|_|"Sem espaço para salvar o áudio.")?;let mut bytes=first.len() as u64;
 while partial&&bytes<total{let start=bytes;let end=(start+CHUNK-1).min(total-1);let(data,reported,partial)=chunk(&client,stream,start,end).await?;if !partial||reported!=total{return Err("O arquivo foi alterado durante o download.".into());}bytes+=data.len() as u64;output.write_all(&data).map_err(|_|"Sem espaço para salvar o áudio.")?;}
 if bytes<512||(total>0&&bytes!=total){return Err("O arquivo recebido está incompleto.".into());}output.flush().map_err(|_|"Não foi possível concluir o arquivo.")?;drop(output);std::fs::rename(&temporary,&path).map_err(|_|"Não foi possível concluir o download.")?;Ok((path,bytes,stream["duration"].as_f64().unwrap_or(0.0)))
 }.await;if result.is_err(){let _=std::fs::remove_file(&temporary);}result
}
#[cfg(test)]mod tests{use super::*;#[test]fn offline_paths_are_confined(){let root=Path::new("C:/app");let p=file(root,"youtube:test","webm");assert!(owned_path(root,p.to_str().unwrap()));assert!(!owned_path(root,"C:/personal/song.mp3"));}#[test]fn range_metadata_is_bounded(){assert_eq!(content_range("bytes 0-1023/4096"),Some((0,1023,4096)));assert!(content_range("0-1023").is_none());}}
