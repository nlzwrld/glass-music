import { useEffect, useState } from 'react';
import {
  Bell,
  Disc3,
  HardDrive,
  Info,
  Palette,
  Search,
  Shield,
  Sliders,
  Sparkles,
  UserRound,
} from 'lucide-react';
import Appearance from '../components/glass/Appearance';
import AccountConnections from '../components/library/AccountConnections';
import { LiquidPlusSection } from '../components/library/LiquidPlusSection';
import { LiquidHubLogo } from '../components/brand/LiquidHubLogo';
import { Toggle } from '../components/glass/controls';
import { audioOutputDevices, requestAudioOutput } from '../lib/audioGraph';
import { isAndroidPlatform } from '../lib/androidBeta';
import { useUpdateNotice } from '../lib/updates';
import { useAccounts } from '../stores/accounts';
import {
  useApp,
  cleanError,
  setPreferencesFromUI,
  type SettingsCategory,
} from '../stores/app';
import {
  resolveNotificationMode,
  type NotificationMode,
  type ShuffleMode,
} from '../../shared/types';

interface CategoryMeta {
  id: SettingsCategory;
  label: string;
  keywords: string;
  Icon: typeof UserRound;
}

const SETTINGS_CATEGORIES: readonly CategoryMeta[] = [
  {
    id: 'account',
    label: 'Conta',
    keywords: 'conta perfil nickname handle bio links login oauth google discord github',
    Icon: UserRound,
  },
  {
    id: 'appearance',
    label: 'Aparência',
    keywords: 'aparencia tema escuro claro liquid glass vidro fosco cor escala animacoes',
    Icon: Palette,
  },
  {
    id: 'playback',
    label: 'Reprodução',
    keywords: 'reproducao transicao fade crossfade autoplay aleatorio smart shuffle descobertas',
    Icon: Disc3,
  },
  {
    id: 'audio',
    label: 'Áudio',
    keywords: 'audio volume booster limiter equalizador eq graves voz saida dispositivo som',
    Icon: Sliders,
  },
  {
    id: 'notifications',
    label: 'Notificações e Sistema',
    keywords: 'notificacoes sistema bandeja tray teclas multimidia windows startup',
    Icon: Bell,
  },
  {
    id: 'privacy',
    label: 'Privacidade',
    keywords: 'privacidade acesso online catalogo termos cofre dpapi seguranca',
    Icon: Shield,
  },
  {
    id: 'storage',
    label: 'Armazenamento',
    keywords: 'armazenamento biblioteca exportar importar cache backup downloads',
    Icon: HardDrive,
  },
  {
    id: 'plus',
    label: 'Liquid Plus',
    keywords: 'liquid plus assinatura beneficios planos anuncios visual temas',
    Icon: Sparkles,
  },
  {
    id: 'about',
    label: 'Sobre',
    keywords: 'sobre versao atualizacao update diagnostico reparo backup',
    Icon: Info,
  },
];

