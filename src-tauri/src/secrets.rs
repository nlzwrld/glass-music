use crate::db::Result;
use serde::{Deserialize, Serialize};
use std::{fs, path::Path};
use windows_sys::Win32::{
    Foundation::LocalFree,
    Security::Cryptography::{
        CryptProtectData, CryptUnprotectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
    },
};
#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Secrets {
    pub youtube_key: String,
    pub broker_url: String,
    pub broker_token: String,
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
    // DPAPI protects credentials for the current Windows user. No plaintext fallback.
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
            return Err("O Windows não conseguiu proteger as credenciais.".into());
        }
        let result = std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec();
        LocalFree(output.pbData as _);
        Ok(result)
    }
}
impl Secrets {
    pub fn load(path: &Path) -> Result<Self> {
        if !path.exists() {
            return Ok(Self::default());
        }
        let bytes = fs::read(path).map_err(|e| e.to_string())?;
        serde_json::from_slice(&protect(&bytes, false)?)
            .map_err(|_| "Não foi possível ler as credenciais protegidas.".into())
    }
    pub fn save(&self, path: &Path) -> Result<()> {
        let bytes = protect(&serde_json::to_vec(self).map_err(|e| e.to_string())?, true)?;
        let pending = path.with_extension("pending");
        fs::write(&pending, bytes).map_err(|e| e.to_string())?;
        fs::rename(&pending, path).map_err(|e| e.to_string())
    }
    pub fn update(&mut self, v: &serde_json::Value) -> Result<()> {
        let mut next = self.clone();
        for key in ["youtubeKey", "brokerUrl", "brokerToken"] {
            if let Some(value) = v.get(key) {
                let value = value.as_str().ok_or("Credencial inválida")?.trim();
                if value.len() > 2048 || value.contains(['\r', '\n']) {
                    return Err("Credencial inválida.".into());
                }
                match key {
                    "youtubeKey" => next.youtube_key = value.into(),
                    "brokerUrl" => next.broker_url = value.trim_end_matches('/').into(),
                    _ => next.broker_token = value.into(),
                }
            }
        }
        if !next.broker_url.is_empty() {
            let u = url::Url::parse(&next.broker_url).map_err(|_| "Servidor inválido")?;
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
        }
        *self = next;
        Ok(())
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn dpapi_roundtrip() {
        let raw = b"private-test-key";
        let encrypted = protect(raw, true).unwrap();
        assert!(!encrypted.windows(raw.len()).any(|w| w == raw));
        assert_eq!(protect(&encrypted, false).unwrap(), raw);
    }
    #[test]
    fn broker_validation() {
        let mut s = Secrets::default();
        assert!(s
            .update(&serde_json::json!({"brokerUrl":"http://evil.test"}))
            .is_err());
        assert!(s
            .update(&serde_json::json!({"brokerUrl":"http://127.0.0.1:8787"}))
            .is_ok());
    }
}
