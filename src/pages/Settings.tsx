import { useEffect, useState } from 'react';
import {
  Palette,
  AudioLines,
  Play,
  Settings2,
  Download,
  Link2,
  Info,
  RefreshCw,
  Trash2,
  Share2,
  FolderInput,
} from 'lucide-react';
import { motion } from 'motion/react';
import Appearance from '../components/glass/Appearance';
import { useApp, cleanError } from '../stores/app';
import AccountConnections from '../components/library/AccountConnections';
import { Toggle } from '../components/glass/controls';
import { audioOutputDevices, requestAudioOutput } from '../lib/audioGraph';
import { JamSettings } from '../components/jam/JamSettings';
import Cover from '../components/glass/Cover';
import { useOptics } from '../components/glass/v3/OpticalEngine';

type SectionId =
  | 'general'
  | 'appearance'
  | 'audio'
  | 'playback'
  | 'downloads'
  | 'integrations'
  | 'about';

const SECTIONS: [SectionId, string, typeof Palette][] = [
  ['general', 'Geral', Settings2],
  ['appearance', 'Aparência', Palette],
  ['audio', 'Áudio', AudioLines],
  ['playback', 'Reprodução', Play],
  ['downloads', 'Downloads', Download],
  ['integrations', 'Integrações', Link2],
  ['about', 'Sobre', Info],
];

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
    <section className="lg-settings-pane">
      <header className="lg-pane-header">
        <div>
          <h2>Áudio e dispositivo</h2>
          <p>Equalizador de 5 bandas, ganho extra sem distorção e saída de som</p>
        </div>
      </header>

      <label className="setting-row">
        <span>
          <strong>Volume principal</strong>
          <small>Nível global de reprodução do aplicativo</small>
        </span>
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
          <output className="lg-val-chip">{p.volume}%</output>
        </span>
      </label>

      <label className="setting-row">
        <span>
          <strong>Volume booster</strong>
          <small>Amplificação adicional de até +12 dB</small>
        </span>
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
          <output className="lg-val-chip">+{p.volumeBoost} dB</output>
        </span>
      </label>

      <Toggle
        label="Proteção contra distorção"
        description="Compressor dinâmico transparente que evita clipping em volumes altos"
        checked={p.limiter}
        onChange={limiter => void pref({ limiter })}
      />

      <div className="lg-subblock">
        <div className="lg-subblock-head">
          <h3>Equalizador</h3>
          <div className="eq-presets">
            <button className="lg-pill-btn" onClick={() => preset([0, 0, 0, 0, 0])}>
              Neutro
            </button>
            <button className="lg-pill-btn" onClick={() => preset([5, 3, 0, 1, 2])}>
              Graves
            </button>
            <button className="lg-pill-btn" onClick={() => preset([-2, 0, 3, 2, 0])}>
              Voz
            </button>
            <button className="lg-pill-btn" onClick={() => preset([3, 1, -1, 2, 4])}>
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

      <div className="lg-subblock">
        <h3>Dispositivo de saída</h3>
        <label className="setting-row">
          <span>
            <strong>Saída de som</strong>
            <small>Escolha fones, caixas ou interface de áudio</small>
          </span>
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
        </label>
        <div style={{ marginTop: 12 }}>
          <button
            className="lg-pill-btn"
            onClick={() =>
              void requestAudioOutput()
                .then(async d => {
                  await pref({ outputDevice: d.deviceId });
                  setDevices(await audioOutputDevices());
                })
                .catch(e => useApp.getState().message(cleanError(e)))
            }
          >
            Escolher dispositivo do sistema
          </button>
        </div>
      </div>
    </section>
  );
}

