import { useEffect } from 'react';
import { create } from 'zustand';
import { ArrowUpCircle, LoaderCircle, X } from 'lucide-react';
import { useApp, cleanError } from '../stores/app';
import { transport } from '../components/player/engine';
import { IconButton } from '../components/glass/controls';
import type { Preferences } from '../../shared/types';

import { APP_VERSION, evaluateVersionPolicy, type VersionPolicyResponse } from '../../shared/version';

export function shouldCheckAutomatically(
  ready: boolean,
  preferences: Pick<Preferences, 'autoUpdate' | 'onlineConsent' | 'onboardingDone'>,
): boolean {
  return Boolean(
    ready && preferences.autoUpdate && preferences.onlineConsent && preferences.onboardingDone,
  );
}

interface UpdateState {
  availableVersion: string;
  dismissedVersion: string;
  installing: boolean;
  progressPercent: number;
  mandatory: boolean;
  clientVersion: string;
  minSupportedVersion: string;
  updateUrl: string;
  releaseNotes: string;
  channel: string;
  reason: string;
  packageIntegrity: string;
  setAvailable: (
    version: string,
    meta?: { notes?: string; integrity?: string; channel?: string; downloadUrl?: string },
  ) => void;
  setProgress: (percent: number) => void;
  dismiss: () => void;
  installNow: () => Promise<void>;
  applyVersionPolicy: (policy: VersionPolicyResponse) => void;
  triggerMandatoryUpdate: (reason?: string, minSupportedVersion?: string) => void;
  checkVersionPolicy: (brokerUrl?: string) => Promise<VersionPolicyResponse | null>;
}

export const useUpdateNotice = create<UpdateState>((set, get) => ({
  availableVersion: '',
  dismissedVersion: '',
  installing: false,
  progressPercent: 0,
  mandatory: false,
  clientVersion: APP_VERSION,
  minSupportedVersion: APP_VERSION,
  updateUrl: 'https://github.com/nlzwrld/glass-music/releases/latest',
  releaseNotes: '',
  channel: 'stable',
  reason: '',
  packageIntegrity: 'Minisign-Ed25519+SHA-256',
  setAvailable: (version, meta) =>
    set(s => ({
      availableVersion: version,
      ...(meta?.notes !== undefined ? { releaseNotes: meta.notes } : {}),
      ...(meta?.integrity ? { packageIntegrity: meta.integrity } : {}),
      ...(meta?.channel ? { channel: meta.channel } : {}),
      ...(meta?.downloadUrl ? { updateUrl: meta.downloadUrl } : {}),
      ...(version ? {} : { progressPercent: 0 }),
    })),
  setProgress: percent =>
    set({ progressPercent: Math.max(0, Math.min(100, Math.round(percent || 0))) }),
  dismiss: () => {
    if (get().mandatory) return;
    set(s => ({ dismissedVersion: s.availableVersion }));
  },
  installNow: async () => {
    if (get().installing) return;
    set({ installing: true, progressPercent: 0 });
    try {
      transport.pause();
      const res = await window.glass.updateStatus(true);
      if (res?.downloadUrl) {
        // Mobile APK update launched in system downloader/browser
        set({ installing: false, progressPercent: 0 });
        if (res.message) useApp.getState().message(res.message);
        return;
      }
      if (!res?.available && get().mandatory && get().updateUrl) {
        await window.glass.external(get().updateUrl);
        set({ installing: false, progressPercent: 0 });
      }
    } catch (e) {
      set({ installing: false, progressPercent: 0 });
      useApp.getState().message(cleanError(e));
    }
  },
  applyVersionPolicy: policy => {
    set(s => ({
      mandatory: Boolean(policy.mandatoryUpdate),
      clientVersion: policy.clientVersion || s.clientVersion,
      minSupportedVersion: policy.minSupportedVersion || s.minSupportedVersion,
      availableVersion:
        policy.mandatoryUpdate || policy.updateAvailable
          ? policy.currentVersion || s.availableVersion
          : s.availableVersion,
      updateUrl: policy.updateUrl || s.updateUrl,
      releaseNotes: policy.releaseNotes || s.releaseNotes,
      reason: policy.reason || s.reason,
      packageIntegrity:
        (typeof policy.packageIntegrity === 'object' && policy.packageIntegrity?.algorithm
          ? `${policy.packageIntegrity.algorithm} (${policy.packageIntegrity.pubkeyFingerprint})`
          : typeof policy.packageIntegrity === 'string'
            ? policy.packageIntegrity
            : '') || s.packageIntegrity,
    }));
  },
  triggerMandatoryUpdate: (reason, minVer) => {
    const policy = evaluateVersionPolicy({
      clientVersion: get().clientVersion || APP_VERSION,
      minSupportedVersion: minVer || get().minSupportedVersion || APP_VERSION,
    });
    set({
      mandatory: true,
      minSupportedVersion: policy.minSupportedVersion,
      availableVersion: policy.currentVersion,
      reason:
        reason ||
        policy.reason ||
        `Esta versão do Liquid Hub não é mais compatível com o protocolo atual. Atualize para a versão ${policy.minSupportedVersion} ou superior.`,
    });
  },
  checkVersionPolicy: async brokerUrl => {
    try {
      if (!window.glass.hubVersionPolicy) return null;
      const policy = await window.glass.hubVersionPolicy({
        brokerUrl,
        clientVersion: APP_VERSION,
      });
      if (policy && typeof policy === 'object' && 'minSupportedVersion' in policy) {
        get().applyVersionPolicy(policy);
        return policy;
      }
    } catch (e) {
      const msg = cleanError(e);
      if (msg.includes('client_update_required')) {
        get().triggerMandatoryUpdate(msg.replace(/^client_update_required:\s*/i, ''));
      }
    }
    return null;
  },
}));

export function AutoUpdates() {
  const ready = useApp(s => s.ready),
    p = useApp(s => s.data.preferences);
  const availableVersion = useUpdateNotice(s => s.availableVersion),
    dismissedVersion = useUpdateNotice(s => s.dismissedVersion),
    installing = useUpdateNotice(s => s.installing),
    progressPercent = useUpdateNotice(s => s.progressPercent);

  useEffect(() => {
    const off = window.glass?.onUpdateProgress?.(ev => {
      useUpdateNotice.getState().setProgress(ev.percent);
    });
    return () => off?.();
  }, []);

  useEffect(() => {
    if (!shouldCheckAutomatically(ready, p)) {
      if (ready && !p.autoUpdate) useUpdateNotice.getState().setAvailable('');
      return;
    }
    let stopped = false,
      busy = false;
    const check = async () => {
      if (busy || !navigator.onLine || useUpdateNotice.getState().installing) return;
      busy = true;
      try {
        await useUpdateNotice.getState().checkVersionPolicy();
        const result = await window.glass.updateStatus(false);
        if (stopped) return;
        if (result.available && result.version) {
          useUpdateNotice.getState().setAvailable(result.version, {
            notes: result.notes,
            integrity: result.integrity,
            channel: result.channel,
            downloadUrl: result.downloadUrl,
          });
        } else if (!useUpdateNotice.getState().mandatory) {
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
  }, [ready, p.autoUpdate, p.onlineConsent, p.onboardingDone]);

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
              {progressPercent > 0 ? `Baixando ${progressPercent}%` : 'Atualizando…'}
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
