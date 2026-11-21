use crate::{
    collections::{self, Collection},
    db::{self, now, s, Result},
    secrets::{self, HubIdentityPublic, HubVaultSession, Secrets},
};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use ring::rand::{SecureRandom, SystemRandom};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};

#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Client {
    pub client_id: String,
    pub client_secret: String,
}

#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct Session {
    access: String,
    refresh: String,
    expires: i64,
    name: String,
    user_id: String,
    last_sync: i64,
}

#[derive(Default, Serialize, Deserialize)]
#[serde(default)]
struct Vault {
    clients: HashMap<String, Client>,
    sessions: HashMap<String, Session>,
}

pub struct Accounts {
    path: PathBuf,
    vault: Mutex<Vault>,
    pub gate: tokio::sync::Mutex<()>,
    cancel: AtomicBool,
}

fn generate_pkce_pair() -> Result<(String, String)> {
    let rng = SystemRandom::new();
    let mut raw = [0u8; 64];
    rng.fill(&mut raw)
        .map_err(|_| "Falha no gerador criptográfico do sistema.")?;
    let verifier = URL_SAFE_NO_PAD.encode(raw);
    let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
    Ok((verifier, challenge))
}

fn generate_oauth_state() -> Result<String> {
    let rng = SystemRandom::new();
    let mut raw = [0u8; 32];
    rng.fill(&mut raw)
        .map_err(|_| "Falha no gerador criptográfico do sistema.")?;
    Ok(URL_SAFE_NO_PAD.encode(raw))
}

fn provider(id: &str) -> Result<(&'static str, &'static str, &'static str, &'static str)> {
    match id {
        "spotify" => Ok((
            "https://accounts.spotify.com/authorize",
            "https://accounts.spotify.com/api/token",
            "playlist-read-private playlist-read-collaborative user-library-read",
            "https://api.spotify.com/v1/",
        )),
        "youtube" => Ok((
            "https://accounts.google.com/o/oauth2/v2/auth",
            "https://oauth2.googleapis.com/token",
            "https://www.googleapis.com/auth/youtube.readonly",
            "https://www.googleapis.com/youtube/v3/",
        )),
        "soundcloud" => Ok((
            "https://secure.soundcloud.com/authorize",
            "https://secure.soundcloud.com/oauth/token",
            "",
            "https://api.soundcloud.com/",
        )),
        _ => Err("Conta inválida.".into()),
    }
}

fn client_ok(id: &str, c: &Client) -> bool {
    !c.client_id.is_empty() && (id != "soundcloud" || !c.client_secret.is_empty())
}

impl Accounts {
    pub fn load(dir: &Path) -> Result<Self> {
        let path = dir.join("accounts.dpapi");
        let vault = if path.exists() {
            let raw = std::fs::read(&path).map_err(|_| "Não foi possível ler as conexões.")?;
            serde_json::from_slice(&crate::secrets::protect(&raw, false)?)
                .map_err(|_| "Conexões salvas inválidas.")?
        } else {
            Vault::default()
        };
        Ok(Self {
            path,
            vault: Mutex::new(vault),
            gate: tokio::sync::Mutex::new(()),
            cancel: AtomicBool::new(false),
        })
    }

    fn save(&self, vault: &Vault) -> Result<()> {
        let bytes = crate::secrets::protect(
            &serde_json::to_vec(vault).map_err(|_| "Conexões inválidas.")?,
            true,
        )?;
        let pending = self.path.with_extension("pending");
        std::fs::write(&pending, bytes).map_err(|_| "Não foi possível salvar a conexão.")?;
        std::fs::rename(pending, &self.path).map_err(|_| "Não foi possível salvar a conexão.".into())
    }

    pub fn status(&self) -> Value {
        let vault = self.vault.lock().unwrap();
        json!(["youtube", "soundcloud", "spotify"].map(|id| {
            let session = vault.sessions.get(id);
            let ready = vault.clients.get(id).is_some_and(|c| client_ok(id, c));
            json!({
                "provider": id,
                "configured": ready,
                "connected": session.is_some(),
                "name": session.map(|s| s.name.as_str()).unwrap_or(""),
                "lastSync": session.map(|s| s.last_sync).unwrap_or(0),
                "reason": if ready {
                    ""
                } else {
                    "O cadastro do Liquid Hub nesta plataforma ainda precisa ser ativado."
                }
            })
        }))
    }

    pub fn configure(&self, value: Value) -> Result<Value> {
        let clients: HashMap<String, Client> =
            serde_json::from_value(value).map_err(|_| "Arquivo de cadastro inválido.")?;
        if clients.len() > 3 {
            return Err("Cadastro inválido.".into());
        }
        for (id, c) in &clients {
            provider(id)?;
            if c.client_id.len() > 500
                || c.client_secret.len() > 1000
                || c.client_id.contains(['\r', '\n'])
                || c.client_secret.contains(['\r', '\n'])
            {
                return Err("Cadastro inválido.".into());
            }
        }
        let mut vault = self.vault.lock().unwrap();
        for (id, c) in clients {
            if vault
                .clients
                .get(&id)
                .is_some_and(|old| old.client_id != c.client_id)
            {
                vault.sessions.remove(&id);
            }
            vault.clients.insert(id, c);
        }
        self.save(&vault)?;
        drop(vault);
        Ok(self.status())
    }

    pub fn ensure_active(&self, id: &str) -> Result<()> {
        if self.cancel.load(Ordering::Acquire) || !self.vault.lock().unwrap().sessions.contains_key(id)
        {
            return Err("Sincronização cancelada.".into());
        }
        Ok(())
    }

    pub fn cancel(&self) {
        self.cancel.store(true, Ordering::Release);
    }

    pub fn disconnect(&self, id: &str) -> Result<Value> {
        provider(id)?;
        self.cancel();
        let mut vault = self.vault.lock().unwrap();
        vault.sessions.remove(id);
        self.save(&vault)?;
        drop(vault);
        Ok(self.status())
    }

    fn client(&self, id: &str) -> Result<Client> {
        provider(id)?;
        let v = self.vault.lock().unwrap();
        let c = v
            .clients
            .get(id)
            .filter(|c| client_ok(id, c))
            .ok_or("A conexão oficial precisa do cadastro do Liquid Hub nesta plataforma. Isso é configurado uma vez para o aplicativo.")?;
        Ok(c.clone())
    }

