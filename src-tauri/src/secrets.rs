use crate::db::Result;
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use ring::signature::{UnparsedPublicKey, ED25519};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{fs, path::Path};
use windows_sys::Win32::{
    Foundation::LocalFree,
    Security::Cryptography::{
        CryptProtectData, CryptUnprotectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
    },
};

#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct HubIdentityPublic {
    pub provider: String,
    pub provider_subject: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub username: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub display_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub email: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub avatar_url: Option<String>,
    pub verified: bool,
    pub linked_at: i64,
}

#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct HubVaultSession {
    pub subject: String,
    pub access_token: String,
    pub refresh_token: String,
    pub family_id: String,
    pub expires_at: i64,
    pub jwk_x: String,
    pub user_id: String,
    pub username: String,
    pub display_name: String,
    pub email: Option<String>,
    pub email_verified: bool,
    pub avatar_url: Option<String>,
    pub has_password: bool,
    pub identities: Vec<HubIdentityPublic>,
    pub terms_version: Option<String>,
    pub privacy_version: Option<String>,
    pub terms_accepted_at: Option<i64>,
    pub needs_terms_acceptance: bool,
    pub public_handle: String,
    pub bio: String,
    pub profile_visibility: String,
    pub social_links: Value,
    pub show_public_tracks: bool,
}

#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct HubOAuthClientSecret {
    pub client_id: String,
    pub client_secret: String,
}

#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Secrets {
    pub youtube_key: String,
    pub broker_url: String,
    pub broker_token: String,
    pub hub_session: Option<HubVaultSession>,
    pub hub_oauth_clients: std::collections::HashMap<String, HubOAuthClientSecret>,
}

pub fn default_broker_url() -> String {
    if let Ok(env_val) = std::env::var("LIQUID_HUB_BROKER_URL") {
        let trimmed = env_val.trim();
        if !trimmed.is_empty() {
            if let Ok(valid) = validate_broker_origin(trimmed) {
                if !valid.is_empty() {
                    return valid;
                }
            }
        }
    }
    serde_json::from_str::<Value>(include_str!("../jam.json"))
        .ok()
        .and_then(|v| {
            v["brokerUrl"]
                .as_str()
                .or_else(|| v["jamUrl"].as_str())
                .map(|s| s.trim().trim_end_matches('/').to_string())
        })
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "https://liquid-hub-jam.nlzezwrld.workers.dev".to_string())
}

pub fn normalize_broker_candidate(raw: &str) -> String {
    let trimmed = raw.trim().trim_end_matches('/');
    if trimmed.is_empty() || trimmed.eq_ignore_ascii_case("https://api.liquidhub.app") {
        String::new()
    } else {
        trimmed.to_string()
    }
}

fn zeroize_bytes(buf: &mut [u8]) {
    for byte in buf.iter_mut() {
        unsafe { std::ptr::write_volatile(byte, 0) };
    }
    std::sync::atomic::compiler_fence(std::sync::atomic::Ordering::SeqCst);
}

pub(crate) fn protect(bytes: &[u8], encrypt: bool) -> Result<Vec<u8>> {
    let input = CRYPT_INTEGER_BLOB {
        cbData: bytes.len() as u32,
        pbData: bytes.as_ptr() as *mut u8,
    };
    let mut output = CRYPT_INTEGER_BLOB {
        cbData: 0,
        pbData: std::ptr::null_mut(),
    };
    // DPAPI protects credentials exclusively for the current Windows user. Never fallback to plaintext.
    unsafe {
        let success = if encrypt {
            CryptProtectData(
                &input,
                std::ptr::null(),
                std::ptr::null(),
                std::ptr::null_mut(),
                std::ptr::null(),
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut output,
            )
        } else {
            CryptUnprotectData(
                &input,
                std::ptr::null_mut(),
                std::ptr::null(),
                std::ptr::null_mut(),
                std::ptr::null(),
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut output,
            )
        };
        if success == 0 {
            return Err("O cofre do Windows (DPAPI) recusou a operação de credenciais.".into());
        }
        let result = std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec();
        LocalFree(output.pbData as _);
        Ok(result)
    }
}

pub fn validate_broker_origin(raw: &str) -> Result<String> {
    if raw.is_empty() {
        return Ok(String::new());
    }
    let u = url::Url::parse(raw).map_err(|_| "Servidor inválido.")?;
    if !u.username().is_empty()
        || u.password().is_some()
        || u.query().is_some()
        || u.fragment().is_some()
        || u.path() != "/"
        || !(u.scheme() == "https"
            || (u.scheme() == "http" && u.host_str() == Some("127.0.0.1")))
    {
        return Err("Use HTTPS ou o servidor local em http://127.0.0.1.".into());
    }
    Ok(raw.trim_end_matches('/').to_string())
}

