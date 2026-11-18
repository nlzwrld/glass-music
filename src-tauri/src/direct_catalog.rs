use crate::db::{self, now, s, Result};
use serde_json::{json, Value};
use std::{
    collections::HashSet,
    path::PathBuf,
    process::Stdio,
    sync::{Mutex, OnceLock},
    time::{Duration, Instant},
};
use tokio::{
    io::{AsyncRead, AsyncReadExt},
    process::Command,
    sync::Semaphore,
};

const PAGE: usize = 20;
const MAX_OFFSET: usize = 180;
const PLUGIN: &str = "plugins/glass/yt_dlp_plugins/extractor/glass_soundcloud.py";
const VISIONOS_UA: &str = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15";
const IOS_UA: &str = "com.google.ios.youtube/20.03.02 (iPhone16,2; U; CPU iOS 18_2_1 like Mac OS X;)";

static VISITOR_CACHE: OnceLock<Mutex<Option<(Instant, String)>>> = OnceLock::new();

pub fn warm_visitor() {
    tokio::spawn(async {
        let _ = visitor_data(false).await;
    });
}

async fn visitor_data(force_refresh: bool) -> String {
    let slot = VISITOR_CACHE.get_or_init(|| Mutex::new(None));
    if !force_refresh {
        if let Some((at, value)) = slot.lock().unwrap().clone() {
            if at.elapsed() < Duration::from_secs(1800) && !value.is_empty() {
                return value;
            }
        }
    }
    let response = crate::providers::client()
        .get("https://www.youtube.com/sw.js_data")
        .header(
            "User-Agent",
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36",
        )
        .timeout(Duration::from_secs(5))
        .send()
        .await;
    if let Ok(mut res) = response {
        if res.status().is_success() {
            let mut bytes = Vec::new();
            while let Ok(Some(chunk)) = res.chunk().await {
                if bytes.len() + chunk.len() > 256_000 {
                    break;
                }
                bytes.extend_from_slice(&chunk);
            }
            if let Ok(text) = String::from_utf8(bytes) {
                if let Some(found) = extract_visitor_token(&text) {
                    *slot.lock().unwrap() = Some((Instant::now(), found.clone()));
                    return found;
                }
            }
        }
    }
    String::new()
}

fn extract_visitor_token(text: &str) -> Option<String> {
    let mut rest = text;
    while let Some(idx) = rest.find("\"Cg") {
        let after = &rest[idx + 1..];
        if let Some(end) = after.find('"') {
            let candidate = &after[..end];
            if (12..=600).contains(&candidate.len())
                && candidate
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"%_-=".contains(&b))
            {
                return Some(candidate.to_string());
            }
        }
        rest = &after[2.min(after.len())..];
    }
    None
}