    pub async fn connect(&self, id: &str, app: &tauri::AppHandle) -> Result<Value> {
        use tauri_plugin_opener::OpenerExt;
        let _guard = self
            .gate
            .try_lock()
            .map_err(|_| "Há outra conexão ou sincronização em andamento.")?;
        let c = self.client(id)?;
        let (auth, token, scope, _) = provider(id)?;
        self.cancel.store(false, Ordering::Release);
        // Single loopback listener on 127.0.0.1 with mandatory PKCE (S256).
        let server = tiny_http::Server::http("127.0.0.1:43871")
            .map_err(|_| "A porta de autorização está ocupada. Tente novamente.")?;
        let redirect = "http://127.0.0.1:43871/callback";
        let state = generate_oauth_state()?;
        let (verifier, challenge) = generate_pkce_pair()?;
        let mut url = url::Url::parse(auth).unwrap();
        {
            let mut q = url.query_pairs_mut();
            q.append_pair("client_id", &c.client_id)
                .append_pair("redirect_uri", redirect)
                .append_pair("response_type", "code")
                .append_pair("state", &state)
                .append_pair("code_challenge", &challenge)
                .append_pair("code_challenge_method", "S256");
            if !scope.is_empty() {
                q.append_pair("scope", scope);
            }
            if id == "youtube" {
                q.append_pair("access_type", "offline")
                    .append_pair("prompt", "consent");
            }
        }
        app.opener()
            .open_url(url.as_str(), None::<&str>)
            .map_err(|_| "Não foi possível abrir a autorização no navegador.")?;
        let start = std::time::Instant::now();
        let code = loop {
            if self.cancel.load(Ordering::Acquire) {
                return Err("Conexão cancelada.".into());
            }
            if start.elapsed() > Duration::from_secs(300) {
                return Err("A autorização expirou. Tente conectar novamente.".into());
            }
            if let Some(req) = server
                .recv_timeout(Duration::from_millis(80))
                .map_err(|_| "Falha no retorno da autorização.")?
            {
                let host_ok = req
                    .headers()
                    .iter()
                    .any(|h| h.field.equiv("Host") && h.value.as_str() == "127.0.0.1:43871");
                if req.method() != &tiny_http::Method::Get || !host_ok {
                    let _ = req.respond(tiny_http::Response::empty(400));
                    continue;
                }
                let result = callback_code(req.url(), &state);
                if req.url().starts_with("/callback?") {
                    let success = result.is_ok();
                    let body = if success {
                        "Conta autorizada. Volte ao Liquid Hub."
                    } else {
                        "Autorização recusada ou inválida. Volte ao Liquid Hub."
                    };
                    let mut response = tiny_http::Response::from_string(body)
                        .with_status_code(if success { 200 } else { 400 });
                    if let Ok(h) = tiny_http::Header::from_bytes("Cache-Control", "no-store") {
                        response.add_header(h);
                    }
                    let _ = req.respond(response);
                    break result?;
                } else {
                    let _ = req.respond(tiny_http::Response::empty(404));
                }
            }
            tokio::task::yield_now().await;
        };
        let mut form = vec![
            ("grant_type", "authorization_code"),
            ("client_id", c.client_id.as_str()),
            ("code", code.as_str()),
            ("code_verifier", verifier.as_str()),
            ("redirect_uri", redirect),
        ];
        if !c.client_secret.is_empty() {
            form.push(("client_secret", &c.client_secret));
        }
        let data = collections::read(
            crate::providers::client()
                .post(token)
                .form(&form)
                .send()
                .await
                .map_err(|_| "Não foi possível concluir a autorização.")?,
        )
        .await?;
        let session = token_session(data, None)?;
        if self.cancel.load(Ordering::Acquire) {
            return Err("Conexão cancelada.".into());
        }
        let mut vault = self.vault.lock().unwrap();
        vault.sessions.insert(id.to_string(), session);
        self.save(&vault)?;
        drop(vault);
        Ok(self.status())
    }

    async fn token(&self, id: &str) -> Result<String> {
        let c = self.client(id)?;
        let session = self
            .vault
            .lock()
            .unwrap()
            .sessions
            .get(id)
            .cloned()
            .ok_or("Conecte a conta primeiro.")?;
        if session.expires > now() + 60000 {
            return Ok(session.access);
        }
        if session.refresh.is_empty() {
            return Err("A autorização expirou. Reconecte sua conta.".into());
        }
        let mut form = vec![
            ("grant_type", "refresh_token"),
            ("client_id", c.client_id.as_str()),
            ("refresh_token", session.refresh.as_str()),
        ];
        if !c.client_secret.is_empty() {
            form.push(("client_secret", &c.client_secret));
        }
        let res = crate::providers::client()
            .post(provider(id)?.1)
            .form(&form)
            .send()
            .await
            .map_err(|_| "Falha ao renovar a conexão.".to_string())?;
        if res.status().as_u16() == 400 || res.status().as_u16() == 401 {
            // Zero-Trust: immediately purge invalidated or reused refresh token from OS vault
            let mut vault = self.vault.lock().unwrap();
            vault.sessions.remove(id);
            let _ = self.save(&vault);
            return Err("Sessão revogada ou expirada na plataforma. Reconecte sua conta.".into());
        }
        let data = collections::read(res).await?;
        let next = token_session(data, Some(session))?;
        let access = next.access.clone();
        let mut vault = self.vault.lock().unwrap();
        vault.sessions.insert(id.to_string(), next);
        self.save(&vault)?;
        Ok(access)
    }

    async fn api(&self, id: &str, path: &str) -> Result<Value> {
        if self.cancel.load(Ordering::Acquire) {
            return Err("Sincronização cancelada.".into());
        }
        let token = self.token(id).await?;
        let base = provider(id)?.3;
        let url = if path.starts_with("https://") {
            let u = url::Url::parse(path).map_err(|_| "Página inválida.")?;
            let b = url::Url::parse(base).unwrap();
            if u.origin() != b.origin()
                || !u.path().starts_with(b.path())
                || !u.username().is_empty()
                || u.password().is_some()
            {
                return Err("Destino de paginação inválido.".into());
            }
            path.to_string()
        } else {
            if path.starts_with('/') || path.contains("://") {
                return Err("Página inválida.".into());
            }
            format!("{base}{path}")
        };
        let auth = if id == "soundcloud" {
            format!("OAuth {token}")
        } else {
            format!("Bearer {token}")
        };
        collections::read(
            crate::providers::client()
                .get(url)
                .header("Authorization", auth)
                .send()
                .await
                .map_err(|_| "Não foi possível sincronizar agora.")?,
        )
        .await
    }

    async fn pages(&self, id: &str, first: &str, field: &str, limit: usize) -> Result<Vec<Value>> {
        let mut path = first.to_string();
        let mut items = vec![];
        let mut seen = std::collections::HashSet::new();
        for _ in 0..200 {
            if !seen.insert(path.clone()) {
                return Err("Paginação repetida pela plataforma.".into());
            }
            let data = self.api(id, &path).await?;
            let rows = data[field].as_array().ok_or("Lista da conta inválida.")?;
            if items.len() + rows.len() > limit {
                return Err(
                    "Lista da conta excede o limite desta sincronização. Importe por playlist."
                        .into(),
                );
            }
            items.extend(rows.iter().cloned());
            if let Some(token) = data["nextPageToken"].as_str() {
                let mut u = url::Url::parse(&format!("{}{first}", provider(id)?.3)).unwrap();
                u.query_pairs_mut().append_pair("pageToken", token);
                path = u.to_string();
            } else if let Some(next) = data["next"].as_str().or(data["next_href"].as_str()) {
                path = next.to_string();
            } else {
                return Ok(items);
            }
        }
        Err("Muitas páginas na conta. Importe listas separadamente.".into())
    }

