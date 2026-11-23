import { useState } from 'react';
import { UserPlus, X } from 'lucide-react';
import { AUDIO_ADS_POLICY, type LiquidPlusStatus } from '../../../shared/plus';
import { useAccounts } from '../../stores/accounts';

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
      className="visitor-visual-ad-banner"
      aria-label="Modo visitante"
    >
      <div className="visitor-visual-ad-info">
        <span className="visitor-visual-ad-text">
          <strong>Modo visitante</strong>
        </span>
      </div>

      <div className="visitor-visual-ad-actions">
        <button
          type="button"
          className="button primary"
          onClick={() => openAuthModal({ view: 'choose' })}
        >
          <UserPlus size={13} />
          Entrar
        </button>
        <button
          type="button"
          className="icon-button"
          aria-label="Ocultar aviso"
          onClick={() => setDismissed(true)}
        >
          <X size={14} />
        </button>
      </div>
    </aside>
  );
}
