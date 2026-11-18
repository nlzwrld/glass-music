import { Input } from '../ui/input';
import { useEffect, useRef, useState } from 'react';
import { X, ListMusic, Plus, LoaderCircle, Check, Sparkles } from 'lucide-react';
import { useApp, cleanError, formatTime } from '../../stores/app';
import { invalidatePlayback } from '../../lib/playback';
import type { StreamCandidate, Track } from '../../../shared/types';
import { IconButton, SourceBadge } from './controls';

function StreamSourcePicker({
  track,
  onDone,
  onError,
}: {
  track: Track;
  onDone: () => void;
  onError: (msg: string) => void;
}) {
  const [candidates, setCandidates] = useState<StreamCandidate[]>([]);
  const [loading, setLoading] = useState(true);
  const [applyingId, setApplyingId] = useState<string | null>(null);

  useEffect(() => {
    const reqId = `candidates-${Date.now()}`;
    let active = true;
    setLoading(true);
    onError('');
    void window.glass
      .streamCandidates(track, reqId)
      .then(items => {
        if (active) setCandidates(items || []);
      })
      .catch(e => {
        if (active) onError(cleanError(e));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
      void window.glass.cancelSearch(reqId).catch(() => {});
    };
  }, [track.id]);

  const choose = async (cand: StreamCandidate | null) => {
    const key = cand ? `${cand.provider}:${cand.id}` : 'auto';
    setApplyingId(key);
    onError('');
    try {
      const updated = await window.glass.selectStreamCandidate(track, cand);
      invalidatePlayback(track.id);
      useApp.getState().applyResolvedTrack(updated, true);
      useApp
        .getState()
        .message(
          cand
            ? `Fonte alterada para ${cand.provider === 'ytmusic' ? 'YT Music' : cand.provider === 'soundcloud' ? 'SoundCloud' : cand.provider === 'deezer' ? 'Deezer' : 'YouTube'}.`
            : 'Seleção automática restaurada.',
        );
      onDone();
    } catch (e) {
      onError(cleanError(e));
    } finally {
      setApplyingId(null);
    }
  };

  const currentId = track.resolvedExternalId || track.playbackId;

  return (
    <div className="stream-source-dialog">
      <h2 id="dialog-title">Trocar fonte de áudio</h2>
      <p className="subtle">
        {track.title} · {track.artist}
      </p>
      {loading ? (
        <div className="stream-candidates-loading" role="status">
          <LoaderCircle size={16} className="spinner" />
          <span>Buscando versões compatíveis em YT Music, SoundCloud e YouTube…</span>
        </div>
      ) : (
        <div className="playlist-picker stream-candidate-picker" role="listbox" aria-label="Fontes de áudio disponíveis">
          <button
            type="button"
            disabled={applyingId !== null}
            onClick={() => void choose(null)}
          >
            <Sparkles size={15} />
            <span>
              Automático (melhor correspondência)
              <small>Prioriza YT Music Topic, fidelidade de duração e menor latência</small>
            </span>
            {!track.streamProvider && <Check size={15} />}
          </button>
          {candidates.map(cand => {
            const key = `${cand.provider}:${cand.id}`;
            const selected =
              currentId === cand.id &&
              (!track.streamProvider || track.streamProvider === cand.provider);
            return (
              <button
                key={key}
                type="button"
                className={selected ? 'selected' : ''}
                disabled={applyingId !== null}
                onClick={() => void choose(cand)}
              >
                <SourceBadge source={cand.provider} compact />
                <span>
                  {cand.title}
                  <small>
                    {cand.artist} · {formatTime(cand.duration)} · {Math.round(cand.score)}%
                  </small>
                </span>
                {selected ? <Check size={15} /> : null}
              </button>
            );
          })}
          {!candidates.length && (
            <p className="fine-print">Nenhuma versão alternativa compatível encontrada agora.</p>
          )}
        </div>
      )}
      <div className="modal-actions">
        <button type="button" className="button secondary" disabled={applyingId !== null} onClick={onDone}>
          Fechar
        </button>
      </div>
    </div>
  );
}

export default function Dialogs() {
  const dialog = useApp(s => s.dialog),
    playlists = useApp(s => s.data.playlists),
    consent = useApp(s => s.data.preferences.onlineConsent);
  const [value, setValue] = useState(''),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setValue(dialog?.type === 'playlist' ? dialog.name || '' : '');
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
          'button:not([disabled]),input:not([disabled]),a[href]',
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
        className="modal glass"
      >
        <IconButton
          label="Fechar diálogo"
          disabled={busy}
          className="modal-close"
          onClick={close}
        >
          <X size={16} />
        </IconButton>

        {dialog.type === 'playlist' && (
          <form
            onSubmit={e => {
              e.preventDefault();
              void run(async () => {
                await useApp
                  .getState()
                  .mutate(
                    dialog.id
                      ? { action: 'rename', id: dialog.id, name: value }
                      : { action: 'create', name: value },
                  );
                useApp
                  .getState()
                  .message(dialog.id ? 'Playlist renomeada.' : 'Playlist criada.');
              });
            }}
          >
            <h2 id="dialog-title">{dialog.id ? 'Renomear playlist' : 'Nova playlist'}</h2>
            <label className="field-label">
              Nome
              <Input
                autoFocus
                aria-label="Nome da playlist"
                value={value}
                maxLength={100}
                onChange={e => setValue(e.target.value)}
                placeholder="Nome da playlist"
                required
              />
            </label>
            <div className="modal-actions">
              <button type="button" className="button secondary" disabled={busy} onClick={close}>
                Cancelar
              </button>
              <button type="submit" className="button primary" disabled={busy || !value.trim()}>
                {busy ? 'Salvando…' : dialog.id ? 'Salvar' : 'Criar playlist'}
              </button>
            </div>
          </form>
        )}

        {dialog.type === 'add' && (
          <>
            <h2 id="dialog-title">
              {dialog.fromPlaylist ? 'Mover para playlist' : 'Adicionar à playlist'}
            </h2>
            <p className="subtle">{dialog.track.title}</p>
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
                    <ListMusic size={16} />
                    <span>
                      {p.name}
                      <small>
                        {p.trackIds.includes(dialog.track.id)
                          ? 'Já adicionada'
                          : `${p.trackIds.length} faixas`}
                      </small>
                    </span>
                    <Plus size={14} />
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
              <div className="modal-actions">
                <button type="button" className="button secondary" disabled={busy} onClick={close}>
                  Cancelar
                </button>
                <button type="submit" className="button primary" disabled={busy || !value.trim()}>
                  {dialog.fromPlaylist ? 'Criar e mover' : 'Criar e adicionar'}
                </button>
              </div>
            </form>
          </>
        )}

        {dialog.type === 'link' && (
          <>
            <h2 id="dialog-title">
              {dialog.playlist ? 'Importar playlist' : 'Importar por link'}
            </h2>
            {!consent ? (
              <div className="consent-needed">
                <p>Ative o acesso online nas configurações ou importe arquivos locais.</p>
                <div className="modal-actions">
                  <button
                    className="button secondary"
                    onClick={() => {
                      close();
                      void useApp.getState().importLocalFiles();
                    }}
                  >
                    Arquivos locais
                  </button>
                  <button
                    className="button primary"
                    onClick={() => {
                      close();
                      useApp.getState().setPage('settings');
                    }}
                  >
                    Configurações
                  </button>
                </div>
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
                  URL
                  <Input
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
                <div className="modal-actions">
                  {!dialog.playlist && (
                    <button
                      type="button"
                      className="text-button"
                      style={{ marginRight: 'auto' }}
                      disabled={busy}
                      onClick={() => {
                        close();
                        void useApp.getState().importLocalFiles();
                      }}
                    >
                      Arquivos locais
                    </button>
                  )}
                  <button type="button" className="button secondary" disabled={busy} onClick={close}>
                    Cancelar
                  </button>
                  <button type="submit" className="button primary" disabled={busy || !value.trim()}>
                    {busy ? (
                      <>
                        <LoaderCircle size={14} className="spinner" /> Importando…
                      </>
                    ) : dialog.playlist ? (
                      'Importar'
                    ) : (
                      'Adicionar'
                    )}
                  </button>
                </div>
              </form>
            )}
          </>
        )}

        {dialog.type === 'streamSource' && (
          <StreamSourcePicker
            track={dialog.track}
            onDone={close}
            onError={setError}
          />
        )}

        {dialog.type === 'confirm' && (
          <>
            <h2 id="dialog-title">{dialog.title}</h2>
            <p className="subtle">{dialog.text}</p>
            <div className="modal-actions">
              <button className="button secondary" disabled={busy} onClick={close}>
                Cancelar
              </button>
              <button
                className="button danger"
                disabled={busy}
                onClick={() => void run(dialog.action)}
              >
                {busy ? 'Aguarde…' : 'Confirmar'}
              </button>
            </div>
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
