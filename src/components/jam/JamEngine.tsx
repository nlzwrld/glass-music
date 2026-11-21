import { useEffect } from 'react';
import { jamPosition, jamDriftMs, canJam, type JamRoom } from '../../../shared/jam';
import {
  computeBackoffMs,
  jamWebSocketUrl,
  shouldHostSync,
  type HostSyncSnapshot,
} from '../../lib/jam';
import { useApp, cleanError } from '../../stores/app';
import { transport } from '../player/engine';
import { jamClient, useJam } from './state';

const WS_HIBERNATION_PING_MS = 20000;
const HOST_SEEK_CHECK_MS = 1200;
const HTTP_CLOUD_HOST_KEEPALIVE_MS = 12000;
const HTTP_LAN_POLL_MS = 1000;
const HTTP_GUEST_POLL_MS = 1000;

export function JamEngine() {
  const session = useJam(s => s.session),
    consent = useApp(
      s => s.data.preferences.onlineConsent && s.data.preferences.onboardingDone,
    );

  useEffect(() => {
    if (!session) {
      transport.rate(1);
      return;
    }
    if (!consent) {
      void useJam.getState().leave();
      transport.pause();
      transport.rate(1);
      return;
    }

    let disposed = false;
    let pollTimer: ReturnType<typeof setTimeout> | undefined;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    let pingInterval: ReturnType<typeof setInterval> | undefined;
    let hostWatchInterval: ReturnType<typeof setInterval> | undefined;
    let followTimer: ReturnType<typeof setTimeout> | undefined;
    let ws: WebSocket | null = null;
    let wsConnected = false;
    let wsOpenedOnce = false;
    let wsFailures = 0;
    let usingHttpFallback = session.mode === 'lan' || session.mode === 'lan-fallback';

    let room: JamRoom | null = useJam.getState().room;
    let lastSeek = 0;
    let changing = '';
    let failures = 0;
    let lastSuccess = Date.now();
    let lastHostSync: HostSyncSnapshot | null = null;
    let hostSyncInFlight = false;

    const currentHostPlayback = () => {
      const s = useApp.getState();
      const track = s.queue[s.index];
      const shared = canJam(track) ? track : null;
      return {
        track: shared,
        playing: !!shared && s.playing,
        position: shared ? s.position : 0,
      };
    };

    // Initial fast RTT calibration burst for millisecond clock sync
    void (async () => {
      for (let i = 0; i < 2; i++) {
        if (disposed) return;
        try {
          const rtt = await jamClient.ping();
          if (!disposed) useJam.setState({ rttMs: Math.round(rtt) });
        } catch {
          break;
        }
      }
    })();

    const follow = () => {
      if (disposed || session.host || !room) return;
      const target = room.playback,
        s = useApp.getState(),
        current = s.queue[s.index];
      if (!target.track) {
        transport.rate(1);
        if (s.playing) transport.pause();
        return;
      }
      if (current?.id !== target.track.id) {
        if (changing !== target.track.id) {
          changing = target.track.id;
          lastSeek = 0;
          transport.rate(1);
          useApp.getState().play(target.track);
        }
        return;
      }
      changing = '';
      if (s.status === 'Carregando' || s.status === 'Preparando áudio') return;
      if (!target.playing && s.playing) {
        transport.rate(1);
        transport.pause();
      } else if (target.playing && !s.playing && !s.error) {
        transport.toggle();
      }

      const nowCalibrated = jamClient.clock.now();
      const expectedPos = jamPosition(target, nowCalibrated);
      const driftMs = jamDriftMs(s.position, target, nowCalibrated);
      const absDriftMs = Math.abs(driftMs);

      if (absDriftMs >= 380 && Date.now() - lastSeek > 1500) {
        lastSeek = Date.now();
        transport.rate(1);
        transport.seek(expectedPos);
      } else if (target.playing && absDriftMs >= 45 && absDriftMs < 380) {
        const nudge = Math.max(-0.03, Math.min(0.03, driftMs / 4000));
        transport.rate(1 + nudge);
      } else {
        transport.rate(1);
      }
    };

    const handleSessionClosed = (notice: string) => {
      if (disposed) return;
      if (!session.host) transport.pause();
      transport.rate(1);
      void useJam.getState().leave();
      useApp.getState().message(notice);
    };

    const tryFallbackToLan = async () => {
      if (jamClient.session?.mode !== 'cloud') return false;
      try {
        const migrated = await jamClient.fallbackToLan(
          session.host ? currentHostPlayback() : undefined,
        );
        if (migrated && !disposed) {
          failures = 0;
          lastSuccess = Date.now();
          useJam.setState({
            session: migrated,
            room: migrated,
            connected: true,
            error: '',
          });
          useApp
            .getState()
            .message('Servidor Cloud indisponível: JAM migrada automaticamente para a rede local (LAN).');
          return true;
        }
      } catch {
        // Continue backoff if LAN fallback is not available
      }
      return false;
    };

    const syncHostNow = async (force = false) => {
      if (disposed || !session.host) return;
      const payload = currentHostPlayback();
      const now = Date.now();
      const candidate = {
        trackId: payload.track?.id ?? null,
        playing: payload.playing,
        position: payload.position,
      };
      if (!force && !shouldHostSync(lastHostSync, candidate, now)) return;

      if (wsConnected && ws && ws.readyState === WebSocket.OPEN) {
        try {
          ws.send(JSON.stringify(jamClient.buildSyncCommand(payload)));
          lastHostSync = { ...candidate, sentAt: now };
          return;
        } catch {
          // Fall through to HTTP if WebSocket send fails
        }
      }
      if (hostSyncInFlight) return;
      hostSyncInFlight = true;
      try {
        const value = await jamClient.update(payload);
        if (disposed) return;
        lastHostSync = { ...candidate, sentAt: Date.now() };
        room = value;
        failures = 0;
        lastSuccess = Date.now();
        useJam.setState({
          room: value,
          connected: true,
          error: '',
          rttMs: Math.round(jamClient.clock.rttMs),
        });
      } catch (e) {
        if (disposed) return;
        failures++;
        const error = cleanError(e);
        useJam.setState({ connected: false, error });
        if (failures >= 3 && (await tryFallbackToLan())) return;
        if (Date.now() - lastSuccess > 25000) {
          handleSessionClosed(`JAM desconectada. ${error}`);
        }
      } finally {
        hostSyncInFlight = false;
      }
    };

    const runHttpTick = async () => {
      if (disposed || wsConnected) return;
      const isLan = session.mode === 'lan' || session.mode === 'lan-fallback';
      let nextDelay = session.host
        ? isLan
          ? HTTP_LAN_POLL_MS
          : HTTP_CLOUD_HOST_KEEPALIVE_MS
        : HTTP_GUEST_POLL_MS;
      try {
        if (session.host) {
          const payload = currentHostPlayback();
          const now = Date.now();
          const candidate = {
            trackId: payload.track?.id ?? null,
            playing: payload.playing,
            position: payload.position,
          };
          // Change-driven sync: if playback hasn't changed, refresh room/members via lightweight poll
          // instead of writing a redundant sync mutation to SQLite.
          const needsSync = shouldHostSync(lastHostSync, candidate, now);
          const value = needsSync
            ? await jamClient.update(payload)
            : await jamClient.update(undefined);
          if (disposed) return;
          if (needsSync) lastHostSync = { ...candidate, sentAt: Date.now() };
          room = value;
        } else {
          const value = await jamClient.update(undefined);
          if (disposed) return;
          room = value;
        }
        failures = 0;
        lastSuccess = Date.now();
        useJam.setState({
          room,
          connected: true,
          error: '',
          rttMs: Math.round(jamClient.clock.rttMs),
        });
        follow();
      } catch (e) {
        if (disposed) return;
        failures++;
        const error = cleanError(e);
        useJam.setState({ connected: false, error });
        if (/encerrada|expirou/i.test(error)) {
          handleSessionClosed(error);
          return;
        }
        if (failures >= 3 && (await tryFallbackToLan())) return;
        if (Date.now() - lastSuccess > 25000) {
          handleSessionClosed(`JAM desconectada. ${error}`);
          return;
        }
        nextDelay = computeBackoffMs(failures, 600, 8000);
      }
      if (!disposed && !wsConnected) {
        pollTimer = setTimeout(() => void runHttpTick(), nextDelay);
      }
    };

    const startHttpFallback = () => {
      usingHttpFallback = true;
      clearTimeout(pollTimer);
      void runHttpTick();
    };

    const connectWebSocket = () => {
      if (disposed || usingHttpFallback) return;
      const wsUrl = jamWebSocketUrl(session.endpoint, session.code, session.token);
      if (!wsUrl || typeof WebSocket === 'undefined') {
        startHttpFallback();
        return;
      }

      let socket: WebSocket;
      try {
        socket = new WebSocket(wsUrl);
      } catch {
        startHttpFallback();
        return;
      }
      ws = socket;

      socket.addEventListener('open', () => {
        if (disposed || ws !== socket) {
          socket.close();
          return;
        }
        wsConnected = true;
        wsFailures = 0;
        failures = 0;
        lastSuccess = Date.now();
        clearTimeout(pollTimer);
        useJam.setState({ connected: true, error: '' });

        // Exact string matches Cloudflare WebSocketRequestResponsePair for zero-cost hibernation keepalive.
        clearInterval(pingInterval);
        pingInterval = setInterval(() => {
          if (socket.readyState === WebSocket.OPEN) {
            try {
              socket.send('{"action":"ping"}');
            } catch {}
          }
        }, WS_HIBERNATION_PING_MS);

        if (session.host) {
          void syncHostNow(true);
        } else if (wsOpenedOnce) {
          // Catch up any state changes missed during a temporary disconnect.
          try {
            socket.send(JSON.stringify(jamClient.buildPollCommand()));
          } catch {}
        }
        wsOpenedOnce = true;
      });

      socket.addEventListener('message', event => {
        if (disposed || ws !== socket) return;
        try {
          const data = JSON.parse(String(event.data)) as Record<string, unknown>;
          lastSuccess = Date.now();
          if (data.pong === true) return;
          if (data.closed === true) {
            handleSessionClosed('JAM encerrada pelo anfitrião.');
            return;
          }
          if (typeof data.error === 'string') {
            useJam.setState({ error: data.error });
            return;
          }
          if (typeof data.code === 'string' && Array.isArray(data.members) && data.playback) {
            const merged = jamClient.applyRoom(data as unknown as JamRoom);
            room = merged;
            failures = 0;
            useJam.setState({ room: merged, connected: true, error: '' });
            follow();
          }
        } catch {
          // Ignore malformed frame safely
        }
      });

      socket.addEventListener('close', event => {
        if (ws === socket) {
          wsConnected = false;
          ws = null;
        }
        clearInterval(pingInterval);
        if (disposed) return;

        // 1008 = revoked / session expired / room closed by server
        if (event.code === 1008) {
          handleSessionClosed(event.reason || 'JAM encerrada ou sessão expirada.');
          return;
        }

        wsFailures++;
        failures++;
        useJam.setState({ connected: false, error: 'Conexão instável. Reconectando…' });

        // If WebSocket cannot connect (e.g. restrictive network/proxy), fall back seamlessly to HTTP.
        if (wsFailures >= 2 && !wsOpenedOnce) {
          startHttpFallback();
          return;
        }
        if (wsFailures >= 4) {
          startHttpFallback();
          return;
        }

        const delay = computeBackoffMs(wsFailures, 800, 12000);
        clearTimeout(reconnectTimer);
        reconnectTimer = setTimeout(() => {
          if (!disposed) connectWebSocket();
        }, delay);
      });

      socket.addEventListener('error', () => {
        // The close handler manages backoff and fallback.
      });
    };

    const off = useApp.subscribe((state, previous) => {
      if (session.host) {
        if (
          state.playing !== previous.playing ||
          state.queue[state.index]?.id !== previous.queue[previous.index]?.id
        ) {
          void syncHostNow(false);
        }
        return;
      }
      if (
        state.playing !== previous.playing ||
        state.status !== previous.status ||
        state.queue[state.index]?.id !== previous.queue[previous.index]?.id
      ) {
        clearTimeout(followTimer);
        followTimer = setTimeout(follow, 0);
      }
    });

    if (session.host) {
      // Local-only check to detect user seeks without sending unnecessary traffic.
      hostWatchInterval = setInterval(() => {
        void syncHostNow(false);
      }, HOST_SEEK_CHECK_MS);
    }

    if (usingHttpFallback) {
      void runHttpTick();
    } else {
      connectWebSocket();
    }

    return () => {
      disposed = true;
      wsConnected = false;
      transport.rate(1);
      clearTimeout(pollTimer);
      clearTimeout(reconnectTimer);
      clearTimeout(followTimer);
      clearInterval(pingInterval);
      clearInterval(hostWatchInterval);
      off();
      if (ws) {
        try {
          ws.close(1000, 'Encerrando cliente.');
        } catch {}
        ws = null;
      }
    };
  }, [session?.token, session?.endpoint, session?.mode, consent]);

  return null;
}
