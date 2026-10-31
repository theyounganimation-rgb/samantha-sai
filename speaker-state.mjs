import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import {OWNER,SPEAKERS,person,isGuestId,guestName,speakerBinding} from './integrations/activity-recall/speaker-context.mjs';

export async function createSpeakerState({file,now=Date.now}={}){
 let data={version:1,devices:{},profiles:{}};try{data=JSON.parse(await fs.readFile(file,'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;}
 if(data.version!==1||!data.devices||typeof data.devices!=='object')throw Error('Speaker state is unreadable.');
 data.profiles??={};
 for(const [id,p]of Object.entries(data.profiles))if(!isGuestId(id)||p.personId!==id||!person(p))throw Error('Guest profile is unreadable.');
 let queue=Promise.resolve();
 const resolve=id=>person(id)??person(data.profiles[id]);
 const read=owner=>{const r=data.devices[owner];return {speaker:resolve(r?.personId)??OWNER,revision:r?.revision??'initial',updatedAt:r?.updatedAt??null};};
 const choices=()=>[...SPEAKERS,...Object.values(data.profiles).filter(p=>!p.anonymous).sort((a,b)=>a.createdAt-b.createdAt).map(p=>({...person(p),createdAt:p.createdAt}))];
 const persist=async()=>{const temp=file+'.'+crypto.randomUUID()+'.tmp';try{await fs.writeFile(temp,JSON.stringify(data),{mode:0o600});await fs.rename(temp,file);}finally{await fs.rm(temp,{force:true});}};
 const serialized=fn=>{const task=queue.then(fn,fn);queue=task.catch(()=>{});return task;};
 const transaction=async fn=>{const old=structuredClone(data);try{const result=fn();await persist();return result;}catch(e){data=old;throw e;}};
 const conflict=message=>Object.assign(Error(message),{status:409});
 return {
  read,choices,
  set:(owner,id,revision)=>serialized(async()=>{
   if(revision!==undefined&&revision!==read(owner).revision)throw conflict('The speaker changed. Refresh before switching again.');
   if(id!=='guest'&&!resolve(id))throw Object.assign(Error('Choose a known speaker or Someone else.'),{status:400});
   return transaction(()=>{
    if(id==='guest'){
     id='guest-'+crypto.randomBytes(12).toString('hex');
     data.profiles[id]={personId:id,name:'Anonymous guest',anonymous:true,createdAt:now()};
    }
    data.devices[owner]={personId:id,revision:crypto.randomUUID(),updatedAt:now()};
    return {...read(owner),choices:choices()};
   });
  }),
  identify:args=>serialized(async()=>{
   const {personId,sourceMessageId,quote}=args,name=guestName(args.name),p=data.profiles[personId];
   if(!isGuestId(personId)||!p)throw conflict('That guest profile is unavailable.');
   if(typeof sourceMessageId!=='string'||!sourceMessageId||sourceMessageId.length>180||typeof quote!=='string'||!quote.trim()||quote.length>500)throw Object.assign(Error('A source message and exact quote are required.'),{status:400});
   if(!p.anonymous){
    if(p.name===name&&p.identification?.sourceMessageId===sourceMessageId)return {ok:true,alreadySaved:true,speaker:person(p)};
    throw conflict('This profile already has a name. Select the right profile before continuing.');
   }
   const owners=Object.keys(data.devices).filter(owner=>data.devices[owner].personId===personId);
   if(!owners.length)throw conflict('This guest is no longer selected. No profile was changed.');
   return transaction(()=>{
    Object.assign(p,{name,anonymous:false,identifiedAt:now(),identification:{sourceMessageId,quote,method:'self-report'}});
    for(const owner of owners)data.devices[owner]={...data.devices[owner],revision:crypto.randomUUID(),updatedAt:now()};
    return {ok:true,speaker:person(p)};
   });
  }),
  capture:(owner,expectedId)=>serialized(async()=>{
   const current=read(owner);
   if(expectedId!==undefined&&expectedId!==current.speaker.personId)throw conflict('The speaker changed. Check who is speaking before sending this message.');
   return speakerBinding(current.speaker,current.revision==='initial'?'account-default':'app-selection');
  })
 };
}
