import { createServer, type IncomingMessage } from 'node:http';
import { randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import type { Track } from '../shared/types.ts';
import type { JamMember, JamPlayback } from '../shared/jam.ts';

interface Member extends JamMember { token: string; seen: number }
interface Room { code: string; members: Map<string, Member>; playback: JamPlayback; touched: number }
class JamError extends Error { constructor(message: string, public status = 400) { super(message); } }
const id = () => randomBytes(24).toString('base64url');
const safeName = (value: unknown) => typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g,'').trim().slice(0,40) || 'Ouvinte' : 'Ouvinte';
const validToken = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{32}$/.test(value);
function track(value: unknown): Track | null {
  if (value === null) return null;
  if (!value || typeof value !== 'object') throw new JamError('Música inválida.');
  const v = value as Record<string, unknown>;
  if (v.kind !== 'track' || !['youtube','link','soundcloud'].includes(String(v.source))) throw new JamError('A JAM aceita músicas online. Arquivos locais ficam no seu dispositivo.');
  for (const key of ['id','sourceId','title','artist']) if (typeof v[key] !== 'string' || !(v[key] as string).length || (v[key] as string).length > (key === 'title' || key === 'artist' ? 500 : 200)) throw new JamError('Dados da música inválidos.');
  if (!/^[A-Za-z0-9_:.-]+$/.test(String(v.id)) || !Number.isFinite(v.duration) || Number(v.duration) < 0 || Number(v.duration) > 86400) throw new JamError('Referência da música inválida.');
  if (v.source === 'youtube' && !/^[A-Za-z0-9_-]{11}$/.test(String(v.sourceId))) throw new JamError('Vídeo inválido.');
  let url: URL;
  try { url = new URL(String(v.url)); } catch { throw new JamError('Link público da música ausente.'); }
  const hosts = ['www.youtube.com','youtube.com','music.youtube.com','youtu.be','open.spotify.com','www.deezer.com','deezer.com','soundcloud.com','www.soundcloud.com','music.apple.com','itunes.apple.com','tidal.com','www.tidal.com','listen.tidal.com'];
  const bandcamp = /^[a-z0-9-]+\.bandcamp\.com$/i.test(url.hostname);
  if (url.protocol !== 'https:' || url.username || url.password || url.port || (!hosts.includes(url.hostname) && !bandcamp) || url.href.length > 2048) throw new JamError('Link da música não permitido.');
  const clean: Track = { id: String(v.id), source: v.source as Track['source'], sourceId: String(v.sourceId), kind: 'track', title: String(v.title), artist: String(v.artist), duration: Number(v.duration), url: url.href, addedAt: 0 };
  if (typeof v.playbackId === 'string' && /^[A-Za-z0-9_-]{11}$/.test(v.playbackId)) clean.playbackId = v.playbackId;
  if (typeof v.artwork === 'string' && v.artwork.length <= 2048) {
    try { const art = new URL(v.artwork); if (art.protocol === 'https:' && !art.username && !art.password && !art.port && ['i.ytimg.com','i9.ytimg.com','lh3.googleusercontent.com','i.scdn.co','i1.sndcdn.com','i2.sndcdn.com','cdn-images.dzcdn.net','e-cdns-images.dzcdn.net','cdns-images.dzcdn.net','mosaic.scdn.co','image-cdn-fa.spotifycdn.com','image-cdn-ak.spotifycdn.com','is1-ssl.mzstatic.com','is2-ssl.mzstatic.com','is3-ssl.mzstatic.com','is4-ssl.mzstatic.com','is5-ssl.mzstatic.com','f4.bcbits.com','resources.tidal.com'].includes(art.hostname)) clean.artwork = art.href; } catch {}
  }
  return clean;
}
async function body(req: IncomingMessage) {
  let size = 0; const chunks: Buffer[] = [];
  for await (const chunk of req) { const buffer = Buffer.from(chunk); size += buffer.length; if (size > 16384) throw new JamError('Solicitação muito grande.',413); chunks.push(buffer); }
  try { const value = JSON.parse(Buffer.concat(chunks).toString('utf8')); if (!value || typeof value !== 'object' || Array.isArray(value)) throw 0; return value; } catch { throw new JamError('Solicitação inválida.'); }
}