    pub async fn sync(&self, id: &str) -> Result<Vec<(Collection, bool)>> {
        self.client(id)?;
        self.cancel.store(false, Ordering::Release);
        let mut lists = vec![];
        let (name, user) = match id {
            "spotify" => {
                let me = self.api(id, "me").await?;
                (
                    me["display_name"].as_str().unwrap_or("Spotify").to_string(),
                    s(&me, "id").to_string(),
                )
            }
            "soundcloud" => {
                let me = self.api(id, "me").await?;
                (
                    s(&me, "username").to_string(),
                    collections::soundcloud_id(&me, "users").ok_or("Identidade SoundCloud inválida.")?,
                )
            }
            "youtube" => {
                let me = self.api(id, "channels?part=snippet&mine=true").await?;
                let ch = me["items"]
                    .as_array()
                    .and_then(|a| a.first())
                    .ok_or("Esta conta não tem um canal do YouTube acessível.")?;
                (s(&ch["snippet"], "title").to_string(), s(ch, "id").to_string())
            }
            _ => return Err("Conta inválida.".into()),
        };
        if user.is_empty() {
            return Err("A plataforma não retornou a identidade da conta.".into());
        }
        let prefix = format!("account:{id}:{user}:");
        let make = |key: &str, title: String, tracks: Vec<Value>| Collection {
            artwork: tracks
                .iter()
                .map(|t| s(t, "artwork"))
                .find(|u| !u.is_empty())
                .unwrap_or("")
                .into(),
            key: format!("{prefix}{key}"),
            name: title,
            tracks,
            warning: String::new(),
            skipped: 0,
        };
        match id {
            "spotify" => {
                let likes = self.pages(id, "me/tracks?limit=50", "items", 1000).await?;
                let tracks: Vec<_> = likes
                    .iter()
                    .filter_map(|v| collections::spotify_track(&v["track"]))
                    .collect();
                lists.push((make("likes", "Spotify · Curtidas".into(), tracks), true));
                for list in self.pages(id, "me/playlists?limit=50", "items", 100).await? {
                    let pid = s(&list, "id");
                    if pid.len() != 22 {
                        continue;
                    }
                    let rows = self
                        .pages(id, &format!("playlists/{pid}/items?limit=50"), "items", 1000)
                        .await?;
                    let tracks = rows
                        .iter()
                        .filter_map(|v| {
                            collections::spotify_track(
                                v.get("item").or(v.get("track")).unwrap_or(&Value::Null),
                            )
                        })
                        .collect();
                    lists.push((make(pid, format!("Spotify · {}", s(&list, "name")), tracks), false));
                }
            }
            "youtube" => {
                let liked = self
                    .pages(
                        id,
                        "videos?part=snippet&myRating=like&maxResults=50",
                        "items",
                        1000,
                    )
                    .await?;
                let tracks = liked
                    .iter()
                    .filter_map(|v| {
                        let mut t = v.clone();
                        t["title"] = v["snippet"]["title"].clone();
                        t["channel"] = v["snippet"]["channelTitle"].clone();
                        collections::youtube_track(&t)
                    })
                    .collect();
                lists.push((make("likes", "YouTube · Curtidas".into(), tracks), true));
                for list in self
                    .pages(
                        id,
                        "playlists?part=snippet&mine=true&maxResults=50",
                        "items",
                        100,
                    )
                    .await?
                {
                    let pid = s(&list, "id");
                    if !db::valid_id(pid) {
                        continue;
                    }
                    let rows = self
                        .pages(
                            id,
                            &format!("playlistItems?part=snippet&playlistId={pid}&maxResults=50"),
                            "items",
                            1000,
                        )
                        .await?;
                    let tracks = rows
                        .iter()
                        .filter_map(|v| {
                            let mut t = v.clone();
                            t["id"] = v["snippet"]["resourceId"]["videoId"].clone();
                            collections::youtube_track(&t)
                        })
                        .collect();
                    lists.push((
                        make(pid, format!("YouTube · {}", s(&list["snippet"], "title")), tracks),
                        false,
                    ));
                }
            }
            _ => {
                let likes = self
                    .pages(
                        id,
                        "me/likes/tracks?limit=100&linked_partitioning=true",
                        "collection",
                        1000,
                    )
                    .await?;
                let tracks = likes
                    .iter()
                    .filter_map(|v| collections::soundcloud_track(v.get("track").unwrap_or(v)))
                    .collect();
                lists.push((make("likes", "SoundCloud · Curtidas".into(), tracks), true));
                for list in self
                    .pages(
                        id,
                        "me/playlists?limit=100&linked_partitioning=true&show_tracks=false",
                        "collection",
                        100,
                    )
                    .await?
                {
                    let pid = collections::soundcloud_id(&list, "playlists")
                        .ok_or("Playlist SoundCloud inválida.")?;
                    let rows = self
                        .pages(
                            id,
                            &format!(
                                "playlists/soundcloud:playlists:{pid}/tracks?limit=100&linked_partitioning=true"
                            ),
                            "collection",
                            1000,
                        )
                        .await?;
                    let tracks = rows.iter().filter_map(collections::soundcloud_track).collect();
                    lists.push((
                        make(&pid, format!("SoundCloud · {}", s(&list, "title")), tracks),
                        false,
                    ));
                }
            }
        }
        self.ensure_active(id)?;
        let mut vault = self.vault.lock().unwrap();
        if let Some(session) = vault.sessions.get_mut(id) {
            session.name = name;
            session.user_id = user;
        }
        self.save(&vault)?;
        Ok(lists)
    }

    pub fn synced(&self, id: &str) -> Result<()> {
        let mut v = self.vault.lock().unwrap();
        if let Some(s) = v.sessions.get_mut(id) {
            s.last_sync = now();
        }
        self.save(&v)
    }
}

fn resolve_hub_broker(secrets_mtx: &Mutex<Secrets>, override_url: Option<&str>) -> Result<String> {
    let stored = secrets_mtx.lock().unwrap().broker_url.clone();
    let env_default = std::env::var("LIQUID_HUB_BROKER_URL").unwrap_or_default();
    let candidate = override_url
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .or_else(|| {
            let s = stored.trim();
            if s.is_empty() { None } else { Some(s) }
        })
        .unwrap_or_else(|| env_default.trim());
    let validated = secrets::validate_broker_origin(candidate)?;
    if validated.is_empty() {
        return Err("Informe o endereço HTTPS do servidor Liquid Hub.".into());
    }
    Ok(validated)
}

fn parse_broker_error(body: &Value, fallback: &str) -> String {
    let msg = s(body, "error");
    if msg.is_empty() {
        fallback.into()
    } else {
        msg.chars().take(240).collect()
    }
}

fn apply_hub_user_profile(session: &mut HubVaultSession, user: &Value) {
    let Some(obj) = user.as_object() else {
        return;
    };
    if let Some(uid) = obj.get("userId").and_then(|v| v.as_str()).filter(|v| !v.is_empty()) {
        session.user_id = uid.to_string();
    }
    if let Some(subj) = obj.get("subject").and_then(|v| v.as_str()).filter(|v| !v.is_empty()) {
        session.subject = subj.to_string();
    }
    if let Some(uname) = obj.get("username").and_then(|v| v.as_str()).filter(|v| !v.is_empty()) {
        session.username = uname.to_string();
        if session.subject.is_empty() {
            session.subject = uname.to_string();
        }
    }
    if let Some(dname) = obj.get("displayName").and_then(|v| v.as_str()).filter(|v| !v.is_empty()) {
        session.display_name = dname.to_string();
    }
    if let Some(email_val) = obj.get("email") {
        session.email = email_val.as_str().map(|v| v.to_string());
    }
    if let Some(ver) = obj.get("emailVerified").and_then(|v| v.as_bool()) {
        session.email_verified = ver;
    }
    if let Some(avatar_val) = obj.get("avatarUrl") {
        session.avatar_url = avatar_val.as_str().map(|v| v.to_string());
    }
    if let Some(hp) = obj.get("hasPassword").and_then(|v| v.as_bool()) {
        session.has_password = hp;
    }
    if let Some(ids_val) = obj.get("identities") {
        if let Ok(ids) = serde_json::from_value::<Vec<HubIdentityPublic>>(ids_val.clone()) {
            session.identities = ids;
        }
    }
    if let Some(tv) = obj.get("termsVersion") {
        session.terms_version = tv.as_str().map(|v| v.to_string());
    }
    if let Some(pv) = obj.get("privacyVersion") {
        session.privacy_version = pv.as_str().map(|v| v.to_string());
    }
    if let Some(ta) = obj.get("termsAcceptedAt") {
        session.terms_accepted_at = ta.as_i64();
    }
    if let Some(needs) = obj.get("needsTermsAcceptance").and_then(|v| v.as_bool()) {
        session.needs_terms_acceptance = needs;
    }
}

async fn fetch_jwk_x(http: &reqwest::Client, broker: &str) -> Result<String> {
    let jwks_res = http
        .get(format!("{broker}/.well-known/jwks.json"))
        .send()
        .await
        .map_err(|_| "Não foi possível conectar ao servidor Liquid Hub.")?;
    if !jwks_res.status().is_success() {
        return Err("Servidor Liquid Hub não expôs chaves Ed25519 válidas.".into());
    }
    let jwks: Value = jwks_res.json().await.map_err(|_| "JWKS inválido.")?;
    jwks["keys"]
        .as_array()
        .and_then(|arr| arr.iter().find(|k| k["crv"] == "Ed25519" && k["alg"] == "EdDSA"))
        .and_then(|k| k["x"].as_str())
        .map(|s| s.to_string())
        .ok_or_else(|| "Chave pública Ed25519 ausente no servidor.".into())
}