function PlaybackSettings() {
  const p = useApp(s => s.data.preferences),
    pref = useApp(s => s.setPreferences);
  return (
    <section className="lg-settings-pane">
      <header className="lg-pane-header">
        <div>
          <h2>Reprodução e transições</h2>
          <p>Controle como uma música passa para a próxima e o rádio contínuo</p>
        </div>
      </header>

      <label className="setting-row">
        <span>
          <strong>Transição entre músicas</strong>
          <small>Sobreposição suave no motor Dual-Deck</small>
        </span>
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
          <span>
            <strong>Duração da transição</strong>
            <small>Tempo de fusão sonora entre o fim e o início das faixas</small>
          </span>
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
            <output className="lg-val-chip">{p.transitionSeconds}s</output>
          </span>
        </label>
      )}

      <Toggle
        label="Continuar ouvindo automaticamente (Rádio do estilo)"
        description="Quando acabar a playlist, reproduz músicas inéditas fora da lista baseadas no estilo que você estava ouvindo"
        checked={p.autoplay !== false}
        onChange={autoplay => void pref({ autoplay })}
      />
    </section>
  );
}

function OfflineSettings() {
  const tracks = useApp(s => s.data.tracks.filter(t => t.offline));
  return (
    <section className="lg-settings-pane">
      <header className="lg-pane-header">
        <div>
          <h2>Downloads e offline</h2>
          <p>{tracks.length} música(s) salva(s) neste computador para ouvir sem internet</p>
        </div>
      </header>

      {tracks.length ? (
        <div className="lg-offline-list">
          {tracks.map(t => (
            <div className="lg-offline-item" key={t.id}>
              <div className="lg-aside-square">
                <Cover track={t} />
              </div>
              <div className="lg-aside-meta">
                <strong>{t.title}</strong>
                <small>{t.artist}</small>
              </div>
              <button
                className="lg-pill-btn"
                onClick={() => void useApp.getState().downloadTrack(t)}
              >
                <Trash2 size={14} /> Remover
              </button>
            </div>
          ))}
        </div>
      ) : (
        <p className="fine-print">
          Use “Baixar para ouvir offline” no menu (⋯) de qualquer música ou playlist compatível.
        </p>
      )}
    </section>
  );
}

function GeneralSettings() {
  const p = useApp(s => s.data.preferences),
    pref = useApp(s => s.setPreferences);
  return (
    <section className="lg-settings-pane">
      <header className="lg-pane-header">
        <div>
          <h2>Geral</h2>
          <p>Comportamento do aplicativo no Windows, biblioteca e manutenção</p>
        </div>
      </header>

      <Toggle
        label="Iniciar com o Windows"
        description="Abre o Glass Music automaticamente ao entrar na sua conta"
        checked={p.startup}
        onChange={v => void pref({ startup: v })}
      />
      <Toggle
        label="Fechar para a bandeja do sistema"
        description="Continua tocando em segundo plano ao fechar a janela"
        checked={p.tray}
        onChange={v => void pref({ tray: v })}
      />
      <Toggle
        label="Teclas multimídia globais"
        description="Controla Play/Pause e Próxima mesmo com outros apps em foco"
        checked={p.globalShortcuts}
        onChange={v => void pref({ globalShortcuts: v })}
      />
      <Toggle
        label="Notificações discretas de faixa"
        description="Exibe título e artista quando uma nova música começa"
        checked={p.notifications}
        onChange={v => void pref({ notifications: v })}
      />

      <div className="lg-subblock">
        <h3>Backup e manutenção</h3>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginTop: 12 }}>
          <button
            className="lg-pill-btn"
            onClick={() => void window.glass.exportLibrary()}
          >
            <Share2 size={15} /> Exportar biblioteca
          </button>
          <button
            className="lg-pill-btn"
            onClick={() => void useApp.getState().importLibrary()}
          >
            <FolderInput size={15} /> Importar biblioteca
          </button>
          <button
            className="lg-pill-btn"
            onClick={() =>
              void window.glass
                .clearCache()
                .then(() => useApp.getState().message('Cache limpo com sucesso.'))
                .catch(e => useApp.getState().message(cleanError(e)))
            }
          >
            Limpar cache de capas e buscas
          </button>
        </div>
      </div>
    </section>
  );
}

