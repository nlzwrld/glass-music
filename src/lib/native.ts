import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type { GlassAPI, MediaCommand, Snapshot, IntegrationStatus } from '../../shared/types';
let resourceBase = '';
const call = <T>(action: string, payload?: unknown) => invoke<T>('call', { action, payload: payload ?? null });
export function nativeResource(path: string) { return `${resourceBase}/${path.replace(/^\//, '')}`; }
export const glass: GlassAPI = {
  offlineSource:id=>call('offlineSource',id),downloadOffline:track=>call('downloadOffline',track),removeOffline:id=>call('removeOffline',id),openLyrics:()=>call('openLyrics'),updateStatus:(install=false)=>call('updateStatus',{install}),
  trackArtwork:id=>call('trackArtwork',id),lyrics:track=>call('lyrics',track),playlistArtwork:id=>call('playlistArtwork',id),
  bootstrap: async () => { const data = await call<Snapshot & {_resourceBase:string}>('bootstrap'); resourceBase=data._resourceBase; return data; },
  library: payload => call('library',payload), preferences: payload => call('preferences',payload),
  search: payload => call('search',payload), cancelSearch: id => call('cancelSearch',id),
  discover: requestId => call('discover', { requestId }),
  accounts:()=>call('accounts'), configureAccounts:()=>call('configureAccounts'),connectAccount:provider=>call('connectAccount',provider),disconnectAccount:provider=>call('disconnectAccount',provider),cancelAccount:()=>call('cancelAccount'),syncAccount:provider=>call('syncAccount',provider),importLink:(url,playlist=false)=>call('importLink',{url,playlist}),
  importAudio: () => call('importAudio'), resolveLink: url => call('resolveLink',url), linkPlayback: (track,requestId) => call('linkPlayback',{track,requestId}),
  exportLibrary: id => call('exportLibrary',id), importLibrary: () => call('importLibrary'),
  integrations: async () => { const data=await call<IntegrationStatus>('integrations');const canvas=document.createElement('canvas');const gl=canvas.getContext('webgl2') || canvas.getContext('webgl');data.gpu=!!gl;gl?.getExtension('WEBGL_lose_context')?.loseContext();return data; }, credentials: payload => call('credentials',payload),
  external: url => call('external',url), playerUrl: () => call('playerUrl'), audioSource: (videoId,requestId) => call('audioSource',{videoId,requestId}), window: action => call('window',action),
  clearCache: () => call('clearCache'), checkUpdates: () => call('checkUpdates'), notify: track => call('notify',track),
  visualState: () => call('visualState'),
  windowShape: () => call('windowShape'),
  onVisualVisibility: callback => { let disposed=false;let off:(()=>void)|undefined;void listen<boolean>('glass-visual-visible',event=>callback(event.payload)).then(unlisten=>{if(disposed)unlisten();else off=unlisten;});return()=>{disposed=true;off?.();}; },
  onMedia: callback => { let disposed=false;let off:(()=>void)|undefined;void listen<MediaCommand>('media',event=>callback(event.payload)).then(unlisten=>{if(disposed)unlisten();else off=unlisten;});return()=>{disposed=true;off?.();}; }
};
window.glass=glass;
