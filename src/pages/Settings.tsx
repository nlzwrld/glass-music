import { useEffect, useState } from 'react';
import Appearance from '../components/glass/Appearance';
import { useApp, cleanError } from '../stores/app';
import { resolveNotificationMode, type NotificationMode } from '../../shared/types';
import AccountConnections from '../components/library/AccountConnections';
import { Toggle } from '../components/glass/controls';
import { audioOutputDevices, requestAudioOutput } from '../lib/audioGraph';
import { JamSettings } from '../components/jam/JamSettings';
import { useUpdateNotice } from '../lib/updates';

function AudioSettings() {
  const p = useApp(s => s.data.preferences),
    pref = useApp(s => s.setPreferences);
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);

  useEffect(() => {
    const refresh = () =>
      void audioOutputDevices()
        .then(setDevices)
        .catch(() => {});
    refresh();
    navigator.mediaDevices?.addEventListener('devicechange', refresh);
    return () => navigator.mediaDevices?.removeEventListener('devicechange', refresh);
  }, []);

  const preset = (eq: number[]) => void pref({ eq });

  return (
    <section className="settings-section">
      <h2>Áudio</h2>
      <label className="setting-row">
        <strong>Volume</strong>
        <span className="setting-range">
          <input
            aria-label="Volume principal"
            type="range"
            min={0}
            max={100}
            value={p.volume}
            style={{ '--progress': `${p.volume}%` } as React.CSSProperties}
            onChange={e => void pref({ volume: Number(e.target.value) })}
          />
          <output>{p.volume}%</output>
        </span>
      </label>
      <label className="setting-row">
        <strong>Volume booster</strong>
        <span className="setting-range">
          <input
            aria-label="Volume booster"
            type="range"
            min={0}
            max={12}
            step={0.5}
            value={p.volumeBoost}
            style={{ '--progress': `${(p.volumeBoost / 12) * 100}%` } as React.CSSProperties}
            onChange={e => void pref({ volumeBoost: Number(e.target.value) })}
          />
          <output>+{p.volumeBoost} dB</output>
        </span>
      </label>
      <Toggle
        label="Proteção contra distorção"
        checked={p.limiter}
        onChange={limiter => void pref({ limiter })}
      />

      <div className="setting-subsection">
        <div className="setting-subhead">
          <h3>Equalizador</h3>
          <div className="eq-presets">
            <button className="button secondary" onClick={() => preset([0, 0, 0, 0, 0])}>
              Neutro
            </button>
            <button className="button secondary" onClick={() => preset([5, 3, 0, 1, 2])}>
              Graves
            </button>
            <button className="button secondary" onClick={() => preset([-2, 0, 3, 2, 0])}>
              Voz
            </button>
            <button className="button secondary" onClick={() => preset([3, 1, -1, 2, 4])}>
              Brilho
            </button>
          </div>
        </div>
        <div className="equalizer-bands">
          {['60 Hz', '230 Hz', '910 Hz', '3,6 kHz', '14 kHz'].map((label, i) => (
            <label key={label}>
              <span>{label}</span>
              <input
                aria-label={`Equalizador ${label}`}
                type="range"
                min={-12}
                max={12}
                step={0.5}
                value={p.eq[i]}
                style={{ '--progress': `${((p.eq[i] + 12) / 24) * 100}%` } as React.CSSProperties}
                onChange={e => {
                  const eq = [...p.eq];
                  eq[i] = Number(e.target.value);
                  void pref({ eq });
                }}
              />
              <output>
                {p.eq[i] > 0 ? '+' : ''}
                {p.eq[i]} dB
              </output>
            </label>
          ))}
        </div>
      </div>

      <label className="setting-row">
        <strong>Saída de som</strong>
        <span className="setting-inline">
          <select
            aria-label="Dispositivo de saída"
            value={p.outputDevice}
            onChange={e => void pref({ outputDevice: e.target.value })}
          >
            <option value="default">Padrão do Windows</option>
            {devices
              .filter(d => d.deviceId !== 'default' && d.deviceId)
              .map((d, i) => (
                <option key={d.deviceId} value={d.deviceId}>
                  {d.label || `Saída ${i + 1}`}
                </option>
              ))}
          </select>
          <button
            className="button secondary"
            onClick={() =>
              void requestAudioOutput()
                .then(async d => {
                  await pref({ outputDevice: d.deviceId });
                  setDevices(await audioOutputDevices());
                })
                .catch(e => useApp.getState().message(cleanError(e)))
            }
          >
            Selecionar
          </button>
        </span>
      </label>
    </section>
  );
}

function OfflineSettings() {
  const allTracks = useApp(s => s.data.tracks);
  const tracks = allTracks.filter(t => t.offline);
  return (
    <section className="settings-section">
      <h2>Downloads</h2>
      <p className="fine-print">{tracks.length} faixas salvas neste computador</p>
      {tracks.map(t => (
        <div className="setting-row" key={t.id}>
          <span>
            <strong>{t.title}</strong>
            <small>{t.artist}</small>
          </span>
          <button
            className="button secondary"
            onClick={() =>
              void window.glass
                .removeOffline(t.id)
                .then(data => useApp.setState({ data }))
                .catch(e => useApp.getState().message(cleanError(e)))
            }
          >
            Remover
          </button>
        </div>
      ))}
    </section>
  );
}

