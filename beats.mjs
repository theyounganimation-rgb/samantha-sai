// A held line: one more thing she wants to say a beat after her reply, sent only
// if he has not written back by then. Held during the text turn (samantha_later),
// armed when the turn completes, delivered by the server after the delay unless a
// newer message of his, a new text turn or a call cancels it. Persisted so a
// restart neither loses an armed line nor sends it twice (the delivery path is
// idempotent on the beat id). Nothing here generates text or decides for her.
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
const LIVE=new Set(['held','armed']);
export async function createBeats({file,deliver,cancelled=async()=>null,log=()=>{},now=Date.now,minAfterMs=30000,maxAfterMs=1800000,defaultAfterMs=75000,staleMs=35*60000,maxChars=600}){
  let saved=[];try{saved=JSON.parse(await fs.readFile(file,'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;}
  const rows=new Map(saved.map(b=>[b.id,b])),timers=new Map();
  let writes=Promise.resolve();
  const persist=()=>{const next=writes.catch(()=>{}).then(async()=>{const tmp=file+'.'+crypto.randomUUID()+'.tmp';try{await fs.writeFile(tmp,JSON.stringify([...rows.values()].slice(-60)),{mode:0o600});await fs.rename(tmp,file);}finally{await fs.rm(tmp,{force:true});}});writes=next;return next;};
  const view=b=>({id:b.id,turnId:b.turnId,status:b.status,afterMs:b.afterMs,heldAt:b.heldAt,armedAt:b.armedAt,sendAt:b.sendAt,settledAt:b.settledAt,reason:b.reason,messageId:b.messageId??null,chars:b.text.length});
  const settle=async(b,status,extra={})=>{if(!LIVE.has(b.status))return;clearTimeout(timers.get(b.id));timers.delete(b.id);b.status=status;b.settledAt=now();Object.assign(b,extra);await persist();log('beat_'+status,{id:b.id,turnId:b.turnId,afterMs:b.afterMs,...extra});};
  const fire=async b=>{
    if(b.status!=='armed')return;
    let why=null;
    try{why=await cancelled(b);}catch(e){log('beat_check_failed',{id:b.id,error:String(e.message).slice(0,160)});}
    if(why)return settle(b,'dropped',{reason:String(why).slice(0,160)});
    try{const r=await deliver(b);await settle(b,'delivered',{messageId:r?.messageId??null});}
    catch(e){await settle(b,'failed',{reason:String(e.message).slice(0,200)});}
  };
  const schedule=b=>{
    clearTimeout(timers.get(b.id));
    if(now()-b.armedAt>staleMs){void settle(b,'dropped',{reason:'stale: the moment passed'});return;}
    const t=setTimeout(()=>{void fire(b);},Math.max(0,b.sendAt-now()));t.unref?.();timers.set(b.id,t);
  };
  for(const b of rows.values()){
    if(b.status==='armed')schedule(b);
    else if(b.status==='held'){b.status='dropped';b.reason='the reply did not complete before a restart';b.settledAt=now();}
  }
  return {
    hold({turnId,text,afterMs=defaultAfterMs,speakerBinding=null,sessionKey='agent:samantha:main'}){
      text=String(text??'').trim();
      if(!turnId)throw Error('A held line needs the reply it belongs to.');
      if(!text||text.length>maxChars)throw Error(`Say it in one short line (up to ${maxChars} characters).`);
      if(/^(NO_REPLY|HEARTBEAT_OK)$/i.test(text))throw Error('A held line has to say something.');
      afterMs=Math.max(minAfterMs,Math.min(maxAfterMs,Number(afterMs)||defaultAfterMs));
      for(const other of rows.values())if(other.turnId===turnId&&LIVE.has(other.status))void settle(other,'dropped',{reason:'replaced by a newer held line'});
      const b={id:crypto.randomUUID(),turnId,text,afterMs,speakerBinding,sessionKey,heldAt:now(),status:'held'};
      rows.set(b.id,b);void persist();log('beat_held',{id:b.id,turnId,afterMs,chars:text.length});
      return {id:b.id,afterMs};
    },
    arm(turnId,{completedAt=now()}={}){
      let n=0;
      for(const b of rows.values())if(b.turnId===turnId&&b.status==='held'){b.status='armed';b.armedAt=completedAt;b.sendAt=completedAt+b.afterMs;schedule(b);n++;}
      if(n){void persist();log('beat_armed',{turnId,count:n});}
      return n;
    },
    async drop(turnId,reason='dropped'){for(const b of rows.values())if(b.turnId===turnId&&LIVE.has(b.status))await settle(b,'dropped',{reason});},
    pending(){return [...rows.values()].filter(b=>LIVE.has(b.status)).map(view);},
    get(id){const b=rows.get(id);return b?view(b):null;},
    async shutdown(){for(const t of timers.values())clearTimeout(t);await writes;}
  };
}
