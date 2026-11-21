use crate::db::Result;
use std::collections::HashMap;

pub fn normalize_code(raw: &str) -> Option<String> {
    let cleaned: String = raw
        .trim()
        .chars()
        .filter(|c| !c.is_whitespace() && *c != '-')
        .map(|c| c.to_ascii_uppercase())
        .collect();
    if (6..=16).contains(&cleaned.len()) && cleaned.bytes().all(|b| b.is_ascii_alphanumeric()) {
        Some(cleaned)
    } else {
        None
    }
}

pub fn parse_and_validate(raw: &str) -> Option<String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() || trimmed.len() > 2048 || trimmed.chars().any(|c| c.is_control()) {
        return None;
    }
    let parsed = url::Url::parse(trimmed).ok()?;
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return None;
    }

    let query: HashMap<String, String> = parsed.query_pairs().into_owned().collect();

    match parsed.scheme() {
        "liquidhub" => {
            let host = parsed.host_str().unwrap_or("");
            let segs: Vec<&str> = parsed
                .path_segments()
                .map(|s| s.filter(|p| !p.is_empty()).collect())
                .unwrap_or_default();

            let raw_code = if host.eq_ignore_ascii_case("jam") {
                if segs.len() == 2 && segs[0].eq_ignore_ascii_case("join") {
                    segs[1].to_string()
                } else if segs.len() == 1 {
                    segs[0].to_string()
                } else if segs.is_empty() {
                    query
                        .get("code")
                        .or_else(|| query.get("jam"))
                        .cloned()
                        .unwrap_or_default()
                } else {
                    return None;
                }
            } else if host.eq_ignore_ascii_case("join") {
                if segs.len() == 1 {
                    segs[0].to_string()
                } else if segs.is_empty() {
                    query
                        .get("code")
                        .or_else(|| query.get("jam"))
                        .cloned()
                        .unwrap_or_default()
                } else {
                    return None;
                }
            } else {
                return None;
            };

            let code = normalize_code(&raw_code)?;
            let mut canonical = format!("liquidhub://jam/join/{code}");
            if let Some(ep_raw) = query.get("endpoint").filter(|v| !v.is_empty()) {
                let valid_ep = crate::jam::validate_endpoint(ep_raw).ok()?;
                if !valid_ep.is_empty() {
                    let encoded: String =
                        url::form_urlencoded::byte_serialize(valid_ep.as_bytes()).collect();
                    canonical.push_str("?endpoint=");
                    canonical.push_str(&encoded);
                }
            }
            Some(canonical)
        }
        "https" | "http" => {
            let origin = parsed.origin().ascii_serialization();
            let valid_ep = crate::jam::validate_endpoint(&origin).ok()?;
            if valid_ep.is_empty() {
                return None;
            }
            let segs: Vec<&str> = parsed
                .path_segments()
                .map(|s| s.filter(|p| !p.is_empty()).collect())
                .unwrap_or_default();

            let mut raw_code = if segs.len() == 3
                && segs[0].eq_ignore_ascii_case("jam")
                && segs[1].eq_ignore_ascii_case("join")
            {
                segs[2].to_string()
            } else if segs.len() == 2 && segs[0].eq_ignore_ascii_case("join") {
                segs[1].to_string()
            } else {
                query
                    .get("jam")
                    .or_else(|| query.get("code"))
                    .cloned()
                    .unwrap_or_default()
            };

            if raw_code.is_empty() {
                if let Some(frag) = parsed.fragment() {
                    let clean_frag = frag.trim_start_matches(['?', '/']);
                    for (k, v) in url::form_urlencoded::parse(clean_frag.as_bytes()) {
                        if k == "jam" || k == "code" {
                            raw_code = v.into_owned();
                            break;
                        }
                    }
                }
            }

            let code = normalize_code(&raw_code)?;
            let encoded: String =
                url::form_urlencoded::byte_serialize(valid_ep.as_bytes()).collect();
            Some(format!("liquidhub://jam/join/{code}?endpoint={encoded}"))
        }
        _ => None,
    }
}

pub fn extract_from_args<I, S>(args: I) -> Option<String>
where
    I: IntoIterator<Item = S>,
    S: AsRef<str>,
{
    for arg in args {
        if let Some(valid) = parse_and_validate(arg.as_ref()) {
            return Some(valid);
        }
    }
    None
}

#[cfg(windows)]
fn to_wide(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(std::iter::once(0)).collect()
}

#[cfg(windows)]
fn reg_set_sz(
    hkey: windows_sys::Win32::System::Registry::HKEY,
    name: Option<&str>,
    value: &str,
) -> Result<()> {
    use windows_sys::Win32::System::Registry::{RegSetValueExW, REG_SZ};
    let wide_name = name.map(to_wide);
    let wide_val = to_wide(value);
    let name_ptr = wide_name
        .as_ref()
        .map_or(std::ptr::null(), |w| w.as_ptr());
    let status = unsafe {
        RegSetValueExW(
            hkey,
            name_ptr,
            0,
            REG_SZ,
            wide_val.as_ptr() as *const u8,
            (wide_val.len() * 2) as u32,
        )
    };
    if status != 0 {
        return Err(format!("Erro ao gravar registro do protocolo ({status})."));
    }
    Ok(())
}

