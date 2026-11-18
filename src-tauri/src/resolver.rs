use crate::{
    audio::AudioStreams,
    db::{self, canonical_mapping_key, now, s, Library, Result, StreamMapping},
    direct_catalog::DirectCatalog,
};
use serde_json::{json, Value};
use std::{collections::HashSet, sync::Mutex};

const NOISE_WORDS: &[&str] = &[
    "official",
    "audio",
    "video",
    "music",
    "lyrics",
    "lyric",
    "hd",
    "4k",
    "hq",
    "remastered",
    "remaster",
    "oficial",
    "clipe",
    "topic",
    "vevo",
    "visualizer",
    "feat",
    "ft",
    "explicit",
    "clean",
];

const FORBIDDEN_WORDS: &[&str] = &[
    "live",
    "cover",
    "tribute",
    "remix",
    "slowed",
    "reverb",
    "karaoke",
    "instrumental",
    "nightcore",
    "acoustic",
    "acustico",
    "parody",
    "parodia",
];

const FORBIDDEN_PHRASES: &[&str] = &[
    "ao vivo",
    "sped up",
    "bass boosted",
    "8d audio",
    "karaoke version",
];

pub fn infer_catalog_source(track: &Value) -> &'static str {
    match s(track, "catalogSource") {
        "spotify" => return "spotify",
        "deezer" => return "deezer",
        "ytmusic" => return "ytmusic",
        "youtube" => return "youtube",
        "soundcloud" => return "soundcloud",
        "local" => return "local",
        _ => {}
    }
    if s(track, "source") == "local" {
        return "local";
    }
    if let Ok(u) = url::Url::parse(s(track, "url")) {
        match u.host_str().unwrap_or("") {
            "open.spotify.com" => return "spotify",
            "deezer.com" | "www.deezer.com" => return "deezer",
            "music.youtube.com" => return "ytmusic",
            "soundcloud.com" | "www.soundcloud.com" => return "soundcloud",
            "youtube.com" | "www.youtube.com" | "youtu.be" => {
                return if s(track, "artist").to_lowercase().ends_with(" - topic") {
                    "ytmusic"
                } else {
                    "youtube"
                };
            }
            _ => {}
        }
    }
    match s(track, "source") {
        "soundcloud" => "soundcloud",
        "youtube" => {
            if s(track, "artist").to_lowercase().ends_with(" - topic") {
                "ytmusic"
            } else {
                "youtube"
            }
        }
        _ => "spotify",
    }
}

pub fn track_duration_ms(track: &Value) -> f64 {
    if let Some(ms) = track["durationMs"].as_f64() {
        if ms.is_finite() && ms >= 0.0 {
            return ms.round();
        }
    }
    (track["duration"].as_f64().unwrap_or(0.0).max(0.0) * 1000.0).round()
}

pub fn normalize_ascii_lower(raw: &str) -> String {
    let mapped: String = raw
        .to_lowercase()
        .chars()
        .map(|c| match c {
            'á' | 'à' | 'â' | 'ã' | 'ä' => 'a',
            'é' | 'è' | 'ê' | 'ë' => 'e',
            'í' | 'ì' | 'î' | 'ï' => 'i',
            'ó' | 'ò' | 'ô' | 'õ' | 'ö' => 'o',
            'ú' | 'ù' | 'û' | 'ü' => 'u',
            'ç' => 'c',
            'ñ' => 'n',
            c if c.is_ascii_alphanumeric() => c,
            _ => ' ',
        })
        .collect();
    mapped.split_whitespace().collect::<Vec<_>>().join(" ")
}

pub fn strip_edition(raw: &str) -> String {
    let mut out = raw.to_string();
    for sep in [" - ", " (", " ["] {
        if let Some((left, right)) = out.split_once(sep) {
            let low = right.to_lowercase();
            if [
                "deluxe",
                "remaster",
                "bonus",
                "radio edit",
                "version",
                "versão",
                "versao",
                "explicit",
                "clean",
                "mono",
                "stereo",
                "feat.",
                "ft.",
            ]
            .iter()
            .any(|k| low.contains(k))
            {
                out = left.to_string();
            }
        }
    }
    out.trim().to_string()
}

