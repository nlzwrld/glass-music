import { Input } from '../ui/input';
import { useEffect, useRef, useState } from 'react';
import {
  X,
  ListMusic,
  ListPlus,
  Plus,
  Link2,
  LoaderCircle,
  Music2,
  ImagePlus,
  AlertTriangle,
} from 'lucide-react';
import { useApp, cleanError } from '../../stores/app';
import { IconButton } from './controls';

async function readCoverImage(file: File): Promise<string> {
  if (file.size > 4_000_000) throw new Error('Escolha uma imagem de até 4 MB.');
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(url);
      const size = 380;
      const canvas = document.createElement('canvas');
      canvas.width = size;
      canvas.height = size;
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        reject(new Error('Não foi possível processar a imagem.'));
        return;
      }
      const minSide = Math.min(img.width, img.height);
      const sx = (img.width - minSide) / 2;
      const sy = (img.height - minSide) / 2;
      ctx.drawImage(img, sx, sy, minSide, minSide, 0, 0, size, size);
      resolve(canvas.toDataURL('image/jpeg', 0.86));
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('Formato de imagem inválido.'));
    };
    img.src = url;
  });
}

export default function Dialogs() {
  const dialog = useApp(s => s.dialog),
    playlists = useApp(s => s.data.playlists),
    consent = useApp(s => s.data.preferences.onlineConsent);
  const [value, setValue] = useState(''),
    [desc, setDesc] = useState(''),
    [cover, setCover] = useState(''),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const box = useRef<HTMLDivElement>(null),
    coverInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setValue(dialog?.type === 'playlist' ? dialog.name || '' : '');
    setDesc(dialog?.type === 'playlist' ? dialog.description || '' : '');
    setCover(dialog?.type === 'playlist' ? dialog.artwork || '' : '');
    setError('');
    setBusy(false);
    const prev = document.activeElement as HTMLElement;
    setTimeout(() => box.current?.querySelector<HTMLElement>('input,button')?.focus(), 0);
    return () => prev?.focus();
  }, [dialog]);

  useEffect(() => {
    if (!dialog) return;
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busy) useApp.getState().setDialog(null);
      if (e.key === 'Tab') {
        const nodes = box.current?.querySelectorAll<HTMLElement>(
          'button:not([disabled]),input:not([disabled]),textarea:not([disabled]),a[href]',
        );
        if (!nodes?.length) return;
        const first = nodes[0],
          last = nodes[nodes.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [dialog, busy]);

  if (!dialog) return null;
  const close = () => {
    if (!busy) useApp.getState().setDialog(null);
  };
  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError('');
    try {
      await fn();
      close();
      useApp.getState().setDialog(null);
    } catch (e) {
      setError(cleanError(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" onMouseDown={e => e.target === e.currentTarget && close()}>
      <div
        ref={box}
        role="dialog"
        aria-modal="true"
        aria-labelledby="dialog-title"
        className={`modal glass lg-modal ${dialog.type === 'playlist' ? 'lg-modal-wide' : ''}`}
      >
        <IconButton
          label="Fechar diálogo"
          disabled={busy}
          className="modal-close"
          onClick={close}
        >
          <X size={19} />
        </IconButton>

        {dialog.type === 'playlist' && (
          <form
            onSubmit={e => {
              e.preventDefault();
              void run(async () => {
                const beforeIds = new Set(useApp.getState().data.playlists.map(p => p.id));
                await useApp
                  .getState()
                  .mutate(
                    dialog.id
                      ? { action: 'rename', id: dialog.id, name: value }
                      : { action: 'create', name: value },
                  );
                const targetId =
                  dialog.id ||
                  useApp.getState().data.playlists.find(p => !beforeIds.has(p.id))?.id;
                if (targetId && (cover || desc !== (dialog.description || ''))) {
                  const snap = await window.glass.playlistMeta(targetId, {
                    artwork: cover || undefined,
                    description: desc,
                  });
                  useApp.setState({
                    data: { ...snap, preferences: useApp.getState().data.preferences },
                  });
                }
                useApp
                  .getState()
                  .message(dialog.id ? 'Playlist atualizada.' : 'Playlist criada.');
              });
            }}
          >
            <header className="lg-modal-header">
              <div className="lg-hero-badge">
                <ListPlus size={22} />
              </div>
              <div>
                <h2 id="dialog-title">
                  {dialog.id ? 'Editar playlist' : 'Criar playlist'}
                </h2>
                <p>Organize suas músicas favoritas em um só lugar.</p>
              </div>
            </header>

            <div className="lg-playlist-modal-grid">
              <div className="lg-playlist-cover-picker">
                {cover ? (
                  <img src={cover} alt="Capa escolhida" />
                ) : (
                  <div className="lg-cover-placeholder">
                    <Music2 size={46} strokeWidth={1.35} />
                  </div>
                )}
                <button
                  type="button"
                  className="lg-cover-pick-btn"
                  onClick={() => coverInput.current?.click()}
                >
                  <ImagePlus size={14} /> Escolher imagem
                </button>
                <input
                  ref={coverInput}
                  type="file"
                  accept="image/jpeg,image/png,image/webp"
                  hidden
                  onChange={e => {
                    const f = e.target.files?.[0];
                    if (f)
                      void readCoverImage(f)
                        .then(setCover)
                        .catch(err => setError(cleanError(err)));
                    e.target.value = '';
                  }}
                />
              </div>

              <div className="lg-playlist-fields">
                <label className="field-label">
                  Nome da playlist
                  <Input
                    autoFocus
                    aria-label="Nome da playlist"
                    value={value}
                    maxLength={100}
                    onChange={e => setValue(e.target.value)}
                    placeholder="Minha nova playlist"
                    required
                  />
                </label>
                <label className="field-label">
                  Descrição (opcional)
                  <textarea
                    className="lg-textarea"
                    aria-label="Descrição da playlist"
                    value={desc}
                    maxLength={300}
                    rows={3}
                    onChange={e => setDesc(e.target.value)}
                    placeholder="Descreva sua playlist…"
                  />
                </label>
              </div>
            </div>

            <footer className="lg-modal-footer">
              <button
                type="button"
                className="lg-pill-btn"
                disabled={busy}
                onClick={close}
              >
                Cancelar
              </button>
              <button
                type="submit"
                className="lg-cta-white"
                disabled={busy || !value.trim()}
              >
                <Plus size={16} />
                {busy
                  ? 'Salvando…'
                  : dialog.id
                    ? 'Salvar alterações'
                    : 'Criar playlist'}
              </button>
            </footer>
          </form>
        )}

        {dialog.type === 'add' && (
          <>
            <header className="lg-modal-header">
              <div className="lg-hero-badge">
                <Plus size={22} />
              </div>
              <div>
                <h2 id="dialog-title">
                  {dialog.fromPlaylist ? 'Mover para playlist' : 'Salvar em uma playlist'}
                </h2>
                <p>{dialog.track.title}</p>
              </div>
            </header>

            <div className="playlist-picker">
              {playlists
                .filter(p => p.id !== dialog.fromPlaylist)
                .map(p => (
                  <button
                    key={p.id}
                    disabled={
                      busy || (!dialog.fromPlaylist && p.trackIds.includes(dialog.track.id))
                    }
                    onClick={() =>
                      void run(async () => {
                        await useApp
                          .getState()
                          .mutate(
                            dialog.fromPlaylist
                              ? {
                                  action: 'move',
                                  id: dialog.fromPlaylist,
                                  targetId: p.id,
                                  trackId: dialog.track.id,
                                }
                              : { action: 'add', id: p.id, track: dialog.track },
                          );
                        useApp
                          .getState()
                          .message(
                            `${dialog.fromPlaylist ? 'Movida para' : 'Adicionada a'} ${p.name}.`,
                          );
                      })
                    }
                  >
                    <ListMusic size={19} />
                    <span>
                      {p.name}
                      <small>
                        {p.trackIds.includes(dialog.track.id)
                          ? 'Já está nesta playlist'
                          : `${p.trackIds.length} faixas`}
                      </small>
                    </span>
                    <Plus size={16} />
                  </button>
                ))}
            </div>

            <form
              onSubmit={e => {
                e.preventDefault();
                void run(async () => {
                  const previous = new Set(
                    useApp.getState().data.playlists.map(p => p.id),
                  );
                  await useApp.getState().mutate({ action: 'create', name: value });
                  const playlist = useApp
                    .getState()
                    .data.playlists.find(p => !previous.has(p.id));
                  if (playlist)
                    await useApp
                      .getState()
                      .mutate(
                        dialog.fromPlaylist
                          ? {
                              action: 'move',
                              id: dialog.fromPlaylist,
                              targetId: playlist.id,
                              trackId: dialog.track.id,
                            }
                          : { action: 'add', id: playlist.id, track: dialog.track },
                      );
                });
              }}
            >
              <label className="field-label">
                Nova playlist
                <Input
                  value={value}
                  onChange={e => setValue(e.target.value)}
                  maxLength={100}
                  placeholder="Nome da nova playlist"
                  required
                />
              </label>
              <footer className="lg-modal-footer">
                <button
                  type="button"
                  className="lg-pill-btn"
                  disabled={busy}
                  onClick={close}
                >
                  Cancelar
                </button>
                <button
                  type="submit"
                  className="lg-cta-white"
                  disabled={busy || !value.trim()}
                >
                  {dialog.fromPlaylist ? 'Criar e mover' : 'Criar e adicionar'}
                </button>
              </footer>
            </form>
          </>
        )}

        {dialog.type === 'link' && (
          <>
            <header className="lg-modal-header">
              <div className="lg-hero-badge">
                <Link2 size={22} />
              </div>
              <div>
                <h2 id="dialog-title">
                  {dialog.playlist ? 'Importar playlist ou álbum' : 'Adicionar link'}
                </h2>
                <p>
                  Spotify, Deezer, Apple Music, YouTube, YT Music, SoundCloud, Bandcamp ou Tidal
                </p>
              </div>
            </header>

            {!consent ? (
              <div className="consent-needed">
                <p>
                  Permita o acesso online para importar links, ou importe arquivos locais do
                  seu computador.
                </p>
                <footer className="lg-modal-footer">
                  <button
                    className="lg-pill-btn"
                    onClick={() => {
                      close();
                      void useApp.getState().importLocalFiles();
                    }}
                  >
                    Importar arquivos do PC
                  </button>
                  <button
                    className="lg-cta-white"
                    onClick={() => {
                      close();
                      useApp.getState().setPage('settings');
                    }}
                  >
                    Abrir configurações
                  </button>
                </footer>
              </div>
            ) : (
              <form
                onSubmit={e => {
                  e.preventDefault();
                  void run(async () => {
                    const result = await window.glass.importLink(value, dialog.playlist);
                    useApp.setState({
                      data: {
                        ...result.snapshot,
                        preferences: useApp.getState().data.preferences,
                      },
                    });
                    if (result.playlistId) {
                      useApp.getState().setPage(`playlist:${result.playlistId}`);
                      useApp
                        .getState()
                        .message(
                          `${result.count} faixas importadas.${result.skipped ? ` ${result.skipped} indisponíveis ignoradas.` : ''}${result.warning ? ` ${result.warning}` : ''}`,
                        );
                    } else if (result.track) {
                      useApp.getState().setPage('library');
                      useApp.getState().play(result.track);
                    }
                  });
                }}
              >
                <label className="field-label">
                  {dialog.playlist ? 'Endereço da playlist ou álbum' : 'Endereço da música, álbum ou playlist'}
                  <Input
                    autoFocus
                    value={value}
                    onChange={e => setValue(e.target.value)}
                    placeholder={
                      dialog.playlist
                        ? 'https://open.spotify.com/playlist/…'
                        : 'https://open.spotify.com/track/…'
                    }
                    type="url"
                    maxLength={2048}
                    required
                  />
                </label>
                <footer className="lg-modal-footer">
                  {!dialog.playlist && (
                    <button
                      type="button"
                      className="lg-pill-btn"
                      disabled={busy}
                      style={{ marginRight: 'auto' }}
                      onClick={() => {
                        close();
                        void useApp.getState().importLocalFiles();
                      }}
                    >
                      Arquivos locais
                    </button>
                  )}
                  <button
                    type="button"
                    className="lg-pill-btn"
                    disabled={busy}
                    onClick={close}
                  >
                    Cancelar
                  </button>
                  <button
                    type="submit"
                    className="lg-cta-white"
                    disabled={busy || !value.trim()}
                  >
                    {busy ? (
                      <>
                        <LoaderCircle size={15} className="spinner" /> Importando…
                      </>
                    ) : dialog.playlist ? (
                      'Importar'
                    ) : (
                      'Adicionar'
                    )}
                  </button>
                </footer>
              </form>
            )}
          </>
        )}

        {dialog.type === 'confirm' && (
          <>
            <header className="lg-modal-header">
              <div className="lg-hero-badge">
                <AlertTriangle size={22} />
              </div>
              <div>
                <h2 id="dialog-title">{dialog.title}</h2>
                <p>{dialog.text}</p>
              </div>
            </header>
            <footer className="lg-modal-footer">
              <button className="lg-pill-btn" disabled={busy} onClick={close}>
                Cancelar
              </button>
              <button
                className="lg-pill-btn danger"
                disabled={busy}
                onClick={() => void run(dialog.action)}
              >
                {busy ? 'Aguarde…' : 'Confirmar'}
              </button>
            </footer>
          </>
        )}

        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
      </div>
    </div>
  );
}
