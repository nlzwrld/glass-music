use crate::db::Result;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LinkProviderId {
    Spotify,
    YouTubeMusic,
    YouTube,
    SoundCloud,
    Deezer,
    AppleMusic,
    Bandcamp,
    Tidal,
}

impl LinkProviderId {
    #[allow(dead_code)]
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Spotify => "spotify",
            Self::YouTubeMusic => "ytmusic",
            Self::YouTube => "youtube",
            Self::SoundCloud => "soundcloud",
            Self::Deezer => "deezer",
            Self::AppleMusic => "apple",
            Self::Bandcamp => "bandcamp",
            Self::Tidal => "tidal",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LinkEntityKind {
    Track,
    Album,
    Playlist,
    Artist,
}

impl LinkEntityKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Track => "track",
            Self::Album => "album",
            Self::Playlist => "playlist",
            Self::Artist => "artist",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedMusicLink {
    pub provider: LinkProviderId,
    pub kind: LinkEntityKind,
    pub entity_id: String,
    pub canonical_url: String,
    pub country: Option<String>,
}

pub trait LinkMetadataProvider: Send + Sync {
    #[allow(dead_code)]
    fn id(&self) -> LinkProviderId;
    #[allow(dead_code)]
    fn display_name(&self) -> &'static str;
    fn matches(&self, url: &url::Url) -> bool;
    fn parse(&self, url: &url::Url, prefer_collection: bool) -> Result<ParsedMusicLink>;
}

struct SpotifyLinkProvider;
impl LinkMetadataProvider for SpotifyLinkProvider {
    fn id(&self) -> LinkProviderId {
        LinkProviderId::Spotify
    }
    fn display_name(&self) -> &'static str {
        "Spotify"
    }
    fn matches(&self, url: &url::Url) -> bool {
        url.host_str() == Some("open.spotify.com")
    }
    fn parse(&self, url: &url::Url, prefer_collection: bool) -> Result<ParsedMusicLink> {
        let parts: Vec<&str> = url
            .path_segments()
            .into_iter()
            .flatten()
            .filter(|p| !p.is_empty())
            .collect();
        let allowed = if prefer_collection {
            &["playlist", "album", "artist"][..]
        } else {
            &["track", "album", "playlist", "artist"][..]
        };
        let idx = parts
            .iter()
            .position(|v| allowed.contains(v))
            .ok_or(if prefer_collection {
                "Use o link completo de uma playlist, álbum ou artista do Spotify."
            } else {
                "Use o link completo compartilhado pelo Spotify."
            })?;
        let entity_kind = parts[idx];
        let id = parts
            .get(idx + 1)
            .copied()
            .ok_or("Link do Spotify incompleto.")?;
        if id.len() != 22 || !id.bytes().all(|b| b.is_ascii_alphanumeric()) {
            return Err("Link do Spotify inválido.".into());
        }
        let kind = match entity_kind {
            "playlist" => LinkEntityKind::Playlist,
            "album" => LinkEntityKind::Album,
            "artist" => LinkEntityKind::Artist,
            _ => LinkEntityKind::Track,
        };
        Ok(ParsedMusicLink {
            provider: LinkProviderId::Spotify,
            kind,
            entity_id: id.to_string(),
            canonical_url: format!("https://open.spotify.com/{entity_kind}/{id}"),
            country: None,
        })
    }
}

fn parse_youtube_playlist_id(url: &url::Url) -> Option<String> {
    let id = url
        .query_pairs()
        .find(|(k, _)| k == "list")
        .map(|(_, v)| v.into_owned())?;
    if id.len() >= 5
        && id.len() <= 150
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"_-".contains(&b))
    {
        Some(id)
    } else {
        None
    }
}