/// Cryptographically verifies an Ed25519 (EdDSA) JWT issued by the Zero-Trust Broker.
pub fn verify_ed25519_jwt(jwt: &str, jwk_x: &str, now_ms: i64) -> Result<Value> {
    let parts: Vec<&str> = jwt.split('.').collect();
    if parts.len() != 3 || jwt.len() > 4096 {
        return Err("Formato de Access Token inválido.".into());
    }
    let header_bytes = URL_SAFE_NO_PAD
        .decode(parts[0])
        .map_err(|_| "Cabeçalho JWT inválido.")?;
    let claims_bytes = URL_SAFE_NO_PAD
        .decode(parts[1])
        .map_err(|_| "Claims JWT inválidos.")?;
    let signature = URL_SAFE_NO_PAD
        .decode(parts[2])
        .map_err(|_| "Assinatura JWT inválida.")?;
    let pubkey_bytes = URL_SAFE_NO_PAD
        .decode(jwk_x)
        .map_err(|_| "Chave pública Ed25519 inválida.")?;
    if pubkey_bytes.len() != 32 || signature.len() != 64 {
        return Err("Tamanho de chave ou assinatura Ed25519 inválido.".into());
    }

    let header: Value =
        serde_json::from_slice(&header_bytes).map_err(|_| "JSON do cabeçalho JWT inválido.")?;
    if header["alg"] != "EdDSA" || header["typ"] != "JWT" {
        return Err("Algoritmo JWT não permitido (exigido EdDSA).".into());
    }

    let signing_input = format!("{}.{}", parts[0], parts[1]);
    let verifier = UnparsedPublicKey::new(&ED25519, &pubkey_bytes);
    verifier
        .verify(signing_input.as_bytes(), &signature)
        .map_err(|_| "Assinatura Ed25519 do servidor inválida.")?;

    let claims: Value =
        serde_json::from_slice(&claims_bytes).map_err(|_| "JSON de claims JWT inválido.")?;
    let now_sec = now_ms / 1000;
    let iat = claims["iat"].as_i64().ok_or("Claim iat ausente.")?;
    let exp = claims["exp"].as_i64().ok_or("Claim exp ausente.")?;
    if claims["iss"] != "liquid-hub-auth"
        || claims["aud"] != "liquid-hub-desktop"
        || exp <= now_sec
        || exp - iat > 900
    {
        return Err("Token expirado ou fora do escopo de 15 minutos.".into());
    }
    Ok(claims)
}

impl Secrets {
    pub fn load(path: &Path) -> Result<Self> {
        if !path.exists() {
            return Ok(Self::default());
        }
        let bytes = fs::read(path).map_err(|e| e.to_string())?;
        let mut decrypted = protect(&bytes, false)?;
        let parsed = serde_json::from_slice(&decrypted)
            .map_err(|_| "Não foi possível ler as credenciais protegidas.".to_string());
        zeroize_bytes(&mut decrypted);
        parsed
    }

    pub fn save(&self, path: &Path) -> Result<()> {
        let mut raw = serde_json::to_vec(self).map_err(|e| e.to_string())?;
        let encrypted = protect(&raw, true);
        zeroize_bytes(&mut raw);
        let bytes = encrypted?;
        let pending = path.with_extension("pending");
        fs::write(&pending, bytes).map_err(|e| e.to_string())?;
        fs::rename(&pending, path).map_err(|e| e.to_string())
    }

    pub fn hub_authenticated(&self, now_ms: i64) -> bool {
        self.hub_session
            .as_ref()
            .is_some_and(|s| !s.refresh_token.is_empty() && (s.expires_at > now_ms || !s.access_token.is_empty()))
    }

    /// Public safe projection: never leaks access_token, refresh_token or broker_token to WebView.
    pub fn public_hub_status(&self, now_ms: i64) -> Value {
        let stored_norm = normalize_broker_candidate(&self.broker_url);
        let effective_broker = if !stored_norm.is_empty() {
            stored_norm
        } else {
            default_broker_url()
        };
        if let Some(session) = &self.hub_session {
            if !session.refresh_token.is_empty() {
                let mut out = json!({
                    "authenticated": true,
                    "subject": session.subject,
                    "expiresAt": session.expires_at,
                    "brokerUrl": effective_broker,
                    "tokenActive": session.expires_at > now_ms,
                    "userId": if session.user_id.is_empty() { &session.subject } else { &session.user_id },
                    "username": if session.username.is_empty() { &session.subject } else { &session.username },
                    "displayName": if session.display_name.is_empty() { &session.subject } else { &session.display_name },
                    "email": session.email,
                    "emailVerified": session.email_verified,
                    "avatarUrl": session.avatar_url,
                    "hasPassword": session.has_password,
                    "identities": session.identities,
                    "termsVersion": session.terms_version,
                    "privacyVersion": session.privacy_version,
                    "termsAcceptedAt": session.terms_accepted_at,
                    "needsTermsAcceptance": session.needs_terms_acceptance,
                    "publicHandle": if session.public_handle.is_empty() { Value::Null } else { json!(session.public_handle) },
                    "bio": session.bio,
                    "profileVisibility": if session.profile_visibility.is_empty() { "public" } else { &session.profile_visibility },
                    "socialLinks": if session.social_links.is_object() { session.social_links.clone() } else { json!({}) },
                    "showPublicTracks": session.show_public_tracks
                });
                if let Some(obj) = out.as_object_mut() {
                    if obj.get("identities").is_some_and(|v| v.as_array().is_none()) {
                        obj.insert("identities".into(), json!([]));
                    }
                }
                return out;
            }
        }
        json!({
            "authenticated": false,
            "subject": "",
            "expiresAt": 0,
            "brokerUrl": effective_broker,
            "tokenActive": false
        })
    }

