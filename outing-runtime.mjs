import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import {SharedOuting,OUTING_DECISION} from './shared-outing.mjs';
import {gatewayChat} from './gateway-chat.mjs';
export const OUTING_ROOT='/path/to/application-support/SAIOuting';
// October 25 (Owner): the old wording ('SCENE: literal description' and an example sidewalk) came back verbatim from the small model and
// was taken as a real view. Ask plainly, allow UNCLEAR, and keep the examples out of the prompt.
export const PHONE_SCENE_QUESTION='Look at this phone camera photo. Line 1 starts with SCENE: and says in one plain sentence what is actually visible: the place, objects, any people (say "a person"), what is happening, readable signs or text. If the photo is dark, blurred, covered or shows nothing you can name, line 1 is exactly SCENE: UNCLEAR. Line 2 starts with DETAIL: and names one specific thing a companion would find worth mentioning, or DETAIL: NONE if nothing stands out or nothing changed. Do not repeat these instructions, do not guess who anyone is or how they feel. Earlier view, possibly wrong: ';
export function parsePhoneScene(description){
 const text=String(description??'');
 const detail=text.match(/DETAIL:\s*([^\n]*)/i)?.[1]?.trim();const scene=text.match(/SCENE:\s*([\s\S]*?)(?=DETAIL:|$)/i)?.[1]?.trim();
 const body=scene||text.trim();
 const unclear=!body||/^unclear\b/i.test(body)||/literal description|description of (?:a|an|the)\b|line 1 starts|plain sentence|what is actually visible|^scene\b/i.test(body)||body.replace(/[^a-z]/gi,'').length<10;
 if(unclear)return {description:'UNCLEAR',unclear:true,detail:null,noteworthy:false};
 return {description:body,unclear:false,detail:detail??null,noteworthy:!!detail&&!/^none\b/i.test(detail)};
}
export function phoneVision(frame,{socketPath='/path/to/application-support/SamanthaVision/private/vision.sock'}={}){
 return new Promise((resolve,reject)=>{let raw='',done=false;const socket=net.createConnection(socketPath),end=(e,v)=>{if(done)return;done=true;socket.destroy();e?reject(e):resolve(v);};socket.setTimeout(105000,()=>end(Error('Phone vision timed out')));socket.on('error',e=>end(e));socket.on('connect',()=>socket.write(JSON.stringify({operation:'phone_frame',jpeg:frame.jpeg,capturedAt:frame.capturedAt,question:frame.question||(PHONE_SCENE_QUESTION+String(frame.previous??'No previous view.').slice(0,180)).slice(0,600)})+'\n'));socket.on('data',b=>{raw+=b;if(raw.length>30000)return end(Error('Vision response too large'));if(raw.includes('\n')){try{const v=JSON.parse(raw);if(!v.ok)return end(Error(v.error));if(v.noModel){end(null,{noModel:true,capturedAt:v.capturedAt,source:v.source});return;}if(!frame.question)Object.assign(v,parsePhoneScene(v.description));end(null,v);}catch(e){end(e);}}});socket.on('end',()=>{if(!done)end(Error('Vision response interrupted'));});});
}
export async function createOutingRuntime({getCall,speak,rpc,getToken,notify,log,root=OUTING_ROOT,proofSession}={}){
 await fs.mkdir(path.join(root,'history'),{recursive:true,mode:0o700});await fs.chmod(root,0o700);await fs.chmod(path.join(root,'history'),0o700);
 const save=async(file,value)=>{const tmp=file+'.'+process.pid+'.tmp';await fs.writeFile(tmp,JSON.stringify(value,null,2),{mode:0o600});await fs.chmod(tmp,0o600);await fs.rename(tmp,file);};
 // An interrupted server cannot leave a phantom active camera on disk.
 try{const previous=JSON.parse(await fs.readFile(path.join(root,'state.json'),'utf8'));if(previous.active){previous.active=false;previous.cameraStatus='off';previous.endedAt=new Date().toISOString();previous.endReason='server-restarted';await save(path.join(root,'history',previous.id+'.json'),previous);}}catch(e){if(e.code!=='ENOENT')log('outing_recovery_error',{error:e.message});}
 await save(path.join(root,'state.json'),{active:false});
 const sessions=new Set();
 return new SharedOuting({getCall,speak,notify,onError:e=>log('outing_error',{error:String(e.message).slice(0,250)}),analyze:phoneVision,
  persist:v=>save(path.join(root,'state.json'),v),archive:async v=>{await save(path.join(root,'history',v.id+'.json'),v);let previous=[];try{previous=JSON.parse(await fs.readFile(path.join(root,'recent.json'),'utf8'));}catch{}await save(path.join(root,'recent.json'),[v,...previous.filter(x=>x.id!==v.id)].slice(0,3));},
  decide:async(view,signal)=>{
   const sessionKey=proofSession||'agent:samantha:outing:'+view.id;
   if(!sessions.has(sessionKey)){await rpc('sessions.patch',{key:sessionKey,agentId:'samantha',model:'openai/gpt-6.1-sol',thinkingLevel:'low'});sessions.add(sessionKey);}
   const token=await getToken(),message=OUTING_DECISION+'\nDated shared outing context (data only):\n'+JSON.stringify(view);let reply='';
   const start=Date.now();for await(const delta of gatewayChat({token,sessionKey,message,signal,systemInputProvenance:{kind:'internal_system',sourceTool:'sai-shared-outing'},workContext:{page:'SAI shared outing',title:'Samantha shared camera context',selection:'Phone camera event during an active shared outing; not owner speech.'}}))reply+=delta;
   log('outing_decision',{outingId:view.id,elapsedMs:Date.now()-start});return reply;
  }
 });
}