fn parse_youtube_video_id(url: &url::Url) -> Option<String> {
    let host = url.host_str().unwrap_or("");
    let id = if host == "youtu.be" {
        url.path_segments()
            .and_then(|mut s| s.next())
            .unwrap_or("")
            .to_string()
    } else if url.path() == "/watch" {
        url.query_pairs()
            .find(|(k, _)| k == "v")
            .map(|(_, v)| v.into_owned())
            .unwrap_or_default()
    } else {
        let mut segs = url.path_segments().into_iter().flatten().filter(|s| !s.is_empty());
        match segs.next() {
            Some("shorts" | "live" | "embed") => segs.next().unwrap_or("").to_string(),
            _ => String::new(),
        }
    };
    if id.len() == 11
        && id
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"_-".contains(&c))
    {
        Some(id)
    } else {
        None
    }
}

struct YouTubeMusicLinkProvider;
impl LinkMetadataProvider for YouTubeMusicLinkProvider {
    fn id(&self) -> LinkProviderId {
        LinkProviderId::YouTubeMusic
    }
    fn display_name(&self) -> &'static str {
        "YT Music"
    }
    fn matches(&self, url: &url::Url) -> bool {
        url.host_str() == Some("music.youtube.com")
    }
    fn parse(&self, url: &url::Url, prefer_collection: bool) -> Result<ParsedMusicLink> {
        if prefer_collection {
            let list_id = parse_youtube_playlist_id(url)
                .ok_or("Use um link de playlist do YT Music com list=.")?;
            return Ok(ParsedMusicLink {
                provider: LinkProviderId::YouTubeMusic,
                kind: LinkEntityKind::Playlist,
                entity_id: list_id.clone(),
                canonical_url: format!("https://music.youtube.com/playlist?list={list_id}"),
                country: None,
            });
        }
        if let Some(vid) = parse_youtube_video_id(url) {
            return Ok(ParsedMusicLink {
                provider: LinkProviderId::YouTubeMusic,
                kind: LinkEntityKind::Track,
                entity_id: vid.clone(),
                canonical_url: format!("https://www.youtube.com/watch?v={vid}"),
                country: None,
            });
        }
        if let Some(list_id) = parse_youtube_playlist_id(url) {
            return Ok(ParsedMusicLink {
                provider: LinkProviderId::YouTubeMusic,
                kind: LinkEntityKind::Playlist,
                entity_id: list_id.clone(),
                canonical_url: format!("https://music.youtube.com/playlist?list={list_id}"),
                country: None,
            });
        }
        Err("Use o link de uma música ou playlist do YT Music.".into())
    }
}

struct YouTubeLinkProvider;
impl LinkMetadataProvider for YouTubeLinkProvider {
    fn id(&self) -> LinkProviderId {
        LinkProviderId::YouTube
    }
    fn display_name(&self) -> &'static str {
        "YouTube"
    }
    fn matches(&self, url: &url::Url) -> bool {
        matches!(
            url.host_str(),
            Some("youtube.com" | "www.youtube.com" | "m.youtube.com" | "youtu.be")
        )
    }
    fn parse(&self, url: &url::Url, prefer_collection: bool) -> Result<ParsedMusicLink> {
        if prefer_collection {
            let list_id = parse_youtube_playlist_id(url)
                .ok_or("Use um link de playlist com list=.")?;
            return Ok(ParsedMusicLink {
                provider: LinkProviderId::YouTube,
                kind: LinkEntityKind::Playlist,
                entity_id: list_id.clone(),
                canonical_url: format!("https://www.youtube.com/playlist?list={list_id}"),
                country: None,
            });
        }
        if let Some(vid) = parse_youtube_video_id(url) {
            return Ok(ParsedMusicLink {
                provider: LinkProviderId::YouTube,
                kind: LinkEntityKind::Track,
                entity_id: vid.clone(),
                canonical_url: format!("https://www.youtube.com/watch?v={vid}"),
                country: None,
            });
        }
        if let Some(list_id) = parse_youtube_playlist_id(url) {
            return Ok(ParsedMusicLink {
                provider: LinkProviderId::YouTube,
                kind: LinkEntityKind::Playlist,
                entity_id: list_id.clone(),
                canonical_url: format!("https://www.youtube.com/playlist?list={list_id}"),
                country: None,
            });
        }
        Err("Use o link de um vídeo do YouTube.".into())
    }
}

