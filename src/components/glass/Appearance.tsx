import { useRef } from 'react';
import { ImagePlus, RotateCcw } from 'lucide-react';
import { useApp, cleanError } from '../../stores/app';
import { Toggle } from './controls';
import { useOptics } from './v3/OpticalEngine';
import { opticalDefaults, type OpticalSettings } from './v3/model';
import { readBackground } from './v3/ambient';

export default function Appearance() {
  const { settings: s, setSettings, setLab } = useOptics(),
    p = useApp(v => v.data.preferences),
    pref = useApp(v => v.setPreferences),
    file = useRef<HTMLInputElement>(null);

  const uiStyle = p.uiStyle ?? 'matte';
  const isGlass = uiStyle === 'glass';

  const range = (
    key: 'blur' | 'specular' | 'refraction' | 'ior' | 'fresnel' | 'edge',
    label: string,
    min: number,
    max: number,
    step: number,
  ) => (
    <label className="setting-row" key={key}>
      <strong>{label}</strong>
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
        <output>{s[key].toFixed(step < 1 ? 2 : 0)}</output>
      </span>
    </label>
  );

  return (
    <section className="settings-section appearance-settings">
      <div className="appearance-heading">
        <h2>Aparência</h2>
        <button
          className="text-button"
          onClick={() => {
            void pref({
              uiStyle: 'matte',
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
              aria-pressed={uiStyle === mode}
              className={uiStyle === mode ? 'selected' : ''}
              onClick={() => void pref({ uiStyle: mode })}
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
              onClick={() => void pref({ theme })}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      <label className="setting-row">
        <strong>Cor de destaque</strong>
        <span className="setting-inline">
          <input
            type="color"
            aria-label="Cor de destaque"
            value={p.accent || '#52b79a'}
            onChange={e => void pref({ accent: e.target.value })}
          />
          {p.accent && p.accent.toLowerCase() !== '#52b79a' && (
            <button
              type="button"
              className="text-button"
              onClick={() => void pref({ accent: '#52b79a' })}
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
        label="Reduzir animações"
        checked={p.reducedMotion}
        onChange={reducedMotion => void pref({ reducedMotion })}
      />

      {isGlass && (
        <>
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
                  type="range"
                  min={0}
                  max={100}
                  value={p.glass}
                  onChange={e => void pref({ glass: Number(e.target.value) })}
                />
                <output>{p.glass}%</output>
              </span>
            </label>
            <label className="setting-row">
              <strong>Movimento do fundo</strong>
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
                <output>{Math.round(s.backgroundMotion * 100)}%</output>
              </span>
            </label>
            <label className="setting-row">
              <strong>Intensidade do gradiente</strong>
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
              label="Modo de desempenho"
              checked={p.performance}
              onChange={performance => void pref({ performance })}
            />
          </div>

          <details className="advanced-appearance">
            <summary>Ajustes do vidro</summary>
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
