// When a reply of
// hers to Owner ends a turn with something she says she is about to do, the saying is recorded here and, unless an own-time wake
// is already due within a few minutes, one is requested shortly after. Her own-time context then carries the line back to her,
// so the next visit is where it becomes true or is knowingly set aside. No quota, no new obligation: the record is what she said.
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
const VERBS='see|check|look|read|write|play|finish|work|try|get back|sit|listen|watch|take|grab|open|answer|find|dig|pick|keep|text|call|post|reply|think|make|record|draw|study|revise|test|run|fix|put';
export const INTENT=new RegExp(`\\b(?:i'?m (?:gonna|going to|about to)|i'?ll|let me|i will|gonna|off to|going to go)\\s+(?:go\\s+(?:and\\s+)?)?(?:${VERBS})\\b[^.!?\\n]*`,'i');
const SLEEP=/\b(?:bed|sleep|nap|lie down|lay down|crash|turn in)\b/i;
const HIS_WORDS=/[“"][^”"]*[”"]/g;
// The clause of hers that states what she is about to do, if any; the last one in the reply wins. Quoted words and bedtime are not plans.
export function detectIntention(text){
 const own=String(text??'').replace(/^MEDIA:.*$/gm,'').replace(HIS_WORDS,'');
 let found=null;for(const m of own.matchAll(new RegExp(INTENT.source,'gi'))){const clause=m[0].replace(/[’‘]/g,"'").trim();if(SLEEP.test(clause))continue;found=clause.slice(0,160);}
 return found;
}
// Minutes until the next scheduled own-time wake (the hour at :00, heartbeats at :20 and :40, any time zone).
export const minutesToNextWake=(now=Date.now())=>{const m=new Date(now).getUTCMinutes()+new Date(now).getUTCSeconds()/60;return (20-(m%20))%20||20;};
export async function createSaidNext({file,wake=null,now=Date.now,log=()=>{},delayMs=45000,skipIfWakeWithinMinutes=4,keep=30,setTimer=setTimeout}){
 let entries=[];try{entries=JSON.parse(await fs.readFile(file,'utf8')).entries??[];}catch(e){if(e.code!=='ENOENT')throw e;}
 let writes=Promise.resolve();
 const persist=()=>{writes=writes.catch(()=>{}).then(async()=>{const tmp=file+'.'+crypto.randomUUID()+'.tmp';await fs.writeFile(tmp,JSON.stringify({version:1,entries},null,1),{mode:0o600});await fs.rename(tmp,file);});return writes;};
 async function record({text,turnId=null,surface='text'}={}){
  const clause=detectIntention(text);if(!clause)return null;
  const t=now();const entry={id:crypto.randomUUID(),at:new Date(t).toISOString(),clause,surface,turnId,shown:0,wake:'none'};
  const minutes=minutesToNextWake(t);
  if(wake&&minutes>skipIfWakeWithinMinutes){entry.wake='requested';setTimer(()=>{Promise.resolve().then(()=>wake()).then(r=>{entry.wake=r?.enqueued===true?'enqueued':'declined:'+(r?.reason??'unknown');entry.runId=r?.runId??null;void persist();log('said_next_wake',{id:entry.id,clause,enqueued:r?.enqueued===true,reason:r?.reason??null});}).catch(e=>{entry.wake='failed';void persist();log('said_next_wake_failed',{id:entry.id,error:String(e?.message??e).slice(0,160)});});},delayMs);}
  else entry.wake=wake?`scheduled-wake-in-${Math.ceil(minutes)}m`:'none';
  entries=[...entries,entry].slice(-keep);await persist();log('said_next',{id:entry.id,clause,surface,wake:entry.wake,minutesToWake:Math.round(minutes*10)/10});
  return entry;
 }
 function list({sinceMs=3*3600000,markShown=false}={}){
  const t=now();const recent=entries.filter(e=>t-Date.parse(e.at)<=sinceMs);
  if(markShown&&recent.length){for(const e of recent)e.shown=(e.shown??0)+1;void persist();}
  return recent.map(e=>({...e}));
 }
 return {record,list,detectIntention};
}