async fn innertube_player(id: &str, visitor: &str, use_ios: bool) -> Result<Value> {
    let ua = if use_ios { IOS_UA } else { VISIONOS_UA };
    let mut req = crate::providers::client()
        .post("https://www.youtube.com/youtubei/v1/player?prettyPrint=false")
        .header("Content-Type", "application/json")
        .header("Origin", "https://www.youtube.com")
        .header("User-Agent", ua)
        .timeout(Duration::from_secs(6));
    if !visitor.is_empty() {
        req = req.header("X-Goog-Visitor-Id", visitor);
    }
    let client_ctx = if use_ios {
        json!({
            "clientName": "IOS",
            "clientVersion": "20.03.02",
            "deviceMake": "Apple",
            "deviceModel": "iPhone16,2",
            "osName": "iPhone",
            "osVersion": "18.2.1.22C161",
            "hl": "pt-BR",
            "timeZone": "UTC",
            "utcOffsetMinutes": 0,
            "visitorData": visitor
        })
    } else {
        json!({
            "clientName": "VISIONOS",
            "clientVersion": "0.1",
            "deviceMake": "Apple",
            "deviceModel": "RealityDevice14,1",
            "osName": "visionOS",
            "osVersion": "1.3.21O771",
            "hl": "en",
            "timeZone": "UTC",
            "utcOffsetMinutes": 0,
            "visitorData": visitor
        })
    };
    let body = json!({
        "videoId": id,
        "contentCheckOk": true,
        "racyCheckOk": true,
        "context": { "client": client_ctx }
    });
    let mut res = req
        .json(&body)
        .send()
        .await
        .map_err(|_| "Falha na consulta direta de áudio.")?;
    if !res.status().is_success() {
        return Err("Resposta indisponível do player.".into());
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = res.chunk().await.map_err(|_| "Resposta incompleta.")? {
        if bytes.len() + chunk.len() > 2_000_000 {
            return Err("Resposta de áudio muito grande.".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    let data: Value = serde_json::from_slice(&bytes).map_err(|_| "JSON de áudio inválido.")?;
    if s(&data["playabilityStatus"], "status") != "OK" {
        return Err("Stream direto requer renovação.".into());
    }
    let duration = data
        .pointer("/videoDetails/lengthSeconds")
        .and_then(Value::as_str)
        .and_then(|v| v.parse::<f64>().ok())
        .unwrap_or(0.0);
    let formats = data
        .pointer("/streamingData/adaptiveFormats")
        .and_then(Value::as_array)
        .ok_or("Formatos adaptativos ausentes.")?;
    let best = formats
        .iter()
        .filter(|f| {
            let mime = s(f, "mimeType");
            (mime.starts_with("audio/mp4") || mime.starts_with("audio/webm"))
                && crate::audio::valid_cdn(s(f, "url"))
        })
        .max_by_key(|f| {
            let itag = f["itag"].as_i64().unwrap_or(0);
            let mp4_bonus = if s(f, "mimeType").starts_with("audio/mp4") {
                500_000
            } else {
                0
            };
            let itag140_bonus = if itag == 140 { 250_000 } else { 0 };
            let br = f["averageBitrate"]
                .as_i64()
                .or_else(|| f["bitrate"].as_i64())
                .unwrap_or(0);
            mp4_bonus + itag140_bonus + br
        })
        .ok_or("Nenhum fluxo de áudio direto compatível.")?;
    let mime = s(best, "mimeType");
    let ext = if mime.starts_with("audio/mp4") {
        "m4a"
    } else {
        "webm"
    };
    let filesize = best["contentLength"]
        .as_str()
        .and_then(|v| v.parse::<u64>().ok());
    let mut out = json!({
        "url": s(best, "url"),
        "vcodec": "none",
        "acodec": if ext == "m4a" { "mp4a.40.2" } else { "opus" },
        "protocol": "https",
        "ext": ext,
        "duration": duration,
        "http_headers": { "User-Agent": ua }
    });
    if let Some(len) = filesize {
        out["filesize"] = json!(len);
    }
    Ok(out)
}

async fn innertube_audio(id: &str) -> Result<Value> {
    let visitor = visitor_data(false).await;
    if let Ok(stream) = innertube_player(id, &visitor, false).await {
        return Ok(stream);
    }
    if let Ok(stream) = innertube_player(id, &visitor, true).await {
        return Ok(stream);
    }
    let refreshed = visitor_data(true).await;
    if !refreshed.is_empty() && refreshed != visitor {
        if let Ok(stream) = innertube_player(id, &refreshed, false).await {
            return Ok(stream);
        }
        if let Ok(stream) = innertube_player(id, &refreshed, true).await {
            return Ok(stream);
        }
    }
    Err("Fallback para extrator auxiliar.".into())
}

pub async fn youtube_radio_mix(video_id: &str) -> Result<Vec<Value>> {
    if video_id.len() != 11
        || !video_id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"_-".contains(&b))
    {
        return Err("Vídeo semente inválido.".into());
    }
    let body = json!({
        "videoId": video_id,
        "playlistId": format!("RD{video_id}"),
        "context": {
            "client": {
                "clientName": "WEB",
                "clientVersion": "2.20250101.00.00",
                "hl": "pt-BR",
                "gl": "BR"
            }
        }
    });
    let mut res = crate::providers::client()
        .post("https://www.youtube.com/youtubei/v1/next?prettyPrint=false")
        .json(&body)
        .timeout(Duration::from_secs(7))
        .send()
        .await
        .map_err(|_| "Mix indisponível.")?;
    if !res.status().is_success() {
        return Err("Mix indisponível.".into());
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = res.chunk().await.map_err(|_| "Mix incompleto.")? {
        if bytes.len() + chunk.len() > 3_500_000 {
            return Err("Mix muito grande.".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    let data: Value = serde_json::from_slice(&bytes).map_err(|_| "Mix inválido.")?;
    let mut rows = Vec::new();
    collect_mix_renderers(&data, 0, &mut rows);
    let mut items = Vec::new();
    let mut seen = HashSet::new();
    for row in rows {
        if db::validate_track(&row).is_ok() && seen.insert(s(&row, "id").to_string()) {
            items.push(row);
        }
    }
    Ok(items)
}

fn collect_mix_renderers(value: &Value, depth: usize, out: &mut Vec<Value>) {
    if depth > 36 || out.len() >= 25 {
        return;
    }
    if let Some(panel) = value.get("playlistPanelVideoRenderer") {
        let id = s(panel, "videoId");
        let title = youtube_text(&panel["title"]);
        let artist = youtube_text(&panel["shortBylineText"])
            .replace(" - Topic", "")
            .trim()
            .to_string();
        let length = youtube_text(&panel["lengthText"]);
        let duration = length
            .split(':')
            .try_fold(0_u64, |sum, p| {
                p.parse::<u64>()
                    .ok()
                    .and_then(|n| sum.checked_mul(60)?.checked_add(n))
            })
            .unwrap_or(0);
        if id.len() == 11
            && id.bytes().all(|b| b.is_ascii_alphanumeric() || b"_-".contains(&b))
            && !title.is_empty()
            && duration > 0
            && duration <= 7200
        {
            out.push(json!({
                "id": format!("youtube:{id}"),
                "source": "youtube",
                "sourceId": id,
                "kind": "track",
                "title": title,
                "artist": if artist.is_empty() { "YouTube".into() } else { artist },
                "duration": duration as f64,
                "url": format!("https://www.youtube.com/watch?v={id}"),
                "artwork": format!("https://i.ytimg.com/vi/{id}/hqdefault.jpg"),
                "addedAt": now()
            }));
        }
        return;
    }
    match value {
        Value::Object(map) => {
            for child in map.values() {
                collect_mix_renderers(child, depth + 1, out);
            }
        }
        Value::Array(list) => {
            for child in list {
                collect_mix_renderers(child, depth + 1, out);
            }
        }
        _ => {}
    }
}

pub struct DirectCatalog { root: PathBuf, slots: Semaphore, audio_slots: Semaphore, disabled: bool }
impl DirectCatalog {
    pub fn new(resources: PathBuf) -> Self {
        Self { root: resources.join("catalog"), slots: Semaphore::new(3), audio_slots: Semaphore::new(4),
            disabled: std::env::var_os("GLASS_TEST_DATA").is_some()
                && std::env::var("GLASS_TEST_DISABLE_DIRECT").as_deref() == Ok("1") }
    }
    pub fn available(&self) -> bool {
        !self.disabled && self.root.join("yt-dlp/yt-dlp.exe").is_file() && self.root.join(PLUGIN).is_file()
    }
    async fn extract(&self, source: &str, kind: &str, query: &str, offset: usize) -> Result<Value> {
        if !self.available() { return Err("Componente de busca ausente. Reinstale esta edição do Glass Music.".into()); }
        let _permit = tokio::time::timeout(Duration::from_secs(15), self.slots.acquire()).await
            .map_err(|_| "Há outras buscas em andamento. Tente novamente.")?
            .map_err(|_| "Busca indisponível.")?;
        let input = search_input(source, kind, query, offset)?;
        let mut cmd = Command::new(self.root.join("yt-dlp/yt-dlp.exe"));
        cmd.current_dir(&self.root).args([
            "--ignore-config", "--no-cache-dir", "--no-plugin-dirs", "--plugin-dirs",
        ]).arg(self.root.join("plugins")).args([
            "--no-js-runtimes", "--no-remote-components", "--flat-playlist",
            "--skip-download", "--dump-single-json", "--no-progress", "--no-colors",
            "--socket-timeout", "10", "--retries", "1", "--extractor-retries", "1",
            "--encoding", "utf-8",
        ]);
        if source == "youtube" {
            // Fetch one extra entry to determine whether another page exists.
            cmd.args(["--playlist-items", &format!("{}:{}", offset + 1, offset + PAGE + 1)]);
        }
        cmd.arg("--").arg(input).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped())
            .env("PYTHONDONTWRITEBYTECODE", "1").env_remove("YTDLP_NO_PLUGINS")
            .kill_on_drop(true);
        #[cfg(windows)]
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW; no console flashes during search.
        let mut child = cmd.spawn().map_err(|_| "Não foi possível iniciar a busca. Reinstale o aplicativo.")?;
        let stdout = child.stdout.take().ok_or("Busca sem resposta.")?;
        let stderr = child.stderr.take().ok_or("Busca sem diagnóstico.")?;
        let operation = async {
            tokio::try_join!(
                async { child.wait().await.map_err(|_| "A busca foi interrompida.".to_string()) },
                limited_read(stdout, 2_000_000), limited_read(stderr, 64_000)
            )
        };
        let (status, output, errors) = tokio::time::timeout(Duration::from_secs(30), operation).await
            .map_err(|_| "A plataforma demorou para responder. Tente novamente.")??;
        if !status.success() { return Err(friendly_error(&String::from_utf8_lossy(&errors))); }
        serde_json::from_slice(&output).map_err(|_| "A plataforma enviou uma resposta inválida.".into())
    }
    pub async fn search(&self, source: &str, request: &Value) -> Result<Value> {
        if s(request, "kind") == "album" { return Ok(json!({"items":[]})); }
        let offset = parse_cursor(s(&request["cursor"], source))?;
        // Public search metadata can be read without launching a complete extractor process.
        // Keep the extractor for continuations, unsupported result types and site changes.
        if !self.disabled && source == "youtube" && offset == 0 && ["track","all"].contains(&s(request,"kind")) {
            if let Ok(value) = youtube_search(s(request,"query")).await { return Ok(value); }
        }
        let value = self.extract(source, s(request, "kind"), s(request, "query"), offset).await?;
        normalize(&value, source, s(request, "kind"), offset)
    }
    pub async fn audio(&self, id: &str) -> Result<Value> {
        if id.len()!=11 || !id.bytes().all(|b|b.is_ascii_alphanumeric()||b"_-".contains(&b)) {return Err("Referência de música inválida.".into());}
        if !self.disabled {
            if let Ok(fast) = innertube_audio(id).await {
                return Ok(fast);
            }
        }
        if !self.available(){return Err("O componente de áudio está ausente. Reinstale esta edição.".into());}
        let _permit=tokio::time::timeout(Duration::from_secs(15),self.audio_slots.acquire()).await.map_err(|_|"Há outra música sendo preparada.")?.map_err(|_|"Áudio indisponível.")?;
        let mut cmd=Command::new(self.root.join("yt-dlp/yt-dlp.exe"));
        cmd.current_dir(&self.root).args(["--ignore-config","--no-cache-dir","--no-plugin-dirs","--no-js-runtimes","--no-remote-components",
            "--no-playlist","--skip-download","--dump-single-json","--no-progress","--no-colors","--encoding","utf-8",
            "--extractor-args","youtube:skip=hls,dash",
            "--socket-timeout","10","--retries","1","--extractor-retries","1","-f","bestaudio[ext=m4a][protocol=https]/bestaudio[protocol=https]","--"])
            .arg(format!("https://www.youtube.com/watch?v={id}")).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped())
            .env("PYTHONDONTWRITEBYTECODE","1").kill_on_drop(true);
        #[cfg(windows)]
        cmd.creation_flags(0x08000000);
        let mut child=cmd.spawn().map_err(|_|"Não foi possível iniciar o áudio.")?;
        let stdout=child.stdout.take().ok_or("Áudio sem resposta.")?;let stderr=child.stderr.take().ok_or("Áudio sem diagnóstico.")?;
        let operation=async{tokio::try_join!(async{child.wait().await.map_err(|_|"Consulta interrompida.".to_string())},limited_read(stdout,4_000_000),limited_read(stderr,64_000))};
        let (status,output,errors)=tokio::time::timeout(Duration::from_secs(35),operation).await.map_err(|_|"O áudio demorou a responder. Tente novamente.")??;
        if !status.success(){return Err(friendly_error(&String::from_utf8_lossy(&errors)));}
        serde_json::from_slice(&output).map_err(|_|"Resposta de áudio inválida.".into())
    }
    pub async fn discover(&self) -> Result<Value> {
        let yt = json!({"query":"música brasileira lançamentos", "kind":"track"});
        let sc = json!({"query":"electronic music", "kind":"track"});
        let (youtube, deezer, soundcloud) = tokio::join!(
            self.search("youtube", &yt),
            async {
                tokio::time::timeout(Duration::from_secs(5), crate::platforms::discover_deezer())
                    .await
                    .unwrap_or_else(|_| Err("A seleção do Deezer demorou para responder.".into()))
            },
            async {
                tokio::time::timeout(Duration::from_secs(4), self.search("soundcloud", &sc))
                    .await
                    .unwrap_or_else(|_| Err("A seleção demorou para responder. Tente novamente para atualizá-la.".into()))
            }
        );
        let mut sections = vec![];
        let mut notices = vec![];
        match youtube {
            Ok(value) => sections.push(json!({"id":"direct-youtube","source":"youtube","title":"Descobertas no YouTube",
                "items":value["items"].as_array().unwrap().iter().take(10).collect::<Vec<_>>()})),
            Err(e) => notices.push(format!("YouTube: {e}")),
        }
        match deezer {
            Ok(items) => sections.push(json!({"id":"direct-deezer","source":"deezer","title":"Em alta no Deezer",
                "items":items})),
            Err(e) => notices.push(format!("Deezer: {e}")),
        }
        match soundcloud {
            Ok(value) => sections.push(json!({"id":"direct-soundcloud","source":"soundcloud","title":"Eletrônica no SoundCloud",
                "items":value["items"].as_array().unwrap().iter().take(10).collect::<Vec<_>>()})),
            Err(e) => notices.push(format!("SoundCloud: {e}")),
        }
        Ok(json!({"sections":sections,"notices":notices}))
    }
    pub async fn collection(&self,url:&str)->Result<Value>{
        if !self.available(){return Err("Componente de importação ausente.".into());}
        let _permit=self.slots.acquire().await.map_err(|_|"Importação indisponível.")?;
        let mut cmd=Command::new(self.root.join("yt-dlp/yt-dlp.exe"));
        cmd.current_dir(&self.root).args(["--ignore-config","--no-cache-dir","--no-plugin-dirs","--plugin-dirs"]).arg(self.root.join("plugins"))
            .args(["--no-js-runtimes","--no-remote-components","--flat-playlist","--skip-download","--dump-single-json","--no-progress","--no-colors","--ignore-errors","--socket-timeout","10","--retries","1","--encoding","utf-8","--playlist-end","1001","--"]).arg(if url.starts_with("https://soundcloud.com/"){format!("glass-sc-playlist:{url}")}else{url.to_string()})
            .stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).kill_on_drop(true).env("PYTHONDONTWRITEBYTECODE","1");
        #[cfg(windows)] cmd.creation_flags(0x08000000);
        let mut child=cmd.spawn().map_err(|_|"Não foi possível iniciar a importação.")?;
        let out=child.stdout.take().ok_or("Sem resposta.")?;let err=child.stderr.take().ok_or("Sem diagnóstico.")?;
        let (status,bytes,errors)=tokio::time::timeout(Duration::from_secs(90),async{tokio::try_join!(async{child.wait().await.map_err(|_|"Importação interrompida.".to_string())},limited_read(out,12_000_000),limited_read(err,64_000))}).await.map_err(|_|"A playlist demorou para responder. Tente novamente.")??;
        if !status.success(){return Err(friendly_error(&String::from_utf8_lossy(&errors)));}
        serde_json::from_slice(&bytes).map_err(|_|"Playlist inválida.".into())
    }
}

async fn youtube_search(query:&str)->Result<Value>{
    if query.trim().is_empty() || query.len() > 800 { return Err("Pesquisa inválida.".into()); }
    if let Ok(fast) = innertube_search(query).await { return Ok(fast); }
    let input=search_input("youtube","track",query,0)?;
    let mut response=crate::providers::client().get(input)
        .header("Accept-Language","pt-BR,pt;q=0.9,en;q=0.7")
        .timeout(Duration::from_secs(8)).send().await.map_err(|_|"Busca pública indisponível.")?;
    if !response.status().is_success(){return Err("Busca pública indisponível.".into());}
    let mut bytes=Vec::new();while let Some(chunk)=response.chunk().await.map_err(|_|"Busca incompleta.")?{
        if bytes.len()+chunk.len()>4_000_000{return Err("Busca muito grande.".into());}bytes.extend_from_slice(&chunk);
    }
    let text=String::from_utf8(bytes).map_err(|_|"Busca inválida.")?;
    let data=parse_initial_data(&text)?;
    let mut rows=vec![];youtube_videos(&data,0,&mut rows);
    if rows.is_empty(){return Err("Formato da busca indisponível.".into());}
    normalize(&json!({"entries":rows.into_iter().take(PAGE+1).collect::<Vec<_>>()}),"youtube","track",0)
}
async fn innertube_search(query:&str)->Result<Value>{
    let body=json!({
        "query": query,
        "params": "EgIQAfABAQ==",
        "context": { "client": { "clientName": "WEB", "clientVersion": "2.20250101.00.00", "hl": "pt-BR", "gl": "BR" } }
    });
    let mut response=crate::providers::client()
        .post("https://www.youtube.com/youtubei/v1/search?prettyPrint=false")
        .json(&body)
        .timeout(Duration::from_secs(6))
        .send().await.map_err(|_|"Busca rápida indisponível.")?;
    if !response.status().is_success(){return Err("Busca rápida indisponível.".into());}
    let mut bytes=Vec::new();while let Some(chunk)=response.chunk().await.map_err(|_|"Busca incompleta.")?{
        if bytes.len()+chunk.len()>3_000_000{return Err("Busca muito grande.".into());}bytes.extend_from_slice(&chunk);
    }
    let data:Value=serde_json::from_slice(&bytes).map_err(|_|"Busca inválida.")?;
    if let Some(vis) = data.pointer("/responseContext/visitorData").and_then(Value::as_str) {
        if (12..=600).contains(&vis.len()) && vis.bytes().all(|b| b.is_ascii_alphanumeric() || b"%_-=".contains(&b)) {
            *VISITOR_CACHE.get_or_init(|| Mutex::new(None)).lock().unwrap() = Some((Instant::now(), vis.to_string()));
        }
    }
    let mut rows=vec![];youtube_videos(&data,0,&mut rows);
    if rows.is_empty(){return Err("Sem vídeos na busca rápida.".into());}
    normalize(&json!({"entries":rows.into_iter().take(PAGE+1).collect::<Vec<_>>()}),"youtube","track",0)
}
fn parse_initial_data(text:&str)->Result<Value>{
    for marker in ["var ytInitialData = ","window[\"ytInitialData\"] = ","ytInitialData = "]{
        if let Some(index)=text.find(marker){
            if let Some(Ok(value))=serde_json::Deserializer::from_str(&text[index+marker.len()..]).into_iter::<Value>().next(){return Ok(value);}
        }
    }Err("Formato da busca indisponível.".into())
}
fn youtube_text(value:&Value)->String{
    value["simpleText"].as_str().map(str::to_string).unwrap_or_else(||value["runs"].as_array().into_iter().flatten().filter_map(|v|v["text"].as_str()).collect::<String>())
}
fn youtube_videos(value:&Value,depth:usize,rows:&mut Vec<Value>){
    if depth>40||rows.len()>PAGE{return;}
    if let Some(video)=value.get("videoRenderer"){
        let id=s(video,"videoId");let title=youtube_text(&video["title"]);let artist=youtube_text(&video["ownerText"]);
        let length=youtube_text(&video["lengthText"]);let duration=length.split(':').try_fold(0_u64,|sum,p|p.parse::<u64>().ok().and_then(|n|sum.checked_mul(60)?.checked_add(n))).unwrap_or(0);
        if id.len()==11&&id.bytes().all(|b|b.is_ascii_alphanumeric()||b"_-".contains(&b))&&!title.is_empty()&&duration>0&&duration<=604800{
            rows.push(json!({"id":id,"title":title,"uploader":artist,"duration":duration,"thumbnails":[{"url":format!("https://i.ytimg.com/vi/{id}/hqdefault.jpg")}]}));
        }return;
    }
    match value{Value::Object(map)=>for child in map.values(){youtube_videos(child,depth+1,rows)},Value::Array(list)=>for child in list{youtube_videos(child,depth+1,rows)},_=>{}}
}

async fn limited_read(reader: impl AsyncRead + Unpin, limit: u64) -> Result<Vec<u8>> {
    let mut bytes = Vec::new();
    reader.take(limit + 1).read_to_end(&mut bytes).await.map_err(|_| "Resposta incompleta da busca.")?;
    if bytes.len() as u64 > limit { return Err("Resposta da busca maior que o permitido.".into()); }
    Ok(bytes)
}
fn friendly_error(error: &str) -> String {
    let lower = error.to_lowercase();
    if lower.contains("429") || lower.contains("too many requests") {
        "A plataforma limitou as consultas temporariamente. Aguarde e tente novamente."
    } else if lower.contains("sign in") || lower.contains("403") || lower.contains("captcha") {
        "A plataforma bloqueou esta consulta pública. Tente novamente mais tarde."
    } else {
        "Não foi possível consultar a plataforma. Verifique a internet e tente novamente; mudanças no site podem exigir uma atualização do Glass Music."
    }.into()
}
fn parse_cursor(raw: &str) -> Result<usize> {
    if raw.is_empty() { return Ok(0); }
    if raw.len() > 3 || !raw.bytes().all(|b| b.is_ascii_digit()) { return Err("Página de busca inválida.".into()); }
    let n: usize = raw.parse().map_err(|_| "Página de busca inválida.")?;
    if n > MAX_OFFSET || n % PAGE != 0 { return Err("Página de busca inválida.".into()); }
    Ok(n)
}
fn search_input(source: &str, kind: &str, query: &str, offset: usize) -> Result<String> {
    if query.trim().is_empty() || query.len() > 800 || !["all","track","artist","playlist"].contains(&kind) {
        return Err("Pesquisa inválida.".into());
    }
    match source {
        "youtube" => {
            let mut url = url::Url::parse("https://www.youtube.com/results").unwrap();
            url.query_pairs_mut().append_pair("search_query", query).append_pair("sp", match kind {
                "artist" => "EgIQAg==", "playlist" => "EgIQAw==", _ => "EgIQAfABAQ==",
            });
            Ok(url.to_string())
        },
        "soundcloud" => Ok(format!("glass-sc-search:{}:{offset}:{}", match kind {
            "artist" => "users", "playlist" => "playlists", _ => "tracks",
        }, url::form_urlencoded::byte_serialize(query.as_bytes()).collect::<String>().replace('+', "%20"))),
        _ => Err("Fonte de busca inválida.".into()),
    }
}
fn normalize(value: &Value, source: &str, requested: &str, offset: usize) -> Result<Value> {
    let rows = value["entries"].as_array().ok_or("Lista de busca inválida.")?;
    if rows.len() > PAGE + 1 { return Err("Lista de busca muito grande.".into()); }
    let mut items = vec![]; let mut seen = HashSet::new();
    for row in rows.iter().take(PAGE) {
        let id = s(row, "id");
        if !db::valid_id(id) || id.len() > 150 { continue; }
        let kind = if source == "soundcloud" { s(row, "glass_kind") } else { match requested {
            "artist" => "artist", "playlist" => "playlist", _ => "track",
        }};
        if !["track","artist","playlist"].contains(&kind) || (requested != "all" && kind != requested) { continue; }
        let link = if source == "youtube" { match kind {
            "track" => format!("https://www.youtube.com/watch?v={id}"),
            "artist" => format!("https://www.youtube.com/channel/{id}"),
            _ => format!("https://www.youtube.com/playlist?list={id}"),
        }} else { s(row, "url").to_string() };
        // SoundCloud IDs live in separate track, user and playlist namespaces.
        let source_id = if source == "soundcloud" && kind != "track" { format!("{kind}-{id}") } else { id.to_string() };
        let artist = [s(row,"uploader"),s(row,"channel"),s(row,"artist")].into_iter().find(|v| !v.is_empty())
            .unwrap_or(if kind == "artist" { s(row,"title") } else { if source == "youtube" { "YouTube" } else { "SoundCloud" } });
        let mut track = json!({"id":format!("{source}:{source_id}"),"source":source,"sourceId":source_id,
            "kind":kind,"title":s(row,"title"),"artist":artist,"duration":row["duration"].as_f64().unwrap_or(0.0),
            "url":link,"addedAt":now()});
        if let Some(art) = row["thumbnails"].as_array().into_iter().flatten().rev()
            .filter_map(|t| t["url"].as_str()).find(|u| db::artwork_url(u)) { track["artwork"] = json!(art); }
        if db::validate_track(&track).is_ok() && seen.insert(s(&track,"id").to_string()) { items.push(track); }
    }
    if !rows.is_empty() && items.is_empty() { return Err("Os resultados mudaram de formato. Atualize o Glass Music e tente novamente.".into()); }
    Ok(json!({"items":items,"next":if rows.len()>PAGE && offset<MAX_OFFSET {json!((offset+PAGE).to_string())}else{Value::Null}}))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn lightweight_youtube_metadata_keeps_duration_and_thumbnail(){
        let data=parse_initial_data(r#"<script>var ytInitialData = {"contents":[{"videoRenderer":{"videoId":"dQw4w9WgXcQ","title":{"runs":[{"text":"A title"}]},"ownerText":{"runs":[{"text":"Artist"}]},"lengthText":{"simpleText":"3:33"}}}]};</script>"#).unwrap();
        let mut rows=vec![];youtube_videos(&data,0,&mut rows);let value=normalize(&json!({"entries":rows}),"youtube","track",0).unwrap();
        assert_eq!(value["items"][0]["duration"],213.0);assert_eq!(value["items"][0]["artist"],"Artist");assert!(db::artwork_url(s(&value["items"][0],"artwork")));
        assert!(parse_initial_data("<script>arbitrary()</script>").is_err());
    }
    #[tokio::test]
    #[ignore = "opt-in real network and extractor benchmark; no user data is changed"]
    async fn real_playback_latency(){
        let resources=PathBuf::from(std::env::var("GLASS_BENCH_RESOURCES").expect("GLASS_BENCH_RESOURCES"));
        let direct=DirectCatalog::new(resources);
        let reference:Value=serde_json::from_str(&std::env::var("GLASS_BENCH_TRACK").expect("GLASS_BENCH_TRACK")).unwrap();
        let start=std::time::Instant::now();let matched=crate::links::playback(reference,"",&direct).await.unwrap();let matching_ms=start.elapsed().as_millis();
        let audio=std::time::Instant::now();let value=direct.audio(s(&matched,"playbackId")).await.unwrap();let audio_ms=audio.elapsed().as_millis();
        let streams=crate::audio::AudioStreams::new();streams.register(s(&matched,"playbackId"),&value).unwrap();let warm=std::time::Instant::now();assert!(streams.cached(s(&matched,"playbackId")).is_some());
        println!("GLASS_BENCH {}",json!({"importedMatchMs":matching_ms,"extractionMs":audio_ms,"coldPreparedMs":start.elapsed().as_millis(),"cachedTicketMs":warm.elapsed().as_millis()}));
        let discovery=std::time::Instant::now();let data=direct.discover().await.unwrap();println!("GLASS_DISCOVERY {}",json!({"ms":discovery.elapsed().as_millis(),"sections":data["sections"].as_array().unwrap().len()}));
    }
    #[test]
    fn only_bounded_numeric_cursors_are_accepted() {
        for bad in ["-1", "1", "200", "../../x", "20&url=x", "0000"] { assert!(parse_cursor(bad).is_err()); }
        assert_eq!(parse_cursor("180").unwrap(),180);
        let input=search_input("youtube","track","--exec calc & é",0).unwrap();
        let url=url::Url::parse(&input).unwrap();
        assert_eq!(url.host_str(),Some("www.youtube.com"));
        assert_eq!(url.query_pairs().find(|(k,_)|k=="search_query").unwrap().1,"--exec calc & é");
        assert!(search_input("evil","track","x",0).is_err());
    }
    #[test]
    fn public_results_cannot_inject_external_urls_or_local_tracks() {
        let rows=json!({"entries":[
            {"id":"42","glass_kind":"track","title":"Good","uploader":"Artist","url":"https://soundcloud.com/artist/good","thumbnails":[{"url":"https://evil.example/track.jpg"}]},
            {"id":"43","glass_kind":"track","title":"Bad","url":"file:///C:/secret"},
            {"id":"44","glass_kind":"local","title":"Local","url":"https://soundcloud.com/x/y"}
        ]});
        let result=normalize(&rows,"soundcloud","track",0).unwrap();
        assert_eq!(result["items"].as_array().unwrap().len(),1);
        assert_eq!(result["items"][0]["id"],"soundcloud:42");
        assert!(result["items"][0]["artwork"].is_null());
        assert!(normalize(&json!({"entries":[{"id":"bad","title":"bad"}]}),"youtube","track",0).is_err());
    }
    #[tokio::test]
    async fn output_is_bounded() {
        assert!(limited_read(&b"12345"[..],4).await.is_err());
        assert_eq!(limited_read(&b"1234"[..],4).await.unwrap(),b"1234");
    }
}