function AudioSettings() {
  const p = useApp(s => s.data.preferences),
    pref = useApp(s => s.setPreferences),
    prefUI = setPreferencesFromUI;
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

  const preset = (eq: number[]) => prefUI({ eq });

  return (
    <section className="settings-section" aria-label="Áudio">
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
            onChange={e => prefUI({ volume: Number(e.target.value) })}
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
            onChange={e => prefUI({ volumeBoost: Number(e.target.value) })}
          />
          <output>+{p.volumeBoost} dB</output>
        </span>
      </label>
      <Toggle
        label="Proteção contra distorção"
        checked={p.limiter}
        onChange={limiter => prefUI({ limiter })}
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
                  prefUI({ eq });
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
            onChange={e => prefUI({ outputDevice: e.target.value })}
          >
            <option value="default">Padrão do sistema</option>
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

function BrandPreviewGallery() {
  return (
    <section className="settings-section brand-preview-section" aria-label="Identidade do Liquid Hub">
      <div className="setting-row" style={{ borderBottom: 0 }}>
        <span style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <LiquidHubLogo size={38} variant="adaptive" />
          <span>
            <strong>Liquid Hub</strong>
            <small>Plataforma musical unificada com catálogos, letras sincronizadas e JAM ao vivo.</small>
          </span>
        </span>
      </div>
    </section>
  );
}

export default function Settings() {
  const p = useApp(s => s.data.preferences),
    tracksCount = useApp(s => s.data.tracks.length),
    playlistsCount = useApp(s => s.data.playlists.length),
    savedCount = useApp(s => s.data.tracks.filter(t => t.offline).length),
    integration = useApp(s => s.integrations),
    activeTab = useApp(s => s.settingsTab),
    setActiveTab = useApp(s => s.setSettingsTab),
    prefUI = setPreferencesFromUI;
  const [busy, setBusy] = useState(false),
    [message, setMessage] = useState(''),
    [filter, setFilter] = useState('');

  const q = filter.trim().toLocaleLowerCase('pt-BR');
  const matchingTabs = q
    ? SETTINGS_CATEGORIES.filter(
        c =>
          c.label.toLocaleLowerCase('pt-BR').includes(q) ||
          c.keywords.toLocaleLowerCase('pt-BR').includes(q),
      )
    : SETTINGS_CATEGORIES;

  const showCategory = (id: SettingsCategory) =>
    q ? matchingTabs.some(c => c.id === id) : activeTab === id;

  return (
    <div className="settings-page settings-shell">
      <div className="page-heading settings-header-row">
        <div className="heading-title-group">
          <h1>Configurações</h1>
          {integration?.version && <span className="version-pill">v{integration.version}</span>}
        </div>
        <label className="library-search settings-filter">
          <Search size={14} />
          <input
            aria-label="Filtrar configurações"
            placeholder="Filtrar configurações…"
            value={filter}
            onChange={e => setFilter(e.target.value)}
          />
        </label>
      </div>

      <div className="settings-layout">
        <nav className="settings-tabs" aria-label="Categorias de configurações">
          {SETTINGS_CATEGORIES.map(({ id, label, Icon }) => {
            const isSelected = !q && activeTab === id;
            const isMatched = Boolean(q && matchingTabs.some(m => m.id === id));
            return (
              <button
                key={id}
                type="button"
                aria-current={isSelected ? 'page' : undefined}
                className={`settings-tab-btn ${isSelected ? 'selected' : ''} ${isMatched ? 'matched' : ''}`}
                onClick={() => {
                  setFilter('');
                  setActiveTab(id);
                  document
                    .querySelector('.main-scroll')
                    ?.scrollTo({ top: 0, behavior: 'smooth' });
                }}
              >
                <Icon size={16} />
                <span>{label}</span>
              </button>
            );
          })}
        </nav>

        <div className="settings-content">
          {q && matchingTabs.length === 0 && (
            <div className="empty-state">
              <Search size={20} />
              <h3>Nenhuma configuração encontrada</h3>
              <p>Limpe o filtro para visualizar todas as categorias.</p>
            </div>
          )}

          {showCategory('account') && <AccountConnections />}

          {showCategory('appearance') && <Appearance />}

          {showCategory('playback') && (
            <section className="settings-section" aria-label="Reprodução">
              <h2>Reprodução</h2>
              <label className="setting-row">
                <strong>Transição entre músicas</strong>
                <select
                  aria-label="Transição entre músicas"
                  value={p.transition}
                  onChange={e => prefUI({ transition: e.target.value as typeof p.transition })}
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
                      onChange={e => prefUI({ transitionSeconds: Number(e.target.value) })}
                    />
                    <output>{p.transitionSeconds}s</output>
                  </span>
                </label>
              )}
              <Toggle
                label="Continuar ouvindo automaticamente"
                description="Reproduz faixas semelhantes ao terminar a fila"
                checked={p.autoplay !== false}
                onChange={autoplay => prefUI({ autoplay })}
              />
              <label className="setting-row">
                <span>
                  <strong>Modo do aleatório</strong>
                  <small>Inteligente considera histórico recente, curtidas e diversidade musical</small>
                </span>
                <select
                  aria-label="Modo do aleatório"
                  value={p.shuffleMode ?? 'smart'}
                  onChange={e => prefUI({ shuffleMode: e.target.value as ShuffleMode })}
                >
                  <option value="smart">Aleatório Inteligente</option>
                  <option value="standard">Aleatório Tradicional</option>
                </select>
              </label>
              <Toggle
                label="Descobertas ocasionais no aleatório inteligente"
                description="Intercala descobertas contextuais sem alterar suas playlists"
                checked={!!p.smartShuffleDiscoveries}
                onChange={smartShuffleDiscoveries => prefUI({ smartShuffleDiscoveries })}
              />
            </section>
          )}

          {showCategory('audio') && <AudioSettings />}

          {showCategory('notifications') && (
            <section className="settings-section" aria-label="Notificações e Sistema">
              <h2>Notificações e Sistema</h2>
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
                    prefUI({
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
              {isAndroidPlatform() ? (
                <div className="setting-row">
                  <span>
                    <strong>Reprodução em segundo plano e Bluetooth (Android)</strong>
                    <small>
                      Serviço de mídia ativo com MediaSession, tela de bloqueio, controles de fones
                      Bluetooth e recuperação automática de foco de áudio.
                    </small>
                  </span>
                </div>
              ) : (
                <>
                  <Toggle
                    label="Teclas multimídia"
                    checked={p.globalShortcuts}
                    onChange={globalShortcuts => prefUI({ globalShortcuts })}
                  />
                  <Toggle
                    label="Fechar janela para a bandeja"
                    description="Minimizar ou recolher para a bandeja mantém a reprodução e a JAM ativas"
                    checked={p.tray}
                    onChange={v => prefUI({ tray: v })}
                  />
                  <Toggle
                    label="Iniciar com o Windows"
                    checked={p.startup}
                    onChange={v => prefUI({ startup: v })}
                  />
                </>
              )}
            </section>
          )}

          {showCategory('privacy') && (
            <section className="settings-section" id="settings-cat-privacy" aria-label="Privacidade">
              <h2>Privacidade e Acesso Online</h2>
              <Toggle
                label="Acesso online"
                description="Permite pesquisas remotas, descobertas, letras, perfis e sessões JAM"
                checked={p.onlineConsent}
                onChange={v => prefUI({ onlineConsent: v, catalogConsent: v })}
              />
              <div className="settings-actions-row">
                <button className="text-button" onClick={() => prefUI({ onboardingDone: false })}>
                  Revisar Termos e Política de Privacidade
                </button>
              </div>
            </section>
          )}

          {showCategory('storage') && (
            <section className="settings-section" aria-label="Armazenamento">
              <h2>Armazenamento e Biblioteca</h2>
              <div className="setting-row">
                <span>
                  <strong>Resumo da biblioteca local</strong>
                  <small>
                    {playlistsCount} playlist(s) · {tracksCount} faixa(s) catalogada(s) · {savedCount} salva(s) para uso sem internet
                  </small>
                </span>
                <button
                  type="button"
                  className="button secondary"
                  onClick={() => useApp.getState().setPage('downloads')}
                >
                  Abrir página de Downloads
                </button>
              </div>
              <div className="settings-actions-row">
                {isAndroidPlatform() ? (
                  <button
                    type="button"
                    className="button secondary"
                    onClick={() =>
                      void useAccounts
                        .getState()
                        .syncAllMultiplatform()
                        .then(() =>
                          useApp
                            .getState()
                            .message('Biblioteca e preferências sincronizadas com sua conta.'),
                        )
                        .catch(e => useApp.getState().message(cleanError(e)))
                    }
                  >
                    Sincronizar biblioteca na nuvem
                  </button>
                ) : (
                  <>
                    <button
                      className="button secondary"
                      onClick={() => void window.glass.exportLibrary()}
                    >
                      Exportar biblioteca
                    </button>
                    <button
                      className="button secondary"
                      onClick={() => void useApp.getState().importLibrary()}
                    >
                      Importar biblioteca
                    </button>
                  </>
                )}
                <button
                  className="button secondary"
                  onClick={() =>
                    void window.glass
                      .clearCache()
                      .then(() => useApp.getState().message('Cache temporário limpo.'))
                      .catch(e => useApp.getState().message(cleanError(e)))
                  }
                >
                  Limpar cache de capas e buscas
                </button>
              </div>
            </section>
          )}

          {showCategory('plus') && <LiquidPlusSection />}

          {showCategory('about') && (
            <>
              <section className="settings-section" aria-label="Sobre o aplicativo">
                <h2>Sobre o Liquid Hub</h2>
                <div className="setting-row">
                  <span>
                    <strong>Versão instalada</strong>
                    <small>
                      Liquid Hub v{integration?.version || '2.2.0'} · Canal estável ·{' '}
                      {isAndroidPlatform()
                        ? 'APK Assinado + SHA-256'
                        : 'Minisign-Ed25519 + SHA-256'}
                    </small>
                  </span>
                  <button
                    className="button secondary"
                    disabled={busy}
                    onClick={() => {
                      setBusy(true);
                      void Promise.all([
                        window.glass.updateStatus(false),
                        useUpdateNotice.getState().checkVersionPolicy(),
                      ])
                        .then(([v]) => {
                          setMessage(v.message);
                          if (v.available && v.version) {
                            useUpdateNotice.getState().setAvailable(v.version, {
                              notes: v.notes,
                              integrity: v.integrity,
                              channel: v.channel,
                              downloadUrl: v.downloadUrl,
                            });
                          }
                        })
                        .catch(e => setMessage(cleanError(e)))
                        .finally(() => setBusy(false));
                    }}
                  >
                    {busy ? 'Verificando…' : 'Verificar atualizações'}
                  </button>
                </div>
                <Toggle
                  label="Atualizar automaticamente"
                  checked={p.autoUpdate}
                  onChange={autoUpdate => prefUI({ autoUpdate })}
                />
                {message && (
                  <p role="status" className="fine-print">
                    {message}
                  </p>
                )}
              </section>

              <InstallationMaintenanceSection />

              <BrandPreviewGallery />
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function InstallationMaintenanceSection() {
  const [maintBusy, setMaintBusy] = useState(false);
  const [report, setReport] = useState<{
    ok: boolean;
    repaired: boolean;
    dbIntegrityOk: boolean;
    vaultReadable: boolean;
    orphanedTempFiles: number;
    removedOrphanedTempFiles: number;
    backupsCount: number;
    message: string;
  } | null>(null);

  const runMaintenance = async (repair: boolean) => {
    if (!window.glass.maintenanceStatus || maintBusy) return;
    setMaintBusy(true);
    try {
      const res = await window.glass.maintenanceStatus(repair);
      setReport(res);
      useApp.getState().message(res.message);
    } catch (e) {
      useApp.getState().message(cleanError(e));
    } finally {
      setMaintBusy(false);
    }
  };

  return (
    <section
      className="settings-section"
      aria-label="Manutenção, integridade e reparo da instalação"
    >
      <h2>Diagnóstico e Reparo</h2>
      <p className="fine-print">
        Verifica a integridade da biblioteca local, limpa arquivos temporários incompletos e cria um
        ponto de restauração seguro sem afetar suas playlists.
      </p>
      <div className="settings-actions-row">
        <button
          type="button"
          className="button secondary"
          disabled={maintBusy}
          onClick={() => void runMaintenance(false)}
        >
          {maintBusy ? 'Verificando…' : 'Verificar integridade'}
        </button>
        <button
          type="button"
          className="button primary"
          disabled={maintBusy}
          onClick={() => void runMaintenance(true)}
        >
          {maintBusy ? 'Reparando…' : 'Reparar e criar backup'}
        </button>
      </div>
      {report && (
        <div role="status" className="maintenance-report-card">
          <strong>
            {report.ok
              ? report.repaired
                ? 'Reparo concluído e backup preventivo atualizado com sucesso.'
                : 'Biblioteca e instalação verificadas sem erros.'
              : 'Foram encontradas inconsistências que exigem reparo.'}
          </strong>
          <div className="maintenance-report-grid">
            <span>Biblioteca local: {report.dbIntegrityOk ? 'OK' : 'Requer reparo'}</span>
            <span>Backups salvos: {report.backupsCount}</span>
          </div>
        </div>
      )}
    </section>
  );
}
