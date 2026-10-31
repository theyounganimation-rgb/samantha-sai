import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';

const fault=(text,status=400)=>Object.assign(Error(text),{status});
const stamp=v=>typeof v==='number'?v:Date.parse(v);
export async function createMessageNotifications({file,push,eligibleOwner=()=>false,inCall=()=>false,now=Date.now,log=()=>{}}){
 let state;try{state=JSON.parse(await fs.readFile(file,'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;state={version:1,devices:{},seen:[],attempts:[],initializedAt:null};}
 let chain=Promise.resolve();const serial=fn=>{const p=chain.then(fn);chain=p.catch(()=>{});return p;};
 const save=async()=>{await fs.mkdir(path.dirname(file),{recursive:true});const tmp=file+'.tmp';await fs.writeFile(tmp,JSON.stringify(state),{mode:0o600});await fs.rename(tmp,file);};
 async function deliver(device,message,{test=false,requestId}={}){
  const key=requestId??message.id;
  if(state.attempts.some(a=>a.deviceId===device.deviceId&&a.messageId===key))return {status:'already-attempted'};
  const attempt={id:randomUUID(),deviceId:device.deviceId,messageId:key,status:'dispatching',at:now(),test};
  state.attempts.push(attempt);state.attempts=state.attempts.slice(-2000);await save();
  let result;try{result=await push.send(device,{id:attempt.id,title:test?'SAI notification test':'Samantha',body:message.text,messageId:test?null:message.id});}
  catch(e){result={status:e.definite?'rejected':'uncertain',reason:'push-unavailable'};}
  Object.assign(attempt,{status:result.status,reason:result.reason??null,code:result.code??null});
  if(result.invalidToken){device.enabled=false;device.pushToken=null;}
  await save();log('message_notification',{status:attempt.status,test});return {status:attempt.status,reason:attempt.reason,deliveryConfirmed:false};
 }
 return {
  register(owner,b){return serial(async()=>{
   if(!eligibleOwner(owner))throw fault('Notifications require Owner’s current paired device',403);
   if(!/^[a-zA-Z0-9-]{16,100}$/.test(b.deviceId??''))throw fault('Invalid notification device');
   if(!['sandbox','production'].includes(b.environment))throw fault('Invalid push environment');
   if(b.enabled!==false&&!/^[a-f0-9]{64,200}$/i.test(b.pushToken??''))throw fault('Invalid notification token');
   const old=state.devices[b.deviceId];if(old&&old.owner!==owner&&eligibleOwner(old.owner))throw fault('Device belongs to a different active pairing',403);
   // Token rotation can replace another registration on this same owner. Do
   // not create two alerts to the same APNs endpoint.
   for(const d of Object.values(state.devices))if(d.deviceId!==b.deviceId&&d.owner===owner&&d.pushToken===b.pushToken)d.enabled=false;
   state.devices[b.deviceId]={deviceId:b.deviceId,owner,environment:b.environment,pushToken:b.enabled===false?null:b.pushToken,enabled:b.enabled!==false,registeredAt:old?.owner===owner&&old?.enabled?old.registeredAt:now()};await save();
   return {ok:true,enabled:b.enabled!==false};
  });},
  observe(snapshot){return serial(async()=>{
   const rows=Array.isArray(snapshot?.messages)?snapshot.messages:[];
   const seen=new Set(state.seen),fresh=rows.filter(r=>r.id&&!seen.has(String(r.id)));
   for(const r of rows)if(r.id)seen.add(String(r.id));state.seen=[...seen].slice(-4000);
   if(state.initializedAt===null){state.initializedAt=now();await save();return {baselined:true};}
   // Persist discovery first. A crash or an unknown Apple outcome cannot
   // replay a message under a fresh request ID on restart.
   await save();
   for(const r of fresh){
    const at=stamp(r.timestamp);
    if(r.surface==='voice'||r.role!=='assistant'||!r.text?.trim()||r.speaker?.personId!=='samantha'||r.recipient?.personId!=='owner'||!Number.isFinite(at)||at<state.initializedAt||now()-at>10*60000||at>now()+60000||inCall())continue;
    for(const d of Object.values(state.devices))if(d.enabled&&d.pushToken&&eligibleOwner(d.owner)&&at>=d.registeredAt){await deliver(d,{id:String(r.id),text:r.text});}
   }
   return {ok:true};
  });},
  async status(){await chain;const transport=await push.status();return {ok:true,pushReady:transport.ready,pushReason:transport.reason??null,devices:Object.values(state.devices).map(d=>({deviceId:d.deviceId,enabled:d.enabled,paired:eligibleOwner(d.owner),registeredAt:d.registeredAt})),recent:state.attempts.slice(-8).map(({status,at,test,reason})=>({status,at,test,reason})),note:'Apple acceptance is not proof a banner was displayed.'};},
  test(deviceId,requestId){return serial(async()=>{const d=state.devices[deviceId];if(!d?.enabled||!eligibleOwner(d.owner))throw fault('Notification device unavailable',404);if(!/^[a-zA-Z0-9-]{8,120}$/.test(requestId??''))throw fault('A stable test ID is required');return {ok:true,...await deliver(d,{id:requestId,text:'SAI notifications are connected. This is a setup test, not a message from Samantha.'},{test:true,requestId})};});},
  async stop(){await chain;}
 };
}
