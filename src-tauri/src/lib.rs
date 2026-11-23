mod accounts;
mod audio;
mod catalog;
mod collections;
#[cfg(windows)]
mod corners;
mod db;
mod deeplink;
#[cfg(windows)]
mod desktop_backdrop;
mod direct_catalog;
mod jam;
mod link_providers;
mod links;
mod lyrics;
mod media;
mod offline;
mod platforms;
mod providers;
mod ranking;
mod resolver;
mod secrets;
mod updates;

use db::{s, Library, Result};
use serde_json::{json, Value};
use std::{
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::Instant,
};
#[cfg(desktop)]
use tauri::{
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    LogicalSize,
};
use tauri::{Emitter, Manager};
#[cfg(desktop)]
use tauri_plugin_autostart::ManagerExt;
#[cfg(desktop)]
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Shortcut, ShortcutState};
use tauri_plugin_notification::NotificationExt;
use tauri_plugin_opener::OpenerExt;

#[cfg(windows)]
fn native_environment(window: &tauri::WebviewWindow, pref: &Value) {
    let is_glass = pref
        .get("uiStyle")
        .and_then(|v| v.as_str())
        .unwrap_or("matte")
        == "glass";
    let desktop = is_glass && pref["appearance"]["background"] == "desktop";
    let target = window.clone();
    let _ = window.run_on_main_thread(move || {
        let _ = target.set_effects(None);
        if let Ok(hwnd) = target.hwnd() {
            let ok = desktop_backdrop::apply(hwnd.0, desktop);
            if desktop && !ok {
                use tauri::window::{Color, Effect, EffectsBuilder};
                let _ = target.set_effects(
                    EffectsBuilder::new()
                        .effect(Effect::Acrylic)
                        .color(Color(18, 21, 23, 22))
                        .build(),
                );
            }
            corners::apply(hwnd.0, target.scale_factor().unwrap_or(1.0));
        }
    });
}

#[cfg(not(windows))]
fn native_environment(_window: &tauri::WebviewWindow, _pref: &Value) {}

struct State {
    db: Arc<Mutex<Library>>,
    secrets: Mutex<secrets::Secrets>,
    search: Mutex<providers::SearchState>,
    data: PathBuf,
    base: String,
    shortcuts: AtomicBool,
    catalog_url: String,
    direct: direct_catalog::DirectCatalog,
    audio: Arc<audio::AudioStreams>,
    accounts: accounts::Accounts,
    offline: offline::Downloads,
    notifications: Mutex<media::NotificationGate>,
    pending_deep_link: Mutex<Option<String>>,
    jam_realtime: jam::JamRealtime,
    hub_auth_gate: tokio::sync::Mutex<()>,
    hub_oauth_cancel: Arc<AtomicBool>,
}

fn dispatch_deep_link(app: &tauri::AppHandle, raw: &str) -> bool {
    let Some(canonical) = deeplink::parse_and_validate(raw) else {
        return false;
    };
    if let Some(st) = app.try_state::<State>() {
        if let Ok(mut pending) = st.pending_deep_link.lock() {
            *pending = Some(canonical.clone());
        }
    }
    #[cfg(desktop)]
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
        let _ = app.emit_to("main", "glass-visual-visible", true);
    }
    let _ = app.emit_to("main", "deep-link", canonical);
    true
}

fn status(st: &State) -> Value {
    let keys = st.secrets.lock().unwrap();
    let ready = !st.catalog_url.is_empty() || st.direct.available();
    let mode = if !st.catalog_url.is_empty() {
        "hosted"
    } else if ready {
        "direct"
    } else {
        "unavailable"
    };
    let (offline_tracks, offline_bytes) = {
        let db = st.db.lock().unwrap();
        offline::stats(&st.data, &db)
    };
    json!({
        "youtube": ready,
        "soundcloud": ready,
        "spotify": st.accounts.spotify_search_ready() || !st.catalog_url.is_empty(),
        "catalogConfigured": ready,
        "catalogMode": mode,
        "encrypted": true,
        "brokerUrl": keys.broker_url,
        "hubAuthenticated": keys.hub_authenticated(db::now()),
        "offlineTracks": offline_tracks,
        "offlineBytes": offline_bytes,
        "version": env!("CARGO_PKG_VERSION"),
        "gpu": true,
        "shortcuts": st.shortcuts.load(Ordering::Relaxed)
    })
}

#[cfg(desktop)]
fn shortcuts(app: &tauri::AppHandle, enabled: bool) -> bool {
    let _ = app.global_shortcut().unregister_all();
    if !enabled {
        return false;
    }
    let mut good = true;
    for (code, command) in [
        (Code::MediaPlayPause, "playPause"),
        (Code::MediaTrackNext, "next"),
        (Code::MediaTrackPrevious, "previous"),
    ] {
        good &= app
            .global_shortcut()
            .on_shortcut(Shortcut::new(None, code), move |app, _, event| {
                if event.state == ShortcutState::Pressed {
                    let _ = app.emit_to("main", "media", command);
                }
            })
            .is_ok();
    }
    good
}

#[cfg(any(desktop, test))]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum WindowLifecycleDecision {
    MinimizeKeepPlayback,
    HideToTrayKeepPlayback,
    ExitApp,
}

#[cfg(any(desktop, test))]
fn decide_close_action(tray_enabled: bool) -> WindowLifecycleDecision {
    if tray_enabled {
        WindowLifecycleDecision::HideToTrayKeepPlayback
    } else {
        WindowLifecycleDecision::ExitApp
    }
}

#[cfg(any(desktop, test))]
fn decide_minimize_action() -> WindowLifecycleDecision {
    WindowLifecycleDecision::MinimizeKeepPlayback
}

#[cfg(test)]
fn decision_pauses_audio(_decision: WindowLifecycleDecision) -> bool {
    false
}

#[cfg(desktop)]
fn close(app: &tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let tray = app.state::<State>().db.lock().unwrap().pref()["tray"] == true;
        match decide_close_action(tray) {
            WindowLifecycleDecision::HideToTrayKeepPlayback => {
                let _ = w.hide();
                let _ = app.emit_to("main", "glass-visual-visible", false);
            }
            WindowLifecycleDecision::ExitApp => app.exit(0),
            WindowLifecycleDecision::MinimizeKeepPlayback => {}
        }
    }
}

#[cfg(desktop)]
fn main_window_size(window: &tauri::WebviewWindow) -> LogicalSize<f64> {
    if let Ok(Some(monitor)) = window.current_monitor() {
        let size = monitor.size().to_logical::<f64>(monitor.scale_factor());
        return LogicalSize::new(
            (size.width - 40.0).clamp(920.0, 1672.0),
            (size.height - 80.0).clamp(650.0, 941.0),
        );
    }
    LogicalSize::new(1366.0, 768.0)
}

fn migrate_legacy_profile_if_needed(target_dir: &PathBuf) {
    if target_dir.join("library.sqlite").exists() {
        return;
    }
    let Some(parent) = target_dir.parent() else {
        return;
    };
    let legacy = parent.join("com.glassmusic.desktop");
    if legacy.join("library.sqlite").is_file() {
        let _ = std::fs::copy(
            legacy.join("library.sqlite"),
            target_dir.join("library.sqlite"),
        );
        for name in ["credentials.dpapi", "accounts.dpapi"] {
            if legacy.join(name).is_file() && !target_dir.join(name).exists() {
                let _ = std::fs::copy(legacy.join(name), target_dir.join(name));
            }
        }
    }
}

fn window_action_allowed(label: &str, action: &str) -> bool {
    if label == "main" {
        return true;
    }
    if label == "lyrics" {
        return ["bootstrap", "lyrics", "lyricsControl", "closeLyrics", "pinLyrics"]
            .contains(&action);
    }
    if label == "jam" {
        return ["bootstrap", "jamControl", "closeJam", "pinJam", "search", "external"]
            .contains(&action);
    }
    false
}

