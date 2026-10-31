import fs from 'node:fs/promises';
import crypto from 'node:crypto';
export const BACKGROUND_JOB='ee28953f-30f5-4925-857b-e22d18a89bf3';
const hash=x=>crypto.createHash('sha256').update(x).digest('hex');
const fail=s=>Object.assign(Error(s),{status:400});
export async function createAppPresence({file,gateway,isBusy=()=>false,now=Date.now,enabled=true,log=()=>{},auto=true}={}){
 let state={version:1,events:[],devices:{}};
 try{state=JSON.parse(await fs.readFile(file));}catch(e){if(e.code!=='ENOENT')throw e;}
 if(state.version!==1||!Array.isArray(state.events)||!state.devices)throw Error('Unreadable app-presence state');
 let queue=Promise.resolve(),timer=null,pumping=false,closed=false;
 const persist=async()=>{const tmp=file+'.'+crypto.randomUUID()+'.tmp';await fs.writeFile(tmp,JSON.stringify(state),{mode:0o600});await fs.rename(tmp,file);};
 const locked=fn=>{const task=queue.then(async()=>{const result=await fn();await persist();return result;});queue=task.catch(()=>{});return task;};
 // A crash after dispatch must not send the same uncertain wake again.
 for(const e of state.events)if(e.status==='dispatching'){e.status='unknown';e.reason='Server restarted during wake admission; wait for the recorded run or the normal heartbeat.';}
 await persist();
 const publicEvent=e=>({id:e.id,openedAt:new Date(e.at).toISOString(),receivedAt:new Date(e.receivedAt).toISOString(),device:e.device,participant:e.participant,secondsSinceOpen:Math.max(0,Math.floor((now()-e.at)/1000)),wakeStatus:e.status,observedBy:e.observedBy??null,runId:e.runId??null,reason:e.reason??null});
 function view(){
  const recent=state.events.filter(e=>now()-e.at<86400000).slice(-8);
  return {version:1,checkedAt:new Date(now()).toISOString(),latest:recent.at(-1)?publicEvent(recent.at(-1)):null,recent:recent.map(publicEvent),
   devices:Object.values(state.devices).filter(d=>now()-d.seenAt<300000).map(d=>({device:d.device,participant:d.participant,visible:d.visible&&now()-d.seenAt<75000,visibilityObservedAt:new Date(d.seenAt).toISOString()})),
   meaning:'An authenticated SAI foreground event is evidence that the selected participant was using SAI at the recorded time. It does not prove when they woke, that they remain attentive, or that an unattended visible screen means they are awake. No message was submitted by opening the app.'};
 }
 function schedule(ms=0){if(!auto||closed||timer)return;timer=setTimeout(()=>{timer=null;void pump().catch(e=>log('app_presence_error',{error:e.message}));},ms);timer.unref?.();}
 async function ingest(owner,p,participant){
  if(!['open','hidden','visible'].includes(p.kind)||!['iphone','ipad','web'].includes(p.device)||typeof p.id!=='string'||!/^[a-zA-Z0-9_-]{16,100}$/.test(p.id))throw fail('Invalid app-presence event');
  const at=Date.parse(p.observedAt);if(!Number.isFinite(at)||at>now()+30000||now()-at>300000)throw fail('App-presence event is stale or has an invalid time');
  const result=await locked(async()=>{
   const key=hash(owner+':'+p.id),prior=state.events.find(e=>e.id===key),previous=state.events.filter(e=>e.owner===owner).at(-1);
   if(!state.devices[owner]||at>=state.devices[owner].clientAt)state.devices[owner]={device:p.device,participant,visible:p.kind!=='hidden',seenAt:now(),clientAt:at};
   if(p.kind!=='open')return {ok:true,recorded:false};
   if(prior)return {ok:true,duplicate:true,id:key,wakeStatus:prior.status};
   const coalesced=previous&&now()-previous.receivedAt<15000;
   const e={id:key,owner,at:Math.min(at,now()),receivedAt:now(),device:p.device,participant,status:coalesced?'coalesced':'pending'};
   if(coalesced){e.reason='Same brief foreground burst';e.coalescedWith=previous.id;}
   state.events.push(e);
   state.events=state.events.filter(x=>now()-x.receivedAt<7*86400000).slice(-300);
   for(const [k,d]of Object.entries(state.devices))if(now()-d.seenAt>7*86400000)delete state.devices[k];
   return {ok:true,recorded:true,id:key,wakeStatus:e.status};
  });
  if(p.kind==='open')schedule();return result;
 }
 async function observed(ids,runId){
  if(!Array.isArray(ids)||ids.length>8||typeof runId!=='string'||runId.length>240)throw fail('Invalid presence observation receipt');
  return locked(async()=>{for(const e of state.events)if(ids.includes(e.id)&&!e.observedBy){e.observedBy={runId,at:now(),meaning:'Included in this background run context, not proof of a sent message.'};e.status='observed';}return {ok:true};});
 }
 async function pump(){
  if(pumping||closed)return;pumping=true;
  try{
   let pending=state.events.filter(e=>e.status==='pending');if(!pending.length)return;
   if(pending.some(e=>now()-e.at>300000))await locked(async()=>{for(const e of pending)if(now()-e.at>300000){e.status='expired';e.reason='App-open evidence is now old; retain it for context without a delayed extra wake.';}});
   pending=state.events.filter(e=>e.status==='pending');if(!pending.length)return;
   if(!enabled){await locked(async()=>{for(const e of pending){e.status='disabled';e.reason='Isolated test server; production wake disabled';}});return;}
   if(isBusy()){schedule(3000);return;}
   let job;try{job=await gateway('cron.get',{id:BACKGROUND_JOB});}catch(e){schedule(15000);return;}
   if(!job.enabled){await locked(async()=>{for(const e of pending){e.status='paused';e.reason='Background routine is paused; no override';}});return;}
   if(job.state?.runningAtMs){schedule(3000);return;}
   // A call may have connected while cron.get was in flight.
   if(isBusy()){schedule(3000);return;}
   // A normal scheduled run may have read these events while we awaited RPC.
   pending=state.events.filter(e=>e.status==='pending');if(!pending.length)return;
   const ids=new Set(await locked(async()=>{const staged=[];for(const e of state.events)if(e.status==='pending'){e.status='dispatching';e.attemptedAt=now();staged.push(e.id);}return staged;}));
   if(!ids.size)return;
   try{
    const r=await gateway('cron.run',{id:BACKGROUND_JOB,mode:'if-enabled'});
    await locked(async()=>{for(const e of state.events)if(ids.has(e.id)&&e.status==='dispatching'){
     if(r.ok&&r.enqueued){e.status='queued';e.runId=r.runId;}
     else if(r.reason==='already-running'){e.status='pending';}
     else {e.status='not-started';e.reason=r.reason??'Wake not accepted';}
    }});
    log('app_presence_wake',{eventIds:[...ids],enqueued:r.enqueued===true,runId:r.runId??null,reason:r.reason??null});
   }catch(e){await locked(async()=>{for(const r of state.events)if(ids.has(r.id)&&r.status==='dispatching'){r.status='unknown';r.reason='Wake admission uncertain; do not replay. The next normal heartbeat can still read this activity.';}});log('app_presence_wake_uncertain',{eventIds:[...ids],error:e.message});}
  }finally{pumping=false;if(state.events.some(e=>e.status==='pending'))schedule(3000);}
 }
 schedule();
 return {ingest,view,observed,pump,async stop(){closed=true;clearTimeout(timer);await queue;}};
}