export default function Settings() {
  const p = useApp(s => s.data.preferences),
    integration = useApp(s => s.integrations),
    pref = useApp(s => s.setPreferences);
  const [busy, setBusy] = useState(false),
    [message, setMessage] = useState('');

  return (
    <div className="settings-page">
      <div className="page-heading">
        <h1>Configurações</h1>
        {integration?.version && <span className="version-pill">v{integration.version}</span>}
      </div>

      <Appearance />

      <AudioSettings />

      <section className="settings-section">
        <h2>Reprodução</h2>
        <label className="setting-row">
          <strong>Transição entre músicas</strong>
          <select
            aria-label="Transição entre músicas"
            value={p.transition}
            onChange={e => void pref({ transition: e.target.value as typeof p.transition })}
          >
            <option value="off">Sem transição</option>
            <option value="fade">Fade suave</option>
            <option value="crossfade">Crossfade</option>
          </select>
        </label>
        {p.transition !== 'off' && (
          <label className="setting-row">
            <strong>Duração da transição</strong>
            <span className="setting-range">
              <input
                aria-label="Duração da transição"
                type="range"
                min={0.5}
                max={10}
                step={0.5}
                value={p.transitionSeconds}
                style={
                  {
                    '--progress': `${((p.transitionSeconds - 0.5) / 9.5) * 100}%`,
                  } as React.CSSProperties
                }
                onChange={e => void pref({ transitionSeconds: Number(e.target.value) })}
              />
              <output>{p.transitionSeconds}s</output>
            </span>
          </label>
        )}
        <Toggle
          label="Continuar ouvindo automaticamente"
          description="Reproduz faixas semelhantes ao terminar a fila"
          checked={p.autoplay !== false}
          onChange={autoplay => void pref({ autoplay })}
        />
      </section>

      <OfflineSettings />

      <section className="settings-section">
        <JamSettings />
      </section>

      <section className="settings-section" id="integrations">
        <h2>Integrações</h2>
        <Toggle
          label="Acesso online"
          checked={p.onlineConsent && p.catalogConsent}
          onChange={v => void pref({ onlineConsent: v, catalogConsent: v })}
        />
        <div className="settings-actions-row">
          <button className="text-button" onClick={() => void pref({ onboardingDone: false })}>
            Termos e privacidade
          </button>
        </div>
      </section>

      <AccountConnections />

      <section className="settings-section">
        <h2>Sistema</h2>
        <Toggle
          label="Iniciar com o Windows"
          checked={p.startup}
          onChange={v => void pref({ startup: v })}
        />
        <Toggle
          label="Fechar para a bandeja"
          checked={p.tray}
          onChange={v => void pref({ tray: v })}
        />
        <Toggle
          label="Teclas multimídia"
          checked={p.globalShortcuts}
          onChange={v => void pref({ globalShortcuts: v })}
        />
        <label className="setting-row">
          <span>
            <strong>Notificações ao trocar de faixa</strong>
            <small>Controles de mídia do sistema continuam ativos em tempo real</small>
          </span>
          <select
            aria-label="Notificações ao trocar de faixa"
            value={resolveNotificationMode(p)}
            onChange={e => {
              const mode = e.target.value as NotificationMode;
              void pref({
                notificationMode: mode,
                notifications: mode !== 'off',
              });
            }}
          >
            <option value="off">Desativado (Silencioso)</option>
            <option value="background">Apenas em segundo plano (Sem spam)</option>
            <option value="always">Sempre</option>
          </select>
        </label>
        <Toggle
          label="Atualizar automaticamente"
          checked={p.autoUpdate}
          onChange={autoUpdate => void pref({ autoUpdate })}
        />
        <div className="settings-actions-row">
          <button
            className="button secondary"
            disabled={busy}
            onClick={() => {
              setBusy(true);
              void window.glass
                .updateStatus(false)
                .then(v => {
                  setMessage(v.message);
                  if (v.available && v.version) useUpdateNotice.getState().setAvailable(v.version);
                })
                .catch(e => setMessage(cleanError(e)))
                .finally(() => setBusy(false));
            }}
          >
            {busy ? 'Verificando…' : 'Verificar atualizações'}
          </button>
          <button className="button secondary" onClick={() => void window.glass.exportLibrary()}>
            Exportar biblioteca
          </button>
          <button className="button secondary" onClick={() => void useApp.getState().importLibrary()}>
            Importar biblioteca
          </button>
          <button
            className="button secondary"
            onClick={() =>
              void window.glass
                .clearCache()
                .then(() => useApp.getState().message('Cache limpo.'))
                .catch(e => useApp.getState().message(cleanError(e)))
            }
          >
            Limpar cache
          </button>
        </div>
        {message && (
          <p role="status" className="fine-print">
            {message}
          </p>
        )}
      </section>
    </div>
  );
}