#[tauri::command]
async fn call(
    action: String,
    payload: Option<Value>,
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    st: tauri::State<'_, State>,
) -> Result<Value> {
    if !window_action_allowed(window.label(), action.as_str()) {
        return Err("Janela sem permissão.".into());
    }
    let p = payload.unwrap_or(Value::Null);
    if p.to_string().len() > 8_000_000 {
        return Err("Solicitação muito grande.".into());
    }
    match action.as_str() {
        "bootstrap" => {
            let data_snap = {
                let db = st.db.lock().unwrap();
                let pref = db.pref();
                if pref["onlineConsent"] == true && pref["onboardingDone"] == true {
                    direct_catalog::warm_visitor();
                }
                db.snapshot()?
            };
            let mut data = data_snap;
            data["_resourceBase"] = json!(st.base);
            Ok(data)
        }
        "library" => {
            if p["action"] == "removeTrack" {
                let _removal = st.offline.removal(s(&p, "id")).await;
                let old = st.db.lock().unwrap().offline_path(s(&p, "id"));
                let v = st.db.lock().unwrap().command(&p)?;
                if let Some((path, _)) = old {
                    if offline::owned_path(&st.data, &path) {
                        let _ = std::fs::remove_file(path);
                    }
                }
                Ok(v)
            } else {
                st.db.lock().unwrap().command(&p)
            }
        }
        "preferences" => {
            db::validate_prefs(&p)?;
            let old = st.db.lock().unwrap().pref();
            #[cfg(desktop)]
            {
                if old["startup"] != p["startup"] {
                    if p["startup"] == true {
                        app.autolaunch().enable()
                    } else {
                        app.autolaunch().disable()
                    }
                    .map_err(|_| "Não foi possível alterar a inicialização do Windows.")?;
                }
                if old["globalShortcuts"] != p["globalShortcuts"] {
                    st.shortcuts
                        .store(shortcuts(&app, p["globalShortcuts"] == true), Ordering::Relaxed);
                }
            }
            if old["appearance"]["background"] != p["appearance"]["background"]
                || old["uiStyle"] != p["uiStyle"]
            {
                native_environment(&window, &p);
            }
            st.db.lock().unwrap().set_pref(&p)?;
            if old["onlineConsent"] != p["onlineConsent"]
                || old["catalogConsent"] != p["catalogConsent"]
                || old["onboardingDone"] != p["onboardingDone"]
            {
                let mut search = st.search.lock().unwrap();
                search.cache.clear();
                st.audio.clear();
                st.accounts.cancel();
                st.offline.cancel_all();
                for token in search.requests.values() {
                    token.cancel();
                }
                if p["onlineConsent"] == true && p["onboardingDone"] == true {
                    direct_catalog::warm_visitor();
                } else {
                    st.jam_realtime.stop();
                    let _ = st.db.lock().unwrap().clear_discovery_cache();
                }
            }
            Ok(p)
        }
        "integrations" => Ok(status(&st)),
        "credentials" => {
            let mut keys = st.secrets.lock().unwrap();
            let mut next = keys.clone();
            next.update(&p)?;
            next.save(&st.data.join("credentials.dpapi"))?;
            *keys = next;
            drop(keys);
            st.search.lock().unwrap().cache.clear();
            Ok(status(&st))
        }
        "hubStatus" => Ok(st.secrets.lock().unwrap().public_hub_status(db::now())),
        "hubProviders" => {
            let pref = st.db.lock().unwrap().pref();
            if pref["onlineConsent"] != true || pref["onboardingDone"] != true {
                return Err("Ative o acesso online antes de autenticar no Liquid Hub.".into());
            }
            let override_url = s(&p, "brokerUrl").to_string();
            let opt = if override_url.is_empty() {
                None
            } else {
                Some(override_url.as_str())
            };
            accounts::hub_providers(&st.secrets, opt).await
        }
        "hubLogin" => {
            let pref = st.db.lock().unwrap().pref();
            if pref["onlineConsent"] != true || pref["onboardingDone"] != true {
                return Err("Ative o acesso online antes de autenticar no Liquid Hub.".into());
            }
            let secrets_path = st.data.join("credentials.dpapi");
            accounts::hub_login(&st.secrets, &secrets_path, &p).await
        }
        "hubOAuthStart" => {
            let pref = st.db.lock().unwrap().pref();
            if pref["onlineConsent"] != true || pref["onboardingDone"] != true {
                return Err("Ative o acesso online antes de autenticar no Liquid Hub.".into());
            }
            let secrets_path = st.data.join("credentials.dpapi");
            accounts::hub_oauth_flow(
                &app,
                &st.secrets,
                &secrets_path,
                &st.hub_auth_gate,
                &st.hub_oauth_cancel,
                &p,
            )
            .await
        }
        "hubCancelOAuth" => {
            st.hub_oauth_cancel.store(true, Ordering::Release);
            Ok(json!({ "ok": true }))
        }
        "hubRefresh" => {
            let pref = st.db.lock().unwrap().pref();
            if pref["onlineConsent"] != true || pref["onboardingDone"] != true {
                return Ok(st.secrets.lock().unwrap().public_hub_status(db::now()));
            }
            let override_url = s(&p, "brokerUrl").to_string();
            let opt = if override_url.is_empty() {
                None
            } else {
                Some(override_url.as_str())
            };
            let secrets_path = st.data.join("credentials.dpapi");
            accounts::hub_refresh(&st.secrets, &secrets_path, opt).await
        }
        "hubAcceptTerms" => {
            let pref = st.db.lock().unwrap().pref();
            if pref["onlineConsent"] != true || pref["onboardingDone"] != true {
                return Err("Ative o acesso online antes de autenticar no Liquid Hub.".into());
            }
            let secrets_path = st.data.join("credentials.dpapi");
            accounts::hub_accept_terms(&st.secrets, &secrets_path, &p).await
        }
        "hubUpdateProfile" => {
            let pref = st.db.lock().unwrap().pref();
            if pref["onlineConsent"] != true || pref["onboardingDone"] != true {
                return Err("Ative o acesso online antes de atualizar o perfil.".into());
            }
            let secrets_path = st.data.join("credentials.dpapi");
            accounts::hub_update_profile(&st.secrets, &secrets_path, &p).await
        }
        "hubGetProfile" => {
            let pref = st.db.lock().unwrap().pref();
            if pref["onlineConsent"] != true || pref["onboardingDone"] != true {
                return Err("Ative o acesso online antes de consultar perfis no Liquid Hub.".into());
            }
            let secrets_path = st.data.join("credentials.dpapi");
            accounts::hub_get_profile(&st.secrets, &secrets_path, &p).await
        }
        "hubSearchUsers" => {
            let pref = st.db.lock().unwrap().pref();
            if pref["onlineConsent"] != true || pref["onboardingDone"] != true {
                return Err("Ative o acesso online antes de pesquisar usuários no Liquid Hub.".into());
            }
            let secrets_path = st.data.join("credentials.dpapi");
            accounts::hub_search_users(&st.secrets, &secrets_path, &p).await
        }
        "hubPublishPlaylist" => {
            let pref = st.db.lock().unwrap().pref();
            if pref["onlineConsent"] != true || pref["onboardingDone"] != true {
                return Err("Ative o acesso online antes de compartilhar playlists no Liquid Hub.".into());
            }
            let secrets_path = st.data.join("credentials.dpapi");
            accounts::hub_publish_playlist(&st.secrets, &secrets_path, &p).await
        }
        "hubMyPlaylists" => {
            let pref = st.db.lock().unwrap().pref();
            if pref["onlineConsent"] != true || pref["onboardingDone"] != true {
                return Err("Ative o acesso online antes de carregar playlists compartilhadas.".into());
            }
            let secrets_path = st.data.join("credentials.dpapi");
            accounts::hub_my_playlists(&st.secrets, &secrets_path, &p).await
        }
        "hubGetSharedPlaylist" => {
            let pref = st.db.lock().unwrap().pref();
            if pref["onlineConsent"] != true || pref["onboardingDone"] != true {
                return Err("Ative o acesso online antes de abrir playlists compartilhadas.".into());
            }
            let secrets_path = st.data.join("credentials.dpapi");
            accounts::hub_get_shared_playlist(&st.secrets, &secrets_path, &p).await
        }
        "hubMutateSharedPlaylist" => {
            let pref = st.db.lock().unwrap().pref();
            if pref["onlineConsent"] != true || pref["onboardingDone"] != true {
                return Err("Ative o acesso online antes de editar playlists compartilhadas.".into());
            }
            let secrets_path = st.data.join("credentials.dpapi");
            accounts::hub_mutate_shared_playlist(&st.secrets, &secrets_path, &p).await
        }
        "hubInviteCollaborator" => {
            let pref = st.db.lock().unwrap().pref();
            if pref["onlineConsent"] != true || pref["onboardingDone"] != true {
                return Err("Ative o acesso online antes de convidar colaboradores.".into());
            }
            let secrets_path = st.data.join("credentials.dpapi");
            accounts::hub_invite_collaborator(&st.secrets, &secrets_path, &p).await
        }
        "hubRespondPlaylistInvite" => {
            let pref = st.db.lock().unwrap().pref();
            if pref["onlineConsent"] != true || pref["onboardingDone"] != true {
                return Err("Ative o acesso online antes de responder ao convite.".into());
            }
            let secrets_path = st.data.join("credentials.dpapi");
            accounts::hub_respond_playlist_invite(&st.secrets, &secrets_path, &p).await
        }
        "hubRemoveCollaborator" => {
            let pref = st.db.lock().unwrap().pref();
            if pref["onlineConsent"] != true || pref["onboardingDone"] != true {
                return Err("Ative o acesso online antes de gerenciar colaboradores.".into());
            }
            let secrets_path = st.data.join("credentials.dpapi");
            accounts::hub_remove_collaborator(&st.secrets, &secrets_path, &p).await
        }
        "hubPlusStatus" => {
            let pref = st.db.lock().unwrap().pref();
            if pref["onlineConsent"] != true || pref["onboardingDone"] != true {
                return Ok(json!({
                    "authenticated": false,
                    "planId": "free",
                    "status": "none",
                    "active": false,
                    "currentPeriodEnd": null,
                    "checkoutEnabled": false,
                    "entitlements": {
                        "nativeAudioAdFree": true,
                        "adFreeVisual": false,
                        "exclusiveThemes": false,
                        "advancedGlassPresets": false,
                        "detailedListeningStats": false,
                        "profileCustomizationPlus": false,
                        "advancedLibraryTools": false
                    },
                    "audioAdsPolicy": {
                        "audioInterruptionsAllowed": false,
                        "nativeAdFreeMusic": true,
                        "visualAdsMutedByDefault": true,
                        "explicitUnmuteRequired": true
                    },
                    "source": "system"
                }));
            }
            let secrets_path = st.data.join("credentials.dpapi");
            accounts::hub_plus_status(&st.secrets, &secrets_path, &p).await
        }
        "hubLibraryPull" => {
            let pref = st.db.lock().unwrap().pref();
            if pref["onlineConsent"] != true || pref["onboardingDone"] != true {
                return Ok(json!({ "playlists": [], "tracks": [], "likes": [], "updatedAt": 0 }));
            }
            let secrets_path = st.data.join("credentials.dpapi");
            accounts::hub_library_pull(&st.secrets, &secrets_path, &p).await
        }
        "hubLibraryPush" => {
            let pref = st.db.lock().unwrap().pref();
            if pref["onlineConsent"] != true || pref["onboardingDone"] != true {
                return Ok(json!({ "ok": false, "updatedAt": 0 }));
            }
            let secrets_path = st.data.join("credentials.dpapi");
            accounts::hub_library_push(&st.secrets, &secrets_path, &p).await
        }
        "hubLinkEmail" => {
            let pref = st.db.lock().unwrap().pref();
            if pref["onlineConsent"] != true || pref["onboardingDone"] != true {
                return Err("Ative o acesso online antes de autenticar no Liquid Hub.".into());
            }
            let secrets_path = st.data.join("credentials.dpapi");
            accounts::hub_link_email(&st.secrets, &secrets_path, &p).await
        }
        "hubUnlinkIdentity" => {
            let pref = st.db.lock().unwrap().pref();
            if pref["onlineConsent"] != true || pref["onboardingDone"] != true {
                return Err("Ative o acesso online antes de autenticar no Liquid Hub.".into());
            }
            let secrets_path = st.data.join("credentials.dpapi");
            accounts::hub_unlink_identity(&st.secrets, &secrets_path, &p).await
        }
        "hubVerifyEmail" => {
            let pref = st.db.lock().unwrap().pref();
            if pref["onlineConsent"] != true || pref["onboardingDone"] != true {
                return Err("Ative o acesso online antes de autenticar no Liquid Hub.".into());
            }
            let secrets_path = st.data.join("credentials.dpapi");
            accounts::hub_verify_email(&st.secrets, &secrets_path, &p).await
        }
        "hubResendVerification" => {
            let pref = st.db.lock().unwrap().pref();
            if pref["onlineConsent"] != true || pref["onboardingDone"] != true {
                return Err("Ative o acesso online antes de autenticar no Liquid Hub.".into());
            }
            let secrets_path = st.data.join("credentials.dpapi");
            accounts::hub_resend_verification(&st.secrets, &secrets_path, &p).await
        }
        "hubForgotPassword" => {
            let pref = st.db.lock().unwrap().pref();
            if pref["onlineConsent"] != true || pref["onboardingDone"] != true {
                return Err("Ative o acesso online antes de autenticar no Liquid Hub.".into());
            }
            accounts::hub_forgot_password(&st.secrets, &p).await
        }
        "hubResetPassword" => {
            let pref = st.db.lock().unwrap().pref();
            if pref["onlineConsent"] != true || pref["onboardingDone"] != true {
                return Err("Ative o acesso online antes de autenticar no Liquid Hub.".into());
            }
            accounts::hub_reset_password(&st.secrets, &p).await
        }
        "hubLogout" => {
            let secrets_path = st.data.join("credentials.dpapi");
            accounts::hub_logout(&st.secrets, &secrets_path).await
        }
        "search" => {
            providers::validate_search(&p)?;
            let id = s(&p, "requestId").to_string();
            let key = json!([p["query"], p["kind"], p["source"], p["cursor"]]).to_string();
            {
                let cache = st.search.lock().unwrap();
                if let Some((at, v)) = cache.cache.get(&key) {
                    if at.elapsed().as_secs() < 300 {
                        return Ok(v.clone());
                    }
                }
            }
            let token = tokio_util::sync::CancellationToken::new();
            {
                let mut search = st.search.lock().unwrap();
                if search.requests.len() >= 30 {
                    return Err("Muitas consultas simultâneas.".into());
                }
                if let Some(prev) = search.requests.insert(id.clone(), token.clone()) {
                    prev.cancel();
                }
            }
            let snap = st.db.lock().unwrap().snapshot()?;
            let consent = snap["preferences"]["onlineConsent"] == true
                && snap["preferences"]["catalogConsent"] == true
                && snap["preferences"]["onboardingDone"] == true;
            let local = snap["tracks"]
                .as_array()
                .unwrap()
                .iter()
                .filter(|t| s(t, "source") == "local")
                .cloned()
                .collect();
            let result = tokio::select! {
                _ = token.cancelled() => Err("Pesquisa cancelada.".into()),
                r = providers::search(&p, local, consent, &st.catalog_url, &st.direct, &st.accounts) => r
            };
            let mut search = st.search.lock().unwrap();
            search.requests.remove(&id);
            if let Ok(ref v) = result {
                if v["notices"].as_array().is_some_and(|a| a.is_empty()) {
                    if search.cache.len() >= 80 {
                        search.cache.clear();
                    }
                    search.cache.insert(key, (Instant::now(), v.clone()));
                }
            }
            result
        }
        "discover" => {
            let pref = st.db.lock().unwrap().pref();
            if pref["onlineConsent"] != true
                || pref["catalogConsent"] != true
                || pref["onboardingDone"] != true
            {
                return Err(
                    "Ative as integrações nas Configurações para ver os catálogos online.".into(),
                );
            }
            let id = s(&p, "requestId").to_string();
            if !db::valid_id(&id) {
                return Err("Solicitação inválida.".into());
            }
            {
                let search = st.search.lock().unwrap();
                if let Some((at, v)) = search.cache.get("catalog:discover") {
                    if at.elapsed().as_secs() < 300 {
                        return Ok(v.clone());
                    }
                }
            }
            let token = tokio_util::sync::CancellationToken::new();
            {
                let mut search = st.search.lock().unwrap();
                if search.requests.len() >= 30 {
                    return Err("Muitas consultas simultâneas.".into());
                }
                if let Some(prev) = search.requests.insert(id.clone(), token.clone()) {
                    prev.cancel();
                }
            }
            let result = tokio::select! {
                _ = token.cancelled() => Err("Consulta cancelada.".into()),
                r = async {
                    if st.catalog_url.is_empty() {
                        st.direct.discover().await
                    } else {
                        catalog::discover(&st.catalog_url).await
                    }
                } => r
            };
            let mut search = st.search.lock().unwrap();
            search.requests.remove(&id);
            if let Ok(ref v) = result {
                if v["notices"].as_array().is_some_and(|a| a.is_empty()) {
                    if search.cache.len() >= 80 {
                        search.cache.clear();
                    }
                    search
                        .cache
                        .insert("catalog:discover".into(), (Instant::now(), v.clone()));
                }
            }
            result
        }
        "cancelSearch" => {
            if let Some(t) = st
                .search
                .lock()
                .unwrap()
                .requests
                .remove(p.as_str().unwrap_or(""))
            {
                t.cancel();
            }
            Ok(Value::Null)
        }
        "accounts" => Ok(st.accounts.status()),
        "cancelAccount" => {
            st.accounts.cancel();
            Ok(Value::Null)
        }
        "configureAccounts" => {
            #[cfg(desktop)]
            {
                if let Some(file) = rfd::AsyncFileDialog::new()
                    .set_title("Cadastro OAuth do Liquid Hub")
                    .add_filter("Cadastro JSON", &["json"])
                    .pick_file()
                    .await
                {
                    if std::fs::metadata(file.path())
                        .map_err(|_| "Arquivo indisponível.")?
                        .len()
                        > 16000
                    {
                        return Err("Arquivo de cadastro muito grande.".into());
                    }
                    let bytes = std::fs::read(file.path()).map_err(|_| "Arquivo indisponível.")?;
                    let config =
                        serde_json::from_slice(&bytes).map_err(|_| "Cadastro JSON inválido.")?;
                    let _guard = st
                        .accounts
                        .gate
                        .try_lock()
                        .map_err(|_| "Há uma conexão em andamento.")?;
                    st.accounts.configure(config)
                } else {
                    Ok(st.accounts.status())
                }
            }
            #[cfg(mobile)]
            {
                Err("Seleção de arquivo de cadastro OAuth indisponível no Android Beta.".into())
            }
        }
        "connectAccount" => {
            let pref = st.db.lock().unwrap().pref();
            if pref["onlineConsent"] != true
                || pref["catalogConsent"] != true
                || pref["onboardingDone"] != true
            {
                return Err("Ative o acesso online antes de conectar uma conta.".into());
            }
            st.accounts
                .connect(p.as_str().ok_or("Conta inválida.")?, &app)
                .await
        }
        "disconnectAccount" => {
            st.accounts.cancel();
            let _guard = st.accounts.gate.lock().await;
            st.accounts.disconnect(p.as_str().ok_or("Conta inválida.")?)
        }
        "syncAccount" => {
            let pref = st.db.lock().unwrap().pref();
            if pref["onlineConsent"] != true
                || pref["catalogConsent"] != true
                || pref["onboardingDone"] != true
            {
                return Err("Ative o acesso online antes de sincronizar.".into());
            }
            let provider = p.as_str().ok_or("Conta inválida.")?;
            let _guard = st
                .accounts
                .gate
                .try_lock()
                .map_err(|_| "Há outra sincronização em andamento.")?;
            let lists = st.accounts.sync(provider).await?;
            st.accounts.ensure_active(provider)?;
            let count = lists.len();
            let tracks = lists.iter().map(|(list, _)| list.tracks.len()).sum::<usize>();
            let snapshot = {
                let db = st.db.lock().unwrap();
                let pref = db.pref();
                if pref["onlineConsent"] != true
                    || pref["catalogConsent"] != true
                    || pref["onboardingDone"] != true
                {
                    return Err("Sincronização cancelada: acesso online desativado.".into());
                }
                st.accounts.ensure_active(provider)?;
                db.merge_account_snapshot(&lists)?;
                db.snapshot()?
            };
            st.accounts.ensure_active(provider)?;
            st.accounts.synced(provider)?;
            Ok(json!({
                "snapshot": snapshot,
                "playlists": count,
                "tracks": tracks,
                "accounts": st.accounts.status()
            }))
        }
        "playlistMeta" => {
            let id = s(&p, "id");
            if !db::valid_id(id) {
                return Err("Playlist inválida.".into());
            }
            let db = st.db.lock().unwrap();
            if let Some(art) = p["artwork"].as_str() {
                if !art.is_empty() {
                    db.collection_artwork(id, art)?;
                }
            }
            if p.get("description").is_some() {
                db.collection_description(id, s(&p, "description"))?;
            }
            db.collection_share_meta(id, &p)?;
            db.snapshot()
        }
        "recommendations" => {
            let pref = st.db.lock().unwrap().pref();
            if pref["onlineConsent"] != true || pref["onboardingDone"] != true {
                return Ok(json!([]));
            }
            let seeds = p["seeds"].as_array().cloned().unwrap_or_default();
            let exclude: Vec<String> = p["excludeIds"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|v| v.as_str().map(str::to_string))
                .take(2500)
                .collect();
            let items = platforms::style_recommendations(&seeds, &exclude, &st.direct).await?;
            Ok(json!(items))
        }
        "previewCollection" => {
            let pref = st.db.lock().unwrap().pref();
            if pref["onlineConsent"] != true || pref["onboardingDone"] != true {
                return Err("Ative o acesso online para abrir este álbum ou playlist.".into());
            }
            let url = p.as_str().ok_or("Link inválido.")?;
            let list = collections::fetch(url, &st.direct).await?;
            Ok(json!({
                "name": list.name,
                "artwork": list.artwork,
                "url": list.key,
                "tracks": list.tracks,
                "warning": list.warning,
                "skipped": list.skipped
            }))
        }
        "importLink" => {
            let pref = st.db.lock().unwrap().pref();
            if pref["onlineConsent"] != true || pref["onboardingDone"] != true {
                return Err("Ative o acesso online após ler os termos.".into());
            }
            let url = s(&p, "url");
            if collections::is_playlist(url) || p["playlist"] == true {
                let list = collections::fetch(url, &st.direct).await?;
                let pref = st.db.lock().unwrap().pref();
                if pref["onlineConsent"] != true {
                    return Err("Importação cancelada: acesso online desativado.".into());
                }
                let id = st
                    .db
                    .lock()
                    .unwrap()
                    .merge_collection(&list.key, &list.name, &list.tracks, false)?;
                st.db
                    .lock()
                    .unwrap()
                    .collection_artwork(&id, &list.artwork)?;
                let snapshot = st.db.lock().unwrap().snapshot()?;
                Ok(json!({
                    "snapshot": snapshot,
                    "playlistId": id,
                    "count": list.tracks.len(),
                    "warning": list.warning,
                    "skipped": list.skipped
                }))
            } else {
                let track = links::resolve(url).await?;
                let pref = st.db.lock().unwrap().pref();
                if pref["onlineConsent"] != true || pref["onboardingDone"] != true {
                    return Err("Importação cancelada: acesso online desativado.".into());
                }
                if track["kind"] != "track" {
                    return Err("Use o link de uma faixa, álbum ou playlist.".into());
                }
                st.db.lock().unwrap().save(&track, None)?;
                let snapshot = st.db.lock().unwrap().snapshot()?;
                Ok(json!({ "snapshot": snapshot, "track": track, "warning": "" }))
            }
        }
        "resolveLink" => {
            if {
                let pref = st.db.lock().unwrap().pref();
                pref["onlineConsent"] != true || pref["onboardingDone"] != true
            } {
                return Err("Ative as integrações após ler os termos.".into());
            }
            links::resolve(p.as_str().ok_or("Link inválido")?).await
        }
        "resolveStream" => {
            let pref = st.db.lock().unwrap().pref();
            if pref["onlineConsent"] != true || pref["onboardingDone"] != true {
                return Err("Ative o acesso online para sincronizar a fonte de áudio.".into());
            }
            let id = s(&p, "requestId").to_string();
            if !db::valid_id(&id) {
                return Err("Solicitação inválida.".into());
            }
            let opts = resolver::ResolveOptions {
                force_refresh: p["forceRefresh"] == true,
                exclude_ids: p["excludeIds"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(|v| v.as_str().map(str::to_string))
                    .take(25)
                    .collect(),
                preferred_provider: p["preferredProvider"].as_str().map(str::to_string),
            };
            let token = tokio_util::sync::CancellationToken::new();
            {
                let mut search = st.search.lock().unwrap();
                if search.requests.len() >= 30 {
                    return Err("Muitas consultas simultâneas.".into());
                }
                if let Some(old) = search.requests.insert(id.clone(), token.clone()) {
                    old.cancel();
                }
            }
            let result = tokio::select! {
                _ = token.cancelled() => Err("Reprodução cancelada.".into()),
                r = resolver::resolve_stream(
                    p["track"].clone(),
                    opts,
                    &st.db,
                    &st.audio,
                    &st.base,
                    &st.catalog_url,
                    &st.direct,
                ) => r
            };
            st.search.lock().unwrap().requests.remove(&id);
            result
        }
        "streamCandidates" => {
            let pref = st.db.lock().unwrap().pref();
            if pref["onlineConsent"] != true || pref["onboardingDone"] != true {
                return Err("Ative o acesso online para listar fontes de áudio.".into());
            }
            let id = s(&p, "requestId").to_string();
            if !db::valid_id(&id) {
                return Err("Solicitação inválida.".into());
            }
            let token = tokio_util::sync::CancellationToken::new();
            {
                let mut search = st.search.lock().unwrap();
                if search.requests.len() >= 30 {
                    return Err("Muitas consultas simultâneas.".into());
                }
                if let Some(old) = search.requests.insert(id.clone(), token.clone()) {
                    old.cancel();
                }
            }
            let result = tokio::select! {
                _ = token.cancelled() => Err("Busca cancelada.".into()),
                r = resolver::search_candidates(&p["track"], &st.catalog_url, &st.direct) => r
            };
            st.search.lock().unwrap().requests.remove(&id);
            Ok(json!(result?))
        }
        "selectStreamCandidate" => {
            let mut track = p["track"].clone();
            db::validate_track(&track)?;
            let key = db::canonical_mapping_key(&track);
            let cat_src = resolver::infer_catalog_source(&track).to_string();
            if p["candidate"].is_null() {
                let guard = st.db.lock().unwrap();
                guard.invalidate_stream_mapping(&key)?;
                if let Some(obj) = track.as_object_mut() {
                    obj.remove("streamProvider");
                    obj.remove("resolvedExternalId");
                    obj.remove("resolvedStreamUrl");
                    obj.remove("playbackId");
                }
                let exists: bool = guard
                    .db
                    .query_row(
                        "SELECT EXISTS(SELECT 1 FROM tracks WHERE id = ?)",
                        [s(&track, "id")],
                        |r| r.get(0),
                    )
                    .unwrap_or(false);
                if exists {
                    let _ = guard.save(&track, None);
                }
                return Ok(track);
            }
            let cand = &p["candidate"];
            let provider = s(cand, "provider").to_string();
            let ext_id = s(cand, "id").to_string();
            if !["ytmusic", "youtube", "soundcloud", "deezer"].contains(&provider.as_str())
                || ext_id.is_empty()
                || ext_id.len() > 200
            {
                return Err("Candidato de áudio inválido.".into());
            }
            let cand_url = cand["url"].as_str().map(str::to_string);
            let delta_ms = cand["durationDeltaMs"].as_f64().unwrap_or(0.0);
            let score = cand["score"].as_f64().unwrap_or(85.0);

            track["catalogSource"] = json!(cat_src);
            track["durationMs"] = json!(resolver::track_duration_ms(&track));
            track["streamProvider"] = json!(provider);
            track["resolvedExternalId"] = json!(ext_id);
            if let Some(ref pub_url) = cand_url {
                if links::public_url(pub_url) {
                    track["resolvedStreamUrl"] = json!(pub_url);
                }
            }
            if s(&track, "source") == "link" {
                if ["ytmusic", "youtube"].contains(&provider.as_str())
                    && ext_id.len() == 11
                    && ext_id.bytes().all(|b| b.is_ascii_alphanumeric() || b"_-".contains(&b))
                {
                    track["playbackId"] = json!(ext_id);
                } else if let Some(obj) = track.as_object_mut() {
                    obj.remove("playbackId");
                }
            }
            db::validate_track(&track)?;
            {
                let guard = st.db.lock().unwrap();
                guard.save_stream_mapping(&db::StreamMapping {
                    source_track_id: key,
                    catalog_source: cat_src,
                    resolved_provider: provider,
                    resolved_id: ext_id,
                    resolved_url: cand_url,
                    duration_delta: delta_ms / 1000.0,
                    score,
                    updated_at: db::now(),
                })?;
                let exists: bool = guard
                    .db
                    .query_row(
                        "SELECT EXISTS(SELECT 1 FROM tracks WHERE id = ?)",
                        [s(&track, "id")],
                        |r| r.get(0),
                    )
                    .unwrap_or(false);
                if exists {
                    let _ = guard.save(&track, None);
                }
            }
            Ok(track)
        }
        "linkPlayback" => {
            let pref = st.db.lock().unwrap().pref();
            if pref["onlineConsent"] != true
                || pref["catalogConsent"] != true
                || pref["onboardingDone"] != true
            {
                return Err("Ative o acesso online para localizar o áudio desta música.".into());
            }
            let id = s(&p, "requestId").to_string();
            if !db::valid_id(&id) {
                return Err("Solicitação inválida.".into());
            }
            let token = tokio_util::sync::CancellationToken::new();
            {
                let mut search = st.search.lock().unwrap();
                if search.requests.len() >= 30 {
                    return Err("Muitas consultas simultâneas.".into());
                }
                if let Some(old) = search.requests.insert(id.clone(), token.clone()) {
                    old.cancel();
                }
            }
            let result = tokio::select! {
                _ = token.cancelled() => Err("Reprodução cancelada.".into()),
                r = async {
                    if let Ok(resolved) = resolver::resolve_stream(
                        p["track"].clone(),
                        resolver::ResolveOptions {
                            force_refresh: false,
                            exclude_ids: vec![],
                            preferred_provider: None,
                        },
                        &st.db,
                        &st.audio,
                        &st.base,
                        &st.catalog_url,
                        &st.direct,
                    )
                    .await
                    {
                        return Ok(resolved["track"].clone());
                    }
                    links::playback(p["track"].clone(), &st.catalog_url, &st.direct).await
                } => r
            };
            st.search.lock().unwrap().requests.remove(&id);
            result
        }
        "offlineSource" => {
            let id = p.as_str().ok_or("Faixa inválida.")?;
            let db = st.db.lock().unwrap();
            if let Some((path, duration)) = db.offline_path(id) {
                if offline::is_cached(&st.data, &path) {
                    return Ok(json!({
                        "url": format!(
                            "{}/offline/{}",
                            st.base,
                            url::form_urlencoded::byte_serialize(id.as_bytes()).collect::<String>()
                        ),
                        "duration": duration
                    }));
                }
                db.remove_offline(id)?;
            }
            Ok(Value::Null)
        }
        "downloadOffline" => {
            let pref = st.db.lock().unwrap().pref();
            if pref["onlineConsent"] != true || pref["onboardingDone"] != true {
                return Err("Ative o acesso online para baixar.".into());
            }
            db::validate_track(&p)?;
            if !["youtube", "link"].contains(&s(&p, "source")) {
                return Err("Esta origem não disponibiliza download neste app.".into());
            }
            let id = s(&p, "id").to_string();
            let operation = st.offline.begin(&id).await;
            let pref = st.db.lock().unwrap().pref();
            if pref["onlineConsent"] != true || pref["onboardingDone"] != true {
                return Err("Ative o acesso online para baixar.".into());
            }
            operation.ensure_current()?;
            {
                let db = st.db.lock().unwrap();
                if let Some((path, _)) = db.offline_path(&id) {
                    if offline::is_cached(&st.data, &path) {
                        return db.snapshot();
                    }
                    db.remove_offline(&id)?;
                }
            }
            static DOWNLOAD: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(2);
            let token = operation.token();
            let _permit = tokio::select! {
                biased;
                _ = token.cancelled() => return Err("Download cancelado.".into()),
                permit = DOWNLOAD.acquire() => permit.map_err(|_| "Serviço de download indisponível.")?,
            };
            let resolved: Result<(Value, offline::PendingDownload)> = tokio::select! {
                biased;
                _ = token.cancelled() => Err("Download cancelado.".into()),
                result = async {
                    let track = if p["source"] == "link" {
                        links::playback(p.clone(), &st.catalog_url, &st.direct).await?
                    } else {
                        p.clone()
                    };
                    db::validate_track(&track)?;
                    if s(&track, "id") != id {
                        return Err("A faixa resolvida mudou durante o download.".into());
                    }
                    let stream = st
                        .direct
                        .audio(track["playbackId"].as_str().unwrap_or(s(&track, "sourceId")))
                        .await?;
                    let progress_id = id.clone();
                    let progress_app = app.clone();
                    let pending = offline::download_with_progress(
                        &st.data,
                        &id,
                        &stream,
                        &token,
                        move |dl, tot| {
                            let pct = if tot > 0 {
                                ((dl as f64 / tot as f64) * 100.0).min(100.0)
                            } else {
                                0.0
                            };
                            let _ = progress_app.emit_to(
                                "main",
                                "download-progress",
                                json!({
                                    "trackId": progress_id,
                                    "downloadedBytes": dl,
                                    "totalBytes": tot,
                                    "percent": pct,
                                    "status": "downloading"
                                }),
                            );
                        },
                    )
                    .await?;
                    Ok((track, pending))
                } => result,
            };
            let (track, pending) = match resolved {
                Ok(pair) => pair,
                Err(err) => {
                    let status = if token.is_cancelled() || err.to_lowercase().contains("cancel") {
                        "cancelled"
                    } else {
                        "error"
                    };
                    let _ = app.emit_to(
                        "main",
                        "download-progress",
                        json!({
                            "trackId": id,
                            "downloadedBytes": 0,
                            "totalBytes": 0,
                            "percent": 0,
                            "status": status
                        }),
                    );
                    return Err(err);
                }
            };
            let db = st.db.lock().unwrap();
            let snap = offline::commit_pending(&db, &st.data, &track, &operation, pending);
            if snap.is_ok() {
                let _ = app.emit_to(
                    "main",
                    "download-progress",
                    json!({
                        "trackId": id,
                        "downloadedBytes": 1,
                        "totalBytes": 1,
                        "percent": 100,
                        "status": "completed"
                    }),
                );
            }
            snap
        }
        "cancelDownload" => {
            let id = p.as_str().ok_or("Faixa inválida.")?;
            st.offline.cancel(id);
            let _ = app.emit_to(
                "main",
                "download-progress",
                json!({
                    "trackId": id,
                    "downloadedBytes": 0,
                    "totalBytes": 0,
                    "percent": 0,
                    "status": "cancelled"
                }),
            );
            Ok(Value::Null)
        }
        "offlineSummary" => {
            let db = st.db.lock().unwrap();
            Ok(offline::list_entries(&st.data, &db))
        }
        "cacheGet" => {
            let pref = st.db.lock().unwrap().pref();
            if pref["onlineConsent"] != true || pref["onboardingDone"] != true {
                return Ok(Value::Null);
            }
            let key = s(&p, "key");
            Ok(st.db.lock().unwrap().get_discovery_cache(key).unwrap_or(Value::Null))
        }
        "cacheSet" => {
            let pref = st.db.lock().unwrap().pref();
            if pref["onlineConsent"] != true || pref["onboardingDone"] != true {
                return Ok(Value::Null);
            }
            let key = s(&p, "key");
            let sig = s(&p, "signature");
            let ttl_ms = p["ttlMs"].as_i64().unwrap_or(600_000);
            st.db
                .lock()
                .unwrap()
                .set_discovery_cache(key, sig, &p["payload"], ttl_ms)?;
            Ok(Value::Null)
        }
        "removeOffline" => {
            let id = p.as_str().ok_or("Faixa inválida.")?;
            let _removal = st.offline.removal(id).await;
            let db = st.db.lock().unwrap();
            if let Some((path, _)) = db.offline_path(id) {
                if offline::owned_path(&st.data, &path) {
                    let _ = std::fs::remove_file(path);
                }
            }
            db.remove_offline(id)?;
            db.snapshot()
        }
        "importAudio" => {
            #[cfg(desktop)]
            {
                if let Some(files) = rfd::AsyncFileDialog::new()
                    .set_title("Importar arquivos de áudio")
                    .add_filter(
                        "Áudio",
                        &["mp3", "flac", "wav", "m4a", "ogg", "opus", "aac", "webm"],
                    )
                    .pick_files()
                    .await
                {
                    let db = st.db.lock().unwrap();
                    for file in files.iter().take(500) {
                        let _ = media::import_file(&db, file.path(), &st.data);
                    }
                    db.snapshot()
                } else {
                    st.db.lock().unwrap().snapshot()
                }
            }
            #[cfg(mobile)]
            {
                Err("Importação local via seletor de arquivos indisponível no Android Beta.".into())
            }
        }
        "exportLibrary" => {
            #[cfg(desktop)]
            {
                let v = st.db.lock().unwrap().export(p.as_str())?;
                if let Some(file) = rfd::AsyncFileDialog::new()
                    .set_file_name("Liquid Hub - biblioteca.json")
                    .add_filter("Biblioteca JSON", &["json"])
                    .save_file()
                    .await
                {
                    std::fs::write(
                        file.path(),
                        serde_json::to_vec_pretty(&v).map_err(|e| e.to_string())?,
                    )
                    .map_err(|e| e.to_string())?;
                    Ok(json!(true))
                } else {
                    Ok(json!(false))
                }
            }
            #[cfg(mobile)]
            {
                Err("Exportação via seletor de arquivo indisponível no Android Beta.".into())
            }
        }
        "importLibrary" => {
            #[cfg(desktop)]
            {
                if let Some(file) = rfd::AsyncFileDialog::new()
                    .add_filter("Biblioteca JSON", &["json"])
                    .pick_file()
                    .await
                {
                    if std::fs::metadata(file.path())
                        .map_err(|e| e.to_string())?
                        .len()
                        > 8_000_000
                    {
                        return Err("Biblioteca maior que 8 MB.".into());
                    }
                    let v: Value = serde_json::from_slice(
                        &std::fs::read(file.path()).map_err(|e| e.to_string())?,
                    )
                    .map_err(|_| "JSON inválido")?;
                    let snap = st.db.lock().unwrap().import(&v)?;
                    st.search.lock().unwrap().cache.clear();
                    Ok(snap)
                } else {
                    Ok(Value::Null)
                }
            }
            #[cfg(mobile)]
            {
                Err("Importação de backup JSON indisponível no Android Beta.".into())
            }
        }
        "audioSource" => {
            let pref = st.db.lock().unwrap().pref();
            if pref["onlineConsent"] != true || pref["onboardingDone"] != true {
                return Err("Ative o acesso online antes de reproduzir.".into());
            }
            let video = s(&p, "videoId");
            let id = s(&p, "requestId").to_string();
            let title = s(&p, "title");
            let artist = s(&p, "artist");
            let duration = p["duration"].as_f64().unwrap_or(0.0);
            if !db::valid_id(&id) {
                return Err("Solicitação inválida.".into());
            }
            let valid_video = video.len() == 11
                && video
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"_-".contains(&b));
            let force_refresh = p["forceRefresh"] == true;
            if valid_video {
                if force_refresh {
                    st.audio.invalidate(video);
                } else if let Some((ticket, dur)) = st.audio.cached(video) {
                    return Ok(json!({"url": format!("{}/audio/{ticket}", st.base), "duration": dur}));
                }
            } else if title.is_empty() {
                return Err("Referência de música inválida.".into());
            }
            let token = tokio_util::sync::CancellationToken::new();
            {
                let mut search = st.search.lock().unwrap();
                if search.requests.len() >= 30 {
                    return Err("Muitas consultas simultâneas.".into());
                }
                if let Some(old) = search.requests.insert(id.clone(), token.clone()) {
                    old.cancel();
                }
            }
            let primary_future = async {
                if valid_video {
                    if let Ok(v) = st.direct.audio(video).await {
                        return Ok((video.to_string(), v));
                    }
                }
                if !title.is_empty() {
                    let (rescued_id, maybe_stream) = links::find_playable_youtube_id(
                        title,
                        artist,
                        duration,
                        video,
                        &st.catalog_url,
                        &st.direct,
                    )
                    .await?;
                    let stream = match maybe_stream {
                        Some(s) => s,
                        None => st.direct.audio(&rescued_id).await?,
                    };
                    return Ok((rescued_id, stream));
                }
                Err("A plataforma não disponibilizou áudio para esta faixa.".into())
            };
            let result: Result<(String, Value)> = tokio::select! {
                _ = token.cancelled() => Err("Reprodução cancelada.".into()),
                r = primary_future => r
            };
            st.search.lock().unwrap().requests.remove(&id);
            let (resolved_video, value) = result?;
            if token.is_cancelled() {
                return Err("Reprodução cancelada.".into());
            }
            let (ticket, dur) = st.audio.register(&resolved_video, &value)?;
            Ok(json!({
                "url": format!("{}/audio/{ticket}", st.base),
                "duration": dur,
                "videoId": resolved_video
            }))
        }
        "playerUrl" => Ok(json!(format!("{}/embed/index.html", st.base))),
        "external" => {
            let url = p.as_str().ok_or("Link inválido")?;
            if !db::official_url(url) && !links::public_url(url) {
                return Err("Link não autorizado.".into());
            }
            app.opener()
                .open_url(url, None::<&str>)
                .map_err(|_| "Não foi possível abrir o navegador.")?;
            Ok(Value::Null)
        }
        "lyrics" => {
            let pref = st.db.lock().unwrap().pref();
            if pref["onlineConsent"] != true || pref["onboardingDone"] != true {
                return Err("Ative o acesso online para carregar letras.".into());
            }
            db::validate_track(&p)?;
            let result = lyrics::fetch(&p).await?;
            if st.db.lock().unwrap().pref()["onlineConsent"] != true {
                return Err("Acesso online desativado.".into());
            }
            Ok(result)
        }
        "trackArtwork" => {
            let id = p
                .as_str()
                .filter(|id| db::valid_id(id))
                .ok_or("Faixa inválida.")?;
            let snapshot = st.db.lock().unwrap().snapshot()?;
            if snapshot["preferences"]["onlineConsent"] != true
                || snapshot["preferences"]["onboardingDone"] != true
            {
                return Ok(Value::Null);
            }
            let track = snapshot["tracks"]
                .as_array()
                .unwrap()
                .iter()
                .find(|t| t["id"] == id)
                .ok_or("Faixa não encontrada.")?;
            if !s(track, "artwork").is_empty() {
                return Ok(track["artwork"].clone());
            }
            if track["source"] == "local" {
                return Ok(Value::Null);
            }
            let art = links::track_artwork(s(track, "url")).await?;
            let db = st.db.lock().unwrap();
            if db.pref()["onlineConsent"] != true {
                return Ok(Value::Null);
            }
            let fresh = db.snapshot()?;
            if fresh["tracks"]
                .as_array()
                .unwrap()
                .iter()
                .any(|t| t["id"] == id)
            {
                db.set_track_artwork(id, &art)?;
                return Ok(json!(art));
            }
            Ok(Value::Null)
        }
        "playlistArtwork" => {
            let id = p
                .as_str()
                .filter(|id| db::valid_id(id))
                .ok_or("Playlist inválida.")?;
            let snapshot = st.db.lock().unwrap().snapshot()?;
            let list = snapshot["playlists"]
                .as_array()
                .and_then(|lists| lists.iter().find(|v| v["id"] == id))
                .ok_or("Playlist não encontrada.")?;
            if let Some(url) = list["artwork"].as_str() {
                if db::artwork_url(url) {
                    return Ok(json!(url));
                }
            }
            let tracks = snapshot["tracks"].as_array().unwrap();
            let ids = list["trackIds"].as_array().unwrap();
            if let Some(url) = tracks
                .iter()
                .filter(|t| ids.contains(&t["id"]))
                .map(|t| s(t, "artwork"))
                .find(|u| !u.is_empty())
            {
                st.db.lock().unwrap().collection_artwork(id, url)?;
                return Ok(json!(url));
            }
            if snapshot["preferences"]["onlineConsent"] != true
                || snapshot["preferences"]["onboardingDone"] != true
            {
                return Ok(Value::Null);
            }
            if let Some(track) = ids
                .iter()
                .filter_map(|tid| tracks.iter().find(|t| t["id"] == *tid))
                .find(|t| t["source"] != "local" && t["url"].is_string())
            {
                if let Ok(fresh) = links::resolve(s(track, "url")).await {
                    let url = s(&fresh, "artwork");
                    if db::artwork_url(url) {
                        let mut repaired = track.clone();
                        repaired["artwork"] = json!(url);
                        let db = st.db.lock().unwrap();
                        db.save(&repaired, None)?;
                        db.collection_artwork(id, url)?;
                        return Ok(json!(url));
                    }
                }
            }
            Ok(Value::Null)
        }
        "openLyrics" => {
            #[cfg(desktop)]
            {
                if let Some(w) = app.get_webview_window("lyrics") {
                    let _ = w.show();
                    let _ = w.set_focus();
                } else {
                    tauri::WebviewWindowBuilder::new(
                        &app,
                        "lyrics",
                        tauri::WebviewUrl::App("index.html?view=lyrics".into()),
                    )
                    .title("Letras · Liquid Hub")
                    .use_https_scheme(true)
                    .inner_size(460.0, 700.0)
                    .min_inner_size(340.0, 460.0)
                    .always_on_top(true)
                    .build()
                    .map_err(|e| e.to_string())?;
                }
                let _ = app.emit_to("main", "lyrics-window-open", true);
                Ok(Value::Null)
            }
            #[cfg(mobile)]
            {
                Ok(json!({ "inline": true }))
            }
        }
        "closeLyrics" => {
            #[cfg(desktop)]
            if let Some(w) = app.get_webview_window("lyrics") {
                let _ = w.close();
            }
            let _ = app.emit_to("main", "lyrics-window-open", false);
            Ok(Value::Null)
        }
        "pinLyrics" => {
            let pinned = p["pinned"].as_bool().unwrap_or(true);
            #[cfg(desktop)]
            if let Some(w) = app.get_webview_window("lyrics") {
                w.set_always_on_top(pinned).map_err(|e| e.to_string())?;
            }
            Ok(json!({ "pinned": pinned }))
        }
        "lyricsWindowOpen" => Ok(json!(app.get_webview_window("lyrics").is_some())),
        "lyricsState" => {
            let open = if let Some(w) = app.get_webview_window("lyrics") {
                if p.to_string().len() < 4_000_000 {
                    let _ = w.emit("lyrics-state", &p);
                }
                true
            } else {
                false
            };
            Ok(json!(open))
        }
        "lyricsControl" => {
            let action = s(&p, "action");
            if action == "seek"
                && !p["position"]
                    .as_f64()
                    .is_some_and(|n| (0.0..=604800.0).contains(&n))
            {
                return Err("Posição inválida.".into());
            }
            if !["seek", "toggle"].contains(&action) {
                return Err("Controle inválido.".into());
            }
            let _ = app.emit_to("main", "lyrics-control", &p);
            Ok(Value::Null)
        }
        "openJam" => {
            #[cfg(desktop)]
            {
                if let Some(w) = app.get_webview_window("jam") {
                    let _ = w.show();
                    let _ = w.set_focus();
                } else {
                    tauri::WebviewWindowBuilder::new(
                        &app,
                        "jam",
                        tauri::WebviewUrl::App("index.html?view=jam".into()),
                    )
                    .title("JAM · Liquid Hub")
                    .use_https_scheme(true)
                    .inner_size(480.0, 740.0)
                    .min_inner_size(380.0, 520.0)
                    .build()
                    .map_err(|e| e.to_string())?;
                }
                let _ = app.emit_to("main", "jam-window-open", true);
                Ok(Value::Null)
            }
            #[cfg(mobile)]
            {
                Ok(json!({ "inline": true }))
            }
        }
        "closeJam" => {
            #[cfg(desktop)]
            if let Some(w) = app.get_webview_window("jam") {
                let _ = w.close();
            }
            let _ = app.emit_to("main", "jam-window-open", false);
            Ok(Value::Null)
        }
        "pinJam" => {
            let pinned = p["pinned"].as_bool().unwrap_or(false);
            #[cfg(desktop)]
            if let Some(w) = app.get_webview_window("jam") {
                w.set_always_on_top(pinned).map_err(|e| e.to_string())?;
            }
            Ok(json!({ "pinned": pinned }))
        }
        "jamWindowOpen" => Ok(json!(app.get_webview_window("jam").is_some())),
        "jamState" => {
            let open = if let Some(w) = app.get_webview_window("jam") {
                if p.to_string().len() < 4_000_000 {
                    let _ = w.emit("jam-state", &p);
                }
                true
            } else {
                false
            };
            Ok(json!(open))
        }
        "jamControl" => {
            let ctrl = s(&p, "action");
            if ![
                "create",
                "lookup",
                "requestJoin",
                "cancelJoinRequest",
                "approveJoin",
                "rejectJoin",
                "blockMember",
                "unblockMember",
                "kick",
                "updateRoom",
                "rotateInvite",
                "voteSkip",
                "queueAdd",
                "queueRemove",
                "recommendPlaylist",
                "savePlaylist",
                "chat",
                "leave",
                "scanLan",
                "resync",
                "playTrack",
            ]
            .contains(&ctrl)
            {
                return Err("Controle de JAM inválido.".into());
            }
            let _ = app.emit_to("main", "jam-control", &p);
            Ok(Value::Null)
        }
        "windowShape" => {
            #[cfg(windows)]
            {
                let mut v = corners::inspect(window.hwnd().map_err(|e| e.to_string())?.0);
                v["frameworkMaximized"] = json!(window.is_maximized().unwrap_or(false));
                v["clippedDesktopBackdrop"] = json!(desktop_backdrop::enabled());
                Ok(v)
            }
            #[cfg(not(windows))]
            {
                Ok(json!({
                    "nativeRegion": false,
                    "frameworkMaximized": false,
                    "clippedDesktopBackdrop": false
                }))
            }
        }
        "visualState" => {
            #[cfg(windows)]
            {
                Ok(json!(window
                    .hwnd()
                    .map(|h| corners::visible(h.0))
                    .unwrap_or(true)))
            }
            #[cfg(not(windows))]
            {
                Ok(json!(true))
            }
        }
        "window" => {
            #[cfg(desktop)]
            {
                match p.as_str().unwrap_or("") {
                    "minimize" => {
                        let _ = decide_minimize_action();
                        window.minimize().map_err(|e| e.to_string())?;
                        let _ = app.emit_to("main", "glass-visual-visible", false);
                    }
                    "maximize" => {
                        if window.is_maximized().unwrap_or(false) {
                            window.unmaximize()
                        } else {
                            window.maximize()
                        }
                        .map_err(|e| e.to_string())?;
                    }
                    "close" => close(&app),
                    "mini" => {
                        let _ = window.unmaximize();
                        window
                            .set_min_size(Some(LogicalSize::new(440, 680)))
                            .map_err(|e| e.to_string())?;
                        window
                            .set_size(LogicalSize::new(440, 680))
                            .map_err(|e| e.to_string())?;
                        window.set_always_on_top(true).map_err(|e| e.to_string())?;
                    }
                    "restore" => {
                        window.unminimize().map_err(|e| e.to_string())?;
                        window.show().map_err(|e| e.to_string())?;
                        let _ = app.emit_to("main", "glass-visual-visible", true);
                        window.set_always_on_top(false).map_err(|e| e.to_string())?;
                        window
                            .set_size(main_window_size(&window))
                            .map_err(|e| e.to_string())?;
                        window
                            .set_min_size(Some(LogicalSize::new(920, 650)))
                            .map_err(|e| e.to_string())?;
                        let _ = window.center();
                    }
                    _ => return Err("Ação de janela inválida.".into()),
                }
                #[cfg(windows)]
                if let Ok(hwnd) = window.hwnd() {
                    corners::apply(hwnd.0, window.scale_factor().unwrap_or(1.0));
                }
                let _ = app.emit_to(
                    "main",
                    "glass-window-maximized",
                    window.is_maximized().unwrap_or(false),
                );
            }
            Ok(Value::Null)
        }
        "clearCache" => {
            st.search.lock().unwrap().cache.clear();
            let _ = st.db.lock().unwrap().clear_discovery_cache();
            media::clear_covers(&st.data);
            window
                .clear_all_browsing_data()
                .map_err(|e| e.to_string())?;
            Ok(Value::Null)
        }
        "jam" => {
            let pref = st.db.lock().unwrap().pref();
            let secrets_path = st.data.join("credentials.dpapi");
            jam::call(
                &app,
                &st.db,
                &st.secrets,
                &secrets_path,
                &st.jam_realtime,
                &p,
                db::s(&pref, "jamEndpoint"),
                pref["onlineConsent"] == true && pref["onboardingDone"] == true,
            )
            .await
        }
        "consumeDeepLink" => {
            let link = st.pending_deep_link.lock().unwrap().take();
            Ok(json!(link))
        }
        "dispatchDeepLink" => {
            let raw = p.as_str().unwrap_or("");
            Ok(json!(dispatch_deep_link(&app, raw)))
        }
        "updateStatus" => {
            let pref = st.db.lock().unwrap().pref();
            let db = st.db.clone();
            let backup = st.data.join("backups");
            updates::status(
                &app,
                pref["onlineConsent"] == true && pref["onboardingDone"] == true,
                p["install"] == true,
                move || updates::backup_library(&db.lock().unwrap(), &backup).map(|_| ()),
            )
            .await
        }
        "maintenanceStatus" => {
            let repair = p["repair"].as_bool().unwrap_or(false);
            updates::verify_and_repair(&st.db.lock().unwrap(), &st.data, repair)
        }
        "hubVersionPolicy" => accounts::hub_version_policy(&st.secrets, &p).await,
        "checkUpdates" => {
            let pref = st.db.lock().unwrap().pref();
            let value = updates::status(&app, pref["onlineConsent"] == true, false, || Ok(())).await?;
            Ok(value["message"].clone())
        }
        "mediaMetadata" => {
            let track_id = s(&p, "id");
            #[cfg(desktop)]
            let title = s(&p, "title").chars().take(100).collect::<String>();
            #[cfg(desktop)]
            let artist = s(&p, "artist").chars().take(100).collect::<String>();
            #[cfg(desktop)]
            let playing = p["playing"] == true;
            st.notifications.lock().unwrap().on_track_metadata(track_id);
            #[cfg(desktop)]
            if let Some(tray) = app.tray_by_id("main-tray") {
                let tip = if playing && !title.is_empty() {
                    if artist.is_empty() {
                        format!("Liquid Hub — {title}")
                    } else {
                        format!("Liquid Hub — {title} · {artist}")
                    }
                } else {
                    "Liquid Hub".to_string()
                };
                let _ = tray.set_tooltip(Some(tip));
            }
            Ok(Value::Null)
        }
        "notify" => {
            let pref = st.db.lock().unwrap().pref();
            let mode = media::resolve_notification_mode(&pref);
            #[cfg(desktop)]
            let native_focused = app
                .get_webview_window("main")
                .map(|w| {
                    w.is_focused().unwrap_or(false)
                        && !w.is_minimized().unwrap_or(false)
                        && w.is_visible().unwrap_or(true)
                })
                .unwrap_or(false);
            #[cfg(mobile)]
            let native_focused = false;
            let window_focused = native_focused || p["windowFocused"] == true;
            let title = s(&p, "title").chars().take(100).collect::<String>();
            let artist = s(&p, "artist").chars().take(100).collect::<String>();
            let fallback_id = format!("{title}|{artist}");
            let track_id = if s(&p, "id").is_empty() {
                fallback_id.as_str()
            } else {
                s(&p, "id")
            };
            let allowed = st
                .notifications
                .lock()
                .unwrap()
                .should_dispatch(mode, window_focused, track_id);
            if allowed && !title.is_empty() {
                let _ = app
                    .notification()
                    .remove_active(vec![media::NOW_PLAYING_SLOT_ID]);
                let _ = app
                    .notification()
                    .builder()
                    .id(media::NOW_PLAYING_SLOT_ID)
                    .group(media::NOW_PLAYING_TAG)
                    .silent()
                    .sound("Silent")
                    .title(title)
                    .body(artist)
                    .show();
            }
            Ok(Value::Null)
        }
        _ => Err("Operação não autorizada.".into()),
    }
}

