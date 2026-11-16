/* This origin has no preload and no access to the desktop bridge. */
const params = new URLSearchParams(location.search);
const parentOrigin = params.get('parent');
const provider = params.get('provider');
const reference = params.get('ref');
let player, ready = false, interval;
const send = (type, data = {}) => parent.postMessage({ channel: 'glass-player', type, ...data }, parentOrigin);
const initialVolume = Math.max(0, Math.min(100, Number(params.get('volume') || 65)));
const script = (src) => { const el = document.createElement('script'); el.src = src; el.onerror = () => send('error', { message: 'Não foi possível carregar o player oficial. Verifique a conexão.' }); document.head.append(el); };
const deadline = setTimeout(() => { if (!ready) send('error', { message: 'O player oficial não respondeu. Tente novamente ou abra na plataforma.' }); }, 22000);
if (provider === 'soundcloud' && /^https:\/\/(www\.)?soundcloud\.com\//.test(reference || '')) {
  const frame = document.createElement('iframe'); frame.title = 'SoundCloud'; frame.allow = 'autoplay; encrypted-media'; frame.src = `https://w.soundcloud.com/player/?${new URLSearchParams({ url: reference, auto_play: 'false', visual: 'false', show_comments: 'false', show_reposts: 'false', show_teaser: 'false', hide_related: 'true' })}`; document.getElementById('player').replaceWith(frame);
  const el = document.createElement('script'); el.src = 'https://w.soundcloud.com/player/api.js';
  el.onerror = () => send('error', { message: 'Falha ao carregar o SoundCloud.' });
  el.onload = () => {
    player = SC.Widget(frame); const E = SC.Widget.Events;
    player.bind(E.READY, () => { ready = true; clearTimeout(deadline); player.setVolume(initialVolume); player.getDuration(d => send('time', { position: 0, duration: d / 1000 })); send('ready'); player.play(); interval = setInterval(() => player.getPosition(position => player.getDuration(duration => send('time', { position: position / 1000, duration: duration / 1000 }))), 700); });
    player.bind(E.PLAY, () => send('playing')); player.bind(E.PAUSE, () => send('paused')); player.bind(E.FINISH, () => send('ended'));
    player.bind(E.PLAY_PROGRESS, e => player.getDuration(d => send('time', { position: e.currentPosition / 1000, duration: d / 1000 })));
    if (E.ERROR) player.bind(E.ERROR, () => send('error', { message: 'SoundCloud: faixa restrita, privada ou indisponível para reprodução incorporada.' }));
  }; document.head.append(el);
} else { clearTimeout(deadline); send('error', { message: 'Referência inválida.' }); }
addEventListener('message', e => {
  if (e.source !== parent || e.origin !== parentOrigin || e.data?.channel !== 'glass-control' || !ready) return;
  const { action, value } = e.data;
  try {
    if (action === 'play') player.play();
    if (action === 'pause') player.pause();
    if (action === 'volume' && Number.isFinite(value)) player.setVolume(Math.max(0, Math.min(100, value)));
    if (action === 'seek' && Number.isFinite(value) && value >= 0) player.seekTo(value * 1000);
  } catch { send('error', { message: 'O controle não está disponível neste conteúdo.' }); }
});
addEventListener('unload', () => { clearInterval(interval); clearTimeout(deadline); });
