use crate::db::{self,s,Result};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD,Engine};
use serde_json::{json,Value};
use std::{collections::HashMap,io::{Read,Write,BufRead,BufReader},net::{IpAddr,UdpSocket,TcpListener,TcpStream},sync::{Arc,Mutex,OnceLock},time::Duration};

struct Member{id:String,token:String,name:String,host:bool,seen:i64}
struct Room{code:String,members:HashMap<String,Member>,playback:Value,touched:i64}
struct Coordinator{rooms:HashMap<String,Room>,rates:HashMap<String,(i64,usize)>}
fn token()->String{let mut bytes=Vec::from(uuid::Uuid::new_v4().as_bytes().as_slice());bytes.extend_from_slice(&uuid::Uuid::new_v4().as_bytes()[..8]);URL_SAFE_NO_PAD.encode(bytes)}
fn name(v:&Value)->String{let clean:String=s(v,"name").chars().filter(|c|!c.is_control()).take(40).collect();if clean.trim().is_empty(){"Ouvinte".into()}else{clean.trim().into()}}
fn track(v:&Value)->Result<Value>{
 if v.is_null(){return Ok(Value::Null);}db::validate_track(v)?;
 if s(v,"kind")!="track"||!["youtube","link","soundcloud"].contains(&s(v,"source")){return Err("A JAM aceita músicas online. Arquivos locais ficam no seu dispositivo.".into());}
 let url=url::Url::parse(s(v,"url")).map_err(|_|"Link público inválido.")?;
 let host=url.host_str().unwrap_or("");
 let allowed_host=["www.youtube.com","youtube.com","music.youtube.com","youtu.be","open.spotify.com","www.deezer.com","deezer.com","soundcloud.com","www.soundcloud.com","music.apple.com","itunes.apple.com","tidal.com","www.tidal.com","listen.tidal.com"].contains(&host)||crate::platforms::is_bandcamp(host);
 if url.scheme()!="https"||!url.username().is_empty()||url.password().is_some()||url.port().is_some()||!allowed_host{return Err("Link público da música inválido.".into());}
 let mut value=json!({"id":v["id"],"source":v["source"],"sourceId":v["sourceId"],"kind":"track","title":v["title"],"artist":v["artist"],"duration":v["duration"],"url":url.as_str(),"addedAt":0});
 if db::artwork_url(s(v,"artwork")){value["artwork"]=v["artwork"].clone();}let playback=s(v,"playbackId");if playback.len()==11&&playback.bytes().all(|b|b.is_ascii_alphanumeric()||b"_-".contains(&b)){value["playbackId"]=json!(playback);}Ok(value)
}
impl Coordinator{
 fn new()->Self{Self{rooms:HashMap::new(),rates:HashMap::new()}}
 fn view(room:&Room,now:i64)->Value{let members:Vec<Value>=room.members.values().map(|m|json!({"id":m.id,"name":m.name,"host":m.host})).collect();json!({"code":room.code,"members":members,"playback":room.playback,"serverTime":now})}
 fn handle(&mut self,p:&Value,ip:&str,now:i64)->std::result::Result<Value,(u16,String)>{
  self.rooms.retain(|_,r|now-r.touched<=900000);self.rates.retain(|_,v|v.0>now);
  for room in self.rooms.values_mut(){room.members.retain(|_,m|m.host||now-m.seen<=35000);}
  let action=s(p,"action");let entry=["create","join"].contains(&action);let key=format!("{ip}:{entry}");
  if self.rates.len()>=1024&&!self.rates.contains_key(&key){return Err((503,"Serviço ocupado.".into()));}
  let rate=self.rates.entry(key).or_insert((now+60000,0));rate.1+=1;if rate.1>if entry{30}else{1800}{return Err((429,"Muitas tentativas. Aguarde um minuto.".into()));}
  if action=="create"{
   if self.rooms.len()>=16{return Err((503,"As salas estão ocupadas.".into()));}
   let mut code=uuid::Uuid::new_v4().simple().to_string()[..10].to_uppercase();while self.rooms.contains_key(&code){code=uuid::Uuid::new_v4().simple().to_string()[..10].to_uppercase();}
   let member=Member{id:uuid::Uuid::new_v4().simple().to_string(),token:token(),name:name(p),host:true,seen:now};let auth=member.token.clone();let mid=member.id.clone();
   let room=Room{code:code.clone(),members:HashMap::from([(auth.clone(),member)]),playback:json!({"track":null,"playing":false,"position":0,"updatedAt":now,"sequence":0}),touched:now};
   let mut value=Self::view(&room,now);value["token"]=json!(auth);value["memberId"]=json!(mid);value["host"]=json!(true);self.rooms.insert(code,room);return Ok(value);
  }
  let code=s(p,"code");if code.len()!=10||!code.bytes().all(|b|b.is_ascii_hexdigit()){return Err((400,"Código da JAM inválido.".into()));}
  let room=self.rooms.get_mut(code).ok_or((410,"Esta JAM foi encerrada ou expirou.".into()))?;
  if action=="join"{
   if room.members.len()>=8{return Err((409,"Esta JAM já tem 8 pessoas.".into()));}
   let member=Member{id:uuid::Uuid::new_v4().simple().to_string(),token:token(),name:name(p),host:false,seen:now};let auth=member.token.clone();let mid=member.id.clone();room.members.insert(auth.clone(),member);
   let mut value=Self::view(room,now);value["token"]=json!(auth);value["memberId"]=json!(mid);value["host"]=json!(false);return Ok(value);
  }
  let auth=s(p,"token");let member=room.members.get_mut(auth).ok_or((401,"Sua sessão expirou. Entre novamente.".into()))?;member.seen=now;let host=member.host;if host{room.touched=now;}
  if action=="leave"{if host{self.rooms.remove(code);}else{room.members.remove(auth);}return Ok(json!({"closed":host,"serverTime":now}));}
  if action=="sync"{
   if !host{return Err((403,"Somente quem criou a JAM controla a reprodução.".into()));}
   let play=&p["playback"];let pos=play["position"].as_f64().ok_or((400,"Reprodução inválida.".into()))?;
   if !play["playing"].is_boolean()||!pos.is_finite()||!(0.0..=86400.0).contains(&pos){return Err((400,"Reprodução inválida.".into()));}
   let song=track(&play["track"]).map_err(|e|(400,e))?;let position=pos.min(song["duration"].as_f64().filter(|d|*d>0.0).unwrap_or(86400.0));let playing=!song.is_null()&&play["playing"]==true;
   room.playback=json!({"track":song,"playing":playing,"position":position,"updatedAt":now,"sequence":room.playback["sequence"].as_u64().unwrap_or(0)+1});
  }else if action!="poll"{return Err((400,"Operação inválida.".into()));}
  Ok(Self::view(room,now))
 }
}

