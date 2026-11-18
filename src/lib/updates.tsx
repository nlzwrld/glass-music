import { useEffect } from 'react';
import { create } from 'zustand';
import { ArrowUpCircle, LoaderCircle, X } from 'lucide-react';
import { useApp, cleanError } from '../stores/app';
import { transport } from '../components/player/engine';
import { IconButton } from '../components/glass/controls';

interface UpdateState {
  availableVersion: string;
  dismissedVersion: string;
  installing: boolean;
  setAvailable: (version: string) => void;
  dismiss: () => void;
  installNow: () => Promise<void>;
}

export const useUpdateNotice = create<UpdateState>((set, get) => ({
  availableVersion: '',
  dismissedVersion: '',
  installing: false,
  setAvailable: version => set({ availableVersion: version }),
  dismiss: () => set(s => ({ dismissedVersion: s.availableVersion })),
  installNow: async () => {
    if (get().installing) return;
    set({ installing: true });
    try {
      transport.pause();
      await window.glass.updateStatus(true);
    } catch (e) {
      set({ installing: false });
      useApp.getState().message(cleanError(e));
    }
  },
}));

export function AutoUpdates() {
  const ready = useApp(s => s.ready),
    p = useApp(s => s.data.preferences);
  const availableVersion = useUpdateNotice(s => s.availableVersion),
    dismissedVersion = useUpdateNotice(s => s.dismissedVersion),
    installing = useUpdateNotice(s => s.installing);

  useEffect(() => {
    if (!ready || !p.onlineConsent || !p.onboardingDone) return;
    let stopped = false,
      busy = false;
    const check = async () => {
      if (busy || !navigator.onLine || useUpdateNotice.getState().installing) return;
      busy = true;
      try {
        const result = await window.glass.updateStatus(false);
        if (stopped) return;
        if (result.available && result.version) {
          useUpdateNotice.getState().setAvailable(result.version);
        } else {
          useUpdateNotice.getState().setAvailable('');
        }
      } catch {
      } finally {
        busy = false;
      }
    };
    const start = setTimeout(() => void check(), 3500);
    const timer = setInterval(() => void check(), 5 * 60_000);
    window.addEventListener('online', check);
    return () => {
      stopped = true;
      clearTimeout(start);
      clearInterval(timer);
      window.removeEventListener('online', check);
    };
  }, [ready, p.onlineConsent, p.onboardingDone]);

  if (!availableVersion || availableVersion === dismissedVersion) return null;

  return (
    <div className="update-banner" role="status" aria-live="polite">
      <div className="update-banner-info">
        <ArrowUpCircle size={15} />
        <span>Nova versão disponível ({availableVersion})</span>
      </div>
      <div className="update-banner-actions">
        <button
          type="button"
          className="button primary update-now-btn"
          disabled={installing}
          onClick={() => void useUpdateNotice.getState().installNow()}
        >
          {installing ? (
            <>
              <LoaderCircle size={13} className="spinner" />
              Atualizando…
            </>
          ) : (
            'Atualizar agora'
          )}
        </button>
        {!installing && (
          <IconButton
            label="Fechar aviso de atualização"
            onClick={() => useUpdateNotice.getState().dismiss()}
          >
            <X size={14} />
          </IconButton>
        )}
      </div>
    </div>
  );
}
