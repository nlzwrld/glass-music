import { useEffect, useRef, useState } from 'react';
import { Film, ImagePlus, RotateCcw, Trash2 } from 'lucide-react';
import {
  DEFAULT_BACKGROUND_VIDEO_PREFERENCES,
  DEFAULT_PULSE_PREFERENCES,
  normalizeBackgroundVideoPreferences,
  normalizePulsePreferences,
  type BackgroundVideoPreferences,
  type PulsePreferences,
} from '../../lib/musicEvents';
import { useApp, cleanError, setPreferencesFromUI } from '../../stores/app';
import {
  refreshBackgroundVideoInfo,
  setBackgroundVideoInfo,
  useBackgroundVideoInfo,
} from './BackgroundVideoLayer';
import { Toggle } from './controls';
import { useOptics } from './v3/OpticalEngine';
import { glassVisualPresets, opticalDefaults, type OpticalSettings } from './v3/model';
import { readBackground } from './v3/ambient';

function formatVideoSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1).replace('.', ',')} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2).replace('.', ',')} GB`;
}

export default function Appearance() {
  const { settings: s, setSettings, setLab } = useOptics(),
    p = useApp(v => v.data.preferences),
    file = useRef<HTMLInputElement>(null);
  const [videoBusy, setVideoBusy] = useState(false);
  const videoInfo = useBackgroundVideoInfo();
  const pref = setPreferencesFromUI;

  const uiStyle = p.uiStyle ?? 'matte';
  const isGlass = uiStyle === 'glass';
  const pulseEnabled = Boolean(p.beatPulse ?? uiStyle === 'beat');
  const pulseCfg = normalizePulsePreferences(p.pulseConfig);
  const bgVideoCfg = normalizeBackgroundVideoPreferences(p.backgroundVideo);

  useEffect(() => {
    if (!videoInfo) {
      void refreshBackgroundVideoInfo();
    }
  }, []);

  const updatePulse = (patch: Partial<PulsePreferences>) => {
    pref({ pulseConfig: normalizePulsePreferences({ ...pulseCfg, ...patch }) });
  };

  const updateBgVideo = (patch: Partial<BackgroundVideoPreferences>) => {
    pref({ backgroundVideo: normalizeBackgroundVideoPreferences({ ...bgVideoCfg, ...patch }) });
  };

  const handlePickVideo = async () => {
    if (videoBusy || typeof window.glass?.pickBackgroundVideo !== 'function') return;
    setVideoBusy(true);
    try {
      const picked = await window.glass.pickBackgroundVideo();
      if (picked) {
        setBackgroundVideoInfo(picked);
        if (!bgVideoCfg.enabled) {
          updateBgVideo({ enabled: true });
        }
        useApp.getState().message('Vídeo de fundo atualizado.');
      }
    } catch (error) {
      useApp.getState().message(cleanError(error));
    } finally {
      setVideoBusy(false);
    }
  };

  const handleClearVideo = async () => {
    if (videoBusy || typeof window.glass?.clearBackgroundVideo !== 'function') return;
    setVideoBusy(true);
    try {
      await window.glass.clearBackgroundVideo();
      setBackgroundVideoInfo(null);
      if (bgVideoCfg.enabled) {
        updateBgVideo({ enabled: false });
      }
      useApp.getState().message('Vídeo de fundo removido.');
    } catch (error) {
      useApp.getState().message(cleanError(error));
    } finally {
      setVideoBusy(false);
    }
  };

  const range = (
    key: 'blur' | 'specular' | 'refraction' | 'ior' | 'fresnel' | 'edge',
    label: string,
    min: number,
    max: number,
    step: number,
  ) => {
    const pct = max > min ? Math.max(0, Math.min(100, ((s[key] - min) / (max - min)) * 100)) : 0;
    const formatted = s[key].toFixed(step < 1 ? 2 : 0);
    return (
      <label className="setting-row" key={key}>
        <strong>{label}</strong>
        <span className="setting-range">
          <input
            aria-label={label}
            aria-valuetext={formatted}
            type="range"
            min={min}
            max={max}
            step={step}
            value={s[key]}
            style={{ '--progress': `${pct}%` } as React.CSSProperties}
            onChange={e => setSettings({ [key]: Number(e.target.value) })}
          />
          <output>{formatted}</output>
        </span>
      </label>
    );
  };

  return (
    <section className="settings-section appearance-settings">
      <div className="appearance-heading">
        <h2>Aparência</h2>
        <button
          className="text-button"
          onClick={() => {
            pref({
              uiStyle: 'matte',
              beatPulse: false,
              pulseConfig: { ...DEFAULT_PULSE_PREFERENCES },
              backgroundVideo: { ...DEFAULT_BACKGROUND_VIDEO_PREFERENCES },
              theme: 'dark',
              accent: '#52b79a',
              glass: 20,
              blur: 24,
              reducedMotion: false,
              performance: false,
              appearance: { ...opticalDefaults, customImage: s.customImage },
            });
            useApp.getState().message('Aparência restaurada.');
          }}
        >
          <RotateCcw size={13} />
          Restaurar padrão
        </button>
      </div>

      <div className="setting-row">
        <strong>Estilo da interface</strong>
        <div className="pills" role="group" aria-label="Estilo da interface">
          {(
            [
              ['matte', 'Fosco'],
              ['glass', 'Liquid Glass'],
            ] as const
          ).map(([mode, label]) => (
            <button
              key={mode}
              aria-pressed={(uiStyle === 'glass' ? 'glass' : 'matte') === mode}
              className={(uiStyle === 'glass' ? 'glass' : 'matte') === mode ? 'selected' : ''}
              onClick={() => pref({ uiStyle: mode })}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      <div className="setting-row">
        <strong>Tema</strong>
        <div className="pills" role="group" aria-label="Tema">
          {(
            [
              ['dark', 'Escuro'],
              ['light', 'Claro'],
              ['system', 'Sistema'],
            ] as const
          ).map(([theme, label]) => (
            <button
              key={theme}
              aria-pressed={p.theme === theme}
              className={p.theme === theme ? 'selected' : ''}
              onClick={() => pref({ theme })}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      <label className="setting-row">
        <strong>Cor de destaque</strong>
        <span className="setting-inline">
          <div className="accent-swatches" role="group" aria-label="Cores rápidas">
            {['#52b79a', '#1db954', '#6366f1', '#ec4899', '#f59e0b', '#38bdf8'].map(hex => (
              <button
                key={hex}
                type="button"
                className={`accent-swatch ${(p.accent || '#52b79a').toLowerCase() === hex ? 'selected' : ''}`}
                style={{ background: hex }}
                aria-label={`Cor ${hex}`}
                onClick={() => pref({ accent: hex })}
              />
            ))}
          </div>
          <input
            type="color"
            aria-label="Cor de destaque"
            value={p.accent || '#52b79a'}
            onChange={e => pref({ accent: e.target.value })}
          />
          {p.accent && p.accent.toLowerCase() !== '#52b79a' && (
            <button
              type="button"
              className="text-button"
              onClick={() => pref({ accent: '#52b79a' })}
            >
              Padrão
            </button>
          )}
        </span>
      </label>

      <label className="setting-row">
        <strong>Escala da interface</strong>
        <select
          aria-label="Escala da interface"
          value={s.scale}
          onChange={e => setSettings({ scale: Number(e.target.value) })}
        >
          {[90, 100, 110, 125].map(n => (
            <option key={n} value={n}>
              {n}%
            </option>
          ))}
        </select>
      </label>

      <Toggle
        label="Sidebar compacta"
        checked={s.sidebarCompact}
        onChange={sidebarCompact => setSettings({ sidebarCompact })}
      />
      <Toggle
        label="Efeito Pulse"
        description="Pulsa nos graves e agudos com movimento fluido no fundo."
        checked={pulseEnabled}
        onChange={beatPulse => pref({ beatPulse, ...(uiStyle === 'beat' ? { uiStyle: 'matte' } : {}) })}
      />
      {pulseEnabled && (
        <div className="setting-subsection pulse-subcontrols" aria-label="Ajustes do Efeito Pulse">
          <Toggle
            label="Graves"
            checked={pulseCfg.bass}
            onChange={bass => updatePulse({ bass })}
          />
          <Toggle
            label="Impactos isolados"
            checked={pulseCfg.oneShot}
            onChange={oneShot => updatePulse({ oneShot })}
          />
          <Toggle
            label="Graves sequenciais"
            checked={pulseCfg.sequentialBass}
            onChange={sequentialBass => updatePulse({ sequentialBass })}
          />
          <Toggle
            label="Bateria e percussão"
            checked={pulseCfg.percussion}
            onChange={percussion => updatePulse({ percussion })}
          />
          <Toggle
            label="Supressão de voz"
            checked={pulseCfg.vocalSuppression}
            onChange={vocalSuppression => updatePulse({ vocalSuppression })}
          />
          <label className="setting-row">
            <strong>Sensibilidade do Pulse</strong>
            <span className="setting-range">
              <input
                aria-label="Sensibilidade do Pulse"
                aria-valuetext={`${pulseCfg.sensitivity.toFixed(2)}x`}
                type="range"
                min={0.25}
                max={2.0}
                step={0.05}
                value={pulseCfg.sensitivity}
                style={
                  {
                    '--progress': `${Math.round(((pulseCfg.sensitivity - 0.25) / 1.75) * 100)}%`,
                  } as React.CSSProperties
                }
                onChange={e => updatePulse({ sensitivity: Number(e.target.value) })}
              />
              <output>{pulseCfg.sensitivity.toFixed(2)}x</output>
            </span>
          </label>
        </div>
      )}

      <div className="setting-subsection bg-video-subsection" aria-label="Vídeo de fundo">
        <Toggle
          label="Vídeo de fundo"
          description="Exibe um vídeo local sem áudio atrás da interface."
          checked={bgVideoCfg.enabled}
          onChange={enabled => updateBgVideo({ enabled })}
        />
        <div className="bg-video-picker-row">
          <div className="bg-video-file-meta">
            {videoInfo ? (
              videoInfo.exists ? (
                <span className="bg-video-file-name" title={videoInfo.name}>
                  {videoInfo.name} · {formatVideoSize(videoInfo.size)}
                </span>
              ) : (
                <span className="bg-video-file-name bg-video-missing" title={videoInfo.name}>
                  Arquivo não encontrado: {videoInfo.name}
                </span>
              )
            ) : (
              <span className="bg-video-file-name">Nenhum vídeo selecionado</span>
            )}
            <span className="bg-video-file-note">MP4 / WebM · áudio silenciado automaticamente</span>
          </div>
          <div className="bg-video-actions">
            <button
              type="button"
              className="button secondary"
              disabled={videoBusy}
              onClick={() => void handlePickVideo()}
            >
              <Film size={14} />
              {videoInfo ? 'Trocar vídeo' : 'Selecionar vídeo'}
            </button>
            {videoInfo && (
              <button
                type="button"
                className="text-button"
                disabled={videoBusy}
                onClick={() => void handleClearVideo()}
              >
                <Trash2 size={13} />
                Remover
              </button>
            )}
          </div>
        </div>
        {bgVideoCfg.enabled && (
          <>
            <Toggle
              label="Sincronizar velocidade com a batida"
              checked={bgVideoCfg.beatSync}
              onChange={beatSync => updateBgVideo({ beatSync })}
            />
            <label className="setting-row">
              <strong>Intensidade da sincronização</strong>
              <span className="setting-range">
                <input
                  aria-label="Intensidade da sincronização"
                  aria-valuetext={`${Math.round(bgVideoCfg.syncIntensity * 100)}%`}
                  type="range"
                  min={0}
                  max={1}
                  step={0.05}
                  value={bgVideoCfg.syncIntensity}
                  style={
                    {
                      '--progress': `${Math.round(bgVideoCfg.syncIntensity * 100)}%`,
                    } as React.CSSProperties
                  }
                  onChange={e => updateBgVideo({ syncIntensity: Number(e.target.value) })}
                />
                <output>{Math.round(bgVideoCfg.syncIntensity * 100)}%</output>
              </span>
            </label>
            <label className="setting-row">
              <strong>Velocidade mínima</strong>
              <span className="setting-range">
                <input
                  aria-label="Velocidade mínima"
                  aria-valuetext={`${bgVideoCfg.minSpeed.toFixed(2)}x`}
                  type="range"
                  min={0.25}
                  max={1.5}
                  step={0.05}
                  value={bgVideoCfg.minSpeed}
                  style={
                    {
                      '--progress': `${Math.round(((bgVideoCfg.minSpeed - 0.25) / 1.25) * 100)}%`,
                    } as React.CSSProperties
                  }
                  onChange={e => {
                    const minSpeed = Number(e.target.value);
                    updateBgVideo({
                      minSpeed,
                      maxSpeed: Math.max(bgVideoCfg.maxSpeed, minSpeed),
                    });
                  }}
                />
                <output>{bgVideoCfg.minSpeed.toFixed(2)}x</output>
              </span>
            </label>
            <label className="setting-row">
              <strong>Velocidade máxima</strong>
              <span className="setting-range">
                <input
                  aria-label="Velocidade máxima"
                  aria-valuetext={`${bgVideoCfg.maxSpeed.toFixed(2)}x`}
                  type="range"
                  min={1.0}
                  max={3.0}
                  step={0.05}
                  value={bgVideoCfg.maxSpeed}
                  style={
                    {
                      '--progress': `${Math.round(((bgVideoCfg.maxSpeed - 1.0) / 2.0) * 100)}%`,
                    } as React.CSSProperties
                  }
                  onChange={e => {
                    const maxSpeed = Number(e.target.value);
                    updateBgVideo({
                      maxSpeed,
                      minSpeed: Math.min(bgVideoCfg.minSpeed, maxSpeed),
                    });
                  }}
                />
                <output>{bgVideoCfg.maxSpeed.toFixed(2)}x</output>
              </span>
            </label>
            <Toggle
              label="Repetir vídeo em loop"
              checked={bgVideoCfg.loop}
              onChange={loop => updateBgVideo({ loop })}
            />
          </>
        )}
      </div>
      <Toggle
        label="Reduzir animações"
        checked={p.reducedMotion}
        onChange={reducedMotion => pref({ reducedMotion })}
      />
      <Toggle
        label="Modo de desempenho"
        checked={p.performance}
        onChange={performance => pref({ performance })}
      />

      {isGlass && (
        <>
          <div className="setting-row">
            <strong>Estilos Liquid Glass</strong>
            <div className="pills glass-preset-row" role="group" aria-label="Predefinições Liquid Glass">
              {(Object.entries(glassVisualPresets) as Array<[keyof typeof glassVisualPresets, (typeof glassVisualPresets)[keyof typeof glassVisualPresets]]>).map(([key, preset]) => {
                const active =
                  s.material === preset.appearance.material &&
                  s.quality === preset.appearance.quality &&
                  Math.abs(s.blur - preset.appearance.blur) <= 1;
                return (
                  <button
                    key={key}
                    type="button"
                    aria-pressed={active}
                    className={active ? 'selected' : ''}
                    onClick={() => {
                      setSettings(preset.appearance);
                      pref({ glass: preset.glass });
                    }}
                  >
                    {preset.label}
                  </button>
                );
              })}
            </div>
          </div>
          <div className="background-options" role="group" aria-label="Fundo do aplicativo">
            {(
              [
                ['dynamic', 'Dinâmico'],
                ['custom', 'Personalizado'],
                ['solid', 'Cor'],
                ['desktop', 'Área de trabalho'],
                ['ambient', 'Ambiente'],
              ] as const
            ).map(([mode, title]) => (
              <button
                key={mode}
                aria-label={title}
                aria-pressed={s.background === mode}
                className={`background-option ${s.background === mode ? 'selected' : ''}`}
                onClick={() => setSettings({ background: mode })}
              >
                <span className={`background-swatch swatch-${mode}`} />
                <strong>{title}</strong>
              </button>
            ))}
          </div>

          {s.background === 'custom' && (
            <div className="custom-background-row">
              <button className="button secondary" onClick={() => file.current?.click()}>
                <ImagePlus size={15} />
                {s.customImage ? 'Trocar imagem' : 'Escolher imagem'}
              </button>
              <span className="fine-print">JPG, PNG ou WebP · até 12 MB</span>
              {s.customImage && (
                <img
                  className="custom-background-preview"
                  src={s.customImage}
                  alt="Fundo personalizado salvo"
                />
              )}
            </div>
          )}

          <input
            ref={file}
            data-background-upload
            type="file"
            accept="image/jpeg,image/png,image/webp"
            hidden
            onChange={e => {
              const image = e.target.files?.[0];
              if (image)
                void readBackground(image)
                  .then(customImage => setSettings({ customImage, background: 'custom' }))
                  .catch(error => useApp.getState().message(cleanError(error)));
              e.target.value = '';
            }}
          />

          {s.background === 'solid' && (
            <label className="setting-row">
              <strong>Cor do fundo</strong>
              <input
                type="color"
                aria-label="Cor do fundo"
                value={s.solidColor}
                onChange={e => setSettings({ solidColor: e.target.value })}
              />
            </label>
          )}

          <div className="appearance-controls">
            <label className="setting-row">
              <strong>Opacidade do vidro</strong>
              <span className="setting-range">
                <input
                  aria-label="Opacidade do vidro"
                  aria-valuetext={`${p.glass}%`}
                  type="range"
                  min={0}
                  max={100}
                  value={p.glass}
                  style={{ '--progress': `${p.glass}%` } as React.CSSProperties}
                  onChange={e => pref({ glass: Number(e.target.value) })}
                />
                <output>{p.glass}%</output>
              </span>
            </label>
            <label className="setting-row">
              <strong>Movimento do fundo</strong>
              <span className="setting-range">
                <input
                  aria-label="Movimento do fundo"
                  aria-valuetext={`${Math.round(s.backgroundMotion * 100)}%`}
                  type="range"
                  min={0}
                  max={1}
                  step={0.05}
                  value={s.backgroundMotion}
                  style={{ '--progress': `${Math.round(s.backgroundMotion * 100)}%` } as React.CSSProperties}
                  onChange={e => setSettings({ backgroundMotion: Number(e.target.value) })}
                />
                <output>{Math.round(s.backgroundMotion * 100)}%</output>
              </span>
            </label>
            <label className="setting-row">
              <strong>Intensidade do gradiente</strong>
              <span className="setting-range">
                <input
                  aria-label="Intensidade do gradiente"
                  aria-valuetext={`${Math.round(s.gradientIntensity * 100)}%`}
                  type="range"
                  min={0.1}
                  max={1}
                  step={0.05}
                  value={s.gradientIntensity}
                  style={
                    {
                      '--progress': `${Math.round(((s.gradientIntensity - 0.1) / 0.9) * 100)}%`,
                    } as React.CSSProperties
                  }
                  onChange={e => setSettings({ gradientIntensity: Number(e.target.value) })}
                />
                <output>{Math.round(s.gradientIntensity * 100)}%</output>
              </span>
            </label>
            {range('blur', 'Desfoque', 0, 24, 1)}
            {range('specular', 'Reflexos', 0, 1, 0.01)}
            <label className="setting-row">
              <strong>Material da interface inteira</strong>
              <select
                aria-label="Material da interface inteira"
                value={s.material}
                onChange={e =>
                  setSettings({ material: e.target.value as OpticalSettings['material'] })
                }
              >
                <option value="floating">Liquid Glass</option>
                <option value="frosted">Fosco</option>
                <option value="clear">Cristal</option>
                <option value="subtle">Discreto</option>
              </select>
            </label>
            <label className="setting-row">
              <strong>Qualidade do Liquid Glass</strong>
              <select
                aria-label="Qualidade do Liquid Glass"
                value={s.quality}
                onChange={e =>
                  setSettings({ quality: e.target.value as OpticalSettings['quality'] })
                }
              >
                <option value="auto">Automática</option>
                <option value="economy">Performance</option>
                <option value="balanced">Balanced</option>
                <option value="high">Ultra</option>
              </select>
            </label>
            <Toggle
              label="Ótica reativa aos graves"
              checked={s.audioReactive !== false}
              onChange={audioReactive => setSettings({ audioReactive })}
            />
          </div>

          <details className="advanced-appearance">
            <summary>Ajustes óticos avançados</summary>
            {range('refraction', 'Refração', 0, 12, 0.1)}
            {range('ior', 'Índice de refração', 1, 2, 0.01)}
            {range('fresnel', 'Fresnel', 0, 1, 0.01)}
            {range('edge', 'Iluminação das bordas', 0, 1, 0.01)}
            <button className="text-button" onClick={() => setLab(true)}>
              Glass Laboratory
            </button>
          </details>
        </>
      )}
    </section>
  );
}