fn respond(mut stream:TcpStream,coordinator:&Mutex<Coordinator>){
 let _=stream.set_read_timeout(Some(Duration::from_secs(3)));let _=stream.set_write_timeout(Some(Duration::from_secs(3)));
 let ip=stream.peer_addr().map(|a|a.ip().to_string()).unwrap_or_default();
 let result=(||->std::result::Result<Value,(u16,String)>{
  let mut reader=BufReader::new(&mut stream);let mut header=Vec::new();let mut content_length=None;let mut content_type=false;let mut first=String::new();
  loop{let before=header.len();reader.by_ref().take((8193-before) as u64).read_until(b'\n',&mut header).map_err(|_|(400,"Solicitação incompleta.".into()))?;
   if header.len()>8192||header.len()==before{return Err((413,"Cabeçalhos inválidos.".into()));}
   let line=std::str::from_utf8(&header[before..]).map_err(|_|(400,"Cabeçalhos inválidos.".into()))?.trim();if first.is_empty(){first=line.into();continue;}if line.is_empty(){break;}
   if let Some((key,value))=line.split_once(':'){match key.trim().to_ascii_lowercase().as_str(){"content-length"=>{if content_length.is_some(){return Err((400,"Tamanho duplicado.".into()));}content_length=Some(value.trim().parse::<usize>().map_err(|_|(400,"Tamanho inválido.".into()))?);},"content-type"=>content_type=value.trim().starts_with("application/json"),"transfer-encoding"=>return Err((400,"Codificação não permitida.".into())),_=>{}}}
  }
  let request:Vec<&str>=first.split_whitespace().collect();if request.len()!=3{return Err((400,"Solicitação inválida.".into()));}
  if request[0]=="GET"&&request[1]=="/health"{return Ok(json!({"service":"glass-music-jam","version":1}));}
  if request[1]!="/v1/jam"{return Err((404,"Não encontrado.".into()));}if request[0]!="POST"{return Err((405,"Método não permitido.".into()));}if !content_type{return Err((415,"Envie JSON.".into()));}
  let length=content_length.ok_or((411,"Tamanho obrigatório.".into()))?;if length>16384{return Err((413,"Solicitação muito grande.".into()));}
  let mut bytes=vec![0u8;length];reader.read_exact(&mut bytes).map_err(|_|(400,"Solicitação incompleta.".into()))?;
  let p:Value=serde_json::from_slice(&bytes).map_err(|_|(400,"Solicitação inválida.".into()))?;if !p.is_object(){return Err((400,"Solicitação inválida.".into()));}
  coordinator.lock().map_err(|_|(503,"Serviço ocupado.".into()))?.handle(&p,&ip,db::now())
 })();
 let(status,value)=match result{Ok(v)=>(200,v),Err((status,error))=>(status,json!({"error":error}))};let data=value.to_string();let headers=format!("HTTP/1.1 {status} Result\r\nContent-Type: application/json; charset=utf-8\r\nCache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\nConnection: close\r\nContent-Length: {}\r\n\r\n",data.len());let _=stream.write_all(headers.as_bytes());let _=stream.write_all(data.as_bytes());
}
fn serve(ip:IpAddr)->Result<String>{
 let listener=Arc::new(TcpListener::bind((ip,0)).map_err(|_|"Não foi possível abrir a JAM na rede local.")?);let endpoint=format!("http://{}",listener.local_addr().map_err(|_|"Endereço da JAM indisponível.")?);let coordinator=Arc::new(Mutex::new(Coordinator::new()));
 for worker in 0..4{let listener=listener.clone();let coordinator=coordinator.clone();std::thread::Builder::new().name(format!("glass-jam-lan-{worker}")).spawn(move||{while let Ok((stream,_))=listener.accept(){respond(stream,&coordinator);}}).map_err(|_|"Não foi possível iniciar o serviço de JAM.")?;}Ok(endpoint)
}
pub fn start()->Result<String>{
 static SERVICE:OnceLock<Mutex<Option<String>>>=OnceLock::new();let mut service=SERVICE.get_or_init(||Mutex::new(None)).lock().map_err(|_|"Não foi possível iniciar a JAM.")?;
 if let Some(endpoint)=&*service{return Ok(endpoint.clone());}
 let socket=UdpSocket::bind("0.0.0.0:0").map_err(|_|"Não foi possível encontrar a rede local.")?;socket.connect("192.0.2.1:80").map_err(|_|"Conecte-se a uma rede local antes de criar uma JAM.")?;
 let ip=socket.local_addr().map_err(|_|"Endereço da rede local indisponível.")?.ip();
 if !matches!(ip,IpAddr::V4(v) if v.is_private()||v.is_loopback()){return Err("Não foi encontrado um endereço privado. Use um servidor HTTPS nas opções de JAM.".into());}
 let endpoint=serve(ip)?;*service=Some(endpoint.clone());Ok(endpoint)
}

