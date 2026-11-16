import {useEffect} from 'react';
import {invoke} from '@tauri-apps/api/core';
import {listen} from '@tauri-apps/api/event';
import {useApp} from '../stores/app';
import {transport} from '../components/player/engine';
export function LyricsWindowBridge(){
 useEffect(()=>{let off:(()=>void)|undefined;let disposed=false;void listen<{action:string;position?:number}>('lyrics-control',e=>{if(e.payload.action==='seek'&&Number.isFinite(e.payload.position)){transport.seek(e.payload.position!);useApp.setState({position:e.payload.position!});}if(e.payload.action==='toggle')transport.toggle();}).then(fn=>{if(disposed)fn();else off=fn;});
 const send=()=>{const s=useApp.getState();if(!s.ready)return;void invoke('call',{action:'lyricsState',payload:{track:s.queue[s.index]||null,position:s.position,playing:s.playing,preferences:{...s.data.preferences,appearance:{...s.data.preferences.appearance,customImage:''}}}}).catch(()=>{});};const timer=setInterval(send,200);return()=>{disposed=true;clearInterval(timer);off?.();};},[]);return null;
}
