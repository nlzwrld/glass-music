import {useEffect} from 'react';
import {listen} from '@tauri-apps/api/event';
import {invoke} from '@tauri-apps/api/core';
import {useApp} from '../stores/app';
import type {Track,Preferences} from '../../shared/types';
import Lyrics from '../components/player/Lyrics';
import {OpticalEngine} from '../components/glass/v3/OpticalEngine';
export default function DetachedLyrics(){
 useEffect(()=>{void window.glass.bootstrap().then(data=>{document.documentElement.dataset.uiStyle=data.preferences.uiStyle??'matte';document.documentElement.dataset.theme=data.preferences.theme==='light'?'light':'dark';useApp.setState({data,ready:true,lyricsOpen:true});});let disposed=false,off:(()=>void)|undefined;void listen<{track:Track|null;position:number;playing:boolean;preferences:Preferences}>('lyrics-state',e=>{const p=e.payload;useApp.setState(s=>({queue:p.track?[p.track]:[],index:p.track?0:-1,position:p.position,playing:p.playing,data:{...s.data,preferences:p.preferences},lyricsOpen:true}));document.documentElement.dataset.uiStyle=p.preferences.uiStyle??'matte';document.documentElement.dataset.theme=p.preferences.theme==='light'?'light':'dark';document.documentElement.dataset.motion=p.preferences.reducedMotion?'reduced':'full';}).then(fn=>{if(disposed)fn();else off=fn;});return()=>{disposed=true;off?.();};},[]);
 return <div className="app detached-lyrics"><OpticalEngine><Lyrics detached onSeek={position=>{void invoke('call',{action:'lyricsControl',payload:{action:'seek',position}});}} onClose={()=>{void invoke('call',{action:'closeLyrics'});}}/></OpticalEngine></div>;
}
