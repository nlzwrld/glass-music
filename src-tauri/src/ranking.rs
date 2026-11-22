use crate::{
    db::s,
    resolver::{extract_tokens, infer_catalog_source, normalize_ascii_lower, primary_artist},
};
use serde_json::Value;
use std::collections::HashSet;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum SearchTier {
    CoverOrReupload = 1,
    OfficialRemix = 2,
    OfficialAlternative = 3,
    OriginalOfficial = 4,
}

const COVER_REUPLOAD_WORDS: &[&str] = &[
    "cover",
    "covers",
    "tribute",
    "karaoke",
    "instrumental",
    "slowed",
    "reverb",
    "nightcore",
    "daycore",
    "parody",
    "parodia",
    "reupload",
    "bootleg",
];

const COVER_REUPLOAD_PHRASES: &[&str] = &[
    "sped up",
    "speed up",
    "bass boosted",
    "8d audio",
    "karaoke version",
    "type beat",
    "slowed reverb",
    "slowed and reverb",
];

const UNOFFICIAL_CHANNEL_WORDS: &[&str] = &[
    "lyrics",
    "letra",
    "letras",
    "traducao",
    "legendado",
    "karaoke",
    "covers",
    "nightcore",
    "8d",
    "fan",
    "fanclub",
    "reupload",
    "edits",
];

const REMIX_WORDS: &[&str] = &["remix", "remixed", "mashup"];
const REMIX_PHRASES: &[&str] = &["vip mix", "club mix", "dub mix", "extended remix"];

const ALTERNATIVE_WORDS: &[&str] = &[
    "live",
    "acoustic",
    "acustico",
    "acustica",
    "unplugged",
    "deluxe",
    "remaster",
    "remastered",
    "session",
    "sessions",
    "extended",
    "orchestral",
];

const ALTERNATIVE_PHRASES: &[&str] = &[
    "ao vivo",
    "radio edit",
    "piano version",
    "acoustic version",
    "versao acustica",
    "tiny desk",
];

fn contains_word(haystack_words: &HashSet<&str>, words: &[&str], query_words: &HashSet<&str>) -> bool {
    words
        .iter()
        .any(|w| haystack_words.contains(w) && !query_words.contains(w))
}

fn contains_phrase(haystack_padded: &str, phrases: &[&str], query_padded: &str) -> bool {
    phrases.iter().any(|p| {
        let needle = format!(" {p} ");
        haystack_padded.contains(&needle) && !query_padded.contains(&needle)
    })
}

fn looks_like_fan_reupload(item: &Value, query_words: &HashSet<&str>) -> bool {
    let source = s(item, "source");
    if !matches!(source, "youtube" | "soundcloud") {
        return false;
    }
    let raw_artist = s(item, "artist");
    let raw_artist_low = raw_artist.to_lowercase();
    if raw_artist_low.ends_with(" - topic") || raw_artist_low.contains("vevo") {
        return false;
    }

    let artist_norm = format!(" {} ", normalize_ascii_lower(raw_artist));
    let artist_words: HashSet<&str> = artist_norm.split_whitespace().collect();
    if UNOFFICIAL_CHANNEL_WORDS
        .iter()
        .any(|w| artist_words.contains(w) && !query_words.contains(w))
    {
        return true;
    }

    // Check YouTube titles formatted as "OriginalArtist - Song" uploaded by an unrelated channel
    if source == "youtube" {
        let raw_title = s(item, "title");
        if let Some((lead, _rest)) = raw_title.split_once(" - ") {
            let lead_tokens: Vec<String> = extract_tokens(primary_artist(lead))
                .into_iter()
                .filter(|t| t.len() >= 2)
                .collect();
            let channel_tokens: HashSet<String> = extract_tokens(raw_artist).into_iter().collect();
            if !lead_tokens.is_empty()
                && !channel_tokens.is_empty()
                && !lead_tokens.iter().any(|t| channel_tokens.contains(t))
            {
                let combined_low = raw_title.to_lowercase();
                // Allow well-known official label prefixes only if title lacks obvious fan/lyrics tags,
                // otherwise treat unrelated channel as a third-party reupload.
                if combined_low.contains("letra")
                    || combined_low.contains("lyric")
                    || combined_low.contains("tradu")
                    || !channel_tokens.iter().any(|t| t == "records" || t == "music")
                {
                    return true;
                }
            }
        }
    }
    false
}

