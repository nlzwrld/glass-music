use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};
use std::{
    path::Path,
    time::{SystemTime, UNIX_EPOCH},
};
pub type Result<T> = std::result::Result<T, String>;
pub fn now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}
pub fn s<'a>(v: &'a Value, key: &str) -> &'a str {
    v[key].as_str().unwrap_or("")
}
pub fn defaults() -> Value {
    json!({"uiStyle":"matte","transition":"fade","transitionSeconds":3,"volumeBoost":0,"limiter":true,"outputDevice":"default","jamEndpoint":"","autoUpdate":true,"autoplay":true,"theme":"dark","glass":20,"blur":24,"accent":"#52b79a","autoAccent":false,"reducedMotion":false,"performance":false,"volume":65,"repeat":"off","shuffle":false,"tray":true,"startup":false,"notifications":false,"globalShortcuts":false,"coverCacheMB":128,"eq":[0,0,0,0,0],"onlineConsent":false,"catalogConsent":false,"onboardingDone":false})
}
pub fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 200
        && id
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"_:.-".contains(&c))
}
pub fn official_url(raw: &str) -> bool {
    url::Url::parse(raw).is_ok_and(|u| {
        u.scheme() == "https"
            && u.username().is_empty()
            && u.password().is_none()
            && u.port().is_none()
            && matches!(
                u.host_str(),
                Some(
                    "youtube.com"
                        | "www.youtube.com"
                        | "music.youtube.com"
                        | "youtu.be"
                        | "soundcloud.com"
                        | "www.soundcloud.com"
                        | "policies.google.com"
                        | "developers.google.com"
                        | "developers.soundcloud.com"
                )
            )
    })
}
pub fn artwork_url(raw: &str) -> bool {
    if let Some(name) = raw.strip_prefix("/covers/") {
        return name.ends_with(".svg")
            && name
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || b"-_.".contains(&c))
            && !name.contains("..");
    }
    if let Some(name) = raw.strip_prefix("glass://app/covers/") {
        return name.split_once('.').is_some_and(|(hash, ext)| {
            !hash.is_empty()
                && hash.bytes().all(|c| c.is_ascii_hexdigit())
                && ["jpg", "png", "webp"].contains(&ext)
        });
    }
    url::Url::parse(raw).is_ok_and(|u| {
        u.scheme() == "https"
            && u.username().is_empty()
            && u.password().is_none()
            && u.port().is_none()
            && matches!(
                u.host_str(),
                Some(
                    "i.ytimg.com"
                        | "i9.ytimg.com"
                        | "lh3.googleusercontent.com"
                        | "i1.sndcdn.com"
                        | "i2.sndcdn.com"
                        | "i.scdn.co"
                        | "mosaic.scdn.co"
                        | "image-cdn-fa.spotifycdn.com"
                        | "image-cdn-ak.spotifycdn.com"
                        | "cdn-images.dzcdn.net"
                        | "e-cdns-images.dzcdn.net"
                        | "cdns-images.dzcdn.net"
                        | "is1-ssl.mzstatic.com"
                        | "is2-ssl.mzstatic.com"
                        | "is3-ssl.mzstatic.com"
                        | "is4-ssl.mzstatic.com"
                        | "is5-ssl.mzstatic.com"
                        | "f4.bcbits.com"
                        | "resources.tidal.com"
                        | "akamai.sscdn.co"
                )
            )
    })
}
pub fn playlist_artwork_url(raw: &str) -> bool {
    if artwork_url(raw) {
        return true;
    }
    raw.len() <= 1_800_000
        && ["data:image/jpeg;base64,", "data:image/png;base64,", "data:image/webp;base64,"]
            .iter()
            .any(|prefix| {
                raw.strip_prefix(prefix)
                    .is_some_and(|d| !d.is_empty() && d.bytes().all(|c| c.is_ascii_alphanumeric() || b"+/=".contains(&c)))
            })
}
pub fn validate_track(t: &Value) -> Result<()> {
    let source = s(t, "source");
    let id = s(t, "sourceId");
    if !["local", "youtube", "soundcloud", "link"].contains(&source)
        || !valid_id(id)
        || s(t, "id") != format!("{source}:{id}")
        || !valid_id(s(t, "id"))
        || !["track", "artist", "playlist", "album"].contains(&s(t, "kind"))
    {
        return Err("Referência de faixa inválida.".into());
    }
    for key in ["title", "artist"] {
        if s(t, key).trim().is_empty() || s(t, key).len() > 2000 {
            return Err("Título ou artista inválido.".into());
        }
    }
    if !t["duration"]
        .as_f64()
        .is_some_and(|v| (0.0..=604800.0).contains(&v))
        || !t["addedAt"].as_f64().is_some_and(|v| v >= 0.0)
    {
        return Err("Duração inválida.".into());
    }
    if source == "youtube"
        && s(t, "kind") == "track"
        && !(id.len() == 11
            && id
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || b"_-".contains(&c)))
    {
        return Err("ID de vídeo inválido.".into());
    }
    if let Some(u) = t["url"].as_str() {
        if u.len() > 2048
            || !(official_url(u) || (source == "link" && crate::links::public_url(u)))
            || (source == "soundcloud"
                && !url::Url::parse(u)
                    .unwrap()
                    .host_str()
                    .is_some_and(|h| ["soundcloud.com", "www.soundcloud.com"].contains(&h)))
        {
            return Err("Link não autorizado.".into());
        }
    }
    if let Some(u) = t["artwork"].as_str() {
        if u.len() > 2048 || !artwork_url(u) {
            return Err("Capa não autorizada.".into());
        }
    }
    if let Some(id) = t.get("playbackId") {
        if source != "link" || s(t,"kind") != "track" || !id.as_str().is_some_and(|id|id.len()==11&&id.bytes().all(|b|b.is_ascii_alphanumeric()||b"_-".contains(&b))) {
            return Err("Referência de reprodução inválida.".into());
        }
    }
    if t.to_string().len() > 12000 {
        return Err("Metadados muito grandes.".into());
    }
    Ok(())
}
pub fn validate_prefs(p: &Value) -> Result<()> {
    if !["dark", "light", "system"].contains(&s(p, "theme"))
        || !["off", "all", "one"].contains(&s(p, "repeat"))
    {
        return Err("Preferência inválida.".into());
    }
    if p.get("uiStyle").is_some() && !["matte", "glass"].contains(&s(p, "uiStyle")) {
        return Err("Estilo inválido.".into());
    }
    if p.get("transition").is_some()&&! ["off","fade","crossfade"].contains(&s(p,"transition")){return Err("Transição inválida.".into());}
    for(key,lo,hi)in [("transitionSeconds",0.5,10.0),("volumeBoost",0.0,12.0)]{if p.get(key).is_some()&&!p[key].as_f64().is_some_and(|n|n.is_finite()&&n>=lo&&n<=hi){return Err("Áudio fora dos limites.".into());}}
    for key in ["limiter","autoUpdate","autoplay"]{if p.get(key).is_some()&&!p[key].is_boolean(){return Err("Preferência inválida.".into());}}
    if p.get("outputDevice").is_some()&&(!p["outputDevice"].is_string()||s(p,"outputDevice").len()>300){return Err("Dispositivo inválido.".into());}
    if p.get("jamEndpoint").is_some(){crate::jam::validate_endpoint(s(p,"jamEndpoint"))?;}
    let accent = s(p, "accent");
    if accent.len() != 7
        || !accent.starts_with('#')
        || !accent[1..].bytes().all(|c| c.is_ascii_hexdigit())
    {
        return Err("Cor inválida.".into());
    }
    for (key, max) in [
        ("glass", 100.0),
        ("blur", 48.0),
        ("volume", 100.0),
        ("coverCacheMB", 512.0),
    ] {
        if !p[key].as_f64().is_some_and(|v| v >= 0.0 && v <= max) {
            return Err("Valor fora dos limites.".into());
        }
    }
    for key in [
        "autoAccent",
        "reducedMotion",
        "performance",
        "shuffle",
        "tray",
        "startup",
        "notifications",
        "globalShortcuts",
        "onlineConsent",
        "catalogConsent",
        "onboardingDone",
    ] {
        if !p[key].is_boolean() {
            return Err("Preferência inválida.".into());
        }
    }
    if !p["eq"].as_array().is_some_and(|a| {
        a.len() == 5
            && a.iter()
                .all(|v| v.as_f64().is_some_and(|n| (-12.0..=12.0).contains(&n)))
    }) {
        return Err("Equalizador inválido.".into());
    }
    if let Some(a) = p.get("appearance") {
        if !a.is_object() { return Err("Aparência inválida.".into()); }
        if a.get("material").is_some() && !["floating","frosted","clear","subtle"].contains(&s(a,"material")) { return Err("Material inválido.".into()); }
        for (key,lo,hi) in [("blur",0.0,24.0),("refraction",0.0,12.0),("opacity",0.0,0.14),("saturation",0.5,2.0),("specular",0.0,1.0),("chromatic",0.0,0.2),("thickness",3.0,30.0),("ior",1.0,2.0),("fresnel",0.0,1.0),("edge",0.0,1.0),("scale",90.0,125.0)] {
            if !a[key].as_f64().is_some_and(|v| v>=lo&&v<=hi) { return Err("Aparência fora dos limites.".into()); }
        }
        if !["auto","economy","balanced","high"].contains(&s(a,"quality")) || !["dynamic","ambient","desktop","custom","solid"].contains(&s(a,"background")) || !a["sidebarCompact"].is_boolean() { return Err("Aparência inválida.".into()); }
        for (key,lo,hi) in [("backgroundMotion",0.0,1.0),("gradientIntensity",0.1,1.0)] {
            if a.get(key).is_some()&&!a[key].as_f64().is_some_and(|n|n>=lo&&n<=hi){return Err("Movimento de fundo inválido.".into());}
        }
        for key in ["tint","solidColor"] { let color=s(a,key);if color.len()!=7||!color.starts_with('#')||!color[1..].bytes().all(|c|c.is_ascii_hexdigit()){return Err("Cor inválida.".into());} }
        let img=s(a,"customImage");
        if img.len()>2_800_000 || (!img.is_empty() && !["data:image/jpeg;base64,","data:image/png;base64,","data:image/webp;base64,"].iter().any(|prefix|img.strip_prefix(prefix).is_some_and(|data|data.bytes().all(|c|c.is_ascii_alphanumeric()||b"+/=".contains(&c))))) {return Err("Imagem de fundo inválida.".into());}
    }
    Ok(())
}
pub struct Library {
    pub db: Connection,
}
impl Library {
    pub fn open(path: &Path) -> Result<Self> {
        let db = Connection::open(path).map_err(|e| e.to_string())?;
        db.execute_batch("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS tracks(id TEXT PRIMARY KEY,data TEXT NOT NULL,local_path TEXT,refreshed INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS playlists(id TEXT PRIMARY KEY,name TEXT NOT NULL,created INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS playlist_tracks(playlist_id TEXT REFERENCES playlists(id) ON DELETE CASCADE,track_id TEXT REFERENCES tracks(id) ON DELETE CASCADE,position INTEGER NOT NULL,PRIMARY KEY(playlist_id,track_id));
      CREATE TABLE IF NOT EXISTS offline_tracks(track_id TEXT PRIMARY KEY REFERENCES tracks(id) ON DELETE CASCADE,path TEXT NOT NULL,size INTEGER NOT NULL,duration REAL NOT NULL,created INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS likes(track_id TEXT PRIMARY KEY REFERENCES tracks(id) ON DELETE CASCADE);
      CREATE TABLE IF NOT EXISTS history(track_id TEXT REFERENCES tracks(id) ON DELETE CASCADE,played INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS history_played ON history(played DESC);
      CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,value TEXT NOT NULL); PRAGMA user_version=1;").map_err(|e|e.to_string())?;
        let this = Self { db };
        let expired = this.query(
            "SELECT data FROM tracks WHERE refreshed < ?",
            params![now() - 28 * 86400000],
        )?;
        for mut t in expired {
            if s(&t, "source") != "local" {
                t["title"] = json!(if s(&t, "source") == "youtube" {
                    "Vídeo do YouTube"
                } else {
                    "Faixa do SoundCloud"
                });
                t["artist"] = t["source"].clone();
                t["duration"] = json!(0);
                if let Some(o) = t.as_object_mut() {
                    o.remove("artwork");
                }
                this.db
                    .execute(
                        "UPDATE tracks SET data=? WHERE id=?",
                        params![t.to_string(), s(&t, "id")],
                    )
                    .map_err(|e| e.to_string())?;
            }
        }
        Ok(this)
    }
    fn query<P: rusqlite::Params>(&self, sql: &str, params: P) -> Result<Vec<Value>> {
        let mut stmt = self.db.prepare(sql).map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(params, |r| r.get::<_, String>(0))
            .map_err(|e| e.to_string())?;
        rows.map(|r| {
            serde_json::from_str(&r.map_err(|e| e.to_string())?).map_err(|e| e.to_string())
        })
        .collect()
    }
    pub fn path(&self, id: &str) -> Option<String> {
        self.db
            .query_row("SELECT local_path FROM tracks WHERE id=?", [id], |r| {
                r.get::<_, Option<String>>(0)
            })
            .optional()
            .ok()
            .flatten()
            .flatten()
    }
    pub fn pref(&self) -> Value {
        let saved = self
            .db
            .query_row(
                "SELECT value FROM settings WHERE key='preferences'",
                [],
                |r| r.get::<_, String>(0),
            )
            .ok()
            .and_then(|s| serde_json::from_str::<Value>(&s).ok());
        let mut p = defaults();
        if let Some(o) = saved.and_then(|v| v.as_object().cloned()) {
            p.as_object_mut().unwrap().extend(o);
        }
        p
    }
    pub fn set_pref(&self, p: &Value) -> Result<()> {
        validate_prefs(p)?;
        self.db.execute("INSERT INTO settings VALUES('preferences',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",[p.to_string()]).map_err(|e|e.to_string())?;
        Ok(())
    }
    pub fn save(&self, t: &Value, path: Option<&str>) -> Result<()> {
        validate_track(t)?;
        let mut t = t.clone();
        if let Some(obj) = t.as_object_mut() {
            obj.remove("lyricSnippet");
            obj.remove("recommended");
        }
        if s(&t,"artwork").is_empty(){if let Ok(Some(art))=self.db.query_row("SELECT json_extract(data,'$.artwork') FROM tracks WHERE id=?",[s(&t,"id")],|row|row.get::<_,Option<String>>(0)){if artwork_url(&art){t["artwork"]=json!(art);}}}
        if s(&t, "source") == "local" && path.is_none() && self.path(s(&t, "id")).is_none() {
            t["available"] = json!(false);
            t["reason"] = json!("Importe novamente o arquivo neste computador.");
        }
        self.db.execute("INSERT INTO tracks VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data,local_path=COALESCE(excluded.local_path,tracks.local_path),refreshed=excluded.refreshed",params![s(&t,"id"),t.to_string(),path,now()]).map_err(|e|e.to_string())?;
        Ok(())
    }
    pub fn snapshot(&self) -> Result<Value> {
        let tracks = self.query(
            "SELECT CASE WHEN EXISTS(SELECT 1 FROM offline_tracks WHERE track_id=tracks.id) THEN json_set(data,'$.offline',json('true')) ELSE json_remove(data,'$.offline') END FROM tracks ORDER BY refreshed DESC LIMIT 20000",
            [],
        )?;
        let playlists=self.query("SELECT json_object('id',id,'name',name,'createdAt',created,'artwork',(SELECT value FROM settings WHERE key='playlist-artwork:'||playlists.id),'description',(SELECT value FROM settings WHERE key='playlist-desc:'||playlists.id),'trackIds',json(COALESCE((SELECT json_group_array(track_id) FROM (SELECT track_id FROM playlist_tracks WHERE playlist_id=playlists.id ORDER BY position)),'[]'))) FROM playlists ORDER BY created DESC",[])?;
        let likes = self.query("SELECT json_quote(track_id) FROM likes", [])?;
        let history=self.query("SELECT json_object('id',track_id,'playedAt',played) FROM history ORDER BY played DESC,rowid DESC LIMIT 500",[])?;
        Ok(
            json!({"tracks":tracks,"playlists":playlists,"likes":likes,"history":history,"preferences":self.pref()}),
        )
    }
    pub fn transact<T>(&self, f: impl FnOnce() -> Result<T>) -> Result<T> {
        self.db
            .execute_batch("BEGIN IMMEDIATE")
            .map_err(|e| e.to_string())?;
        match f() {
            Ok(v) => {
                self.db.execute_batch("COMMIT").map_err(|e| e.to_string())?;
                Ok(v)
            }
            Err(e) => {
                let _ = self.db.execute_batch("ROLLBACK");
                Err(e)
            }
        }
    }
    pub fn command(&self, c: &Value) -> Result<Value> {
        self.transact(||{
      let action=s(c,"action"); let id=s(c,"id"); let tid=s(c,"trackId");
      if c.get("track").is_some(){self.save(&c["track"],None)?;}
      let name=s(c,"name").trim(); if ["create","rename"].contains(&action) && (name.is_empty()||name.chars().count()>100){return Err("Escolha um nome de até 100 caracteres.".into());}
      let q=|sql:&str,p:&[&dyn rusqlite::ToSql]|self.db.execute(sql,p).map_err(|e|e.to_string());
      match action {
        "save"=>{validate_track(&c["track"])?;},
        "like"=>{let tid=s(&c["track"],"id"); if q("DELETE FROM likes WHERE track_id=?",&[&tid])?==0{q("INSERT INTO likes VALUES(?)",&[&tid])?;}},
        "history"=>{q("INSERT INTO history VALUES(?,?)",&[&s(&c["track"],"id"),&now()])?;q("DELETE FROM history WHERE rowid NOT IN (SELECT rowid FROM history ORDER BY played DESC,rowid DESC LIMIT 500)",&[])?;},
        "create"=>{q("INSERT INTO playlists VALUES(?,?,?)",&[&uuid::Uuid::new_v4().to_string(),&name,&now()])?;},
        "rename"=>{q("UPDATE playlists SET name=? WHERE id=?",&[&name,&id])?;},
        "delete"=>{q("DELETE FROM playlists WHERE id=?",&[&id])?;},
        "add"=>{q("INSERT OR IGNORE INTO playlist_tracks SELECT ?,?,COALESCE(MAX(position),-1)+1 FROM playlist_tracks WHERE playlist_id=?",&[&id,&s(&c["track"],"id"),&id])?;},
        "move"=>{let target=s(c,"targetId");if target==id||self.query("SELECT json_quote(id) FROM playlists WHERE id=?",[target])?.is_empty()||self.query("SELECT json_quote(track_id) FROM playlist_tracks WHERE playlist_id=? AND track_id=?",[id,tid])?.is_empty(){return Err("Escolha outra playlist válida para mover a faixa.".into());}q("INSERT OR IGNORE INTO playlist_tracks SELECT ?,?,COALESCE(MAX(position),-1)+1 FROM playlist_tracks WHERE playlist_id=?",&[&target,&tid,&target])?;q("DELETE FROM playlist_tracks WHERE playlist_id=? AND track_id=?",&[&id,&tid])?;},
        "remove"=>{q("DELETE FROM playlist_tracks WHERE playlist_id=? AND track_id=?",&[&id,&tid])?;},
        "removeTrack"=>{q("DELETE FROM tracks WHERE id=?",&[&id])?;},
        "clearHistory"=>{q("DELETE FROM history",&[])?;},
        "reorder"=>{let ids=c["trackIds"].as_array().ok_or("Ordem inválida")?;let current=self.query("SELECT json_quote(track_id) FROM playlist_tracks WHERE playlist_id=?",[id])?;let unique:std::collections::HashSet<_>=ids.iter().filter_map(Value::as_str).collect();if ids.len()!=current.len()||unique.len()!=current.len()||ids.iter().any(|v|!current.contains(v)){return Err("A ordem precisa conter cada faixa uma vez.".into());}for(i,tid)in ids.iter().enumerate(){q("UPDATE playlist_tracks SET position=? WHERE playlist_id=? AND track_id=?",&[&(i as i64),&id,&tid.as_str().unwrap()])?;}},
        _=>return Err("Operação não autorizada.".into())
      } Ok(())
    })?;
        self.snapshot()
    }
    pub fn offline_path(&self,id:&str)->Option<(String,f64)>{self.db.query_row("SELECT path,duration FROM offline_tracks WHERE track_id=?",[id],|r|Ok((r.get(0)?,r.get(1)?))).optional().ok().flatten()}
    pub fn save_offline(&self,id:&str,path:&str,size:u64,duration:f64)->Result<()>{self.db.execute("INSERT INTO offline_tracks VALUES(?,?,?,?,?) ON CONFLICT(track_id) DO UPDATE SET path=excluded.path,size=excluded.size,duration=excluded.duration,created=excluded.created",params![id,path,size as i64,duration,now()]).map_err(|e|e.to_string())?;Ok(())}
    pub fn remove_offline(&self,id:&str)->Result<()>{self.db.execute("DELETE FROM offline_tracks WHERE track_id=?",[id]).map_err(|e|e.to_string())?;Ok(())}
    pub fn set_track_artwork(&self,id:&str,url:&str)->Result<()> {
        if !artwork_url(url){return Err("Capa inválida.".into());}
        self.db.execute("UPDATE tracks SET data=json_set(data,'$.artwork',?) WHERE id=?",params![url,id]).map_err(|e|e.to_string())?;Ok(())
    }
    pub fn collection_artwork(&self,id:&str,url:&str)->Result<()> {
        if !valid_id(id)||!playlist_artwork_url(url){return Ok(());}
        self.db.execute("INSERT OR REPLACE INTO settings VALUES(?,?)",params![format!("playlist-artwork:{id}"),url]).map_err(|e|e.to_string())?;Ok(())
    }
    pub fn collection_description(&self,id:&str,desc:&str)->Result<()> {
        if !valid_id(id){return Ok(());}
        let clean:String=desc.trim().chars().take(300).collect();
        if clean.is_empty(){
            self.db.execute("DELETE FROM settings WHERE key=?",[format!("playlist-desc:{id}")]).map_err(|e|e.to_string())?;
        }else{
            self.db.execute("INSERT OR REPLACE INTO settings VALUES(?,?)",params![format!("playlist-desc:{id}"),clean]).map_err(|e|e.to_string())?;
        }
        Ok(())
    }
    pub fn merge_collection(&self,key:&str,name:&str,tracks:&[Value],liked:bool)->Result<String>{
        use sha2::{Digest,Sha256};
        if key.len()>2048||name.trim().is_empty()||tracks.len()>1000{return Err("Playlist inválida ou maior que 1000 faixas.".into());}
        for t in tracks{validate_track(t)?;}
        let id=format!("remote-{:x}",Sha256::digest(key.as_bytes()));let name:String=name.chars().take(100).collect();
        self.transact(||{
            self.db.execute("INSERT INTO playlists VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name",params![id,name,now()]).map_err(|e|e.to_string())?;
            for t in tracks{
                self.save(t,None)?;
                self.db.execute("INSERT OR IGNORE INTO playlist_tracks SELECT ?,?,COALESCE(MAX(position),-1)+1 FROM playlist_tracks WHERE playlist_id=?",params![id,s(t,"id"),id]).map_err(|e|e.to_string())?;
                if liked{self.db.execute("INSERT OR IGNORE INTO likes VALUES(?)",[s(t,"id")]).map_err(|e|e.to_string())?;}
            }Ok(())
        })?;Ok(id)
    }
    pub fn export(&self, playlist: Option<&str>) -> Result<Value> {
        let mut snap = self.snapshot()?;
        if let Some(id) = playlist {
            snap["playlists"]
                .as_array_mut()
                .unwrap()
                .retain(|p| s(p, "id") == id);
            let ids: Vec<Value> = snap["playlists"]
                .as_array()
                .unwrap()
                .iter()
                .flat_map(|p| p["trackIds"].as_array().unwrap().clone())
                .collect();
            snap["tracks"]
                .as_array_mut()
                .unwrap()
                .retain(|t| ids.contains(&t["id"]));
            snap["likes"]
                .as_array_mut()
                .unwrap()
                .retain(|v| ids.contains(v));
        }
        Ok(
            json!({"format":"glass-music","version":1,"tracks":snap["tracks"],"playlists":snap["playlists"],"likes":snap["likes"]}),
        )
    }
    pub fn import(&self, v: &Value) -> Result<Value> {
        if s(v, "format") != "glass-music" || v["version"] != 1 {
            return Err("Formato de biblioteca inválido.".into());
        }
        let tracks = v["tracks"].as_array().ok_or("Faixas ausentes")?;
        let lists = v["playlists"].as_array().ok_or("Playlists ausentes")?;
        let likes = v["likes"].as_array().ok_or("Curtidas ausentes")?;
        if tracks.len() > 20000 || lists.len() > 1000 || likes.len() > 20000 {
            return Err("Biblioteca muito grande.".into());
        }
        let ids: std::collections::HashSet<&str> = tracks.iter().map(|t| s(t, "id")).collect();
        for t in tracks {
            validate_track(t)?;
        }
        for p in lists {
            let name = s(p, "name");
            let tids = p["trackIds"].as_array().ok_or("Playlist inválida")?;
            if name.trim().is_empty()
                || name.chars().count() > 100
                || tids.len() > 10000
                || tids.iter().any(|v| !ids.contains(v.as_str().unwrap_or("")))
            {
                return Err("Playlist ou referência inválida.".into());
            }
        }
        if likes
            .iter()
            .any(|v| !ids.contains(v.as_str().unwrap_or("")))
        {
            return Err("Curtida sem referência.".into());
        }
        self.transact(|| {
            for t in tracks {
                self.save(t, None)?;
            }
            for p in lists {
                let id = uuid::Uuid::new_v4().to_string();
                self.db
                    .execute(
                        "INSERT INTO playlists VALUES(?,?,?)",
                        params![id, s(p, "name"), now()],
                    )
                    .map_err(|e| e.to_string())?;
                self.collection_artwork(&id,s(p,"artwork"))?;
                for (i, t) in p["trackIds"].as_array().unwrap().iter().enumerate() {
                    self.db
                        .execute(
                            "INSERT OR IGNORE INTO playlist_tracks VALUES(?,?,?)",
                            params![id, t.as_str(), i as i64],
                        )
                        .map_err(|e| e.to_string())?;
                }
            }
            for tid in likes {
                self.db
                    .execute("INSERT OR IGNORE INTO likes VALUES(?)", [tid.as_str()])
                    .map_err(|e| e.to_string())?;
            }
            Ok(())
        })?;
        self.snapshot()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn track(id: &str) -> Value {
        json!({"id":format!("local:{id}"),"source":"local","sourceId":id,"kind":"track","title":id,"artist":"Teste","duration":3,"addedAt":now()})
    }
    #[test]
    fn move_is_atomic_deduplicated_and_preserves_other_tracks(){
      let db=Library::open(Path::new(":memory:")).unwrap();
      let a=db.merge_collection("move:a","A",&[track("a"),track("b")],false).unwrap();
      let b=db.merge_collection("move:b","B",&[track("c"),track("a")],false).unwrap();
      let before=db.snapshot().unwrap();assert!(db.command(&json!({"action":"move","id":a,"targetId":"missing","trackId":"local:a"})).is_err());assert_eq!(db.snapshot().unwrap(),before);
      db.command(&json!({"action":"move","id":a,"targetId":b,"trackId":"local:a"})).unwrap();let after=db.snapshot().unwrap();let lists=after["playlists"].as_array().unwrap();
      assert_eq!(lists.iter().find(|p|p["id"]==a).unwrap()["trackIds"],json!(["local:b"]));assert_eq!(lists.iter().find(|p|p["id"]==b).unwrap()["trackIds"],json!(["local:c","local:a"]));assert_eq!(after["tracks"],before["tracks"]);
      assert!(db.command(&json!({"action":"move","id":a,"targetId":b,"trackId":"local:a"})).is_err());assert_eq!(db.snapshot().unwrap(),after);
    }
    #[test]
    fn repaired_artwork_keeps_order_and_survives_stale_metadata(){
      let db=Library::open(Path::new(":memory:")).unwrap();db.save(&track("a"),Some("C:/a.wav")).unwrap();let before=db.snapshot().unwrap();let url="https://i.scdn.co/image/ab67616d00001e02test";
      db.set_track_artwork("local:a",url).unwrap();assert_eq!(db.snapshot().unwrap()["tracks"][0]["artwork"],url);db.save(&track("a"),None).unwrap();assert_eq!(db.snapshot().unwrap()["tracks"][0]["artwork"],url);assert_eq!(before["tracks"][0]["id"],db.snapshot().unwrap()["tracks"][0]["id"]);assert!(db.set_track_artwork("local:a","https://evil.example/image").is_err());
    }
    #[test]
    fn remote_merge_is_idempotent_and_validates_before_writing(){
        let db=Library::open(Path::new(":memory:")).unwrap();
        let id=db.merge_collection("remote:test","Lista",&[track("a"),track("b")],true).unwrap();
        let again=db.merge_collection("remote:test","Lista",&[track("a"),track("c")],true).unwrap();assert_eq!(id,again);
        let snap=db.snapshot().unwrap();assert_eq!(snap["playlists"].as_array().unwrap().len(),1);assert_eq!(snap["playlists"][0]["trackIds"],json!(["local:a","local:b","local:c"]));assert_eq!(snap["likes"].as_array().unwrap().len(),3);
        let mut bad=track("x");bad["source"]=json!("invalid");assert!(db.merge_collection("remote:test","Bad",&[track("d"),bad],false).is_err());assert_eq!(db.snapshot().unwrap(),snap);
    }
    #[test]
    fn upgrade_preserves_preferences_without_granting_catalog_consent() {
        let db = Library::open(Path::new(":memory:")).unwrap();
        let mut old = defaults();
        old.as_object_mut().unwrap().remove("catalogConsent");
        old["onlineConsent"] = json!(true);
        old["volume"] = json!(23);
        db.db.execute("INSERT OR REPLACE INTO settings VALUES('preferences',?)", [old.to_string()]).unwrap();
        let upgraded = db.pref();
        assert_eq!(upgraded["onlineConsent"], true);
        assert_eq!(upgraded["volume"], 23);
        assert_eq!(upgraded["catalogConsent"], false);
        validate_prefs(&upgraded).unwrap();
        db.set_pref(&upgraded).unwrap();
    }
    #[test]
    fn persistence_order_and_rollback() {
        let db = Library::open(Path::new(":memory:")).unwrap();
        db.save(&track("a"), Some("C:/music/a.wav")).unwrap();
        db.save(&track("b"), None).unwrap();
        let snap = db
            .command(&json!({"action":"create","name":"Teste"}))
            .unwrap();
        let id = s(&snap["playlists"][0], "id");
        for name in ["a", "b"] {
            db.command(&json!({"action":"add","id":id,"track":track(name)}))
                .unwrap();
        }
        assert!(db
            .command(&json!({"action":"reorder","id":id,"trackIds":["local:a","local:a"]}))
            .is_err());
        assert_eq!(
            db.snapshot().unwrap()["playlists"][0]["trackIds"],
            json!(["local:a", "local:b"])
        );
        db.command(&json!({"action":"reorder","id":id,"trackIds":["local:b","local:a"]}))
            .unwrap();
        assert_eq!(
            db.snapshot().unwrap()["playlists"][0]["trackIds"][0],
            "local:b"
        );
        let export = db.export(None).unwrap();
        let fresh = Library::open(Path::new(":memory:")).unwrap();
        fresh.import(&export).unwrap();
        assert_eq!(fresh.snapshot().unwrap()["tracks"][0]["available"], false);
    }
    #[test]
    fn import_is_atomic_and_validated() {
        let db = Library::open(Path::new(":memory:")).unwrap();
        let v = json!({"format":"glass-music","version":1,"tracks":[track("a")],"playlists":[],"likes":["missing"]});
        assert!(db.import(&v).is_err());
        assert_eq!(db.snapshot().unwrap()["tracks"], json!([]));
    }
    #[test]
    fn allowlist_rejects_host_confusion() {
        assert!(!official_url("https://youtube.com.evil.test/a"));
        assert!(!official_url("https://user@youtube.com/a"));
        assert!(!artwork_url("file:///C:/secret"));
        assert!(!artwork_url("/covers/../secrets.svg"));
        assert!(official_url("https://www.youtube.com/watch?v=M7lc1UVf-VE"));
    }
    #[test]
    fn removing_demo_music_preserves_personal_tracks_and_playlists() {
        let db=Library::open(Path::new(":memory:")).unwrap();
        for id in ["glass-prisma","glass-mare","glass-orbita","my-song"] {
            db.command(&json!({"action":"history","track":track(id)})).unwrap();
        }
        let snap=db.command(&json!({"action":"create","name":"Personal"})).unwrap();
        let id=s(&snap["playlists"][0],"id");
        db.command(&json!({"action":"add","id":id,"track":track("my-song")})).unwrap();
        crate::media::seed(&db,Path::new(".")).unwrap();
        let snap=db.snapshot().unwrap();
        assert_eq!(snap["tracks"].as_array().unwrap().len(),1);
        assert_eq!(snap["tracks"][0]["id"],"local:my-song");
        assert_eq!(snap["history"].as_array().unwrap().len(),1);
        assert_eq!(snap["playlists"][0]["trackIds"],json!(["local:my-song"]));
        crate::media::seed(&db,Path::new(".")).unwrap();
        assert_eq!(db.snapshot().unwrap()["tracks"],snap["tracks"]);
    }
    #[test]
    fn history_is_bounded() {
        let db = Library::open(Path::new(":memory:")).unwrap();
        for _ in 0..505 {
            db.command(&json!({"action":"history","track":track("a")}))
                .unwrap();
        }
        assert_eq!(
            db.snapshot().unwrap()["history"].as_array().unwrap().len(),
            500
        );
    }
}