struct SoundCloudLinkProvider;
impl LinkMetadataProvider for SoundCloudLinkProvider {
    fn id(&self) -> LinkProviderId {
        LinkProviderId::SoundCloud
    }
    fn display_name(&self) -> &'static str {
        "SoundCloud"
    }
    fn matches(&self, url: &url::Url) -> bool {
        matches!(
            url.host_str(),
            Some("soundcloud.com" | "www.soundcloud.com" | "m.soundcloud.com")
        )
    }
    fn parse(&self, url: &url::Url, prefer_collection: bool) -> Result<ParsedMusicLink> {
        let parts: Vec<&str> = url
            .path_segments()
            .into_iter()
            .flatten()
            .filter(|s| !s.is_empty())
            .collect();
        if prefer_collection {
            if parts.len() == 3 && parts[1] == "sets" {
                let slug = parts.join("/");
                return Ok(ParsedMusicLink {
                    provider: LinkProviderId::SoundCloud,
                    kind: LinkEntityKind::Playlist,
                    entity_id: slug.clone(),
                    canonical_url: format!("https://soundcloud.com/{slug}"),
                    country: None,
                });
            }
            return Err("Use o link completo de uma playlist pública do SoundCloud.".into());
        }
        if parts.len() < 2 {
            return Err("Use o link completo de uma faixa ou playlist pública.".into());
        }
        let kind = if parts.len() >= 3 && parts[1] == "sets" {
            LinkEntityKind::Playlist
        } else {
            LinkEntityKind::Track
        };
        let slug = parts.join("/");
        Ok(ParsedMusicLink {
            provider: LinkProviderId::SoundCloud,
            kind,
            entity_id: slug.clone(),
            canonical_url: format!("https://soundcloud.com/{slug}"),
            country: None,
        })
    }
}

struct DeezerLinkProvider;
impl LinkMetadataProvider for DeezerLinkProvider {
    fn id(&self) -> LinkProviderId {
        LinkProviderId::Deezer
    }
    fn display_name(&self) -> &'static str {
        "Deezer"
    }
    fn matches(&self, url: &url::Url) -> bool {
        matches!(
            url.host_str(),
            Some("deezer.com" | "www.deezer.com" | "m.deezer.com")
        )
    }
    fn parse(&self, url: &url::Url, prefer_collection: bool) -> Result<ParsedMusicLink> {
        let parts: Vec<&str> = url
            .path_segments()
            .into_iter()
            .flatten()
            .filter(|p| !p.is_empty())
            .collect();
        let allowed = if prefer_collection {
            &["playlist", "album", "artist"][..]
        } else {
            &["track", "album", "playlist", "artist"][..]
        };
        let idx = parts
            .iter()
            .position(|v| allowed.contains(v))
            .ok_or("Use o link completo de música, álbum ou playlist do Deezer.")?;
        let entity = parts[idx];
        let id = parts.get(idx + 1).copied().ok_or("Link Deezer incompleto.")?;
        if id.is_empty() || id.len() > 25 || !id.bytes().all(|b| b.is_ascii_digit()) {
            return Err("Link Deezer inválido.".into());
        }
        let kind = match entity {
            "playlist" => LinkEntityKind::Playlist,
            "album" => LinkEntityKind::Album,
            "artist" => LinkEntityKind::Artist,
            _ => LinkEntityKind::Track,
        };
        Ok(ParsedMusicLink {
            provider: LinkProviderId::Deezer,
            kind,
            entity_id: id.to_string(),
            canonical_url: format!("https://www.deezer.com/{entity}/{id}"),
            country: None,
        })
    }
}