async fn exchange_pkce_and_seal(
    secrets_mtx: &Mutex<Secrets>,
    secrets_path: &Path,
    broker: &str,
    code: &str,
    verifier: &str,
    redirect_uri: Option<&str>,
) -> Result<Value> {
    let http = crate::providers::client();
    let jwk_x = fetch_jwk_x(&http, broker).await?;
    let mut body = json!({
        "grant_type": "authorization_code",
        "code": code,
        "client_id": "liquid-hub-desktop",
        "code_verifier": verifier
    });
    if let Some(redir) = redirect_uri {
        body["redirect_uri"] = json!(redir);
    }
    let token_res = http
        .post(format!("{broker}/v1/auth/token"))
        .json(&body)
        .send()
        .await
        .map_err(|_| "Falha na troca PKCE de tokens.")?;
    let token_status = token_res.status();
    let tokens: Value = token_res.json().await.unwrap_or(Value::Null);
    if !token_status.is_success() {
        return Err(parse_broker_error(
            &tokens,
            "Falha ao validar prova PKCE S256.",
        ));
    }
    let access_token = s(&tokens, "access_token");
    let refresh_token = s(&tokens, "refresh_token");
    if access_token.is_empty() || refresh_token.len() < 32 {
        return Err("Tokens inválidos retornados pelo servidor.".into());
    }
    let now_ms = now();
    let claims = secrets::verify_ed25519_jwt(access_token, &jwk_x, now_ms)?;
    let expires_at = claims["exp"].as_i64().unwrap_or(0) * 1000;
    let family_id = s(&claims, "fam").to_string();

    let mut session = HubVaultSession {
        subject: s(&tokens, "subject").to_string(),
        access_token: access_token.to_string(),
        refresh_token: refresh_token.to_string(),
        family_id,
        expires_at,
        jwk_x,
        ..Default::default()
    };
    if let Some(user_obj) = tokens.get("user") {
        apply_hub_user_profile(&mut session, user_obj);
    }

    let mut guard = secrets_mtx.lock().unwrap();
    guard.broker_url = broker.to_string();
    guard.hub_session = Some(session);
    guard.save(secrets_path)?;
    Ok(guard.public_hub_status(now_ms))
}

async fn ensure_fresh_hub_token(
    secrets_mtx: &Mutex<Secrets>,
    secrets_path: &Path,
    broker_override: Option<&str>,
) -> Result<(String, String)> {
    ensure_fresh_hub_token_with_force(secrets_mtx, secrets_path, broker_override, false).await
}

async fn ensure_fresh_hub_token_with_force(
    secrets_mtx: &Mutex<Secrets>,
    secrets_path: &Path,
    broker_override: Option<&str>,
    force_refresh: bool,
) -> Result<(String, String)> {
    let broker = resolve_hub_broker(secrets_mtx, broker_override)?;
    let (access_token, refresh_token, expires_at) = {
        let guard = secrets_mtx.lock().unwrap();
        let Some(sess) = &guard.hub_session else {
            return Err("Autenticação Liquid Hub necessária.".into());
        };
        if sess.refresh_token.is_empty() {
            return Err("Autenticação Liquid Hub necessária.".into());
        }
        (
            sess.access_token.clone(),
            sess.refresh_token.clone(),
            sess.expires_at,
        )
    };

    let now_ms = now();
    if !force_refresh && !access_token.is_empty() && expires_at > now_ms + 60_000 {
        return Ok((broker, access_token));
    }

    let http = crate::providers::client();
    let jwk_x = fetch_jwk_x(&http, &broker).await?;
    let res = http
        .post(format!("{broker}/v1/auth/token"))
        .json(&json!({
            "grant_type": "refresh_token",
            "refresh_token": refresh_token,
            "client_id": "liquid-hub-desktop"
        }))
        .send()
        .await
        .map_err(|_| "Não foi possível renovar a sessão no servidor Liquid Hub.")?;
    let status = res.status();
    let tokens: Value = res.json().await.unwrap_or(Value::Null);
    if status == reqwest::StatusCode::UNAUTHORIZED {
        let mut guard = secrets_mtx.lock().unwrap();
        guard.clear_hub_session();
        let _ = guard.save(secrets_path);
        return Err("Sua sessão expirou ou foi revogada. Entre novamente.".into());
    }
    if !status.is_success() {
        return Err(parse_broker_error(
            &tokens,
            "Falha ao renovar a sessão do Liquid Hub.",
        ));
    }
    let new_access = s(&tokens, "access_token");
    let new_refresh = s(&tokens, "refresh_token");
    if new_access.is_empty() || new_refresh.len() < 32 {
        return Err("Tokens inválidos na renovação da sessão.".into());
    }
    let verify_now = now();
    let claims = secrets::verify_ed25519_jwt(new_access, &jwk_x, verify_now)?;
    let new_exp = claims["exp"].as_i64().unwrap_or(0) * 1000;
    let new_fam = s(&claims, "fam").to_string();

    let mut guard = secrets_mtx.lock().unwrap();
    let mut updated = guard.hub_session.clone().unwrap_or_default();
    updated.subject = s(&tokens, "subject").to_string();
    updated.access_token = new_access.to_string();
    updated.refresh_token = new_refresh.to_string();
    updated.family_id = new_fam;
    updated.expires_at = new_exp;
    updated.jwk_x = jwk_x;
    if let Some(user_obj) = tokens.get("user") {
        apply_hub_user_profile(&mut updated, user_obj);
    }
    guard.broker_url = broker.clone();
    guard.hub_session = Some(updated);
    guard.save(secrets_path)?;
    Ok((broker, new_access.to_string()))
}

pub async fn hub_providers(secrets_mtx: &Mutex<Secrets>, broker_override: Option<&str>) -> Result<Value> {
    let broker = resolve_hub_broker(secrets_mtx, broker_override)?;
    let res = crate::providers::client()
        .get(format!("{broker}/v1/auth/providers"))
        .send()
        .await
        .map_err(|_| "Não foi possível consultar os métodos de login no servidor Liquid Hub.")?;
    let status = res.status();
    let body: Value = res.json().await.unwrap_or(Value::Null);
    if !status.is_success() {
        return Err(parse_broker_error(
            &body,
            "Servidor Liquid Hub não retornou provedores.",
        ));
    }
    Ok(body)
}