pub fn extract_tokens(raw: &str) -> Vec<String> {
    let clean = raw
        .split_once(" (feat.")
        .or_else(|| raw.split_once(" (ft."))
        .or_else(|| raw.split_once(" [feat."))
        .map(|(h, _)| h)
        .unwrap_or(raw);
    normalize_ascii_lower(clean)
        .split_whitespace()
        .filter(|w| !w.is_empty() && !NOISE_WORDS.contains(w))
        .map(str::to_string)
        .collect()
}

pub fn primary_artist(raw: &str) -> &str {
    raw.split([',', '&', ';', '/'])
        .next()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or(raw)
}

pub fn build_resolver_query(title: &str, artist: &str) -> String {
    let clean_title = strip_edition(title);
    let prim = primary_artist(artist);
    if ["Spotify", "Deezer", "Apple Music", "Tidal", "Bandcamp", "YouTube", "SoundCloud"]
        .contains(&artist)
        || prim.is_empty()
    {
        format!("{clean_title} Audio")
    } else {
        format!("{prim} - {clean_title} Audio")
    }
}

fn coverage(wanted: &[String], found: &[String]) -> f64 {
    if wanted.is_empty() {
        return 0.0;
    }
    let hits = wanted.iter().filter(|w| found.contains(w)).count();
    hits as f64 / wanted.len() as f64
}

fn has_unrequested_modifier(ref_raw: &str, cand_raw: &str) -> bool {
    let ref_norm = format!(" {} ", normalize_ascii_lower(ref_raw));
    let cand_norm = format!(" {} ", normalize_ascii_lower(cand_raw));
    for phrase in FORBIDDEN_PHRASES {
        let needle = format!(" {phrase} ");
        if cand_norm.contains(&needle) && !ref_norm.contains(&needle) {
            return true;
        }
    }
    let ref_words: HashSet<&str> = ref_norm.split_whitespace().collect();
    for word in cand_norm.split_whitespace() {
        if FORBIDDEN_WORDS.contains(&word) && !ref_words.contains(word) {
            return true;
        }
    }
    false
}

fn provider_rank(provider: &str) -> u8 {
    match provider {
        "ytmusic" => 0,
        "deezer" => 1,
        "soundcloud" => 2,
        "youtube" => 3,
        _ => 9,
    }
}

/// Scores a stream candidate on a 0..100 scale against the catalog reference track.
/// Returns None if the candidate violates critical duration delta, is a 30s preview, or is an unrequested Live/Cover/Remix.
pub fn score_candidate(reference: &Value, candidate: &Value, provider: &str) -> Option<f64> {
    let ref_ms = track_duration_ms(reference);
    let cand_ms = track_duration_ms(candidate);
    let ref_sec = ref_ms / 1000.0;
    let cand_sec = cand_ms / 1000.0;

    // 1. Critical Duration Delta (up to 40 pts; rejects 30s DRM previews and >18s music-video stories/loops)
    if ref_sec > 45.0 && cand_sec > 0.0 && cand_sec <= 35.0 {
        return None;
    }
    if ref_sec > 0.0 && cand_sec <= 0.0 {
        return None;
    }

    let duration_score = if ref_sec > 0.0 && cand_sec > 0.0 {
        let delta = (ref_sec - cand_sec).abs();
        if delta > 18.0_f64.max(ref_sec * 0.12) {
            return None;
        }
        if delta <= 2.0 {
            40.0
        } else if delta <= 5.0 {
            40.0 - ((delta - 2.0) / 3.0) * 10.0
        } else if delta <= 10.0 {
            30.0 - ((delta - 5.0) / 5.0) * 15.0
        } else {
            (5.0 - (delta - 10.0) * 3.5).max(-25.0)
        }
    } else {
        22.0
    };

    // 2. Title & Artist Fidelity (up to 45 pts) + Forbidden Version Rejection
    let ref_combined = format!("{} {}", s(reference, "title"), s(reference, "artist"));
    let cand_combined = format!("{} {}", s(candidate, "title"), s(candidate, "artist"));
    if has_unrequested_modifier(&ref_combined, &cand_combined) {
        return None;
    }

    let ref_title_tokens = extract_tokens(&strip_edition(s(reference, "title")));
    if ref_title_tokens.is_empty() {
        return None;
    }
    let cand_artist_clean = s(candidate, "artist")
        .trim_end_matches(" - Topic")
        .trim_end_matches(" - topic");
    let mut cand_all = extract_tokens(s(candidate, "title"));
    cand_all.extend(extract_tokens(cand_artist_clean));

    let title_cov = coverage(&ref_title_tokens, &cand_all);
    if title_cov < 0.55 {
        return None;
    }

    let ref_artist = s(reference, "artist");
    let artist_cov = if [
        "Spotify",
        "Deezer",
        "Apple Music",
        "Tidal",
        "Bandcamp",
        "YouTube",
        "SoundCloud",
    ]
    .contains(&ref_artist)
    {
        0.6
    } else {
        let full = coverage(&extract_tokens(ref_artist), &cand_all);
        let prim = coverage(&extract_tokens(primary_artist(ref_artist)), &cand_all) * 0.95;
        let best = full.max(prim);
        if best < 0.45 && title_cov < 0.90 {
            return None;
        }
        best
    };

    let fidelity_score = title_cov * 27.0 + artist_cov * 18.0;

    // 3. Official Channel / Topic / ISRC / Provider Bonus (up to 15 pts)
    let raw_artist_low = s(candidate, "artist").to_lowercase();
    let raw_title_low = s(candidate, "title").to_lowercase();
    let is_topic = raw_artist_low.ends_with(" - topic") || provider == "ytmusic";
    let is_official_audio = raw_title_low.contains("official audio")
        || raw_title_low.contains("audio oficial")
        || raw_title_low.contains("áudio oficial");
    let is_music_video = raw_title_low.contains("official video")
        || raw_title_low.contains("music video")
        || raw_title_low.contains("clipe oficial");

    let isrc_a = s(reference, "isrc").replace('-', "").to_uppercase();
    let isrc_b = s(candidate, "isrc").replace('-', "").to_uppercase();
    let isrc_match = !isrc_a.is_empty() && isrc_a == isrc_b;

    let mut bonus: f64 = if isrc_match {
        15.0
    } else if is_topic {
        12.0
    } else if is_official_audio {
        9.0
    } else {
        0.0
    };

    bonus += match provider {
        "ytmusic" => 3.0,
        "deezer" => 2.5,
        "soundcloud" => 2.0,
        _ => 1.0,
    };

    if is_music_video && !is_topic && !is_official_audio {
        bonus -= 4.0;
    }

    let total = ((duration_score + fidelity_score + bonus.min(15.0)) * 10.0).round() / 10.0;
    let clamped = total.clamp(0.0, 100.0);
    if clamped < 55.0 {
        None
    } else {
        Some(clamped)
    }
}

