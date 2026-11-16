import { useEffect, useState } from 'react';
import { Music2 } from 'lucide-react';
import type { Track } from '../../../shared/types';
import { nativeResource } from '../../lib/native';
export function coverURL(t?: Pick<Track,'artwork'>) {
 if (!t?.artwork) return '';
 return t.artwork.startsWith('https://') ? nativeResource(`cover?url=${encodeURIComponent(t.artwork)}`) : t.artwork.startsWith('glass://app/') ? nativeResource(t.artwork.slice(12)) : t.artwork;
}
export default function Cover({ track, className = '' }: { track?: Pick<Track,'title'|'artwork'|'source'>; className?: string }) {
 const [state,setState]=useState({url:'',failed:false,loaded:false}),url=coverURL(track);
 const failed=state.url===url&&state.failed,loaded=state.url===url&&state.loaded;
 useEffect(()=>setState({url,failed:false,loaded:false}),[url]);
 return <div className={`cover ${url&&!loaded&&!failed?'cover-loading':''} ${className}`} data-source={track?.source}>
 {url&&!failed?<img src={url} alt={`Capa de ${track?.title}`} loading="lazy" decoding="async" draggable={false} onLoad={()=>setState({url,failed:false,loaded:true})} onError={()=>setState({url,failed:true,loaded:false})}/>:<div className="cover-fallback"><Music2 size={36} strokeWidth={1.2}/></div>}
 </div>;
}
