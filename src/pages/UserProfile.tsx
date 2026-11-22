import { useEffect, useState } from 'react';
import {
  ArrowLeft,
  Copy,
  ExternalLink,
  Globe,
  ListMusic,
  LoaderCircle,
  Lock,
  Pencil,
  Shield,
  UserCheck,
  Users,
} from 'lucide-react';
import type { PublicUserProfile, SocialLinks } from '../../shared/types';
import { resolveEffectiveBroker, useAccounts } from '../stores/accounts';
import { cleanError, useApp } from '../stores/app';
import TrackList from '../components/library/TrackList';

const SOCIAL_LABELS: Record<keyof SocialLinks, string> = {
  website: 'Site',
  instagram: 'Instagram',
  twitter: 'X / Twitter',
  youtube: 'YouTube',
  spotify: 'Spotify',
  github: 'GitHub',
};

function safeHttpUrl(raw?: string): string | null {
  if (!raw) return null;
  try {
    const parsed = new URL(raw);
    if (parsed.protocol === 'https:' || parsed.protocol === 'http:') return parsed.toString();
  } catch {}
  return null;
}

function visibilityLabel(v: PublicUserProfile['visibility']): string {
  if (v === 'restricted') return 'Restrito (autenticados)';
  if (v === 'private') return 'Privado';
  return 'Perfil público';
}