#[cfg(any(all(desktop, debug_assertions), test))]
fn parse_debug_cdp_port(raw: &str) -> Option<u16> {
    raw.trim()
        .strip_prefix("--remote-debugging-port=")?
        .parse::<u16>()
        .ok()
        .filter(|port| *port >= 1024)
}

#[cfg(all(desktop, debug_assertions))]
fn debug_test_browser_args() -> Option<String> {
    std::env::var_os("GLASS_TEST_DATA")?;
    let raw = std::env::var("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS").ok()?;
    let port = parse_debug_cdp_port(&raw)?;
    // Pass the CDP port programmatically via CoreWebView2EnvironmentOptions so WebView2 v150+
    // honors it inside elevated CI runners (e.g. GitHub Actions windows-latest).
    Some(format!(
        "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection --autoplay-policy=no-user-gesture-required --remote-debugging-port={port}"
    ))
}

#[cfg(all(desktop, debug_assertions))]
fn debug_test_webview_data_dir() -> Option<PathBuf> {
    std::env::var_os("GLASS_TEST_DATA")?;
    std::env::var_os("WEBVIEW2_USER_DATA_FOLDER")
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default();
    #[cfg(desktop)]
    let builder = if std::env::var_os("GLASS_TEST_DATA").is_none() {
        builder.plugin(tauri_plugin_single_instance::init(|app, args, _| {
            if let Some(link) = deeplink::extract_from_args(args.iter().skip(1)) {
                dispatch_deep_link(app, &link);
                return;
            }
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.show();
                let _ = w.unminimize();
                let _ = w.set_focus();
                let _ = app.emit_to("main", "glass-visual-visible", true);
            }
        }))
    } else {
        builder
    };
    #[cfg(desktop)]
    let builder = builder
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(
            tauri_plugin_autostart::Builder::new()
                .app_name("Liquid Hub")
                .build(),
        )
        .plugin(tauri_plugin_global_shortcut::Builder::new().build());
    let builder = builder
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .invoke_handler(tauri::generate_handler![call])
        .setup(|app| {
            let window = {
                #[cfg(desktop)]
                {
                    let main_config = app
                        .config()
                        .app
                        .windows
                        .iter()
                        .find(|w| w.label == "main")
                        .ok_or("Configuração da janela principal ausente.")?;
                    #[cfg_attr(not(debug_assertions), allow(unused_mut))]
                    let mut main_builder =
                        tauri::WebviewWindowBuilder::from_config(app.handle(), main_config)?;
                    #[cfg(debug_assertions)]
                    {
                        if let Some(dir) = debug_test_webview_data_dir() {
                            std::fs::create_dir_all(&dir)?;
                            main_builder = main_builder.data_directory(dir);
                        }
                        if let Some(args) = debug_test_browser_args() {
                            main_builder = main_builder.additional_browser_args(&args);
                        }
                    }
                    let w = main_builder.build()?;
                    w.set_size(main_window_size(&w))?;
                    let _ = w.center();
                    #[cfg(windows)]
                    if let Ok(hwnd) = w.hwnd() {
                        corners::attach(hwnd.0);
                    }
                    w
                }
                #[cfg(mobile)]
                {
                    if let Some(existing) = app.get_webview_window("main") {
                        existing
                    } else {
                        tauri::WebviewWindowBuilder::new(
                            app.handle(),
                            "main",
                            tauri::WebviewUrl::App("index.html".into()),
                        )
                        .use_https_scheme(true)
                        .background_color(tauri::window::Color(11, 14, 17, 255))
                        .build()?
                    }
                }
            };
            let is_test = std::env::var_os("GLASS_TEST_DATA").is_some();
            let data = std::env::var_os("GLASS_TEST_DATA")
                .map(PathBuf::from)
                .unwrap_or(app.path().app_data_dir()?);
            std::fs::create_dir_all(&data)?;
            secrets::init_vault_dir(&data);
            if !is_test {
                migrate_legacy_profile_if_needed(&data);
                let _ = deeplink::register_windows_protocol();
            }
            let initial_deep_link = deeplink::extract_from_args(std::env::args().skip(1));
            let resources = app
                .path()
                .resource_dir()
                .unwrap_or_else(|_| data.clone());
            let db = Library::open(&data.join("library.sqlite"))?;
            media::seed(&db, &resources)?;
            let pref = db.pref();
            native_environment(&window, &pref);
            let keys = match secrets::Secrets::load(&data.join("credentials.dpapi")) {
                Ok(loaded) => loaded,
                Err(err) => {
                    #[cfg(mobile)]
                    {
                        eprintln!("Aviso mobile: cofre de credenciais reiniciado ({err})");
                        secrets::Secrets::default()
                    }
                    #[cfg(desktop)]
                    return Err(err.into());
                }
            };
            let db = Arc::new(Mutex::new(db));
            let audio = Arc::new(audio::AudioStreams::new());
            let base = media::serve(db.clone(), data.clone(), audio.clone())?;
            let accounts = match accounts::Accounts::load(&data) {
                Ok(loaded) => loaded,
                Err(err) => {
                    #[cfg(mobile)]
                    {
                        eprintln!("Aviso mobile: conexões reiniciadas ({err})");
                        let _ = std::fs::remove_file(data.join("accounts.dpapi"));
                        accounts::Accounts::load(&data)?
                    }
                    #[cfg(desktop)]
                    return Err(err.into());
                }
            };
            app.manage(State {
                accounts,
                offline: offline::Downloads::default(),
                db,
                secrets: Mutex::new(keys),
                search: Mutex::new(providers::SearchState::new()),
                data,
                base,
                audio,
                shortcuts: AtomicBool::new(false),
                catalog_url: catalog::configured_url()?,
                direct: direct_catalog::DirectCatalog::new(resources),
                notifications: Mutex::new(media::NotificationGate::new()),
                pending_deep_link: Mutex::new(initial_deep_link),
                jam_realtime: jam::JamRealtime::new(),
                hub_auth_gate: tokio::sync::Mutex::new(()),
                hub_oauth_cancel: Arc::new(AtomicBool::new(false)),
            });
            #[cfg(desktop)]
            {
                let menu = Menu::with_items(
                    app,
                    &[
                        &MenuItem::with_id(app, "show", "Abrir Liquid Hub", true, None::<&str>)?,
                        &MenuItem::with_id(
                            app,
                            "playPause",
                            "Reproduzir / pausar",
                            true,
                            None::<&str>,
                        )?,
                        &MenuItem::with_id(app, "next", "Próxima música", true, None::<&str>)?,
                        &MenuItem::with_id(app, "quit", "Sair", true, None::<&str>)?,
                    ],
                )?;
                if let Err(err) = TrayIconBuilder::with_id("main-tray")
                    .icon(app.default_window_icon().unwrap().clone())
                    .tooltip("Liquid Hub")
                    .menu(&menu)
                    .on_menu_event(|app, event| match event.id.as_ref() {
                        "quit" => app.exit(0),
                        "show" => {
                            if let Some(w) = app.get_webview_window("main") {
                                let _ = w.show();
                                let _ = w.unminimize();
                                let _ = w.set_focus();
                                let _ = app.emit_to("main", "glass-visual-visible", true);
                            }
                        }
                        "playPause" | "next" => {
                            let _ = app.emit_to("main", "media", event.id.as_ref());
                        }
                        _ => {}
                    })
                    .build(app)
                {
                    eprintln!("Aviso: ícone da bandeja indisponível: {err}");
                }
                if pref["globalShortcuts"] == true {
                    app.state::<State>()
                        .shortcuts
                        .store(shortcuts(app.handle(), true), Ordering::Relaxed);
                }
            }
            Ok(())
        });
    #[cfg(desktop)]
    let builder = builder.on_window_event(|window, event| {
        match event {
            tauri::WindowEvent::Resized(size) => {
                let _ = window.emit(
                    "glass-window-maximized",
                    window.is_maximized().unwrap_or(false),
                );
                #[cfg(windows)]
                {
                    if size.width > 0 && size.height > 0 {
                        if let Ok(hwnd) = window.hwnd() {
                            corners::apply(hwnd.0, window.scale_factor().unwrap_or(1.0));
                        }
                    }
                    let visible = window
                        .hwnd()
                        .map(|h| corners::visible(h.0))
                        .unwrap_or(true);
                    let _ = window.emit("glass-visual-visible", visible);
                }
                #[cfg(not(windows))]
                let _ = size;
            }
            tauri::WindowEvent::Moved(_)
            | tauri::WindowEvent::ThemeChanged(_)
            | tauri::WindowEvent::ScaleFactorChanged { .. } => {
                #[cfg(windows)]
                if let Ok(hwnd) = window.hwnd() {
                    corners::apply(hwnd.0, window.scale_factor().unwrap_or(1.0));
                }
            }
            tauri::WindowEvent::Focused(_) => {
                #[cfg(windows)]
                {
                    if let Ok(hwnd) = window.hwnd() {
                        corners::apply(hwnd.0, window.scale_factor().unwrap_or(1.0));
                    }
                    let visible = window
                        .hwnd()
                        .map(|h| corners::visible(h.0))
                        .unwrap_or(true);
                    let _ = window.emit("glass-visual-visible", visible);
                }
            }
            tauri::WindowEvent::Destroyed => {
                if window.label() == "lyrics" {
                    let _ = window
                        .app_handle()
                        .emit_to("main", "lyrics-window-open", false);
                } else if window.label() == "jam" {
                    let _ = window
                        .app_handle()
                        .emit_to("main", "jam-window-open", false);
                }
            }
            _ => {}
        }
        if let tauri::WindowEvent::CloseRequested { api, .. } = event {
            if window.label() == "main" {
                api.prevent_close();
                close(window.app_handle());
            }
        }
    });
    builder
        .run(tauri::generate_context!())
        .expect("Falha ao iniciar Liquid Hub");
}