pub fn classify_search_tier(item: &Value, query: &str) -> SearchTier {
    let query_norm = format!(" {} ", normalize_ascii_lower(query));
    let query_words: HashSet<&str> = query_norm.split_whitespace().collect();

    let title_norm = format!(" {} ", normalize_ascii_lower(s(item, "title")));
    let artist_norm = format!(" {} ", normalize_ascii_lower(s(item, "artist")));
    let combined_norm = format!("{title_norm} {artist_norm}");
    let combined_words: HashSet<&str> = combined_norm.split_whitespace().collect();

    if contains_phrase(&combined_norm, COVER_REUPLOAD_PHRASES, &query_norm)
        || contains_word(&combined_words, COVER_REUPLOAD_WORDS, &query_words)
        || looks_like_fan_reupload(item, &query_words)
    {
        return SearchTier::CoverOrReupload;
    }

    // "edit" only counts as remix when not "radio edit" and not requested by the user
    let has_plain_edit = combined_words.contains("edit")
        && !combined_norm.contains(" radio edit ")
        && !query_words.contains("edit");
    if contains_phrase(&combined_norm, REMIX_PHRASES, &query_norm)
        || contains_word(&combined_words, REMIX_WORDS, &query_words)
        || has_plain_edit
    {
        return SearchTier::OfficialRemix;
    }

    if contains_phrase(&combined_norm, ALTERNATIVE_PHRASES, &query_norm)
        || contains_word(&combined_words, ALTERNATIVE_WORDS, &query_words)
    {
        return SearchTier::OfficialAlternative;
    }

    SearchTier::OriginalOfficial
}

fn token_coverage(wanted: &[String], found: &[String]) -> f64 {
    if wanted.is_empty() {
        return 0.0;
    }
    let hits = wanted.iter().filter(|w| found.contains(w)).count();
    hits as f64 / wanted.len() as f64
}

fn source_authority_score(item: &Value) -> f64 {
    let cat = infer_catalog_source(item);
    let raw_artist_low = s(item, "artist").to_lowercase();
    let is_vevo = raw_artist_low.contains("vevo");
    let is_topic = raw_artist_low.ends_with(" - topic");
    match cat {
        "spotify" => 10.0,
        "ytmusic" => 9.0,
        "deezer" => 8.5,
        "local" => 7.0,
        "youtube" if is_topic => 9.0,
        "youtube" if is_vevo => 6.5,
        "soundcloud" => 5.0,
        "youtube" => 3.5,
        _ => {
            if s(item, "url").contains("music.apple.com") {
                8.0
            } else {
                5.0
            }
        }
    }
}

fn score_search_item(item: &Value, query: &str, requested_kind: &str) -> (SearchTier, f64) {
    let tier = classify_search_tier(item, query);

    let q_norm = normalize_ascii_lower(query);
    let q_tokens = extract_tokens(query);
    let title_norm = normalize_ascii_lower(s(item, "title"));
    let artist_clean = s(item, "artist")
        .trim_end_matches(" - Topic")
        .trim_end_matches(" - topic");
    let artist_norm = normalize_ascii_lower(artist_clean);

    let title_tokens = extract_tokens(&title_norm);
    let artist_tokens = extract_tokens(&artist_norm);
    let mut combined_tokens = title_tokens.clone();
    combined_tokens.extend(artist_tokens.clone());

    let query_cov = token_coverage(&q_tokens, &combined_tokens);
    let title_cov = token_coverage(&title_tokens, &q_tokens);

    let mut score = query_cov * 40.0 + title_cov * 12.0;

    if !q_norm.is_empty() {
        if title_norm == q_norm {
            score += 20.0;
        } else if title_norm.starts_with(&q_norm) || q_norm.starts_with(&title_norm) {
            score += 9.0;
        } else if title_norm.contains(&q_norm) {
            score += 6.0;
        }

        if artist_norm == q_norm {
            score += 22.0;
        } else if !artist_tokens.is_empty()
            && q_tokens.len() >= artist_tokens.len()
            && artist_tokens.iter().all(|t| q_tokens.contains(t))
        {
            score += 14.0;
        }
    }

    score += source_authority_score(item);

    if requested_kind != "all" && s(item, "kind") == requested_kind {
        score += 4.0;
    }

    (tier, score)
}

