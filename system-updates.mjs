// Shared source copied byte-for-byte into samantha-life on deployment.
import net from 'node:net';

export function readSystemUpdates({query='',limit=3,offset=0,socketPath='/path/to/shared/SamanthaLife/bridge.sock',timeoutMs=1500}={}){
 return new Promise((resolve,reject)=>{
  const socket=net.createConnection(socketPath);let data='',done=false;
  const finish=(error,value)=>{if(done)return;done=true;clearTimeout(deadline);socket.destroy();error?reject(error):resolve(value);};
  const deadline=setTimeout(()=>finish(Error('Update history temporarily unavailable')),timeoutMs);
  socket.on('connect',()=>socket.write(JSON.stringify({operation:'updates',query,limit,offset,compact:true})+'\n'));
  socket.on('data',chunk=>{data+=chunk;if(data.length>100000)return finish(Error('Update history exceeded read bound'));if(data.includes('\n')){
   try{const result=JSON.parse(data.split('\n')[0]);result.ok?finish(null,result):finish(Error(result.error??'Update history unavailable'));}catch(e){finish(e);}
  }});
  socket.on('error',e=>finish(e));socket.on('end',()=>{if(!done)finish(Error('Update history closed without a result'));});
 });
}

export function renderSystemUpdates(value,{maxChars=6500}={}){
 if(!value?.ok)return 'System update history is unavailable on this turn. Do not infer that no update happened, or explain an old failure from current capability alone. Check samantha_life operation=updates before deciding.\n';
 const head='SYSTEM UPDATE TIMELINE — maintenance evidence, not a message from Owner.\n'+value.guidance+'\n';
 const records=(value.records??[]).map(({id,package:name,at,status,before,after,verification,limits,phaseTimeline})=>({id,package:name,at,status,before,after,verification,limits,phaseTimeline}));
 const data={records,omitted:Math.max(0,(value.totalInReadWindow??records.length)-records.length),olderLogBytesOmitted:value.olderLogBytesOmitted===true,
  contractObservations:value.contractObservations??[],warnings:value.warnings??[]};
 while(head.length+JSON.stringify(data).length>maxChars&&data.records.length){data.records.pop();data.omitted++;}
 while(head.length+JSON.stringify(data).length>maxChars&&data.contractObservations.length)data.contractObservations.shift();
 return head+JSON.stringify(data)+'\n';
}

export function registerSystemUpdates(api,{read=readSystemUpdates}={}){
 api.on('before_prompt_build',async(_event,ctx)=>{
  if(ctx.agentId!=='samantha'||ctx.sessionKey?.startsWith('agent:samantha:regulation-proof-'))return;
  let value;try{value=await read();}catch{value={ok:false};}
  // Current per-turn evidence, not a static startup prompt. Includes text,
  // classic voice, own time and the private writers without becoming an agenda.
  return {prependSystemContext:renderSystemUpdates(value)};
 },{priority:40,timeoutMs:2000});
}
