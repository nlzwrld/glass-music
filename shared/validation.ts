import { z } from 'zod';
export const idSchema = z.string().min(1).max(200).regex(/^[\w:.\-]+$/);
const text = z.string().trim().min(1).max(500);
export function officialUrl(raw: string): boolean {
  try { const u = new URL(raw); return u.protocol === 'https:' && !u.username && !u.password && !u.port && ['youtube.com','www.youtube.com','music.youtube.com','youtu.be','soundcloud.com','www.soundcloud.com','policies.google.com','developers.google.com','developers.soundcloud.com'].includes(u.hostname); } catch { return false; }
}
export function publicMusicUrl(raw: string): boolean {
  try { const u = new URL(raw); return u.protocol === 'https:' && !u.username && !u.password && !u.port && u.hostname.includes('.') && !u.hostname.includes(':') && !/^([0-9.]+|localhost)$/.test(u.hostname) && !['.local','.localhost','.internal'].some(s=>u.hostname.endsWith(s)); } catch { return false; }
}
export function artworkUrl(raw: string): boolean {
  if (/^\/covers\/[\w-]+\.svg$/.test(raw) || /^glass:\/\/app\/covers\/[a-f0-9]+\.(jpg|png|webp)$/.test(raw)) return true;
  try { const u = new URL(raw); return u.protocol === 'https:' && !u.username && !u.password && ['i.ytimg.com','i9.ytimg.com','lh3.googleusercontent.com','i1.sndcdn.com','i2.sndcdn.com','i.scdn.co','mosaic.scdn.co','image-cdn-fa.spotifycdn.com','image-cdn-ak.spotifycdn.com','cdn-images.dzcdn.net','e-cdns-images.dzcdn.net','cdns-images.dzcdn.net','is1-ssl.mzstatic.com','is2-ssl.mzstatic.com','is3-ssl.mzstatic.com','is4-ssl.mzstatic.com','is5-ssl.mzstatic.com','f4.bcbits.com','resources.tidal.com'].includes(u.hostname); } catch { return false; }
}
export const trackSchema = z.object({
  id: idSchema, source: z.enum(['local','youtube','soundcloud','link']), kind: z.enum(['track','artist','playlist','album']),
  sourceId: idSchema, title: text, artist: text, album: z.string().max(500).optional(),
  artwork: z.string().max(2048).refine(artworkUrl).optional(), duration: z.number().finite().min(0).max(604800),
  url: z.string().max(2048).refine(publicMusicUrl).optional(), addedAt: z.number().finite().min(0),
  available: z.boolean().optional(), reason: z.string().max(500).optional()
}).superRefine((t, ctx) => {
  if (t.source !== 'link' && t.url && !officialUrl(t.url)) ctx.addIssue({ code: 'custom', message: 'Link da plataforma inválido' });
  if (t.id !== `${t.source}:${t.sourceId}`) ctx.addIssue({ code: 'custom', message: 'Identificador inconsistente' });
  if (t.source === 'youtube' && t.kind === 'track' && !/^[\w-]{11}$/.test(t.sourceId)) ctx.addIssue({ code: 'custom', message: 'ID de vídeo inválido' });
  if (t.source === 'soundcloud' && t.url && !['soundcloud.com','www.soundcloud.com'].includes(new URL(t.url).hostname)) ctx.addIssue({ code: 'custom', message: 'URL SoundCloud inválida' });
});
export const preferencesSchema = z.object({
  theme: z.enum(['dark','light','system']), glass: z.number().min(0).max(100), blur: z.number().min(0).max(48),
  accent: z.string().regex(/^#[a-fA-F0-9]{6}$/), autoAccent: z.boolean(), reducedMotion: z.boolean(), performance: z.boolean(),
  volume: z.number().min(0).max(100), repeat: z.enum(['off','all','one']), shuffle: z.boolean(), tray: z.boolean(), startup: z.boolean(),
  notifications: z.boolean(), globalShortcuts: z.boolean(), coverCacheMB: z.number().int().min(16).max(512),
  eq: z.array(z.number().min(-12).max(12)).length(5), onlineConsent: z.boolean(), catalogConsent: z.boolean(), onboardingDone: z.boolean()
});
export const librarySchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('like'), track: trackSchema }), z.object({ action: z.literal('save'), track: trackSchema }),
  z.object({ action: z.literal('history'), track: trackSchema }), z.object({ action: z.literal('create'), name: z.string().trim().min(1).max(100) }),
  z.object({ action: z.literal('rename'), id: idSchema, name: z.string().trim().min(1).max(100) }),
  z.object({ action: z.literal('delete'), id: idSchema }), z.object({ action: z.literal('add'), id: idSchema, track: trackSchema }),
  z.object({ action: z.literal('remove'), id: idSchema, trackId: idSchema }),
  z.object({ action: z.literal('reorder'), id: idSchema, trackIds: z.array(idSchema).max(10000) }),
  z.object({ action: z.literal('removeTrack'), id: idSchema }), z.object({ action: z.literal('clearHistory') })
]);
export const searchSchema = z.object({ query: z.string().trim().min(1).max(200), kind: z.enum(['all','track','artist','playlist','album']), source: z.enum(['all','local','youtube','soundcloud']), cursor: z.record(z.string(), z.string().max(2048)).optional(), requestId: idSchema });
export function brokerUrl(raw: string): boolean {
  if (!raw) return true;
  try { const u = new URL(raw); return !u.username && !u.password && !u.search && !u.hash && u.pathname === '/' && (u.protocol === 'https:' || (u.protocol === 'http:' && u.hostname === '127.0.0.1')); } catch { return false; }
}
export const credentialSchema = z.object({ youtubeKey: z.string().trim().max(200).optional(), brokerUrl: z.string().trim().max(2048).refine(brokerUrl).optional(), brokerToken: z.string().trim().max(1000).optional() });
export const portableSchema = z.object({ format: z.literal('glass-music'), version: z.literal(1), tracks: z.array(trackSchema).max(20000), playlists: z.array(z.object({ id: idSchema, name: z.string().min(1).max(100), createdAt: z.number(), trackIds: z.array(idSchema).max(10000) })).max(1000), likes: z.array(idSchema).max(20000) });