pub fn rank_search_results(items: Vec<Value>, query: &str, requested_kind: &str) -> Vec<Value> {
    let mut deduped = Vec::with_capacity(items.len());
    let mut seen = HashSet::new();
    for item in items {
        let id = s(&item, "id").to_string();
        if !id.is_empty() && !seen.insert(id) {
            continue;
        }
        deduped.push(item);
    }

    let mut keyed: Vec<(SearchTier, i64, usize, Value)> = deduped
        .into_iter()
        .enumerate()
        .map(|(idx, item)| {
            let (tier, score) = score_search_item(&item, query, requested_kind);
            (tier, (score * 1000.0).round() as i64, idx, item)
        })
        .collect();

    keyed.sort_by(|a, b| {
        b.0.cmp(&a.0)
            .then_with(|| b.1.cmp(&a.1))
            .then_with(|| a.2.cmp(&b.2))
    });

    keyed.into_iter().map(|(_, _, _, item)| item).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn ranks_original_official_above_alternative_remix_and_covers() {
        let cover = json!({
            "id": "youtube:cover123456",
            "source": "youtube",
            "sourceId": "cover123456",
            "kind": "track",
            "title": "Blinding Lights (Acoustic Cover)",
            "artist": "Bedroom Covers",
            "duration": 190,
            "addedAt": 0
        });
        let slowed = json!({
            "id": "youtube:slowed12345",
            "source": "youtube",
            "sourceId": "slowed12345",
            "kind": "track",
            "title": "Blinding Lights (Slowed + Reverb)",
            "artist": "The Weeknd Lyrics",
            "duration": 225,
            "addedAt": 0
        });
        let remix = json!({
            "id": "link:sp_remix",
            "source": "link",
            "sourceId": "sp_remix",
            "kind": "track",
            "title": "Blinding Lights - Chromatics Remix",
            "artist": "The Weeknd",
            "catalogSource": "spotify",
            "duration": 210,
            "url": "https://open.spotify.com/track/1111111111111111111111",
            "addedAt": 0
        });
        let live = json!({
            "id": "link:sp_live",
            "source": "link",
            "sourceId": "sp_live",
            "kind": "track",
            "title": "Blinding Lights (Live at SoFi Stadium)",
            "artist": "The Weeknd",
            "catalogSource": "spotify",
            "duration": 215,
            "url": "https://open.spotify.com/track/2222222222222222222222",
            "addedAt": 0
        });
        let reupload = json!({
            "id": "youtube:reup1234567",
            "source": "youtube",
            "sourceId": "reup1234567",
            "kind": "track",
            "title": "The Weeknd - Blinding Lights",
            "artist": "Random Channel BR",
            "duration": 200,
            "addedAt": 0
        });
        let original = json!({
            "id": "link:sp_orig",
            "source": "link",
            "sourceId": "sp_orig",
            "kind": "track",
            "title": "Blinding Lights",
            "artist": "The Weeknd",
            "catalogSource": "spotify",
            "duration": 200,
            "url": "https://open.spotify.com/track/0VjIjW4GlUZAMYd2vXMi3b",
            "addedAt": 0
        });

        let ranked = rank_search_results(
            vec![cover, slowed, remix, live, reupload, original],
            "The Weeknd Blinding Lights",
            "track",
        );

        let ids: Vec<&str> = ranked.iter().map(|v| s(v, "id")).collect();
        assert_eq!(ids[0], "link:sp_orig");
        assert_eq!(ids[1], "link:sp_live");
        assert_eq!(ids[2], "link:sp_remix");
        assert!(ids[3..].contains(&"youtube:reup1234567"));
        assert!(ids[3..].contains(&"youtube:cover123456"));
        assert!(ids[3..].contains(&"youtube:slowed12345"));
    }

    #[test]
    fn promotes_explicitly_requested_remix_or_live_version() {
        let studio = json!({
            "id": "link:sp_studio",
            "source": "link",
            "sourceId": "sp_studio",
            "kind": "track",
            "title": "Blinding Lights",
            "artist": "The Weeknd",
            "catalogSource": "spotify",
            "duration": 200,
            "url": "https://open.spotify.com/track/0VjIjW4GlUZAMYd2vXMi3b",
            "addedAt": 0
        });
        let remix = json!({
            "id": "link:sp_remix",
            "source": "link",
            "sourceId": "sp_remix",
            "kind": "track",
            "title": "Blinding Lights (Remix)",
            "artist": "The Weeknd, Rosalía",
            "catalogSource": "spotify",
            "duration": 212,
            "url": "https://open.spotify.com/track/3333333333333333333333",
            "addedAt": 0
        });

        let ranked = rank_search_results(vec![studio, remix], "Blinding Lights remix", "track");
        assert_eq!(s(&ranked[0], "id"), "link:sp_remix");
    }
}