function IntegrationsSettings() {
  const p = useApp(s => s.data.preferences),
    pref = useApp(s => s.setPreferences);
  return (
    <section className="lg-settings-pane">
      <header className="lg-pane-header">
        <div>
          <h2>Integrações, JAM e Contas</h2>
          <p>Conecte catálogos online, escute sincronizado com amigos e gerencie contas</p>
        </div>
      </header>

      <Toggle
        label="Acesso online e catálogos públicos"
        description="Habilita buscas no YouTube, Deezer, Apple Music, SoundCloud, letras e rádio automática"
        checked={p.onlineConsent && p.catalogConsent}
        onChange={v => void pref({ onlineConsent: v, catalogConsent: v })}
      />

      <div className="lg-subblock">
        <JamSettings />
      </div>

      <div className="lg-subblock">
        <AccountConnections />
      </div>
    </section>
  );
}

function AboutSettings() {
  const p = useApp(s => s.data.preferences),
    integration = useApp(s => s.integrations),
    pref = useApp(s => s.setPreferences);
  const [busy, setBusy] = useState(false),
    [message, setMessage] = useState('');
  return (
    <section className="lg-settings-pane">
      <header className="lg-pane-header">
        <div>
          <h2>Sobre o Glass Music</h2>
          <p>Versão {integration?.version || '2.2'} • Edição Windows Liquid Glass</p>
        </div>
      </header>

      <Toggle
        label="Atualizar automaticamente"
        description="Baixa e aplica novas edições assinadas publicadas no GitHub Releases"
        checked={p.autoUpdate}
        onChange={autoUpdate => void pref({ autoUpdate })}
      />

      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginTop: 16 }}>
        <button
          className="lg-cta-white"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            void window.glass
              .updateStatus(false)
              .then(v => setMessage(v.message))
              .catch(e => setMessage(cleanError(e)))
              .finally(() => setBusy(false));
          }}
        >
          <RefreshCw size={15} className={busy ? 'spinner' : ''} />
          {busy ? 'Verificando…' : 'Verificar atualizações'}
        </button>
        <button
          className="lg-pill-btn"
          onClick={() => void pref({ onboardingDone: false })}
        >
          Termos e privacidade
        </button>
      </div>

      {message && (
        <p role="status" className="notice" style={{ marginTop: 16 }}>
          {message}
        </p>
      )}
    </section>
  );
}

export default function Settings() {
  const [active, setActive] = useState<SectionId>('appearance');
  const integration = useApp(s => s.integrations);
  const { reduced } = useOptics();

  return (
    <div className="lg-settings-shell">
      <header className="lg-section-hero">
        <div className="lg-hero-badge">
          <Settings2 size={24} />
        </div>
        <div>
          <h1>Configurações</h1>
          <p>Personalize sua experiência</p>
        </div>
        {integration?.version && (
          <span className="lg-chip-badge" style={{ marginLeft: 'auto' }}>
            v{integration.version}
          </span>
        )}
      </header>

      <div className="lg-settings-split">
        <nav className="lg-settings-rail" aria-label="Categorias de configurações">
          {SECTIONS.map(([id, label, Icon]) => (
            <button
              key={id}
              type="button"
              aria-current={active === id ? 'page' : undefined}
              className={`nav-item ${active === id ? 'selected' : ''}`}
              onClick={() => setActive(id)}
            >
              {active === id && (
                <motion.span
                  className="nav-capsule"
                  layoutId="settings-nav-capsule"
                  transition={{
                    type: 'tween',
                    duration: reduced ? 0 : 0.26,
                    ease: [0.22, 1, 0.36, 1],
                  }}
                />
              )}
              <Icon size={18} />
              <span>{label}</span>
            </button>
          ))}
        </nav>

        <div className="lg-settings-detail">
          {active === 'general' && <GeneralSettings />}
          {active === 'appearance' && <Appearance />}
          {active === 'audio' && <AudioSettings />}
          {active === 'playback' && <PlaybackSettings />}
          {active === 'downloads' && <OfflineSettings />}
          {active === 'integrations' && <IntegrationsSettings />}
          {active === 'about' && <AboutSettings />}
        </div>
      </div>
    </div>
  );
}