/// Zero-Trust Desktop Login against the Liquid Hub Broker:
/// 1. Validates broker HTTPS/loopback URL
/// 2. Generates high-entropy PKCE (S256) verifier + challenge
/// 3. Authenticates credentials (Argon2id on server) to obtain single-use code
/// 4. Fetches server Ed25519 public JWK and exchanges code + PKCE verifier for 15-min EdDSA JWT + Refresh Token
/// 5. Cryptographically verifies Ed25519 signature and persists exclusively in Windows DPAPI vault
pub async fn hub_login(
    secrets_mtx: &Mutex<Secrets>,
    secrets_path: &Path,
    payload: &Value,
) -> Result<Value> {
    let obj = payload.as_object().ok_or("Solicitação inválida.")?;
    for k in obj.keys() {
        if ![
            "brokerUrl",
            "username",
            "email",
            "identifier",
            "displayName",
            "password",
            "register",
            "termsVersion",
            "privacyVersion",
        ]
        .contains(&k.as_str())
        {
            return Err("Campo de login não permitido.".into());
        }
    }
    let broker = resolve_hub_broker(secrets_mtx, Some(s(payload, "brokerUrl")))?;
    let username = s(payload, "username").trim();
    let email = s(payload, "email").trim();
    let identifier = s(payload, "identifier").trim();
    let display_name = s(payload, "displayName").trim();
    let password = s(payload, "password");
    let login_key = if !identifier.is_empty() {
        identifier
    } else if !email.is_empty() {
        email
    } else {
        username
    };
    if login_key.len() < 3 || login_key.len() > 160 || password.len() < 12 || password.len() > 256
    {
        return Err(
            "Informe seu e-mail ou usuário e uma senha forte (mínimo 12 caracteres).".into(),
        );
    }
    let register = payload["register"] == true;
    let client_id = "liquid-hub-desktop";
    let (verifier, challenge) = generate_pkce_pair()?;
    let http = crate::providers::client();

    let auth_endpoint = if register {
        format!("{broker}/v1/auth/register")
    } else {
        format!("{broker}/v1/auth/login")
    };
    let mut auth_json = json!({
        "password": password,
        "client_id": client_id,
        "code_challenge": challenge,
        "code_challenge_method": "S256"
    });
    if !username.is_empty() {
        auth_json["username"] = json!(username);
    }
    if !email.is_empty() {
        auth_json["email"] = json!(email);
    }
    if !register && !identifier.is_empty() {
        auth_json["identifier"] = json!(identifier);
    }
    if !display_name.is_empty() {
        auth_json["displayName"] = json!(display_name);
    }
    let tv = s(payload, "termsVersion").trim();
    let pv = s(payload, "privacyVersion").trim();
    if !tv.is_empty() && !pv.is_empty() {
        auth_json["termsVersion"] = json!(tv);
        auth_json["privacyVersion"] = json!(pv);
    }

    let auth_res = http
        .post(auth_endpoint)
        .json(&auth_json)
        .send()
        .await
        .map_err(|_| "Falha ao autenticar com o servidor.")?;
    let auth_status = auth_res.status();
    let auth_body: Value = auth_res.json().await.unwrap_or(Value::Null);
    if !auth_status.is_success() {
        return Err(parse_broker_error(
            &auth_body,
            "Credenciais recusadas pelo servidor.",
        ));
    }
    let code = auth_body["code"]
        .as_str()
        .filter(|c| c.len() >= 24 && c.len() <= 256)
        .ok_or("Código PKCE ausente na resposta.")?;

    exchange_pkce_and_seal(secrets_mtx, secrets_path, &broker, code, &verifier, None).await
}

fn hub_callback_code(raw: &str, expected_state: &str) -> Result<String> {
    let u = url::Url::parse(&format!("http://127.0.0.1{raw}")).map_err(|_| "Retorno inválido.")?;
    if u.path() != "/callback" || raw.len() > 8192 {
        return Err("Retorno inválido.".into());
    }
    let pairs: Vec<_> = u.query_pairs().into_owned().collect();
    let params: HashMap<_, _> = pairs.iter().cloned().collect();
    if params.len() != pairs.len() {
        return Err("Retorno ambíguo.".into());
    }
    if params.get("state").map(String::as_str) != Some(expected_state) {
        return Err("A autorização não corresponde à solicitação.".into());
    }
    if let Some(err) = params.get("error") {
        let mapped = match err.as_str() {
            "access_denied" => "Autorização cancelada no provedor.".to_string(),
            "identity_already_linked" => {
                "Esta conta externa já está vinculada a outro usuário do Liquid Hub.".to_string()
            }
            "account_exists_link_required" => {
                "Já existe uma conta com este e-mail. Entre nela primeiro para vincular este provedor."
                    .to_string()
            }
            "provider_already_linked" => {
                "Você já possui outra conta deste provedor vinculada.".to_string()
            }
            _ => params
                .get("error_description")
                .map(|d| d.trim().chars().take(220).collect::<String>())
                .filter(|d| !d.is_empty())
                .unwrap_or_else(|| "Autenticação externa recusada.".to_string()),
        };
        return Err(mapped);
    }
    params
        .get("code")
        .filter(|s| s.len() >= 24 && s.len() <= 256)
        .cloned()
        .ok_or("Código de autorização ausente.".into())
}