#[cfg(test)]mod tests{use super::*;
 #[test]fn embedded_coordinator_has_real_two_client_transport_and_host_ownership(){
  let mut server=Coordinator::new();let host=server.handle(&json!({"action":"create","name":"Host"}),"127.0.0.1",1000).unwrap();let code=host["code"].clone();let guest=server.handle(&json!({"action":"join","code":code,"name":"Friend"}),"127.0.0.2",1001).unwrap();
  let track=json!({"id":"youtube:M7lc1UVf-VE","source":"youtube","sourceId":"M7lc1UVf-VE","kind":"track","title":"Test","artist":"Glass","duration":180,"url":"https://www.youtube.com/watch?v=M7lc1UVf-VE","addedAt":0});
  server.handle(&json!({"action":"sync","code":code,"token":host["token"],"playback":{"track":track,"playing":true,"position":20}}),"127.0.0.1",2000).unwrap();
  let follow=server.handle(&json!({"action":"poll","code":code,"token":guest["token"]}),"127.0.0.2",3000).unwrap();assert_eq!(follow["playback"]["track"]["id"],track["id"]);assert_eq!(follow["playback"]["updatedAt"],2000);assert_eq!(follow["members"].as_array().unwrap().len(),2);assert!(follow["members"].as_array().unwrap().iter().all(|m|m.get("token").is_none()));
  assert_eq!(server.handle(&json!({"action":"sync","code":code,"token":guest["token"],"playback":{"track":track,"playing":false,"position":20}}),"127.0.0.2",3001).unwrap_err().0,403);
  server.handle(&json!({"action":"leave","code":code,"token":host["token"]}),"127.0.0.1",4000).unwrap();assert_eq!(server.handle(&json!({"action":"poll","code":code,"token":guest["token"]}),"127.0.0.2",4001).unwrap_err().0,410);
 }
}
