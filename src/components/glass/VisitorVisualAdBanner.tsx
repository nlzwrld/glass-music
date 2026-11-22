import { useState } from 'react';
import { Sparkles, VolumeX, UserPlus, X } from 'lucide-react';
import { AUDIO_ADS_POLICY, type LiquidPlusStatus } from '../../../shared/plus';
import { useAccounts } from '../../stores/accounts';
import { useApp } from '../../stores/app';

export const VISITOR_VISUAL_AD_SPEC = {
  label: 'Patrocinado · Somente visual (sem áudio)',
  mutedByDefault: true,
  hasAudioElement: false,
  interruptsMusicPlayback: AUDIO_ADS_POLICY.audioInterruptionsAllowed,
  allowedInVisitorModeOnly: true,
} as const;

export function shouldShowVisitorVisualAd(state: {
  visitorMode: boolean;
  authenticated: boolean;
  plusStatus?: LiquidPlusStatus | null;
  dismissed?: boolean;
}): boolean {
  if (state.dismissed) return false;
  if (!state.visitorMode || state.authenticated) return false;
  if (state.plusStatus?.entitlements?.adFreeVisual) return false;
  return true;
}

export function canVisitorPerformAction(
  action:
    | 'browse'
    | 'search'
    | 'playback'
    | 'public_profile'
    | 'local_playlist'
    | 'jam'
    | 'collaborative_playlist'
    | 'cloud_sync'
    | 'profile_edit',
  state: { visitorMode: boolean; authenticated: boolean },
): { allowed: boolean; reason?: string } {
  if (state.authenticated) {
    return { allowed: true };
  }
  if (!state.visitorMode) {
    return {
      allowed: false,
      reason: 'Inicie sessão ou ative o modo visitante para explorar o Liquid Hub.',
    };
  }
  if (
    action === 'browse' ||
    action === 'search' ||
    action === 'playback' ||
    action === 'public_profile' ||
    action === 'local_playlist'
  ) {
    return { allowed: true };
  }
  return {
    allowed: false,
    reason:
      'Este recurso requer uma conta autenticada no Liquid Hub (JAM, playlists colaborativas e sincronização na nuvem são exclusivos para contas registradas).',
  };
}

export function VisitorVisualAdBanner() {
  const visitorMode = useAccounts(s => s.visitorMode);
  const authenticated = useAccounts(s => s.hub.authenticated);
  const plusStatus = useAccounts(s => s.plusStatus);
  const openAuthModal = useAccounts(s => s.openAuthModal);
  const setPage = useApp(s => s.setPage);
  const setSettingsTab = useApp(s => s.setSettingsTab);
  const [dismissed, setDismissed] = useState(false);

  if (
    !shouldShowVisitorVisualAd({
      visitorMode,
      authenticated,
      plusStatus,
      dismissed,
    })
  ) {
    return null;
  }

  return (
    <aside
      className="visitor-visual-ad-banner glass-surface"
      aria-label="Banner informativo de modo visitante e destaque visual patrocinado sem áudio"
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 12,
        margin: '8px 18px 0',
        padding: '10px 14px',
        borderRadius: 12,
        background: 'rgba(255, 255, 255, 0.04)',
        border: '1px solid rgba(255, 255, 255, 0.09)',
        fontSize: 12.5,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
        <span
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 4,
            padding: '2px 8px',
            borderRadius: 999,
            background: 'rgba(56, 189, 248, 0.14)',
            color: '#38bdf8',
            fontSize: 11,
            fontWeight: 600,
            whiteSpace: 'nowrap',
          }}
        >
          <VolumeX size={12} />
          {VISITOR_VISUAL_AD_SPEC.label}
        </span>
        <span style={{ opacity: 0.88, overflow: 'hidden', textOverflow: 'ellipsis' }}>
          <strong>Modo Visitante:</strong> você pode buscar e ouvir músicas livremente. Crie sua
          conta gratuita para usar JAM ao vivo, playlists colaborativas e sincronização na nuvem —
          ou conheça o <strong>Liquid Plus</strong> sem banners visuais.
        </span>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
        <button
          type="button"
          className="button ghost"
          onClick={() => {
            setSettingsTab('plus');
            setPage('settings');
          }}
          style={{ padding: '5px 10px', fontSize: 12 }}
        >
          <Sparkles size={13} />
          Liquid Plus
        </button>
        <button
          type="button"
          className="button primary"
          onClick={() => openAuthModal({ view: 'choose' })}
          style={{ padding: '5px 11px', fontSize: 12 }}
        >
          <UserPlus size={13} />
          Criar conta ou entrar
        </button>
        <button
          type="button"
          className="text-button"
          aria-label="Ocultar banner visual"
          onClick={() => setDismissed(true)}
          style={{ padding: 4 }}
        >
          <X size={14} />
        </button>
      </div>
    </aside>
  );
}