struct AppleMusicLinkProvider;
impl LinkMetadataProvider for AppleMusicLinkProvider {
    fn id(&self) -> LinkProviderId {
        LinkProviderId::AppleMusic
    }
    fn display_name(&self) -> &'static str {
        "Apple Music"
    }
    fn matches(&self, url: &url::Url) -> bool {
        matches!(url.host_str(), Some("music.apple.com" | "itunes.apple.com"))
    }
    fn parse(&self, url: &url::Url, prefer_collection: bool) -> Result<ParsedMusicLink> {
        let (cc, raw_kind, id) = crate::platforms::parse_apple_url(url)?;
        if prefer_collection && !["album", "artist"].contains(&raw_kind) {
            return Err("Use o link de um álbum ou artista do Apple Music.".into());
        }
        let kind = match raw_kind {
            "album" => LinkEntityKind::Album,
            "artist" => LinkEntityKind::Artist,
            _ => LinkEntityKind::Track,
        };
        let canonical = if raw_kind == "track" {
            let mut clean = url.clone();
            clean.set_fragment(None);
            clean.to_string()
        } else {
            format!("https://music.apple.com/{cc}/{raw_kind}/{id}")
        };
        Ok(ParsedMusicLink {
            provider: LinkProviderId::AppleMusic,
            kind,
            entity_id: id,
            canonical_url: canonical,
            country: Some(cc),
        })
    }
}

struct BandcampLinkProvider;
impl LinkMetadataProvider for BandcampLinkProvider {
    fn id(&self) -> LinkProviderId {
        LinkProviderId::Bandcamp
    }
    fn display_name(&self) -> &'static str {
        "Bandcamp"
    }
    fn matches(&self, url: &url::Url) -> bool {
        crate::platforms::is_bandcamp(url.host_str().unwrap_or(""))
    }
    fn parse(&self, url: &url::Url, prefer_collection: bool) -> Result<ParsedMusicLink> {
        let parts: Vec<&str> = url
            .path_segments()
            .into_iter()
            .flatten()
            .filter(|p| !p.is_empty())
            .collect();
        if parts.len() != 2 || !["track", "album"].contains(&parts[0]) {
            return Err("Use o link de uma faixa ou álbum do Bandcamp.".into());
        }
        if prefer_collection && parts[0] != "album" {
            return Err("Use o link de um álbum do Bandcamp.".into());
        }
        let mut clean = url.clone();
        clean.set_query(None);
        clean.set_fragment(None);
        Ok(ParsedMusicLink {
            provider: LinkProviderId::Bandcamp,
            kind: if parts[0] == "album" {
                LinkEntityKind::Album
            } else {
                LinkEntityKind::Track
            },
            entity_id: parts[1].to_string(),
            canonical_url: clean.to_string(),
            country: None,
        })
    }
}

struct TidalLinkProvider;
impl LinkMetadataProvider for TidalLinkProvider {
    fn id(&self) -> LinkProviderId {
        LinkProviderId::Tidal
    }
    fn display_name(&self) -> &'static str {
        "Tidal"
    }
    fn matches(&self, url: &url::Url) -> bool {
        matches!(
            url.host_str(),
            Some("tidal.com" | "www.tidal.com" | "listen.tidal.com")
        )
    }
    fn parse(&self, url: &url::Url, prefer_collection: bool) -> Result<ParsedMusicLink> {
        if prefer_collection {
            return Err("Importação de coleção completa do Tidal ainda não é suportada por link.".into());
        }
        let parts: Vec<&str> = url
            .path_segments()
            .into_iter()
            .flatten()
            .filter(|p| !p.is_empty() && *p != "browse")
            .collect();
        let pos = parts
            .iter()
            .position(|p| ["track", "album", "playlist"].contains(p))
            .ok_or("Use o link de uma música, álbum ou playlist do Tidal.")?;
        let entity = parts[pos];
        let id = parts.get(pos + 1).ok_or("Link do Tidal incompleto.")?;
        if id.is_empty()
            || id.len() > 64
            || !id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
        {
            return Err("Identificador do Tidal inválido.".into());
        }
        let kind = match entity {
            "album" => LinkEntityKind::Album,
            "playlist" => LinkEntityKind::Playlist,
            _ => LinkEntityKind::Track,
        };
        Ok(ParsedMusicLink {
            provider: LinkProviderId::Tidal,
            kind,
            entity_id: (*id).to_string(),
            canonical_url: format!("https://tidal.com/{entity}/{id}"),
            country: None,
        })
    }
}

