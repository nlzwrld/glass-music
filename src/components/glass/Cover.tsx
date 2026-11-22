import { useEffect, useState } from 'react';
import { Music2 } from 'lucide-react';
import type { Track } from '../../../shared/types';
import { nativeResource } from '../../lib/native';
export function coverURL(t?: Pick<Track,'artwork'>) {
 if (!t?.artwork) return '';
 const normalized = t.artwork.replace(
  /^(https:\/\/(?:i\.ytimg\.com|img\.youtube\.com)\/vi\/[^/]+)\/(?:hqdefault|sddefault|default)\.jpg(\?.*)?$/i,
  '$1/mqdefault.jpg$2',
 );
 return normalized.startsWith('https://') ? nativeResource(`cover?url=${encodeURIComponent(normalized)}`) : normalized.startsWith('glass://app/') ? nativeResource(normalized.slice(12)) : normalized;
}
export default function Cover({ track, className = '' }: { track?: Pick<Track,'title'|'artwork'|'source'>; className?: string }) {
 const [state,setState]=useState({url:'',failed:false,loaded:false}),url=coverURL(track);
 const failed=state.url===url&&state.failed,loaded=state.url===url&&state.loaded;
 useEffect(()=>setState({url,failed:false,loaded:false}),[url]);
 return <div className={`cover ${url&&!loaded&&!failed?'cover-loading':''} ${className}`} data-source={track?.source}>
 {url&&!failed?<img src={url} alt={`Capa de ${track?.title}`} loading="lazy" decoding="async" draggable={false} onLoad={()=>setState({url,failed:false,loaded:true})} onError={()=>setState({url,failed:true,loaded:false})}/>:<div className="cover-fallback"><Music2 size={36} strokeWidth={1.2}/></div>}
 </div>;
}