pub async fn enrich_catalog_metadata(mut track: Value) -> Value {
    let artist = s(&track, "artist");
    let dur = track["duration"].as_f64().unwrap_or(0.0);
    if (["Spotify", "Deezer", "Apple Music", "Tidal"].contains(&artist) || dur <= 0.0)
        && crate::links::public_url(s(&track, "url"))
    {
        if let Ok(fresh) = crate::links::resolve(s(&track, "url")).await {
            if !s(&fresh, "artist").is_empty() && s(&fresh, "artist") != "Spotify" {
                track["artist"] = fresh["artist"].clone();
            }
            if dur <= 0.0 && fresh["duration"].as_f64().unwrap_or(0.0) > 0.0 {
                track["duration"] = fresh["duration"].clone();
                track["durationMs"] = fresh["durationMs"].clone();
            }
            if s(&track, "isrc").is_empty() && !s(&fresh, "isrc").is_empty() {
                track["isrc"] = fresh["isrc"].clone();
            }
        }
    }
    // Cross-enrich ISRC or missing exact duration via public Deezer API if needed
    if s(&track, "isrc").is_empty() || track["duration"].as_f64().unwrap_or(0.0) <= 0.0 {
        if !s(&track, "isrc").is_empty() {
            if let Some(dz) = crate::platforms::lookup_deezer_isrc(s(&track, "isrc")).await {
                if track["duration"].as_f64().unwrap_or(0.0) <= 0.0 {
                    track["duration"] = dz["duration"].clone();
                    track["durationMs"] = dz["durationMs"].clone();
                }
            }
        }
    }
    track
}