pub struct LinkProviderRegistry {
    providers: Vec<Box<dyn LinkMetadataProvider>>,
}

impl LinkProviderRegistry {
    pub fn empty() -> Self {
        Self { providers: Vec::new() }
    }

    pub fn register<P: LinkMetadataProvider + 'static>(&mut self, provider: P) {
        self.providers.push(Box::new(provider));
    }

    pub fn with_default() -> Self {
        let mut reg = Self::empty();
        reg.register(SpotifyLinkProvider);
        reg.register(YouTubeMusicLinkProvider);
        reg.register(YouTubeLinkProvider);
        reg.register(SoundCloudLinkProvider);
        reg.register(DeezerLinkProvider);
        reg.register(AppleMusicLinkProvider);
        reg.register(BandcampLinkProvider);
        reg.register(TidalLinkProvider);
        reg
    }

    pub fn matches_any(&self, url: &url::Url) -> bool {
        self.providers.iter().any(|provider| provider.matches(url))
    }

    pub fn parse(&self, raw: &str, prefer_collection: bool) -> Result<ParsedMusicLink> {
        let url = normalize_input(raw)?;
        for provider in &self.providers {
            if provider.matches(&url) {
                return provider.parse(&url, prefer_collection);
            }
        }
        Err("Use o link completo de uma música, álbum ou playlist do Spotify, YouTube Music, SoundCloud, Deezer, Apple Music, Bandcamp ou Tidal.".into())
    }
}

pub fn normalize_input(raw: &str) -> Result<url::Url> {
    let trimmed = raw.trim();
    if trimmed.is_empty() || trimmed.len() > 2048 || trimmed.chars().any(|c| c.is_control()) {
        return Err("Use um link público HTTPS de música.".into());
    }
    if let Some(rest) = trimmed.strip_prefix("spotify:") {
        let parts: Vec<&str> = rest.split(':').collect();
        if parts.len() == 2
            && ["track", "album", "playlist", "artist"].contains(&parts[0])
            && parts[1].len() == 22
            && parts[1].bytes().all(|b| b.is_ascii_alphanumeric())
        {
            let https = format!("https://open.spotify.com/{}/{}", parts[0], parts[1]);
            return url::Url::parse(&https).map_err(|_| "Link do Spotify inválido.".into());
        }
        return Err("URI do Spotify inválido.".into());
    }
    if !crate::links::public_url(trimmed) {
        return Err("Use um link público HTTPS de música.".into());
    }
    let mut u = url::Url::parse(trimmed).map_err(|_| "Link inválido.".to_string())?;
    u.set_fragment(None);
    Ok(u)
}

pub fn matches_known_provider(url: &url::Url) -> bool {
    LinkProviderRegistry::with_default().matches_any(url)
}

pub fn parse_link(raw: &str) -> Result<ParsedMusicLink> {
    LinkProviderRegistry::with_default().parse(raw, false)
}

