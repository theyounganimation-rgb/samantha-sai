// Runs as Samantha. All writes use the host's canonical, locked transcript API;
// never edit a native Claude file or write a second personality store.
import fs from 'node:fs/promises';
import {getSessionEntry} from '/opt/homebrew/lib/node_modules/openclaw/dist/plugin-sdk/session-store-runtime.js';
import {appendSessionTranscriptMessageByIdentityStrict,publishSessionTranscriptUpdateByIdentity} from '/opt/homebrew/lib/node_modules/openclaw/dist/plugin-sdk/session-transcript-runtime.js';
import {readSharedContext} from '/path/to/agent/.openclaw/extensions/samantha-daily-transcript/shared-context.mjs';
import {personalPresent} from '/path/to/agent/.openclaw/extensions/samantha-daily-transcript/personal-presence.mjs';
import {createDevelopment} from '/path/to/agent/.openclaw/extensions/samantha-daily-transcript/development-context.mjs';
import {readMainConversationRows} from '/path/to/agent/.openclaw/extensions/samantha-daily-transcript/index.js';
import {mergeSends,readDirectSends,summarizeConversation} from '/path/to/agent/.openclaw/extensions/samantha-daily-transcript/conversation-context.mjs';
import {createWorkingContext} from '/path/to/agent/.openclaw/extensions/samantha-daily-transcript/working-context.mjs';
import {createFactualMemory,factsHandoff} from '/path/to/agent/.openclaw/extensions/samantha-daily-transcript/factual-memory.mjs';
import {recallConversation,recallHandoff,recallContextTopics} from '/path/to/agent/.openclaw/extensions/samantha-daily-transcript/conversation-recall.mjs';
import {activityHandoff} from '/path/to/agent/.openclaw/extensions/samantha-daily-transcript/activity-context.mjs';
import {presenceHandoff} from '/path/to/agent/.openclaw/extensions/samantha-daily-transcript/personal-presence.mjs';
import {createMemoryField,renderField} from '/path/to/agent/.openclaw/extensions/samantha-daily-transcript/memory-field.mjs';
let voiceFacts,voiceMemory,voiceDevelopment,voiceWorking;
import {speakerBinding} from './integrations/activity-recall/speaker-context.mjs';
import {attributedReply} from '/path/to/agent/.openclaw/extensions/samantha-daily-transcript/speaker-context.mjs';
import net from 'node:net';
// The regulation controller, as her user: one line in, one line out. Best effort; never replays.
function regulation(request,timeoutMs=4000){
  return new Promise((resolve,reject)=>{
    const s=net.connect('/path/to/agent/.openclaw/run/regulation.sock');let out='';
    const t=setTimeout(()=>{s.destroy();reject(Error('regulation timed out'));},timeoutMs);
    s.on('connect',()=>s.write(JSON.stringify(request)+'\n'));
    s.on('data',b=>{out+=b;const i=out.indexOf('\n');if(i>=0){clearTimeout(t);s.destroy();try{resolve(JSON.parse(out.slice(0,i)));}catch(e){reject(e);}}});
    s.on('error',e=>{clearTimeout(t);reject(e);});
  });
}
import {conversationWorkContext} from './context.mjs';
async function handle(p){
const key=p.sessionKey;

if(typeof key!=='string'||!(key==='agent:samantha:main'||/^agent:samantha:regulation-proof-live-[a-z0-9-]{1,80}$/.test(key)))throw Error('Invalid voice memory scope');
const entry=getSessionEntry({agentId:'samantha',sessionKey:key});
if(!entry?.sessionId||entry.incognito||entry.status==='archived')throw Error('Saved conversation unavailable');
const scope={agentId:'samantha',sessionKey:key,sessionId:entry.sessionId};
if(p.operation==='context'){
  const personId=speakerBinding(p.person??p.personId).speaker.personId;
  const workspace='/path/to/agent/.openclaw/workspace-samantha';
  const documents=Object.fromEntries(await Promise.all(['IDENTITY.md','SOUL.md'].map(async name=>[name,await fs.readFile(workspace+'/'+name,'utf8')])));
  const ctx={agentId:'samantha',sessionKey:key},enhanced=p.includeVoiceContext===true;
  let rows=[],rowUnavailable=false;
  if(enhanced)try{rows=mergeSends(await readMainConversationRows(ctx),key==='agent:samantha:main'?await readDirectSends():[]);}catch{rowUnavailable=true;}
  const query=enhanced&&typeof p.query==='string'?p.query.trim().slice(0,600):'';
  if(enhanced){voiceFacts??=createFactualMemory();voiceMemory??=createMemoryField();voiceDevelopment??=createDevelopment();voiceWorking??=createWorkingContext();}
  const [shared,development]=await Promise.all([readSharedContext({session:key,personId,query}),enhanced?voiceDevelopment.read(ctx,rows,personId):createDevelopment().read(ctx,rows,personId)]);
  const present=personalPresent(shared,development,{personId,query});
  let voiceContext;
  if(enhanced){
  let facts={unavailable:true},associated='',recall='',factsText='';
  try{if(!rowUnavailable){facts=await voiceFacts.read(ctx,rows,{personId,limit:8});factsText=factsHandoff(facts,{brief:true,maxBytes:1800});if(query){const topical=await voiceFacts.read(ctx,rows,{query,personId,limit:6});factsText+=factsHandoff(topical,{brief:true,maxBytes:1400});}}}catch{}
  let aliases=[speakerBinding(p.person??p.personId).speaker.name];
  try{const state=JSON.parse(await fs.readFile('/path/to/agent/.openclaw/state/samantha-factual-memory/state.json','utf8'));const names=state.people?.[personId]?.aliases;if(Array.isArray(names))aliases=[...new Set(names.filter(n=>typeof n==='string'&&n.length<=70))].slice(0,4);}catch{}
  const personQuery=aliases.join(' ');
  try{const r=query?recallContextTopics(rows,{query:personQuery+'\n'+query,maxBytes:7000,limit:4}):recallConversation(rows,{query:personQuery,maxBytes:7000,limit:4});recall=recallHandoff(r,{compact:true,limit:6,maxBytes:2200});}catch{}
  try{const conversation=summarizeConversation(rows);Object.defineProperty(conversation,'handoffRows',{value:rows});const working=await voiceWorking.read(ctx,conversation);const v=await voiceMemory.present(ctx,rows,{query:query||personQuery,shared,development,working,advance:false});associated=renderField(v,{maxBytes:1800});}catch{}
  // Same read-only source projections used by text. Every section is bounded
  // at record boundaries; source absence never means a fact is false.
  const activitySource=activityHandoff(shared,{maxBytes:3800}),activityData=activitySource.slice(activitySource.indexOf('\n')+1);
  voiceContext={facts:factsText,recall,activity:'Dated authored experiences and activity; partial evidence, no required disclosure. Preserve actor, uncertainty, execution and time. '+activityData,presence:presenceHandoff(present,{maxBytes:1800}),associated,unavailable:[...(rowUnavailable?['conversation']:[]),...(shared.unavailable??[]),...(facts.unavailable?['personFacts']:[])]};
  }
  const bounded={checkedAt:shared.checkedAt,revision:shared.revision,unavailable:shared.unavailable,carriedInterests:shared.carriedInterests?.slice(0,3),personalPerspectives:shared.personalPerspectives?.slice(0,3),perspective:shared.perspective?.slice(0,2),actualActivity:shared.actualActivity?.slice(0,enhanced?5:2),...(enhanced?{activityWindow:shared.activityWindow}:{}),currentPerception:shared.currentPerception};
  for(const k of ['actualActivity','carriedInterests','perspective','personalPerspectives'])while(Buffer.byteLength(JSON.stringify(bounded))>10000&&bounded[k]?.length)bounded[k].pop();
  return ({sessionId:entry.sessionId,checkedAt:new Date().toISOString(),documents,shared:bounded,present,...(enhanced?{voiceContext}:{}),coverage:enhanced?'Bounded, source-linked text-conversation context. Omitted and unavailable records are not evidence of absence.':'Bounded current state and recent history; delegate for full sources or omitted memory.'});
}else if(p.operation==='append'){
  if(p.sessionId!==entry.sessionId)throw Error('Conversation changed during the call');
  const m=p.message;if(!m||!['user','assistant'].includes(m.role)||typeof m.text!=='string'||!m.text.trim()||m.text.length>20000||!/^[a-zA-Z0-9:_-]{8,180}$/.test(m.id))throw Error('Invalid transcript message');
  if(!Number.isFinite(m.timestamp)||m.timestamp>Date.now()+60000)throw Error('Invalid timestamp');
  const binding=speakerBinding(p.person??p.personId),runId='sai-live-'+p.callId;
  if(!/^[a-f0-9-]{36}$/.test(p.callId))throw Error('Invalid call identity');
  const delivered=m.role==='user'||m.delivery==='played';
  const text=delivered?m.text:'[Voice generated; playback not fully confirmed] '+m.text;
  const message={role:m.role,content:m.role==='user'?text:[{type:'text',text}],timestamp:m.timestamp,idempotencyKey:'sai-live:'+p.callId+':'+m.id,
    __openclaw:{runId,workContext:{text,snapshot:conversationWorkContext({voice:true,speakerBinding:binding})},saiLive:{callId:p.callId,channel:m.role,delivery:m.delivery??'captured',source:'separate-audio-channel-asr'}},
    ...(m.role==='user'?{provenance:{kind:'external_user'}}:{api:'openai-responses',provider:'openai',model:'gpt-live-1',stopReason:'stop',usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}}})};
  const result=await appendSessionTranscriptMessageByIdentityStrict({...scope,message,idempotencyLookup:'scan'});
  if(result.kind!=='result')throw Error('Voice transcript was not saved');
  await publishSessionTranscriptUpdateByIdentity(scope);
  return ({ok:true,messageId:result.result.messageId,appended:result.result.appended});
}else if(p.operation==='beat'){
  // October 21: a held line she chose during a text reply, delivered now by the server. Same canonical
  // transcript API as voice rows, idempotent on the beat id, then observed by her controller as her own report.
  if(key!=='agent:samantha:main')throw Error('Held lines belong to the live conversation');
  if(!/^[a-f0-9-]{36}$/.test(String(p.id)))throw Error('Invalid held line identity');
  const text=String(p.text??'').trim();if(!text||text.length>600)throw Error('Invalid held line');
  if(!Number.isFinite(p.timestamp)||p.timestamp>Date.now()+60000)throw Error('Invalid timestamp');
  const binding=speakerBinding(p.person??p.personId??'owner'),runId='sai-beat-'+p.id;
  const message={role:'assistant',content:[{type:'text',text}],timestamp:p.timestamp,idempotencyKey:'sai-beat:'+p.id,
    __openclaw:{runId,workContext:{text,snapshot:conversationWorkContext({voice:false,speakerBinding:binding})},saiBeat:{turnId:p.turnId??null,afterMs:p.afterMs??null,delivery:'held-line'}},
    api:'sai-held-line',provider:'sai',model:'sai-held-line',stopReason:'stop',usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}}};
  const result=await appendSessionTranscriptMessageByIdentityStrict({...scope,message,idempotencyLookup:'scan'});
  if(result.kind!=='result')throw Error('Held line was not saved');
  await publishSessionTranscriptUpdateByIdentity(scope);
  let observed=false;
  if(result.result.appended){try{const r=await regulation({op:'observe',session:key,source:'reply:'+runId,kind:'assistant_report',text:attributedReply(text,binding)});observed=!!r?.ok;}catch{}}
  return ({ok:true,messageId:result.result.messageId,appended:result.result.appended,observed});
}else if(p.operation==='contact'){
  // When did he last write, on any channel? From her controller's direct-contact tracker.
  const r=await regulation({op:'contact_status',session:key});
  return ({ok:true,contact:r?.contact??null});
}else throw Error('Unknown voice memory operation');

}
import {createInterface} from 'node:readline';
const input=createInterface({input:process.stdin,crlfDelay:Infinity});
for await(const line of input){
  try{if(line.length>100000)throw Error('Request too large');const result=await handle(JSON.parse(line));process.stdout.write('SAI_LIVE_RESULT:'+JSON.stringify({ok:true,result})+'\n');}
  catch(e){process.stdout.write('SAI_LIVE_RESULT:'+JSON.stringify({ok:false,error:String(e.message).slice(0,200)})+'\n');}
}
process.stdout.write('',()=>process.exit(0));