#[cfg(test)]
mod main_tests {
    use super::{
        decide_close_action, decide_minimize_action, decision_pauses_audio, parse_debug_cdp_port,
        window_action_allowed, WindowLifecycleDecision,
    };

    #[test]
    fn jam_window_action_gate_blocks_privileged_commands() {
        for allowed in ["bootstrap", "jamControl", "closeJam", "pinJam", "search", "external"] {
            assert!(window_action_allowed("jam", allowed), "{allowed}");
        }
        for denied in ["jam", "secrets", "account", "auth", "db", "download", "window"] {
            assert!(!window_action_allowed("jam", denied), "{denied}");
        }
        assert!(window_action_allowed("main", "jam"));
        assert!(!window_action_allowed("lyrics", "jamControl"));
    }

    #[test]
    fn parse_debug_cdp_port_accepts_valid_unprivileged_port_only() {
        assert_eq!(parse_debug_cdp_port("--remote-debugging-port=9347"), Some(9347));
        assert_eq!(parse_debug_cdp_port("  --remote-debugging-port=9339  "), Some(9339));
        assert_eq!(parse_debug_cdp_port("--remote-debugging-port=80"), None);
        assert_eq!(parse_debug_cdp_port("--remote-debugging-port=9347 --disable-web-security"), None);
        assert_eq!(parse_debug_cdp_port("--disable-web-security"), None);
        assert_eq!(parse_debug_cdp_port(""), None);
    }

    #[test]
    fn window_minimize_and_tray_close_preserve_active_playback() {
        let minimize = decide_minimize_action();
        let tray_close = decide_close_action(true);
        let app_exit = decide_close_action(false);

        assert_eq!(minimize, WindowLifecycleDecision::MinimizeKeepPlayback);
        assert_eq!(tray_close, WindowLifecycleDecision::HideToTrayKeepPlayback);
        assert_eq!(app_exit, WindowLifecycleDecision::ExitApp);

        assert!(!decision_pauses_audio(minimize));
        assert!(!decision_pauses_audio(tray_close));
    }
}