pub async fn hub_oauth_flow(
    app: &tauri::AppHandle,
    secrets_mtx: &Mutex<Secrets>,
    secrets_path: &Path,
    gate: &tokio::sync::Mutex<()>,
    cancel: &Arc<AtomicBool>,
    payload: &Value,
) -> Result<Value> {
    let obj = payload.as_object().ok_or("Solicitação OAuth inválida.")?;
    for k in obj.keys() {
        if !["brokerUrl", "provider", "mode", "termsVersion", "privacyVersion"]
            .contains(&k.as_str())
        {
            return Err("Campo OAuth não permitido.".into());
        }
    }
    let provider = s(payload, "provider").trim().to_string();
    if provider != "discord" && provider != "github" {
        return Err("Provedor OAuth não suportado.".into());
    }
    let mode_raw = s(payload, "mode").trim();
    let mode = if mode_raw.is_empty() { "login" } else { mode_raw };
    if mode != "login" && mode != "link" {
        return Err("Modo OAuth inválido.".into());
    }

    let _guard = gate
        .try_lock()
        .map_err(|_| "Já existe uma autenticação externa em andamento.")?;
    cancel.store(false, Ordering::Release);

    let (broker, bearer) = if mode == "link" {
        let (b, tok) = ensure_fresh_hub_token(
            secrets_mtx,
            secrets_path,
            Some(s(payload, "brokerUrl")),
        )
        .await?;
        (b, Some(tok))
    } else {
        let b = resolve_hub_broker(secrets_mtx, Some(s(payload, "brokerUrl")))?;
        (b, None)
    };

    let server = tiny_http::Server::http("127.0.0.1:0")
        .map_err(|_| "Não foi possível abrir o listener local para autenticação OAuth.")?;
    let port = server
        .server_addr()
        .to_ip()
        .ok_or("Endereço local OAuth indisponível.")?
        .port();
    let expected_host = format!("127.0.0.1:{port}");
    let redirect_uri = format!("http://{expected_host}/callback");
    let state = generate_oauth_state()?;
    let (verifier, challenge) = generate_pkce_pair()?;

    let mut start_body = json!({
        "provider": provider,
        "client_id": "liquid-hub-desktop",
        "redirect_uri": redirect_uri,
        "code_challenge": challenge,
        "code_challenge_method": "S256",
        "state": state,
        "mode": mode
    });
    let tv = s(payload, "termsVersion").trim();
    let pv = s(payload, "privacyVersion").trim();
    if !tv.is_empty() && !pv.is_empty() {
        start_body["termsVersion"] = json!(tv);
        start_body["privacyVersion"] = json!(pv);
    }

    let http = crate::providers::client();
    let mut start_req = http
        .post(format!("{broker}/v1/auth/oauth/{provider}/start"))
        .json(&start_body);
    if let Some(tok) = bearer {
        start_req = start_req.header("Authorization", format!("Bearer {tok}"));
    }
    let start_res = start_req
        .send()
        .await
        .map_err(|_| "Não foi possível iniciar o fluxo OAuth no servidor Liquid Hub.")?;
    let start_status = start_res.status();
    let start_json: Value = start_res.json().await.unwrap_or(Value::Null);
    if !start_status.is_success() {
        return Err(parse_broker_error(
            &start_json,
            "Provedor OAuth indisponível no servidor.",
        ));
    }
    let authorize_url = s(&start_json, "authorizeUrl").to_string();
    let parsed_auth_url =
        url::Url::parse(&authorize_url).map_err(|_| "URL de autorização inválida.")?;
    let host_ok = match (parsed_auth_url.scheme(), parsed_auth_url.host_str()) {
        ("https", Some(_)) => true,
        ("http", Some("127.0.0.1")) | ("http", Some("localhost")) => true,
        _ => false,
    };
    if !host_ok {
        return Err("URL de autorização do provedor não permitida.".into());
    }

    let mut launched_autofollow = false;
    #[cfg(debug_assertions)]
    {
        if std::env::var("LIQUID_HUB_TEST_OAUTH_AUTOFOLLOW").as_deref() == Ok("1")
            && matches!(
                parsed_auth_url.host_str(),
                Some("127.0.0.1") | Some("localhost")
            )
        {
            launched_autofollow = true;
            let follow_url = authorize_url.clone();
            tokio::spawn(async move {
                let policy = reqwest::redirect::Policy::custom(|attempt| {
                    if attempt.previous().len() >= 6 {
                        return attempt.stop();
                    }
                    let is_loopback = matches!(
                        attempt.url().host_str(),
                        Some("127.0.0.1") | Some("localhost")
                    ) && attempt.url().scheme() == "http";
                    if is_loopback {
                        attempt.follow()
                    } else {
                        attempt.stop()
                    }
                });
                if let Ok(test_client) = reqwest::Client::builder()
                    .connect_timeout(Duration::from_secs(5))
                    .timeout(Duration::from_secs(12))
                    .redirect(policy)
                    .build()
                {
                    let _ = test_client.get(follow_url).send().await;
                }
            });
        }
    }
    if !launched_autofollow {
        use tauri_plugin_opener::OpenerExt;
        app.opener()
            .open_url(&authorize_url, None::<&str>)
            .map_err(|_| "Não foi possível abrir o navegador para autorização.")?;
    }

    let cancel_flag = Arc::clone(cancel);
    let expected_state = state.clone();
    let code = tokio::task::spawn_blocking(move || -> Result<String> {
        let deadline = std::time::Instant::now() + Duration::from_secs(300);
        loop {
            if cancel_flag.load(Ordering::Acquire) {
                return Err("Autenticação cancelada.".into());
            }
            if std::time::Instant::now() > deadline {
                return Err("Tempo limite de autenticação excedido. Tente novamente.".into());
            }
            if let Some(req) = server
                .recv_timeout(Duration::from_millis(80))
                .map_err(|_| "Falha ao receber retorno OAuth.")?
            {
                let host_header = req
                    .headers()
                    .iter()
                    .find(|h| h.field.equiv("Host"))
                    .map(|h| h.value.as_str())
                    .unwrap_or("");
                if req.method() != &tiny_http::Method::Get || host_header != expected_host {
                    let _ = req.respond(tiny_http::Response::empty(400));
                    continue;
                }
                if !req.url().starts_with("/callback?") {
                    let _ = req.respond(tiny_http::Response::empty(404));
                    continue;
                }
                let result = hub_callback_code(req.url(), &expected_state);
                let ok = result.is_ok();
                let html = match &result {
                    Ok(_) => "<!doctype html><html lang='pt-BR'><meta charset='utf-8'><title>Liquid Hub</title><body style='font-family:system-ui;background:#101216;color:#f3f5f8;display:grid;place-items:center;height:100vh;margin:0'><p>Autenticação concluída. Você pode fechar esta aba e voltar para o Liquid Hub.</p></body></html>".to_string(),
                    Err(msg) => format!("<!doctype html><html lang='pt-BR'><meta charset='utf-8'><title>Liquid Hub</title><body style='font-family:system-ui;background:#101216;color:#f3f5f8;display:grid;place-items:center;height:100vh;margin:0'><p>{}</p></body></html>", msg.replace('<', "&lt;")),
                };
                let mut resp = tiny_http::Response::from_string(html)
                    .with_status_code(if ok { 200 } else { 400 });
                if let Ok(h) = tiny_http::Header::from_bytes("Content-Type", "text/html; charset=utf-8") {
                    resp.add_header(h);
                }
                if let Ok(h) = tiny_http::Header::from_bytes("Cache-Control", "no-store") {
                    resp.add_header(h);
                }
                let _ = req.respond(resp);
                return result;
            }
        }
    })
    .await
    .map_err(|_| "Falha interna ao aguardar o retorno OAuth.")??;

    exchange_pkce_and_seal(
        secrets_mtx,
        secrets_path,
        &broker,
        &code,
        &verifier,
        Some(&redirect_uri),
    )
    .await
}

pub async fn hub_refresh(
    secrets_mtx: &Mutex<Secrets>,
    secrets_path: &Path,
    broker_override: Option<&str>,
) -> Result<Value> {
    let has_session = secrets_mtx
        .lock()
        .unwrap()
        .hub_session
        .as_ref()
        .is_some_and(|s| !s.refresh_token.is_empty());
    if !has_session {
        return Ok(secrets_mtx.lock().unwrap().public_hub_status(now()));
    }

    let (mut broker, mut token) =
        match ensure_fresh_hub_token(secrets_mtx, secrets_path, broker_override).await {
            Ok(pair) => pair,
            Err(err) => {
                if err.contains("expirou") || err.contains("revogada") {
                    return Ok(secrets_mtx.lock().unwrap().public_hub_status(now()));
                }
                return Err(err);
            }
        };

    let http = crate::providers::client();
    let mut res = http
        .get(format!("{broker}/v1/auth/me"))
        .header("Authorization", format!("Bearer {token}"))
        .send()
        .await
        .map_err(|_| "Sem conexão com o servidor Liquid Hub.")?;
    if res.status() == reqwest::StatusCode::UNAUTHORIZED {
        // Retry once forcing refresh_token rotation in case signing key rolled over cleanly.
        match ensure_fresh_hub_token_with_force(secrets_mtx, secrets_path, broker_override, true)
            .await
        {
            Ok((next_broker, next_tok)) => {
                broker = next_broker;
                token = next_tok;
                res = http
                    .get(format!("{broker}/v1/auth/me"))
                    .header("Authorization", format!("Bearer {token}"))
                    .send()
                    .await
                    .map_err(|_| "Sem conexão com o servidor Liquid Hub.")?;
            }
            Err(err) => {
                if err.contains("expirou") || err.contains("revogada") {
                    return Ok(secrets_mtx.lock().unwrap().public_hub_status(now()));
                }
                return Err(err);
            }
        }
    }
    let status = res.status();
    if status == reqwest::StatusCode::UNAUTHORIZED {
        let mut guard = secrets_mtx.lock().unwrap();
        guard.clear_hub_session();
        let _ = guard.save(secrets_path);
        return Ok(guard.public_hub_status(now()));
    }
    if status.is_success() {
        let user: Value = res.json().await.unwrap_or(Value::Null);
        let mut guard = secrets_mtx.lock().unwrap();
        if let Some(sess) = guard.hub_session.as_mut() {
            apply_hub_user_profile(sess, &user);
        }
        guard.save(secrets_path)?;
        return Ok(guard.public_hub_status(now()));
    }
    Ok(secrets_mtx.lock().unwrap().public_hub_status(now()))
}

pub async fn hub_accept_terms(
    secrets_mtx: &Mutex<Secrets>,
    secrets_path: &Path,
    payload: &Value,
) -> Result<Value> {
    let obj = payload.as_object().ok_or("Solicitação inválida.")?;
    for k in obj.keys() {
        if !["brokerUrl", "termsVersion", "privacyVersion"].contains(&k.as_str()) {
            return Err("Campo inválido.".into());
        }
    }
    let tv = s(payload, "termsVersion").trim().to_string();
    let pv = s(payload, "privacyVersion").trim().to_string();
    if tv.is_empty() || pv.is_empty() {
        return Err("Versão de termos obrigatória.".into());
    }
    let (broker, token) =
        ensure_fresh_hub_token(secrets_mtx, secrets_path, Some(s(payload, "brokerUrl"))).await?;
    let res = crate::providers::client()
        .post(format!("{broker}/v1/auth/terms/accept"))
        .header("Authorization", format!("Bearer {token}"))
        .json(&json!({ "termsVersion": tv, "privacyVersion": pv }))
        .send()
        .await
        .map_err(|_| "Falha ao registrar aceitação dos termos.")?;
    let status = res.status();
    let body: Value = res.json().await.unwrap_or(Value::Null);
    if !status.is_success() {
        return Err(parse_broker_error(
            &body,
            "Não foi possível confirmar os Termos e Privacidade.",
        ));
    }
    let mut guard = secrets_mtx.lock().unwrap();
    if let Some(sess) = guard.hub_session.as_mut() {
        apply_hub_user_profile(sess, &body);
    }
    guard.save(secrets_path)?;
    Ok(guard.public_hub_status(now()))
}

