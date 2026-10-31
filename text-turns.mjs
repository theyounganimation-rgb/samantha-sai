import fs from 'node:fs/promises';
import crypto from 'node:crypto';

const pending=s=>['accepted','running'].includes(s);
const validId=id=>typeof id==='string'&&/^[a-zA-Z0-9_-]{16,100}$/.test(id);
const fault=(message,status=409)=>Object.assign(new Error(message),{status});
export const textOwner=token=>crypto.createHash('sha256').update(token||'local-mac').digest('hex');

// The turn belongs to the conversation, not the lifetime of an HTTP socket.
// Persist admission before starting it; a repeated request ID never runs twice.
export async function createTextTurns({file,generate,isBusy=()=>false,onComplete=()=>{},onState=()=>{},onDelivered=()=>{},log=()=>{},now=Date.now}) {
  let saved=[];try{saved=JSON.parse(await fs.readFile(file,'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;}
  const rows=new Map(saved.map(r=>[r.id,r])),controllers=new Map(),listeners=new Map();
  const completing=new Set();
  let admissions=Promise.resolve(),writes=Promise.resolve();
  const persist=()=>{const next=writes.catch(()=>{}).then(async()=>{const temp=file+'.'+crypto.randomUUID()+'.tmp';try{await fs.writeFile(temp,JSON.stringify([...rows.values()]),{mode:0o600});await fs.rename(temp,file);}finally{await fs.rm(temp,{force:true});}});writes=next;return next;};
  for(const r of rows.values())if(pending(r.status)){r.status='interrupted';r.error='The Mac restarted during this reply. Your message is saved; it has not been sent again.';}
  if(saved.some(r=>r.status==='interrupted')){await persist();for(const r of saved)if(r.status==='interrupted')await onState(r);}
  const view=r=>r?Object.fromEntries(['id','text','reply','media','attachments','status','error','createdAt','updatedAt','deliveredAt','speakerBinding','quiet'].filter(k=>r[k]!==undefined).map(k=>[k,k==='status'&&completing.has(r.id)?'running':r[k]])):null;
  const get=(id,owner)=>{if(!validId(id))throw fault('Invalid message ID.',400);const r=rows.get(id);if(r&&r.owner!==owner)throw fault('Message not found.',404);return r;};
  const publish=r=>{for(const f of listeners.get(r.id)??[])f(view(r));};
  const run=async r=>{
    const ac=new AbortController();controllers.set(r.id,ac);
    try{
      r.status='running';r.updatedAt=now();await persist();await onState(r);publish(r);
      ac.signal.throwIfAborted();
      for await(const delta of generate(r.text,{signal:ac.signal,requestId:r.id,speakerBinding:r.speakerBinding,attachments:r.attachments,onReceipt:receipt=>{r.runId=receipt.runId;if(receipt.media?.length)r.media=receipt.media;if(receipt.quiet)r.quiet=true;}})){
        if(ac.signal.aborted)throw ac.signal.reason;
        r.reply+=delta;r.updatedAt=now();await persist();publish(r);
      }
      if(ac.signal.aborted)throw ac.signal.reason;
      // October 21: a quiet turn (she read it and chose not to reply) completes without text; anything else empty is still a failure.
      if(!r.reply.trim()&&!r.media?.length&&!r.quiet)throw Error('Samantha finished without a visible reply.');
      r.status='completed';r.updatedAt=now();completing.add(r.id);try{await persist();await onState(r);}finally{completing.delete(r.id);}publish(r);onComplete(view(r));
      log('text_turn_completed',{id:r.id,totalMs:now()-r.createdAt});
    }catch(e){
      completing.add(r.id);
      r.status=ac.signal.aborted?'stopped':'failed';r.error=ac.signal.aborted?'Response stopped.':String(e?.message||e).slice(0,400);r.updatedAt=now();
      await persist().catch(()=>{});await Promise.resolve(onState(r)).catch(error=>log('text_contact_error',{id:r.id,error:String(error.message)}));completing.delete(r.id);publish(r);log('text_turn_'+r.status,{id:r.id,error:r.error});
    }finally{controllers.delete(r.id);}
  };
  const start=(id,owner,text,{captureSpeaker,attachments=[]}={})=>{
    const admit=async()=>{
      const existing=get(id,owner);
      if(existing){if(existing.text!==null&&existing.text!==text)throw fault('This message ID already belongs to a different message.');return view(existing);}
      if(!Array.isArray(attachments)||attachments.length>4||attachments.some(a=>a?.type!=='image'||!/^[a-f0-9]{64}$/.test(a.id)))throw fault('Attach up to four photos.',400);
      if(typeof text!=='string'||text.length>20000||(!text.trim()&&!attachments.length))throw fault('Enter a message.',400);
      if([...rows.values()].some(r=>pending(r.status)||completing.has(r.id))||isBusy())throw fault('A reply is already in progress. Let it finish or stop it first.');
      const speakerBinding=captureSpeaker?await captureSpeaker():undefined;
      const r={id,owner,text,reply:'',status:'accepted',createdAt:now(),updatedAt:now(),...(speakerBinding?{speakerBinding}:{}),...(attachments.length?{attachments}:{})};rows.set(id,r);
      try{await persist();}catch(e){rows.delete(id);throw e;}
      log('text_turn_accepted',{id});void run(r);
      return view(r);
    };
    const next=admissions.then(admit,admit);admissions=next.catch(()=>{});return next;
  };
  // Photos sent with a turn, for the history feed: the canonical transcript row
  // carries the same text at nearly the same time.
  const photosFor=(text,timestamp)=>{
    const at=new Date(timestamp).getTime();if(!Number.isFinite(at))return null;
    let best=null;
    for(const r of rows.values()){
      if(!r.attachments?.length||r.text!==text)continue;
      const gap=Math.abs(r.createdAt-at);
      if(gap<300000&&(!best||gap<best.gap))best={gap,media:r.attachments};
    }
    return best?.media??null;
  };
  return {
    start,photosFor,get:(id,owner)=>view(get(id,owner)),busy:()=>[...rows.values()].some(r=>pending(r.status)||completing.has(r.id)),
    // October 21: the reply being written right now (for a held line), and whether he has written since a moment.
    current:()=>[...rows.values()].find(r=>pending(r.status)||completing.has(r.id))??null,
    startedAfter:at=>[...rows.values()].some(r=>r.text!==null&&r.createdAt>at),
    subscribe(id,owner,fn){const r=get(id,owner);if(!r)throw fault('Message not found.',404);const set=listeners.get(id)??new Set();set.add(fn);listeners.set(id,set);fn(view(r));return()=>{set.delete(fn);if(!set.size)listeners.delete(id);};},
    async stop(id,owner){
      const cancel=async()=>{let r=get(id,owner);if(!r){r={id,owner,text:null,reply:'',status:'stopped',error:'Response stopped.',createdAt:now(),updatedAt:now()};rows.set(id,r);}
        else if(pending(r.status)){r.status='stopped';r.error='Response stopped.';r.updatedAt=now();controllers.get(id)?.abort(new DOMException('Stopped','AbortError'));}
        await persist();publish(r);return view(r);};
      const next=admissions.then(cancel,cancel);admissions=next.catch(()=>{});return next;
    },
    async delivered(id,owner){const r=get(id,owner);if(!r||r.status!=='completed')throw fault('Reply is not complete.');if(!r.deliveredAt){if(!r.quiet)await onDelivered(id,view(r));r.deliveredAt=now();await persist();}return {ok:true,...(r.quiet?{quiet:true}:{})};},
    async shutdown(){for(const ac of controllers.values())ac.abort(new DOMException('Server stopped','AbortError'));await writes;}
  };
}

// Snapshot events let a reconnect replace partial text without repeating words.
export function streamTextTurn(turns,id,owner,res,{legacy=false,log=()=>{}}={}) {
  res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-store','X-Accel-Buffering':'no'});
  res.flushHeaders();let ended=false,rendered='',unsubscribe=()=>{};
  const heartbeat=setInterval(()=>{if(!res.destroyed)res.write(': keepalive\n\n');},10000);heartbeat.unref?.();
  const end=()=>{if(ended)return;ended=true;clearInterval(heartbeat);unsubscribe();};
  res.on('close',()=>{end();log('text_stream_detached',{id});});
  const send=m=>{if(!res.destroyed)res.write('data: '+JSON.stringify(m)+'\n\n');};
  unsubscribe=turns.subscribe(id,owner,row=>{
    if(ended)return;
    if(legacy){if(row.reply.length>rendered.length)send({type:'delta',text:row.reply.slice(rendered.length)});rendered=row.reply;}
    else send({type:'snapshot',...row});
    if(!pending(row.status)){
      if(legacy)send(row.status==='completed'?{type:'done',deliveryId:row.id}:{type:'error',error:row.error});
      end();res.end();
    }
  });
  if(ended)unsubscribe();
}