export default function UserProfile({ handle }: { handle: string }) {
  const hub = useAccounts(s => s.hub);
  const preferredBrokerUrl = useAccounts(s => s.preferredBrokerUrl);
  const onlineConsent = useApp(s => s.data.preferences.onlineConsent);

  const [profile, setProfile] = useState<PublicUserProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const brokerUrl = resolveEffectiveBroker(undefined, { preferredBrokerUrl, hub });

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError('');
    setProfile(null);

    if (!onlineConsent) {
      setLoading(false);
      setError('Ative o acesso online nas Configurações para visualizar perfis do Liquid Hub.');
      return;
    }

    if (!window.glass?.hubGetProfile) {
      setLoading(false);
      setError('Visualização de perfis indisponível neste ambiente.');
      return;
    }

    void window.glass
      .hubGetProfile({ handle, brokerUrl })
      .then(data => {
        if (!cancelled) setProfile(data);
      })
      .catch(e => {
        if (!cancelled) setError(cleanError(e) || 'Perfil não encontrado ou privado.');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [handle, brokerUrl, onlineConsent, hub.authenticated, hub.publicHandle]);

  if (loading) {
    return (
      <div className="loading-page" role="status">
        <LoaderCircle size={16} className="spinner" /> Carregando perfil @{handle}…
      </div>
    );
  }

  if (error || !profile) {
    return (
      <div className="empty-state profile-empty-state">
        <Lock size={26} />
        <h3>Perfil indisponível</h3>
        <p>{error || 'Este perfil não existe ou está restrito pelas preferências de privacidade.'}</p>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'center', marginTop: 14 }}>
          {!hub.authenticated && (
            <button
              className="button primary"
              onClick={() => useAccounts.getState().openAuthModal({ view: 'choose' })}
            >
              Entrar no Liquid Hub
            </button>
          )}
          <button className="button secondary" onClick={() => useApp.getState().navigate(-1)}>
            <ArrowLeft size={14} />
            Voltar
          </button>
        </div>
      </div>
    );
  }

  const isSelf = hub.authenticated && hub.publicHandle === profile.handle;
  const shareHttpUrl = `${brokerUrl}/u/${encodeURIComponent(profile.handle)}`;
  const socialEntries = (Object.keys(SOCIAL_LABELS) as (keyof SocialLinks)[])
    .map(key => {
      const href = safeHttpUrl(profile.socialLinks?.[key]);
      return href ? { key, label: SOCIAL_LABELS[key], href } : null;
    })
    .filter((item): item is { key: keyof SocialLinks; label: string; href: string } => !!item);

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(shareHttpUrl);
      useApp.getState().message('Link do perfil copiado.');
    } catch {
      useApp.getState().message(shareHttpUrl);
    }
  };

  return (
    <div className="profile-page">
      <div className="profile-hero">
        <div className="profile-avatar-lg" aria-hidden="true">
          {profile.avatarUrl ? (
            <img src={profile.avatarUrl} alt={profile.displayName} />
          ) : (
            <span>{(profile.displayName || profile.handle).charAt(0).toUpperCase()}</span>
          )}
        </div>
        <div className="profile-hero-info">
          <div className="profile-badges-row">
            <span className="entity-badge entity-badge-user">
              <UserCheck size={12} />
              Perfil do usuário
            </span>
            <span className="entity-badge entity-badge-privacy">
              {profile.visibility === 'private' ? (
                <Lock size={12} />
              ) : profile.visibility === 'restricted' ? (
                <Shield size={12} />
              ) : (
                <Globe size={12} />
              )}
              {visibilityLabel(profile.visibility)}
            </span>
          </div>
          <h1>{profile.displayName}</h1>
          <p className="profile-handle-line">@{profile.handle}</p>
          {profile.bio && <p className="profile-bio">{profile.bio}</p>}
          {socialEntries.length > 0 && (
            <div className="profile-social-links">
              {socialEntries.map(link => (
                <button
                  key={link.key}
                  type="button"
                  className="profile-social-pill"
                  onClick={() =>
                    void window.glass
                      .external(link.href)
                      .catch(e => useApp.getState().message(cleanError(e)))
                  }
                >
                  <ExternalLink size={12} />
                  {link.label}
                </button>
              ))}
            </div>
          )}
        </div>
        <div className="heading-actions">
          <button className="button secondary" onClick={() => void copyLink()}>
            <Copy size={14} />
            Copiar link
          </button>
          {isSelf && (
            <button
              className="button primary"
              onClick={() => {
                useApp.getState().setSettingsTab('account');
                useApp.getState().setPage('settings');
                setTimeout(() => {
                  document.getElementById('hub-account-section')?.scrollIntoView({ behavior: 'smooth' });
                }, 60);
              }}
            >
              <Pencil size={14} />
              Editar perfil
            </button>
          )}
          <button className="text-button" onClick={() => useApp.getState().navigate(-1)}>
            <ArrowLeft size={14} />
            Voltar
          </button>
        </div>
      </div>

      <section className="profile-section" aria-label="Playlists públicas">
        <div className="section-heading">
          <h2>Playlists públicas</h2>
          <span className="subtle">{profile.publicPlaylists.length} playlist(s)</span>
        </div>
        {profile.publicPlaylists.length > 0 ? (
          <div className="playlist-grid">
            {profile.publicPlaylists.map(pl => (
              <article className="library-playlist-card shared-playlist-card" key={pl.id}>
                <button
                  className="playlist-card-open"
                  onClick={() => useApp.getState().setPage(`shared-playlist:${pl.id}`)}
                >
                  <div className="shared-playlist-thumb">
                    {pl.artwork ? (
                      <img src={pl.artwork} alt="" />
                    ) : (
                      <ListMusic size={22} />
                    )}
                  </div>
                  <span>
                    <strong>{pl.name}</strong>
                    <small>
                      {pl.trackCount} faixa(s)
                      {pl.collaborative ? ' · Colaborativa' : ''}
                    </small>
                  </span>
                  {pl.collaborative && (
                    <span className="entity-badge entity-badge-collab" title="Playlist colaborativa">
                      <Users size={11} />
                    </span>
                  )}
                </button>
              </article>
            ))}
          </div>
        ) : (
          <p className="subtle">Nenhuma playlist pública compartilhada até o momento.</p>
        )}
      </section>

      {profile.showPublicTracks && profile.publicTracks.length > 0 && (
        <section className="profile-section" aria-label="Músicas públicas">
          <div className="section-heading">
            <h2>Músicas em destaque</h2>
          </div>
          <TrackList tracks={profile.publicTracks} showHeaderShuffle={false} />
        </section>
      )}
    </div>
  );
}
