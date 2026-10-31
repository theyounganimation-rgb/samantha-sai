// Render previously fragmented Phonic speech as whole turns only when an exact
// provider-verified mapping still matches every original adjacent record.
// Original session records remain untouched; mappings contain IDs and hashes.
import crypto from 'node:crypto';
export function projectVoiceTurnRepairs(messages,repairs={}){
 if(!Array.isArray(messages)||repairs?.version!==1||!Array.isArray(repairs.groups))return messages;
 const firsts=new Map();for(const g of repairs.groups.slice(0,100)){if(typeof g?.callId==='string'&&Array.isArray(g.ids)&&g.ids.length>1&&g.ids.length<=100&&g.ids.every(x=>typeof x==='string')&&/^[a-f0-9]{64}$/.test(g.textSha256??'')&&!firsts.has(g.ids[0]))firsts.set(g.ids[0],g);}
 const out=[];
 for(let i=0;i<messages.length;i++){
  const m=messages[i],g=firsts.get(m?.idempotencyKey??m?.__openclaw?.idempotencyKey);if(!g){out.push(m);continue;}
  const part=messages.slice(i,i+g.ids.length);
  if(part.length!==g.ids.length||part.some((x,j)=>x.role!=='user'||(x.idempotencyKey??x.__openclaw?.idempotencyKey)!==g.ids[j]||x.__openclaw?.saiLive?.callId!==g.callId||typeof x.content!=='string')){out.push(m);continue;}
  const text=part.map(x=>x.content).join(' ').trim();if(crypto.createHash('sha256').update(text).digest('hex')!==g.textSha256){out.push(m);continue;}
  const openclaw=m.__openclaw??{},ctx=openclaw.workContext??{};
  out.push({...m,content:text,__openclaw:{...openclaw,workContext:{...ctx,text},saiLive:{...openclaw.saiLive,displayGrouped:true}}});i+=g.ids.length-1;
 }
 return out;
}
