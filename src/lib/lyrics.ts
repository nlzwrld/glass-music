export interface LyricLine { time:number; text:string }
export function parseLRC(raw:string):LyricLine[] {
 const offset=Number(raw.match(/\[offset:([+-]?\d+)\]/i)?.[1]||0)/1000;
 const lines:LyricLine[]=[];
 for(const row of raw.split(/\r?\n/)) {
  const stamps=[...row.matchAll(/\[(\d{1,3}):(\d{2}(?:\.\d{1,3})?)\]/g)];
  const text=row.replace(/\[[^\]]*\]/g,'').replace(/<\d{1,3}:\d{2}(?:\.\d{1,3})?>/g,'').trim();
  for(const stamp of stamps){const seconds=Number(stamp[2]);if(seconds<60)lines.push({time:Math.max(0,Number(stamp[1])*60+seconds-offset),text});}
 }
 return lines.sort((a,b)=>a.time-b.time);
}
export function activeLyric(lines:LyricLine[],position:number):number {
 let low=0,high=lines.length-1,result=-1;
 while(low<=high){const mid=(low+high)>>1;if(lines[mid].time<=position){result=mid;low=mid+1;}else high=mid-1;}
 return result;
}