pub async fn hub_link_email(
    secrets_mtx: &Mutex<Secrets>,
    secrets_path: &Path,
    payload: &Value,
) -> Result<Value> {
    let obj = payload.as_object().ok_or("Solicitação inválida.")?;
    for k in obj.keys() {
        if !["brokerUrl", "email", "password", "username", "displayName"].contains(&k.as_str()) {
            return Err("Campo inválido.".into());
        }
    }
    let email = s(payload, "email").trim().to_string();
    let password = s(payload, "password");
    if email.is_empty() || password.len() < 12 {
        return Err("E-mail válido e senha com mínimo 12 caracteres são obrigatórios.".into());
    }
    let (broker, token) =
        ensure_fresh_hub_token(secrets_mtx, secrets_path, Some(s(payload, "brokerUrl"))).await?;
    let mut body = json!({ "email": email, "password": password });
    let uname = s(payload, "username").trim();
    let dname = s(payload, "displayName").trim();
    if !uname.is_empty() {
        body["username"] = json!(uname);
    }
    if !dname.is_empty() {
        body["displayName"] = json!(dname);
    }
    let res = crate::providers::client()
        .post(format!("{broker}/v1/auth/identities/email"))
        .header("Authorization", format!("Bearer {token}"))
        .json(&body)
        .send()
        .await
        .map_err(|_| "Falha ao vincular e-mail à conta.")?;
    let status = res.status();
    let resp_body: Value = res.json().await.unwrap_or(Value::Null);
    if !status.is_success() {
        return Err(parse_broker_error(
            &resp_body,
            "Não foi possível vincular o e-mail.",
        ));
    }
    let mut guard = secrets_mtx.lock().unwrap();
    if let Some(sess) = guard.hub_session.as_mut() {
        apply_hub_user_profile(sess, &resp_body);
    }
    guard.save(secrets_path)?;
    Ok(guard.public_hub_status(now()))
}

pub async fn hub_unlink_identity(
    secrets_mtx: &Mutex<Secrets>,
    secrets_path: &Path,
    payload: &Value,
) -> Result<Value> {
    let obj = payload.as_object().ok_or("Solicitação inválida.")?;
    for k in obj.keys() {
        if !["brokerUrl", "provider"].contains(&k.as_str()) {
            return Err("Campo inválido.".into());
        }
    }
    let provider = s(payload, "provider").trim();
    if !["email", "discord", "github"].contains(&provider) {
        return Err("Provedor inválido.".into());
    }
    let (broker, token) =
        ensure_fresh_hub_token(secrets_mtx, secrets_path, Some(s(payload, "brokerUrl"))).await?;
    let res = crate::providers::client()
        .delete(format!("{broker}/v1/auth/identities/{provider}"))
        .header("Authorization", format!("Bearer {token}"))
        .send()
        .await
        .map_err(|_| "Falha ao desvincular provedor.")?;
    let status = res.status();
    let resp_body: Value = res.json().await.unwrap_or(Value::Null);
    if !status.is_success() {
        return Err(parse_broker_error(
            &resp_body,
            "Não foi possível desvincular o provedor.",
        ));
    }
    let mut guard = secrets_mtx.lock().unwrap();
    if let Some(sess) = guard.hub_session.as_mut() {
        apply_hub_user_profile(sess, &resp_body);
    }
    guard.save(secrets_path)?;
    Ok(guard.public_hub_status(now()))
}

pub async fn hub_verify_email(
    secrets_mtx: &Mutex<Secrets>,
    secrets_path: &Path,
    payload: &Value,
) -> Result<Value> {
    let obj = payload.as_object().ok_or("Solicitação inválida.")?;
    for k in obj.keys() {
        if !["brokerUrl", "token"].contains(&k.as_str()) {
            return Err("Campo inválido.".into());
        }
    }
    let broker = resolve_hub_broker(secrets_mtx, Some(s(payload, "brokerUrl")))?;
    let token = s(payload, "token").trim().to_string();
    if token.len() < 16 {
        return Err("Código de verificação inválido.".into());
    }
    let res = crate::providers::client()
        .post(format!("{broker}/v1/auth/email/verify"))
        .json(&json!({ "token": token }))
        .send()
        .await
        .map_err(|_| "Falha ao verificar e-mail no servidor.")?;
    let status = res.status();
    let body: Value = res.json().await.unwrap_or(Value::Null);
    if !status.is_success() {
        return Err(parse_broker_error(
            &body,
            "Token de verificação expirado ou inválido.",
        ));
    }
    let mut guard = secrets_mtx.lock().unwrap();
    if let (Some(sess), Some(user_obj)) = (guard.hub_session.as_mut(), body.get("user")) {
        let target_uid = s(user_obj, "userId");
        if !target_uid.is_empty() && (sess.user_id == target_uid || sess.user_id.is_empty()) {
            apply_hub_user_profile(sess, user_obj);
            guard.save(secrets_path)?;
        }
    }
    Ok(json!({
        "ok": true,
        "status": guard.public_hub_status(now())
    }))
}

pub async fn hub_resend_verification(
    secrets_mtx: &Mutex<Secrets>,
    secrets_path: &Path,
    payload: &Value,
) -> Result<Value> {
    let obj = payload.as_object().ok_or("Solicitação inválida.")?;
    for k in obj.keys() {
        if !["brokerUrl", "email"].contains(&k.as_str()) {
            return Err("Campo inválido.".into());
        }
    }
    let email = s(payload, "email").trim().to_string();
    let has_sess = secrets_mtx
        .lock()
        .unwrap()
        .hub_session
        .as_ref()
        .is_some_and(|s| !s.refresh_token.is_empty());
    let (broker, bearer) = if has_sess && email.is_empty() {
        let (b, t) =
            ensure_fresh_hub_token(secrets_mtx, secrets_path, Some(s(payload, "brokerUrl"))).await?;
        (b, Some(t))
    } else {
        (resolve_hub_broker(secrets_mtx, Some(s(payload, "brokerUrl")))?, None)
    };
    let mut body = json!({});
    if !email.is_empty() {
        body["email"] = json!(email);
    }
    let mut req = crate::providers::client()
        .post(format!("{broker}/v1/auth/email/resend"))
        .json(&body);
    if let Some(tok) = bearer {
        req = req.header("Authorization", format!("Bearer {tok}"));
    }
    let res = req
        .send()
        .await
        .map_err(|_| "Falha ao reenviar verificação.")?;
    let status = res.status();
    let resp_body: Value = res.json().await.unwrap_or(Value::Null);
    if !status.is_success() {
        return Err(parse_broker_error(
            &resp_body,
            "Não foi possível reenviar o e-mail de verificação.",
        ));
    }
    Ok(resp_body)
}

pub async fn hub_forgot_password(secrets_mtx: &Mutex<Secrets>, payload: &Value) -> Result<Value> {
    let obj = payload.as_object().ok_or("Solicitação inválida.")?;
    for k in obj.keys() {
        if !["brokerUrl", "email"].contains(&k.as_str()) {
            return Err("Campo inválido.".into());
        }
    }
    let broker = resolve_hub_broker(secrets_mtx, Some(s(payload, "brokerUrl")))?;
    let email = s(payload, "email").trim().to_string();
    if email.is_empty() {
        return Err("Informe um e-mail válido.".into());
    }
    let res = crate::providers::client()
        .post(format!("{broker}/v1/auth/password/forgot"))
        .json(&json!({ "email": email }))
        .send()
        .await
        .map_err(|_| "Falha ao solicitar recuperação de senha.")?;
    let status = res.status();
    let resp_body: Value = res.json().await.unwrap_or(Value::Null);
    if !status.is_success() {
        return Err(parse_broker_error(
            &resp_body,
            "Não foi possível iniciar a recuperação de senha.",
        ));
    }
    Ok(resp_body)
}