/** Ephemeral coordinator: no audio relay, accounts, logs of tokens, or persisted listening history. */
export function createJam(env: NodeJS.ProcessEnv = process.env, clock = Date.now) {
  const rooms = new Map<string, Room>(), rates = new Map<string,{until:number;count:number}>();
  const roomLimit = Math.max(1,Math.min(10000,Number(env.JAM_MAX_ROOMS) || 1000));
  const ttl = Math.max(30000,Math.min(3600000,Number(env.JAM_IDLE_TTL_MS) || 900000));
  function prune(now: number) {
    for (const [code,room] of rooms) {
      for (const [token,member] of room.members) if (!member.host && now-member.seen > 35000) room.members.delete(token);
      if (now-room.touched > ttl) rooms.delete(code);
    }
    for (const [ip,rate] of rates) if (rate.until <= now) rates.delete(ip);
  }
  function allow(req: IncomingMessage, action: string, now: number) {
    // Direct peer addresses only: untrusted forwarding headers cannot bypass this limit.
    const ip = `${req.socket.remoteAddress || 'unknown'}:${['create','join'].includes(action)?'entry':'active'}`;
    let rate = rates.get(ip); if (!rate || rate.until <= now) { if (rates.size >= 8192) throw new JamError('Serviço ocupado.',503); rate = {until:now+60000,count:0}; rates.set(ip,rate); }
    if (++rate.count > (['create','join'].includes(action)?30:1800)) throw new JamError('Muitas tentativas. Aguarde um minuto.',429);
  }
  function view(room: Room, now: number) { return {code:room.code,members:[...room.members.values()].map(({id,name,host})=>({id,name,host})),playback:room.playback,serverTime:now}; }
  function session(room: Room, member: Member, now: number) { return {...view(room,now),token:member.token,memberId:member.id,host:member.host}; }
  const server = createServer(async (req,res) => {
    res.setHeader('Content-Type','application/json; charset=utf-8'); res.setHeader('Cache-Control','no-store'); res.setHeader('X-Content-Type-Options','nosniff');
    const send = (status:number,value:unknown) => { if (!res.destroyed) res.writeHead(status).end(JSON.stringify(value)); };
    try {
      if (req.url === '/health' && req.method === 'GET') { send(200,{service:'glass-music-jam',version:1});return; }
      if (req.method !== 'POST') { res.setHeader('Allow','POST');throw new JamError('Método não permitido.',405); }
      if (req.url !== '/v1/jam') throw new JamError('Não encontrado.',404);
      if (!String(req.headers['content-type']).startsWith('application/json')) throw new JamError('Envie JSON.',415);
      const p = await body(req), now = clock(); prune(now); allow(req,String(p.action),now);
      if (p.action === 'create') {
        if (rooms.size >= roomLimit) throw new JamError('As salas estão ocupadas. Tente novamente em instantes.',503);
        let code: string; do { code=randomBytes(5).toString('hex').toUpperCase(); } while(rooms.has(code));
        const member:Member={id:id(),token:id(),name:safeName(p.name),host:true,seen:now};
        const room:Room={code,members:new Map([[member.token,member]]),playback:{track:null,playing:false,position:0,updatedAt:now,sequence:0},touched:now};rooms.set(code,room);send(201,session(room,member,now));return;
      }
      if (typeof p.code !== 'string' || !/^[A-F0-9]{10}$/.test(p.code)) throw new JamError('Código da JAM inválido.');
      const room=rooms.get(p.code); if (!room) throw new JamError('Esta JAM foi encerrada ou expirou.',410);
      if (p.action === 'join') {
        if (room.members.size >= 8) throw new JamError('Esta JAM já tem 8 pessoas.',409);
        const member:Member={id:id(),token:id(),name:safeName(p.name),host:false,seen:now};room.members.set(member.token,member);send(200,session(room,member,now));return;
      }
      if (!validToken(p.token)) throw new JamError('Sessão da JAM inválida.',401);
      const member=room.members.get(p.token);if (!member) throw new JamError('Sua sessão expirou. Entre novamente.',401);member.seen=now;
      if (member.host) room.touched=now;
      if (p.action === 'leave') { if (member.host) rooms.delete(room.code);else room.members.delete(p.token);send(200,{closed:member.host,serverTime:now});return; }
      if (p.action === 'sync') {
        if (!member.host) throw new JamError('Somente quem criou a JAM controla a reprodução.',403);
        const play=p.playback;if (!play || typeof play.playing !== 'boolean' || !Number.isFinite(play.position) || play.position < 0 || play.position > 86400) throw new JamError('Reprodução inválida.');
        const song=track(play.track);room.playback={track:song,playing:!!song&&play.playing,position:Math.min(song?.duration || 86400,play.position),updatedAt:now,sequence:room.playback.sequence+1};
      } else if (p.action !== 'poll') throw new JamError('Operação inválida.');
      send(200,view(room,now));
    } catch(error) { send(error instanceof JamError?error.status:500,{error:error instanceof JamError?error.message:'Não foi possível concluir a operação.'}); }
  });
  server.requestTimeout=10000;server.headersTimeout=5000;server.keepAliveTimeout=5000;return server;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port=Number(process.env.PORT || 8789);createJam().listen(port,process.env.JAM_HOST || '127.0.0.1',()=>console.log(`Glass Music JAM ready on port ${port}`));
}