    pub fn clear_hub_session(&mut self) {
        if let Some(mut old) = self.hub_session.take() {
            unsafe {
                zeroize_bytes(old.access_token.as_bytes_mut());
                zeroize_bytes(old.refresh_token.as_bytes_mut());
            }
        }
    }

    pub fn update(&mut self, v: &Value) -> Result<()> {
        let obj = v.as_object().ok_or("Formato de credenciais inválido.")?;
        for key in obj.keys() {
            if !["youtubeKey", "brokerUrl", "brokerToken"].contains(&key.as_str()) {
                return Err("Campo de credencial não permitido.".into());
            }
        }
        let mut next = self.clone();
        for key in ["youtubeKey", "brokerUrl", "brokerToken"] {
            if let Some(value) = obj.get(key) {
                let value = value.as_str().ok_or("Credencial inválida")?.trim();
                if value.len() > 2048 || value.contains(['\r', '\n']) {
                    return Err("Credencial inválida.".into());
                }
                match key {
                    "youtubeKey" => next.youtube_key = value.into(),
                    "brokerUrl" => {
                        let normalized = validate_broker_origin(value)?;
                        if normalized != next.broker_url {
                            next.clear_hub_session();
                        }
                        next.broker_url = normalized;
                    }
                    _ => next.broker_token = value.into(),
                }
            }
        }
        *self = next;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ring::rand::SystemRandom;
    use ring::signature::{Ed25519KeyPair, KeyPair};

    #[test]
    fn dpapi_roundtrip_and_public_projection_hides_tokens() {
        let raw = b"private-test-key";
        let encrypted = protect(raw, true).unwrap();
        assert!(!encrypted.windows(raw.len()).any(|w| w == raw));
        assert_eq!(protect(&encrypted, false).unwrap(), raw);

        let mut secrets = Secrets::default();
        secrets.hub_session = Some(HubVaultSession {
            subject: "alice".into(),
            access_token: "secret-ed25519-jwt".into(),
            refresh_token: "secret-opaque-refresh".into(),
            family_id: "fam_1".into(),
            expires_at: 9999999999999,
            jwk_x: "x".into(),
            ..Default::default()
        });
        let status = secrets.public_hub_status(1000).to_string();
        assert!(status.contains("alice"));
        assert!(!status.contains("secret-ed25519-jwt"));
        assert!(!status.contains("secret-opaque-refresh"));
    }

    #[test]
    fn broker_validation_and_unknown_field_rejection() {
        let mut s = Secrets::default();
        assert!(s
            .update(&serde_json::json!({"brokerUrl":"http://evil.test"}))
            .is_err());
        assert!(s
            .update(&serde_json::json!({"brokerUrl":"http://127.0.0.1:8787"}))
            .is_ok());
        assert!(s
            .update(&serde_json::json!({"brokerUrl":"http://127.0.0.1:8787","extra":"bad"}))
            .is_err());
    }

    #[test]
    fn verifies_valid_ed25519_jwt_and_rejects_tampered_or_expired() {
        let rng = SystemRandom::new();
        let pkcs8 = Ed25519KeyPair::generate_pkcs8(&rng).unwrap();
        let kp = Ed25519KeyPair::from_pkcs8(pkcs8.as_ref()).unwrap();
        let jwk_x = URL_SAFE_NO_PAD.encode(kp.public_key().as_ref());

        let header = URL_SAFE_NO_PAD.encode(r#"{"alg":"EdDSA","typ":"JWT"}"#);
        let claims = URL_SAFE_NO_PAD.encode(
            r#"{"iss":"liquid-hub-auth","aud":"liquid-hub-desktop","sub":"usr_1","fam":"fam_1","iat":1000,"exp":1900}"#,
        );
        let msg = format!("{header}.{claims}");
        let sig = URL_SAFE_NO_PAD.encode(kp.sign(msg.as_bytes()).as_ref());
        let jwt = format!("{msg}.{sig}");

        assert!(verify_ed25519_jwt(&jwt, &jwk_x, 1_200_000).is_ok());
        // Expired after 15m
        assert!(verify_ed25519_jwt(&jwt, &jwk_x, 2_000_000).is_err());
        // Tampered payload
        let bad_claims = URL_SAFE_NO_PAD.encode(
            r#"{"iss":"liquid-hub-auth","aud":"liquid-hub-desktop","sub":"admin","fam":"fam_1","iat":1000,"exp":1900}"#,
        );
        assert!(verify_ed25519_jwt(&format!("{header}.{bad_claims}.{sig}"), &jwk_x, 1_200_000).is_err());
    }
}