/// Searches YT Music, SoundCloud and YouTube in parallel (never attempting Spotify stream extraction)
/// and returns scored `StreamCandidate` objects ordered by descending score (0..100).
pub async fn search_candidates(
    raw_track: &Value,
    catalog: &str,
    direct: &DirectCatalog,
) -> Result<Vec<Value>> {
    let reference = enrich_catalog_metadata(raw_track.clone()).await;
    let title = s(&reference, "title");
    let artist = s(&reference, "artist");
    if title.trim().is_empty() {
        return Err("Título da música ausente para resolução.".into());
    }
    let query = build_resolver_query(title, artist);
    let plain_query = format!("{} {}", primary_artist(artist), strip_edition(title))
        .trim()
        .to_string();

    let yt_req = json!({ "query": query, "kind": "track" });
    let sc_req = json!({ "query": plain_query, "kind": "track" });

    let (ytm_res, yt_res, sc_res) = tokio::join!(
        async {
            if catalog.is_empty() {
                direct.ytmusic_search(&plain_query).await.ok()
            } else {
                None
            }
        },
        async {
            if catalog.is_empty() {
                direct.search("youtube", &yt_req).await.ok()
            } else {
                crate::catalog::search(catalog, "youtube", &yt_req).await.ok()
            }
        },
        async {
            if catalog.is_empty() {
                if direct.available() {
                    direct.search("soundcloud", &sc_req).await.ok()
                } else {
                    None
                }
            } else {
                crate::catalog::search(catalog, "soundcloud", &sc_req).await.ok()
            }
        }
    );

    let ref_ms = track_duration_ms(&reference);
    let mut out = Vec::new();
    let mut seen = HashSet::new();

    let groups: &[(&str, Option<Value>)] = &[
        ("ytmusic", ytm_res),
        ("youtube", yt_res),
        ("soundcloud", sc_res),
    ];

    for (hint_provider, maybe_val) in groups {
        let Some(val) = maybe_val else { continue };
        let Some(items) = val["items"].as_array() else {
            continue;
        };
        for item in items {
            if item["available"] == false || s(item, "reason").contains("prévia") {
                continue;
            }
            let is_topic = s(item, "artist").to_lowercase().ends_with(" - topic")
                || *hint_provider == "ytmusic";
            let provider = if *hint_provider == "youtube" && is_topic {
                "ytmusic"
            } else {
                *hint_provider
            };
            let ext_id = s(item, "sourceId");
            if ext_id.is_empty() {
                continue;
            }
            let dedup = format!("{provider}:{ext_id}");
            if seen.contains(&dedup) {
                continue;
            }
            let Some(score) = score_candidate(&reference, item, provider) else {
                continue;
            };
            seen.insert(dedup);
            let cand_ms = track_duration_ms(item);
            let delta_ms = if ref_ms > 0.0 {
                (ref_ms - cand_ms).abs().round()
            } else {
                0.0
            };
            let url = if provider == "ytmusic" {
                format!("https://music.youtube.com/watch?v={ext_id}")
            } else {
                s(item, "url").to_string()
            };
            let mut candidate = json!({
                "provider": provider,
                "id": ext_id,
                "title": s(item, "title"),
                "artist": s(item, "artist"),
                "duration": item["duration"].as_f64().unwrap_or(0.0),
                "durationMs": cand_ms,
                "durationDeltaMs": delta_ms,
                "score": score,
                "url": url,
                "isOfficialTopic": is_topic
            });
            if !s(item, "artwork").is_empty() {
                candidate["artwork"] = item["artwork"].clone();
            }
            out.push(candidate);
        }
    }

    out.sort_by(|a, b| {
        let sa = a["score"].as_f64().unwrap_or(0.0);
        let sb = b["score"].as_f64().unwrap_or(0.0);
        if (sb - sa).abs() > 0.5 {
            sb.total_cmp(&sa)
        } else {
            provider_rank(s(a, "provider")).cmp(&provider_rank(s(b, "provider")))
        }
    });

    Ok(out)
}

async fn materialize_stream(
    provider: &str,
    ext_id: &str,
    ext_url: Option<&str>,
    audio_streams: &AudioStreams,
    base_url: &str,
    catalog: &str,
    direct: &DirectCatalog,
) -> Result<(String, f64)> {
    let cache_key = format!("{provider}:{ext_id}");
    if let Some((ticket, dur)) = audio_streams.cached(&cache_key) {
        return Ok((format!("{base_url}/audio/{ticket}"), dur));
    }
    if ["ytmusic", "youtube"].contains(&provider) {
        if let Some((ticket, dur)) = audio_streams.cached(ext_id) {
            return Ok((format!("{base_url}/audio/{ticket}"), dur));
        }
        if !catalog.is_empty() && !direct.available() {
            // Hosted-catalog-only environment without local extractor
            return Err("Extrator local ausente para stream direto.".into());
        }
        let raw_stream = direct.audio(ext_id).await?;
        let (ticket, dur) = audio_streams.register(ext_id, &raw_stream)?;
        return Ok((format!("{base_url}/audio/{ticket}"), dur));
    }
    if provider == "soundcloud" {
        let sc_url = ext_url.ok_or("URL do SoundCloud ausente para extração.")?;
        let raw_stream = direct.soundcloud_audio(sc_url).await?;
        let (ticket, dur) = audio_streams.register(&cache_key, &raw_stream)?;
        return Ok((format!("{base_url}/audio/{ticket}"), dur));
    }
    Err("Provedor de stream não suportado.".into())
}

