import { useRef } from 'react';
import {
  ImagePlus,
  RotateCcw,
  Sparkles,
  Play,
  Pause,
  SkipBack,
  SkipForward,
  Shuffle,
  Repeat,
  Volume2,
  Layers,
  Scan,
} from 'lucide-react';
import { useApp, cleanError } from '../../stores/app';
import { Toggle } from './controls';
import { useOptics } from './v3/OpticalEngine';
import { opticalDefaults, type OpticalSettings } from './v3/model';
import { readBackground } from './v3/ambient';
import { transport } from '../player/engine';

export default function Appearance() {
  const { settings: s, setSettings, setLab } = useOptics(),
    p = useApp(v => v.data.preferences),
    playing = useApp(v => v.playing),
    pref = useApp(v => v.setPreferences),
    file = useRef<HTMLInputElement>(null);

  const range = (
    key: 'blur' | 'specular' | 'refraction' | 'ior' | 'fresnel' | 'edge',
    label: string,
    min: number,
    max: number,
    step: number,
  ) => (
    <label className="setting-row" key={key}>
      <span>
        <strong>{label}</strong>
      </span>
      <span className="setting-range">
        <input
          aria-label={label}
          type="range"
          min={min}
          max={max}
          step={step}
          value={s[key]}
          onChange={e => setSettings({ [key]: Number(e.target.value) })}
        />
        <output className="lg-val-chip">{s[key].toFixed(step < 1 ? 2 : 0)}</output>
      </span>
    </label>
  );

  const blurPreset =
    s.blur === 0 ? 'off' : s.blur <= 10 ? 'soft' : s.blur <= 18 ? 'medium' : 'deep';

  return (
    <section className="lg-settings-pane appearance-settings">
      <header className="lg-pane-header">
        <div>
          <h2>Aparência</h2>
          <p>Personalize o visual do Glass music</p>
        </div>
        <button
          className="lg-pill-btn"
          onClick={() => {
            void pref({
              theme: 'dark',
              glass: 20,
              blur: 24,
              reducedMotion: false,
              performance: false,
              appearance: { ...opticalDefaults, customImage: s.customImage },
            });
            useApp
              .getState()
              .message('Aparência restaurada. Sua imagem personalizada foi preservada.');
          }}
        >
          <RotateCcw size={14} />
          Restaurar padrão
        </button>
      </header>

      <div className="lg-theme-block">
        <div className="lg-block-label">
          <strong>Tema</strong>
          <small>Escolha o tema da interface</small>
        </div>
        <div className="lg-theme-cards" role="radiogroup" aria-label="Tema">
          {(
            [
              ['dark', 'Escuro', 'Tema escuro com vidro fosco'],
              ['light', 'Claro', 'Tema claro e limpo'],
              ['system', 'Sistema', 'Segue o tema do Windows'],
            ] as const
          ).map(([theme, title, desc]) => (
            <button
              key={theme}
              type="button"
              role="radio"
              aria-checked={p.theme === theme}
              className={`lg-theme-card ${p.theme === theme ? 'selected' : ''}`}
              onClick={() => void pref({ theme })}
            >
              <div className={`lg-theme-mockup mockup-${theme}`} aria-hidden="true">
                <i />
                <span />
                <b />
              </div>
              <div className="lg-theme-meta">
                <strong>{title}</strong>
                <small>{desc}</small>
              </div>
              <span className="lg-radio-dot" aria-hidden="true" />
            </button>
          ))}
        </div>
      </div>

      <label className="setting-row">
        <span>
          <strong>Transparência</strong>
          <small>Define o nível de transparência das superfícies de vidro do aplicativo</small>
        </span>
        <span className="setting-range">
          <input
            aria-label="Opacidade do vidro"
            type="range"
            min={0}
            max={100}
            value={100 - p.glass}
            style={{ '--progress': `${100 - p.glass}%` } as React.CSSProperties}
            onChange={e => void pref({ glass: Math.max(0, 100 - Number(e.target.value)) })}
          />
          <output className="lg-val-chip">{100 - p.glass}%</output>
        </span>
      </label>

      <div className="lg-icon-setting-row">
        <span className="lg-row-lead">
          <Layers size={18} />
        </span>
        <Toggle
          label="Liquid Glass"
          description="Ativa o material Liquid Glass com desfoque, profundidade e reflexos suaves"
          checked={!p.performance}
          onChange={enabled => void pref({ performance: !enabled })}
        />
      </div>

      <div className="lg-icon-setting-row">
        <span className="lg-row-lead">
          <Sparkles size={18} />
        </span>
        <Toggle
          label="Animações suaves"
          description="Habilita transições e microanimações na interface"
          checked={!p.reducedMotion}
          onChange={smooth => void pref({ reducedMotion: !smooth })}
        />
      </div>

      <div className="lg-icon-setting-row">
        <span className="lg-row-lead">
          <Scan size={18} />
        </span>
        <label className="setting-row" style={{ flex: 1 }}>
          <span>
            <strong>Desfoque de fundo</strong>
            <small>Controla a intensidade do desfoque (blur) do material de vidro</small>
          </span>
          <select
            aria-label="Desfoque de fundo"
            value={blurPreset}
            onChange={e => {
              const v = e.target.value;
              const nextBlur =
                v === 'off' ? 0 : v === 'soft' ? 8 : v === 'medium' ? 16 : 24;
              setSettings({ blur: nextBlur });
              void pref({ blur: nextBlur });
            }}
          >
            <option value="soft">Suave</option>
            <option value="medium">Médio (padrão)</option>
            <option value="deep">Intenso</option>
            <option value="off">Desativado</option>
          </select>
        </label>
      </div>

      <div className="lg-material-preview" aria-label="Prévia do material">
        <button
          type="button"
          className="lg-preview-badge"
          aria-label="Testar reprodução na prévia"
          onClick={() => transport.toggle()}
        >
          {playing ? <Pause size={16} /> : <Play size={16} />}
        </button>
        <div className="lg-preview-copy">
          <strong>Prévia do material</strong>
          <small>Veja como o Liquid Glass fica com as configurações atuais</small>
        </div>
        <div className="lg-preview-transport" aria-hidden="true">
          <Shuffle size={14} />
          <SkipBack size={15} />
          <span className="lg-preview-play">
            {playing ? <Pause size={15} fill="currentColor" /> : <Play size={15} fill="currentColor" />}
          </span>
          <SkipForward size={15} />
          <Repeat size={14} />
          <span className="lg-preview-vol">
            <i />
          </span>
          <Volume2 size={15} />
        </div>
      </div>

      <div className="lg-theme-block" style={{ marginTop: 22 }}>
        <div className="lg-block-label">
          <strong>Ambiente de fundo</strong>
          <small>Escolha como a luz reage às capas dos álbuns ou à área de trabalho</small>
        </div>
        <div className="background-options" role="group" aria-label="Fundo do aplicativo">
          {(
            [
              ['dynamic', 'Dinâmico', 'Cores da música'],
              ['custom', 'Personalizado', 'Sua imagem'],
              ['solid', 'Cor', 'Gradiente vivo'],
              ['desktop', 'Área de trabalho', 'Transparência nativa'],
              ['ambient', 'Ambiente', 'Luz difusa'],
            ] as const
          ).map(([mode, title, caption]) => (
            <button
              key={mode}
              aria-label={title}
              aria-pressed={s.background === mode}
              className={`background-option ${s.background === mode ? 'selected' : ''}`}
              onClick={() => setSettings({ background: mode })}
            >
              <span className={`background-swatch swatch-${mode}`} />
              <strong>{title}</strong>
              <small>{caption}</small>
            </button>
          ))}
        </div>
      </div>

      {s.background === 'custom' && (
        <div className="custom-background-row">
          <button className="lg-pill-btn" onClick={() => file.current?.click()}>
            <ImagePlus size={16} />
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
          <span>
            <strong>Cor do fundo</strong>
          </span>
          <input
            type="color"
            aria-label="Cor do fundo"
            value={s.solidColor}
            onChange={e => setSettings({ solidColor: e.target.value })}
          />
        </label>
      )}

      <details className="advanced-appearance">
        <summary>Ajustes ópticos avançados e escala</summary>
        <div className="appearance-controls">
          <label className="setting-row">
            <span>
              <strong>Material da interface</strong>
            </span>
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
            <span>
              <strong>Qualidade óptica</strong>
            </span>
            <select
              aria-label="Qualidade do Liquid Glass"
              value={s.quality}
              onChange={e =>
                setSettings({ quality: e.target.value as OpticalSettings['quality'] })
              }
            >
              <option value="auto">Automática</option>
              <option value="economy">Performance</option>
              <option value="balanced">Equilibrada</option>
              <option value="high">Ultra</option>
            </select>
          </label>
          <label className="setting-row">
            <span>
              <strong>Escala da interface</strong>
            </span>
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
          <label className="setting-row">
            <span>
              <strong>Movimento do fundo</strong>
            </span>
            <span className="setting-range">
              <input
                aria-label="Movimento do fundo"
                type="range"
                min={0}
                max={1}
                step={0.05}
                value={s.backgroundMotion}
                onChange={e => setSettings({ backgroundMotion: Number(e.target.value) })}
              />
              <output className="lg-val-chip">
                {Math.round(s.backgroundMotion * 100)}%
              </output>
            </span>
          </label>
          <label className="setting-row">
            <span>
              <strong>Intensidade do gradiente</strong>
            </span>
            <span className="setting-range">
              <input
                aria-label="Intensidade do gradiente"
                type="range"
                min={0.1}
                max={1}
                step={0.05}
                value={s.gradientIntensity}
                onChange={e => setSettings({ gradientIntensity: Number(e.target.value) })}
              />
              <output className="lg-val-chip">
                {Math.round(s.gradientIntensity * 100)}%
              </output>
            </span>
          </label>
          {range('specular', 'Reflexos', 0, 1, 0.01)}
          {range('refraction', 'Refração', 0, 12, 0.1)}
          {range('ior', 'Índice de refração', 1, 2, 0.01)}
          {range('fresnel', 'Fresnel', 0, 1, 0.01)}
          {range('edge', 'Iluminação das bordas', 0, 1, 0.01)}
        </div>
        <Toggle
          label="Sidebar compacta"
          checked={s.sidebarCompact}
          onChange={sidebarCompact => setSettings({ sidebarCompact })}
        />
        <div style={{ marginTop: 12 }}>
          <button className="lg-pill-btn" onClick={() => setLab(true)}>
            <Sparkles size={14} /> Abrir Glass Laboratory
          </button>
        </div>
      </details>
    </section>
  );
}