pub fn parse_collection_link(raw: &str) -> Result<ParsedMusicLink> {
    LinkProviderRegistry::with_default().parse(raw, true)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_all_eight_platforms_and_spotify_uris() {
        let sp = parse_link("spotify:track:4uLU6hMCjMI75M1A2tKUQC").unwrap();
        assert_eq!(sp.provider, LinkProviderId::Spotify);
        assert_eq!(sp.kind, LinkEntityKind::Track);
        assert_eq!(
            sp.canonical_url,
            "https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC"
        );

        let sp_intl =
            parse_link("https://open.spotify.com/intl-pt/playlist/37i9dQZF1DXcBWIGoYBM5M?si=abc")
                .unwrap();
        assert_eq!(sp_intl.provider, LinkProviderId::Spotify);
        assert_eq!(sp_intl.kind, LinkEntityKind::Playlist);
        assert_eq!(
            sp_intl.canonical_url,
            "https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M"
        );

        let ytm = parse_link("https://music.youtube.com/watch?v=dQw4w9WgXcQ").unwrap();
        assert_eq!(ytm.provider, LinkProviderId::YouTubeMusic);
        assert_eq!(ytm.entity_id, "dQw4w9WgXcQ");

        let yt_mob = parse_link("https://m.youtube.com/watch?v=dQw4w9WgXcQ").unwrap();
        assert_eq!(yt_mob.provider, LinkProviderId::YouTube);
        assert_eq!(yt_mob.canonical_url, "https://www.youtube.com/watch?v=dQw4w9WgXcQ");

        let yt_list =
            parse_collection_link("https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PLabc12345")
                .unwrap();
        assert_eq!(yt_list.kind, LinkEntityKind::Playlist);
        assert_eq!(
            yt_list.canonical_url,
            "https://www.youtube.com/playlist?list=PLabc12345"
        );

        let sc = parse_link("https://m.soundcloud.com/forss/flickermood?in=x").unwrap();
        assert_eq!(sc.provider, LinkProviderId::SoundCloud);
        assert_eq!(sc.canonical_url, "https://soundcloud.com/forss/flickermood");

        let dz = parse_link("https://m.deezer.com/br/track/3135556").unwrap();
        assert_eq!(dz.provider, LinkProviderId::Deezer);
        assert_eq!(dz.canonical_url, "https://www.deezer.com/track/3135556");

        let ap = parse_link("https://music.apple.com/br/album/discovery/697194953?i=697195787")
            .unwrap();
        assert_eq!(ap.provider, LinkProviderId::AppleMusic);
        assert_eq!(ap.kind, LinkEntityKind::Track);

        let bc = parse_collection_link("https://c418.bandcamp.com/album/minecraft-volume-alpha")
            .unwrap();
        assert_eq!(bc.provider, LinkProviderId::Bandcamp);
        assert_eq!(bc.kind, LinkEntityKind::Album);

        let td = parse_link("https://listen.tidal.com/browse/track/12345678").unwrap();
        assert_eq!(td.provider, LinkProviderId::Tidal);
        assert_eq!(td.canonical_url, "https://tidal.com/track/12345678");
    }

    #[test]
    fn rejects_ssrf_local_and_invalid_urls() {
        for bad in [
            "file:///C:/music/song.mp3",
            "http://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC",
            "https://127.0.0.1/track/1",
            "https://localhost/track/1",
            "https://user:pass@open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC",
            "https://evil.bandcamp.com.attacker.test/track/abc",
            "spotify:track:short",
            "javascript:alert(1)",
        ] {
            assert!(parse_link(bad).is_err(), "expected {bad} to fail");
        }
    }

    #[test]
    fn registry_supports_custom_provider_extension() {
        struct CustomMockProvider;
        impl LinkMetadataProvider for CustomMockProvider {
            fn id(&self) -> LinkProviderId {
                LinkProviderId::Tidal
            }
            fn display_name(&self) -> &'static str {
                "Custom"
            }
            fn matches(&self, url: &url::Url) -> bool {
                url.host_str() == Some("audio.custom.example")
            }
            fn parse(&self, url: &url::Url, _prefer_collection: bool) -> Result<ParsedMusicLink> {
                Ok(ParsedMusicLink {
                    provider: LinkProviderId::Tidal,
                    kind: LinkEntityKind::Track,
                    entity_id: "custom-1".into(),
                    canonical_url: url.to_string(),
                    country: None,
                })
            }
        }
        let mut reg = LinkProviderRegistry::with_default();
        reg.register(CustomMockProvider);
        let parsed = reg.parse("https://audio.custom.example/track/1", false).unwrap();
        assert_eq!(parsed.entity_id, "custom-1");
    }
}