pub struct ResolveOptions {
    pub force_refresh: bool,
    pub exclude_ids: Vec<String>,
    pub preferred_provider: Option<String>,
}

/// Resolves a catalog track (Spotify, Deezer, Apple Music, or broken stream) into a verified local proxy stream URL,
/// consulting `track_stream_mappings` first and falling back across YT Music -> SoundCloud -> YouTube on failure.
pub async fn resolve_stream(
    track: Value,
    opts: ResolveOptions,
    db: &Mutex<Library>,
    audio_streams: &AudioStreams,
    base_url: &str,
    catalog: &str,
    direct: &DirectCatalog,
) -> Result<Value> {
    db::validate_track(&track)?;
    let key = canonical_mapping_key(&track);
    let catalog_src = infer_catalog_source(&track).to_string();
    let excluded: HashSet<String> = opts.exclude_ids.into_iter().collect();

    // 1. Persistent SQLite `track_stream_mappings` fast path
    if !opts.force_refresh && opts.preferred_provider.is_none() {
        let cached = db.lock().unwrap().get_stream_mapping(&key);
        if let Some(m) = cached {
            if !excluded.contains(&m.resolved_id) {
                match materialize_stream(
                    &m.resolved_provider,
                    &m.resolved_id,
                    m.resolved_url.as_deref(),
                    audio_streams,
                    base_url,
                    catalog,
                    direct,
                )
                .await
                {
                    Ok((stream_url, dur)) => {
                        let mut updated = track.clone();
                        updated["catalogSource"] = json!(catalog_src);
                        updated["durationMs"] = json!(track_duration_ms(&track));
                        updated["streamProvider"] = json!(m.resolved_provider);
                        updated["resolvedExternalId"] = json!(m.resolved_id);
                        if let Some(ref pub_url) = m.resolved_url {
                            if crate::links::public_url(pub_url) {
                                updated["resolvedStreamUrl"] = json!(pub_url);
                            }
                        }
                        if s(&updated, "source") == "link"
                            && ["ytmusic", "youtube"].contains(&m.resolved_provider.as_str())
                            && m.resolved_id.len() == 11
                        {
                            updated["playbackId"] = json!(m.resolved_id);
                        }
                        return Ok(json!({
                            "track": updated,
                            "provider": m.resolved_provider,
                            "externalId": m.resolved_id,
                            "streamUrl": stream_url,
                            "duration": if dur > 0.0 { dur } else { track["duration"].as_f64().unwrap_or(0.0) },
                            "durationDeltaMs": (m.duration_delta * 1000.0).round(),
                            "score": m.score,
                            "fromCache": true
                        }));
                    }
                    Err(_) => {
                        // Cached link expired or became unavailable -> invalidate and re-resolve!
                        let _ = db.lock().unwrap().invalidate_stream_mapping(&key);
                    }
                }
            }
        }
    }

    // 2. Parallel Multi-Provider Search + Cascade Fallback (#1 -> #2 -> #3...)
    let mut candidates = search_candidates(&track, catalog, direct).await?;
    candidates.retain(|c| !excluded.contains(s(c, "id")));

    if let Some(ref pref) = opts.preferred_provider {
        candidates.sort_by_key(|c| if s(c, "provider") == pref { 0 } else { 1 });
    }

    if candidates.is_empty() {
        return Err("Não encontrei uma fonte de áudio compatível para esta música.".into());
    }

    for cand in candidates.iter().take(6) {
        let provider = s(cand, "provider").to_string();
        let ext_id = s(cand, "id").to_string();
        let cand_url = cand["url"].as_str().map(str::to_string);
        let delta_ms = cand["durationDeltaMs"].as_f64().unwrap_or(0.0);
        let score = cand["score"].as_f64().unwrap_or(0.0);

        match materialize_stream(
            &provider,
            &ext_id,
            cand_url.as_deref(),
            audio_streams,
            base_url,
            catalog,
            direct,
        )
        .await
        {
            Ok((stream_url, dur)) => {
                let mapping = StreamMapping {
                    source_track_id: key.clone(),
                    catalog_source: catalog_src.clone(),
                    resolved_provider: provider.clone(),
                    resolved_id: ext_id.clone(),
                    resolved_url: cand_url.clone(),
                    duration_delta: delta_ms / 1000.0,
                    score,
                    updated_at: now(),
                };
                let mut updated = track.clone();
                updated["catalogSource"] = json!(catalog_src);
                updated["durationMs"] = json!(track_duration_ms(&track));
                updated["streamProvider"] = json!(provider);
                updated["resolvedExternalId"] = json!(ext_id);
                if let Some(ref pub_url) = cand_url {
                    if crate::links::public_url(pub_url) {
                        updated["resolvedStreamUrl"] = json!(pub_url);
                    }
                }
                if s(&updated, "source") == "link"
                    && ["ytmusic", "youtube"].contains(&provider.as_str())
                    && ext_id.len() == 11
                {
                    updated["playbackId"] = json!(ext_id);
                }
                {
                    let guard = db.lock().unwrap();
                    let _ = guard.save_stream_mapping(&mapping);
                    // Persist updated mapping onto track row if track already exists in library
                    let exists: bool = guard
                        .db
                        .query_row(
                            "SELECT EXISTS(SELECT 1 FROM tracks WHERE id = ?)",
                            [s(&updated, "id")],
                            |r| r.get(0),
                        )
                        .unwrap_or(false);
                    if exists {
                        let _ = guard.save(&updated, None);
                    }
                }
                return Ok(json!({
                    "track": updated,
                    "provider": provider,
                    "externalId": ext_id,
                    "streamUrl": stream_url,
                    "duration": if dur > 0.0 { dur } else { cand["duration"].as_f64().unwrap_or(0.0) },
                    "durationDeltaMs": delta_ms,
                    "score": score,
                    "fromCache": false
                }));
            }
            Err(_) => continue,
        }
    }

    Err("Todas as fontes de áudio candidatas falharam ou estão indisponíveis.".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scores_topic_highest_and_rejects_live_cover_slowed_and_30s_previews() {
        let spotify_ref = json!({
            "title": "Blinding Lights",
            "artist": "The Weeknd",
            "duration": 200.04,
            "durationMs": 200040,
            "catalogSource": "spotify"
        });

        let ytm_topic = json!({
            "title": "Blinding Lights",
            "artist": "The Weeknd - Topic",
            "duration": 200.0,
            "durationMs": 200000
        });
        let yt_video_story = json!({
            "title": "The Weeknd - Blinding Lights (Official Video)",
            "artist": "The Weeknd",
            "duration": 262.0,
            "durationMs": 262000
        });
        let yt_live = json!({
            "title": "The Weeknd - Blinding Lights (Ao Vivo)",
            "artist": "The Weeknd",
            "duration": 201.0,
            "durationMs": 201000
        });
        let yt_slowed = json!({
            "title": "Blinding Lights (Slowed + Reverb)",
            "artist": "The Weeknd",
            "duration": 200.0,
            "durationMs": 200000
        });
        let preview_30s = json!({
            "title": "Blinding Lights",
            "artist": "The Weeknd",
            "duration": 30.0,
            "durationMs": 30000
        });
        let sc_good = json!({
            "title": "Blinding Lights",
            "artist": "The Weeknd",
            "duration": 201.0,
            "durationMs": 201000
        });

        let s_topic = score_candidate(&spotify_ref, &ytm_topic, "ytmusic").unwrap();
        let s_sc = score_candidate(&spotify_ref, &sc_good, "soundcloud").unwrap();
        assert!(s_topic >= 95.0, "expected >= 95, got {s_topic}");
        assert!(s_topic > s_sc, "YT Music Topic should outrank plain SoundCloud");

        assert!(score_candidate(&spotify_ref, &yt_video_story, "youtube").is_none());
        assert!(score_candidate(&spotify_ref, &yt_live, "youtube").is_none());
        assert!(score_candidate(&spotify_ref, &yt_slowed, "youtube").is_none());
        assert!(score_candidate(&spotify_ref, &preview_30s, "deezer").is_none());
    }
}