#[cfg(windows)]
fn reg_create_and_set(subkey: &str, pairs: &[(Option<&str>, &str)]) -> Result<()> {
    use windows_sys::Win32::System::Registry::{
        RegCloseKey, RegCreateKeyExW, HKEY, HKEY_CURRENT_USER, KEY_WRITE, REG_OPTION_NON_VOLATILE,
    };
    let wide_sub = to_wide(subkey);
    let mut hkey: HKEY = std::ptr::null_mut();
    let status = unsafe {
        RegCreateKeyExW(
            HKEY_CURRENT_USER,
            wide_sub.as_ptr(),
            0,
            std::ptr::null_mut(),
            REG_OPTION_NON_VOLATILE,
            KEY_WRITE,
            std::ptr::null(),
            &mut hkey,
            std::ptr::null_mut(),
        )
    };
    if status != 0 {
        return Err(format!("Erro ao registrar chave de protocolo ({status})."));
    }
    let res = (|| {
        for (name, val) in pairs {
            reg_set_sz(hkey, *name, val)?;
        }
        Ok(())
    })();
    unsafe {
        RegCloseKey(hkey);
    }
    res
}

pub fn register_windows_protocol() -> Result<()> {
    #[cfg(windows)]
    {
        let exe = std::env::current_exe()
            .map_err(|_| "Não foi possível localizar o executável do Liquid Hub.")?;
        let exe_str = exe.to_string_lossy().to_string();
        reg_create_and_set(
            "Software\\Classes\\liquidhub",
            &[
                (None, "URL:Liquid Hub Protocol"),
                (Some("URL Protocol"), ""),
            ],
        )?;
        reg_create_and_set(
            "Software\\Classes\\liquidhub\\DefaultIcon",
            &[(None, &format!("\"{exe_str}\",0"))],
        )?;
        reg_create_and_set(
            "Software\\Classes\\liquidhub\\shell\\open\\command",
            &[(None, &format!("\"{exe_str}\" \"%1\""))],
        )?;
    }
    Ok(())
}

pub fn is_protocol_registered() -> bool {
    #[cfg(windows)]
    {
        use windows_sys::Win32::System::Registry::{
            RegCloseKey, RegOpenKeyExW, HKEY, HKEY_CURRENT_USER, KEY_READ,
        };
        let wide = to_wide("Software\\Classes\\liquidhub\\shell\\open\\command");
        let mut hkey: HKEY = std::ptr::null_mut();
        let status = unsafe { RegOpenKeyExW(HKEY_CURRENT_USER, wide.as_ptr(), 0, KEY_READ, &mut hkey) };
        if status == 0 {
            unsafe {
                RegCloseKey(hkey);
            }
            return true;
        }
        false
    }
    #[cfg(not(windows))]
    {
        false
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_valid_and_rejects_invalid_codes() {
        assert_eq!(normalize_code("abc-1234").as_deref(), Some("ABC1234"));
        assert_eq!(normalize_code(" k9m4 p2xr ").as_deref(), Some("K9M4P2XR"));
        assert_eq!(normalize_code("ABCDEF0123").as_deref(), Some("ABCDEF0123"));
        assert!(normalize_code("ab12").is_none());
        assert!(normalize_code("abc$1234").is_none());
    }

    #[test]
    fn parses_deep_links_and_http_invite_links_safely() {
        assert_eq!(
            parse_and_validate("liquidhub://jam/join/ab12-cd34").as_deref(),
            Some("liquidhub://jam/join/AB12CD34")
        );
        assert_eq!(
            parse_and_validate("liquidhub://jam/K9M4P2XR?endpoint=https%3A%2F%2Fjam.liquidhub.app")
                .as_deref(),
            Some("liquidhub://jam/join/K9M4P2XR?endpoint=https%3A%2F%2Fjam.liquidhub.app")
        );
        assert_eq!(
            parse_and_validate("https://liquidhub.app/jam/join/abc12345").as_deref(),
            Some("liquidhub://jam/join/ABC12345?endpoint=https%3A%2F%2Fliquidhub.app")
        );
        assert_eq!(
            parse_and_validate("http://192.168.1.25:8789/jam/join/abc12345").as_deref(),
            Some("liquidhub://jam/join/ABC12345?endpoint=http%3A%2F%2F192.168.1.25%3A8789")
        );
        assert_eq!(
            parse_and_validate("https://jam.example/#jam=ABCDEF0123").as_deref(),
            Some("liquidhub://jam/join/ABCDEF0123?endpoint=https%3A%2F%2Fjam.example")
        );
        assert_eq!(
            parse_and_validate(
                "liquidhub://join?code=ABC1234567&endpoint=http%3A%2F%2F192.168.1.5%3A1234"
            )
            .as_deref(),
            Some("liquidhub://jam/join/ABC1234567?endpoint=http%3A%2F%2F192.168.1.5%3A1234")
        );

        // Reject unsafe inputs
        assert!(parse_and_validate("javascript:alert(1)").is_none());
        assert!(parse_and_validate("liquidhub://other?code=ABC1234567&endpoint=https%3A%2F%2Fjam.example").is_none());
        assert!(parse_and_validate("http://evil.example/jam/join/ABC12345").is_none());
        assert!(parse_and_validate("https://user:pass@liquidhub.app/jam/join/ABC12345").is_none());
        assert!(parse_and_validate("liquidhub://jam/join/ABC12345?endpoint=http://evil.example").is_none());
    }

    #[test]
    fn extracts_first_valid_invite_from_argv() {
        let args = [
            "liquid-hub.exe",
            "--flag",
            "liquidhub://jam/join/K9M4P2XR?endpoint=https%3A%2F%2Fjam.example",
        ];
        assert_eq!(
            extract_from_args(args).as_deref(),
            Some("liquidhub://jam/join/K9M4P2XR?endpoint=https%3A%2F%2Fjam.example")
        );
    }
}