pub async fn hub_reset_password(secrets_mtx: &Mutex<Secrets>, payload: &Value) -> Result<Value> {
    let obj = payload.as_object().ok_or("Solicitação inválida.")?;
    for k in obj.keys() {
        if !["brokerUrl", "token", "newPassword"].contains(&k.as_str()) {
            return Err("Campo inválido.".into());
        }
    }
    let broker = resolve_hub_broker(secrets_mtx, Some(s(payload, "brokerUrl")))?;
    let token = s(payload, "token").trim().to_string();
    let new_password = s(payload, "newPassword");
    if token.len() < 16 || new_password.len() < 12 {
        return Err("Código válido e senha forte (mínimo 12 caracteres) são obrigatórios.".into());
    }
    let res = crate::providers::client()
        .post(format!("{broker}/v1/auth/password/reset"))
        .json(&json!({ "token": token, "newPassword": new_password }))
        .send()
        .await
        .map_err(|_| "Falha ao redefinir a senha.")?;
    let status = res.status();
    let resp_body: Value = res.json().await.unwrap_or(Value::Null);
    if !status.is_success() {
        return Err(parse_broker_error(
            &resp_body,
            "Token inválido ou expirado.",
        ));
    }
    Ok(resp_body)
}

pub async fn hub_logout(secrets_mtx: &Mutex<Secrets>, secrets_path: &Path) -> Result<Value> {
    let (broker, token) = {
        let guard = secrets_mtx.lock().unwrap();
        let tok = guard
            .hub_session
            .as_ref()
            .map(|s| s.access_token.clone())
            .unwrap_or_default();
        (guard.broker_url.clone(), tok)
    };
    if !broker.is_empty() && !token.is_empty() {
        let _ = crate::providers::client()
            .post(format!("{broker}/v1/auth/logout"))
            .header("Authorization", format!("Bearer {token}"))
            .send()
            .await;
    }
    let mut guard = secrets_mtx.lock().unwrap();
    guard.clear_hub_session();
    guard.save(secrets_path)?;
    Ok(guard.public_hub_status(now()))
}

fn callback_code(raw: &str, state: &str) -> Result<String> {
    let u = url::Url::parse(&format!("http://127.0.0.1:43871{raw}")).map_err(|_| "Retorno inválido.")?;
    if u.path() != "/callback" || raw.len() > 8192 {
        return Err("Retorno inválido.".into());
    }
    let pairs: Vec<_> = u.query_pairs().into_owned().collect();
    let params: HashMap<_, _> = pairs.iter().cloned().collect();
    if params.len() != pairs.len() {
        return Err("Retorno ambíguo.".into());
    }
    if params.get("state").map(String::as_str) != Some(state) {
        return Err("A autorização não corresponde à solicitação.".into());
    }
    if params.contains_key("error") {
        return Err("Autorização recusada pela conta.".into());
    }
    params
        .get("code")
        .filter(|s| !s.is_empty() && s.len() < 4096)
        .cloned()
        .ok_or("Código de autorização ausente.".into())
}

fn token_session(data: Value, old: Option<Session>) -> Result<Session> {
    let mut next = old.unwrap_or_default();
    next.access = data["access_token"]
        .as_str()
        .filter(|s| !s.is_empty() && s.len() < 16000)
        .ok_or("A plataforma não retornou uma autorização válida.")?
        .to_string();
    if let Some(refresh) = data["refresh_token"].as_str() {
        if refresh.is_empty() || refresh.len() > 16000 {
            return Err("Renovação inválida.".into());
        }
        next.refresh = refresh.to_string();
    }
    next.expires = now() + data["expires_in"].as_i64().unwrap_or(3600).clamp(60, 86400) * 1000;
    Ok(next)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn callback_requires_state_and_code() {
        assert_eq!(callback_code("/callback?state=ok&code=abc", "ok").unwrap(), "abc");
        for raw in [
            "/callback?state=wrong&code=abc",
            "/callback?state=ok&error=access_denied",
            "/other?state=ok&code=abc",
            "/callback?state=bad&state=ok&code=abc",
        ] {
            assert!(callback_code(raw, "ok").is_err());
        }
    }

    #[test]
    fn pkce_pair_meets_rfc7636_s256_requirements() {
        let (verifier, challenge) = generate_pkce_pair().unwrap();
        assert!(verifier.len() >= 43 && verifier.len() <= 128);
        assert_eq!(
            challenge,
            URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()))
        );
    }

    #[test]
    fn refresh_rotation_preserves_only_when_omitted() {
        let old = Session {
            refresh: "old".into(),
            ..Default::default()
        };
        let new = token_session(
            json!({"access_token":"a","refresh_token":"new","expires_in":3600}),
            Some(old),
        )
        .unwrap();
        assert_eq!(new.refresh, "new");
        let preserved = token_session(json!({"access_token":"b"}), Some(new)).unwrap();
        assert_eq!(preserved.refresh, "new");
    }
    #[test]
    fn hub_callback_handles_oauth_codes_and_errors() {
        let valid_code = "abcdefghijklmnopqrstuvwxyz123456";
        assert_eq!(
            hub_callback_code(&format!("/callback?state=st1&code={valid_code}"), "st1").unwrap(),
            valid_code
        );
        assert!(hub_callback_code("/callback?state=st1&error=access_denied", "st1")
            .unwrap_err()
            .contains("cancelada"));
        assert!(
            hub_callback_code("/callback?state=st1&error=identity_already_linked", "st1")
                .unwrap_err()
                .contains("outro usuário")
        );
        assert!(
            hub_callback_code("/callback?state=st1&error=account_exists_link_required", "st1")
                .unwrap_err()
                .contains("Já existe uma conta")
        );
        assert!(hub_callback_code(&format!("/callback?state=wrong&code={valid_code}"), "st1").is_err());
    }
}

#[cfg(test)]
mod storage_tests {
    use super::*;
    #[test]
    fn account_tokens_are_encrypted_and_status_does_not_expose_them() {
        let dir = std::env::temp_dir().join(format!("liquid-account-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&dir).unwrap();
        let accounts = Accounts::load(&dir).unwrap();
        accounts
            .configure(json!({"spotify":{"clientId":"test-app-id"}}))
            .unwrap();
        {
            let mut v = accounts.vault.lock().unwrap();
            v.sessions.insert(
                "spotify".into(),
                Session {
                    access: "secret-access-fixture-190".into(),
                    refresh: "secret-refresh-fixture-190".into(),
                    ..Default::default()
                },
            );
            accounts.save(&v).unwrap();
        }
        let raw = std::fs::read(dir.join("accounts.dpapi")).unwrap();
        assert!(!String::from_utf8_lossy(&raw).contains("secret-access-fixture-190"));
        let restored = Accounts::load(&dir).unwrap();
        let status = restored.status();
        assert!(status
            .as_array()
            .unwrap()
            .iter()
            .any(|v| v["provider"] == "spotify" && v["connected"] == true));
        assert!(!status.to_string().contains("secret-"));
        restored.disconnect("spotify").unwrap();
        assert!(Accounts::load(&dir)
            .unwrap()
            .status()
            .as_array()
            .unwrap()
            .iter()
            .all(|v| v["connected"] == false));
        std::fs::remove_file(dir.join("accounts.dpapi")).unwrap();
        std::fs::remove_dir(dir).unwrap();
    }
}
