import { useEffect, useRef, useState } from 'react';
import {
  BookmarkPlus,
  ListMusic,
  ListPlus,
  MessageSquare,
  Play,
  Plus,
  Search,
  Send,
  SkipForward,
  Trash2,
} from 'lucide-react';
import { canJam } from '../../../shared/jam';
import type { Track } from '../../../shared/types';
import { useApp } from '../../stores/app';
import { useJam } from './state';

export function JamInteractivePanel() {
  const jam = useJam();
  const data = useApp(s => s.data);
  const [chatText, setChatText] = useState('');
  const [queueQuery, setQueueQuery] = useState('');
  const [searchResults, setSearchResults] = useState<Track[]>([]);
  const [searching, setSearching] = useState(false);
  const [selectedPlaylistId, setSelectedPlaylistId] = useState('');
  const chatEndRef = useRef<HTMLDivElement>(null);

  const session = jam.session;
  const room = jam.room || session;
  const messages = room?.messages || [];
  const jamQueue = room?.jamQueue || [];
  const recommendations = room?.recommendations || [];
  const skipVotes = room?.skipVotes || [];
  const skipThreshold = room?.skipThreshold || 1;
  const hasVotedSkip = session ? skipVotes.includes(session.memberId) : false;

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }, [messages.length]);

  if (!session || !room) return null;

  const onlineLibraryTracks = data.tracks.filter(t => canJam(t)).slice(0, 8);
  const shareablePlaylists = data.playlists.filter(pl =>
    pl.trackIds.some(id => {
      const tr = data.tracks.find(t => t.id === id);
      return canJam(tr);
    }),
  );

  const handleQueueSearch = async (e: React.FormEvent) => {
    e.preventDefault();
    const q = queueQuery.trim();
    if (!q) {
      setSearchResults([]);
      return;
    }
    setSearching(true);
    try {
      const res = await window.glass.search({
        query: q,
        kind: 'track',
        source: 'all',
        requestId: `jam-q-${Date.now()}`,
      });
      setSearchResults((res.items || []).filter(t => canJam(t)).slice(0, 6));
    } catch {
      setSearchResults([]);
    } finally {
      setSearching(false);
    }
  };

  const handleRecommendPlaylist = async () => {
    const chosenId = selectedPlaylistId || shareablePlaylists[0]?.id;
    const pl = shareablePlaylists.find(p => p.id === chosenId);
    if (!pl) return;
    const tracks = pl.trackIds
      .map(id => data.tracks.find(t => t.id === id))
      .filter((t): t is Track => canJam(t));
    if (!tracks.length) return;
    await jam.recommendPlaylist(pl.name, tracks);
  };

  const handleSaveRecommendedPlaylist = async (name: string, tracks: Track[]) => {
    try {
      let snap = await window.glass.library({ action: 'create', name });
      const created = [...snap.playlists].reverse().find(p => p.name === name);
      if (created) {
        for (const tr of tracks) {
          snap = await window.glass.library({ action: 'add', id: created.id, track: tr });
        }
      }
      useApp.setState(s => ({ data: { ...snap, preferences: s.data.preferences } }));
      void import('../../stores/accounts').then(m =>
        m.useAccounts.getState().syncLibraryToCloud(),
      );
      useApp.getState().message(`Playlist "${name}" salva na sua biblioteca!`);
    } catch {
      useApp.getState().message('Não foi possível salvar a playlist recomendada.');
    }
  };

  const candidateTracks = searchResults.length ? searchResults : onlineLibraryTracks;

  return (
    <div className="jam-interactive">
      {/* 1. Vote to Skip */}
      <div className="jam-interactive-bar">
        <button
          type="button"
          className={`button ${hasVotedSkip ? 'primary' : 'secondary'}`}
          onClick={() => void jam.voteSkip()}
        >
          <SkipForward size={14} />
          {hasVotedSkip
            ? `Voto registrado (${skipVotes.length}/${skipThreshold})`
            : `Votar para pular (${skipVotes.length}/${skipThreshold})`}
        </button>
      </div>

      {/* 2. Shared JAM Queue */}
      <div className="jam-card">
        <div className="jam-card-head">
          <ListPlus size={15} />
          <strong>Fila da JAM ({jamQueue.length})</strong>
        </div>

        {jamQueue.length > 0 ? (
          <div className="jam-queue-list">
            {jamQueue.map(item => (
              <div key={item.id} className="jam-queue-row">
                <div className="jam-queue-meta">
                  <strong>{item.track.title}</strong>
                  <small>
                    {item.track.artist} · pedido por {item.addedByName}
                  </small>
                </div>
                <div className="jam-queue-actions">
                  {session.host && (
                    <button
                      type="button"
                      className="icon-button"
                      title="Tocar agora"
                      aria-label={`Tocar ${item.track.title}`}
                      onClick={() => {
                        useApp.getState().play(item.track, [
                          item.track,
                          ...jamQueue.filter(q => q.id !== item.id).map(q => q.track),
                        ]);
                        void jam.queueRemove(item.id);
                      }}
                    >
                      <Play size={13} />
                    </button>
                  )}
                  {(session.host || item.addedById === session.memberId) && (
                    <button
                      type="button"
                      className="icon-button"
                      title="Remover da fila"
                      aria-label={`Remover ${item.track.title} da fila`}
                      onClick={() => void jam.queueRemove(item.id)}
                    >
                      <Trash2 size={13} />
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        ) : (
          <p className="fine-print" style={{ margin: 0 }}>
            Nenhuma música na fila da JAM ainda. Busque abaixo ou escolha da sua biblioteca.
          </p>
        )}

        <form className="jam-inline-form" onSubmit={e => void handleQueueSearch(e)}>
          <input
            type="text"
            className="input"
            placeholder="Buscar música para adicionar à fila da JAM…"
            value={queueQuery}
            onChange={e => setQueueQuery(e.target.value)}
          />
          <button type="submit" className="button secondary" disabled={searching}>
            <Search size={14} />
            {searching ? 'Buscando…' : 'Buscar'}
          </button>
        </form>

        {candidateTracks.length > 0 && (
          <div className="jam-pick-list">
            {candidateTracks.map(track => (
              <div key={track.id} className="jam-queue-row">
                <div className="jam-queue-meta">
                  <strong>{track.title}</strong>
                  <small>{track.artist}</small>
                </div>
                <button
                  type="button"
                  className="button secondary"
                  onClick={() => void jam.queueAdd(track)}
                >
                  <Plus size={13} />
                  Fila
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* 3. Playlist Recommendations */}
      <div className="jam-card">
        <div className="jam-card-head">
          <ListMusic size={15} />
          <strong>Playlists recomendadas ({recommendations.length})</strong>
        </div>

        {shareablePlaylists.length > 0 ? (
          <div className="jam-inline-form">
            <select
              className="input"
              aria-label="Selecionar playlist para recomendar"
              value={selectedPlaylistId || shareablePlaylists[0]?.id || ''}
              onChange={e => setSelectedPlaylistId(e.target.value)}
            >
              {shareablePlaylists.map(pl => (
                <option key={pl.id} value={pl.id}>
                  {pl.name} ({pl.trackIds.length} faixas)
                </option>
              ))}
            </select>
            <button
              type="button"
              className="button secondary"
              onClick={() => void handleRecommendPlaylist()}
            >
              Recomendar
            </button>
          </div>
        ) : (
          <p className="fine-print" style={{ margin: 0 }}>
            Crie uma playlist com faixas online para recomendá-la na JAM.
          </p>
        )}

        {recommendations.length > 0 && (
          <div className="jam-queue-list">
            {recommendations.map(rec => (
              <div key={rec.id} className="jam-queue-row">
                <div className="jam-queue-meta">
                  <strong>{rec.name}</strong>
                  <small>
                    {rec.trackCount} faixas · por {rec.recommendedByName}
                  </small>
                </div>
                <div className="jam-queue-actions">
                  {session.host && rec.tracks[0] && (
                    <button
                      type="button"
                      className="button secondary"
                      onClick={() => useApp.getState().play(rec.tracks[0]!, rec.tracks)}
                    >
                      <Play size={13} />
                      Tocar
                    </button>
                  )}
                  <button
                    type="button"
                    className="button secondary"
                    onClick={() => void handleSaveRecommendedPlaylist(rec.name, rec.tracks)}
                  >
                    <BookmarkPlus size={13} />
                    Salvar
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* 4. Real-time JAM Chat */}
      <div className="jam-card">
        <div className="jam-card-head">
          <MessageSquare size={15} />
          <strong>Bate-papo da JAM</strong>
        </div>

        <div className="jam-chat-feed" aria-live="polite">
          {messages.length === 0 ? (
            <p className="fine-print" style={{ margin: 0 }}>
              Nenhuma mensagem ainda. Diga oi para quem está na sala!
            </p>
          ) : (
            messages.map(msg => (
              <div
                key={msg.id}
                className={`jam-chat-msg ${msg.memberId === session.memberId ? 'mine' : ''}`}
              >
                <div className="jam-chat-msg-head">
                  <strong>{msg.name}</strong>
                  <small>
                    {new Date(msg.sentAt).toLocaleTimeString([], {
                      hour: '2-digit',
                      minute: '2-digit',
                    })}
                  </small>
                </div>
                <p>{msg.text}</p>
              </div>
            ))
          )}
          <div ref={chatEndRef} />
        </div>

        <form
          className="jam-inline-form"
          onSubmit={e => {
            e.preventDefault();
            if (!chatText.trim()) return;
            const text = chatText;
            setChatText('');
            void jam.sendChat(text);
          }}
        >
          <input
            type="text"
            className="input"
            maxLength={300}
            placeholder="Escreva uma mensagem na JAM…"
            value={chatText}
            onChange={e => setChatText(e.target.value)}
          />
          <button type="submit" className="button primary" disabled={!chatText.trim()}>
            <Send size={14} />
            Enviar
          </button>
        </form>
      </div>
    </div>
  );
}
