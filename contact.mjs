import fs from 'node:fs/promises';import path from 'node:path';import crypto from 'node:crypto';
export function createContactLedger({directory='/path/to/shared/SAI',enabled=true,now=Date.now}={}){
 let queue=Promise.resolve();
 return (role,channel,id=crypto.randomUUID(),binding,replyStatus)=>{
  if(!enabled)return Promise.resolve();
  if(binding&&(role==='user'?binding.speaker?.personId:binding.recipient?.personId)!=='owner')return Promise.resolve();
  const write=async()=>{
   if(!['user','assistant'].includes(role)||!['sai_text','sai_voice'].includes(channel))throw new Error('Invalid contact event');
   const file=path.join(directory,'contact.json');let value={version:1,events:[]};try{value=JSON.parse(await fs.readFile(file,'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;}
   // A request and its delivered reply share a turn ID, but are distinct events.
   const existing=value.events.find(e=>e.id===id&&e.role===role&&e.channel===channel);
   const status=role==='user'&&channel==='sai_text'&&['running','completed','failed','stopped','interrupted'].includes(replyStatus)?replyStatus:undefined;
   if(existing){if(!status||existing.replyStatus===status)return;existing.replyStatus=status;}
   else value.events.push({id,role,channel,at:now()/1000,...(status?{replyStatus:status}:{})});value.events=value.events.slice(-1000);
   await fs.mkdir(directory,{recursive:true,mode:0o700});const temp=file+'.tmp';await fs.writeFile(temp,JSON.stringify(value),{mode:0o600});await fs.rename(temp,file);
  };
  const next=queue.then(write,write);queue=next.catch(()=>{});return next;
 };
}
