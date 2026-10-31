import fs from 'node:fs/promises';
import path from 'node:path';
import {rootFor,WORKSPACE,digest} from './experience-store.mjs';
import {withStateLock,writeState} from './durable-state.js';
import {readThreadState,threadFile} from '../samantha-regulation/carried-threads.mjs';
import {captureChoiceBinding,collectChoiceEvidence} from './choice-evidence.mjs';

const clip=(v,n)=>String(v??'').slice(0,n);
const dataFrom=result=>{if(result?.details)return result.details;const block=result?.content?.find(c=>c.type==='text');if(block){try{return JSON.parse(block.text)}catch{}}return result??{};};
const root=(workspace,ctx)=>path.join(rootFor(workspace,ctx),'choice-history');
async function json(file,fallback){try{return JSON.parse(await fs.readFile(file,'utf8'));}catch(e){if(e.code==='ENOENT')return fallback;throw e;}}
const signature=args=>digest(args);

export const perspectiveRefSchema={type:'array',maxItems:4,items:{type:'object',additionalProperties:false,required:['id','version','quote','implication'],properties:{
 id:{type:'string',maxLength:80},version:{type:'number',description:'Exact updatedAt/version of the existing self-perspective, sourced inquiry or pursuit you read.'},quote:{type:'string',minLength:1,maxLength:350,description:'Exact passage from its currentView or authored want. Project citations retain their kind and do not become self-beliefs or permission to resume.'},implication:{type:'string',minLength:8,maxLength:500,description:'How this view or care motive favors, limits or changes this particular option; do not invent a new belief.'}}}};

export async function prepareChoice(ctx,args,{workspace=WORKSPACE,now=Date.now}={}) {
 const folder=root(workspace,ctx),id=digest((ctx.sessionKey??'agent:samantha:main')+':'+args.requestKey);
 const receipt=await json(path.join(folder,id+'.json'),null);
 if(receipt){if(receipt.signature!==signature(args))throw Error('This decision key already has another saved request. Inspect effects; do not overwrite a committed choice.');return {existing:receipt};}
 const refs=args.options.flatMap(o=>(o.perspectiveRefs??[]).map(r=>({...r,optionId:o.id})));
 if(!refs.length)return {views:[],signature:signature(args)};
 const state=await readThreadState(threadFile(workspace,ctx.sessionKey));
 const views=refs.map(r=>{const t=state.threads.find(t=>t.id===r.id&&(t.kind==='perspective'||t.kind==='pursuit'&&/^[-a-z0-9]{1,80}$/.test(t.careFor??'')&&t.desiredOutcome?.trim()&&t.source?.trim()||['inquiry','pursuit'].includes(t.kind)&&!t.careFor&&t.source?.trim()));
  const quoted=t&&(t.currentView?.includes(r.quote)||['inquiry','pursuit'].includes(t.kind)&&t.want?.includes(r.quote));
  if(!t||!['open','parked','complete'].includes(t.status)||t.updatedAt!==r.version||!Number.isFinite(r.version)||r.version>now()+60000||!r.quote?.trim()||!quoted||typeof r.implication!=='string'||r.implication.trim().length<8||r.implication.length>500)throw Error('A perspective reference needs the existing current self-view or sourced inquiry/pursuit, exact version/quote and particular implication. Refresh after a change; no decision was submitted.');
  return {...r,view:t.currentView,source:t.source,counterevidence:t.revisionCondition,...(['inquiry','pursuit'].includes(t.kind)&&!t.careFor?{referenceKind:t.kind,quotedField:t.currentView?.includes(r.quote)?'currentView':'want',want:t.want,status:t.status,nextStep:t.nextStep,meaning:'An authored project view or want cited in constructing an option. Does not reopen work, grant permission or establish an enduring self-belief.'}:{}),...(t.careFor?{careFor:t.careFor,want:t.want,desiredOutcome:t.desiredOutcome}:{})};});
 return {views,signature:signature(args)};
}

export async function recordChoice(ctx,args,value,prepared,{workspace=WORKSPACE,now=Date.now}={}) {
 if(prepared.existing)return prepared.existing;
 if(!value?.ok||!value.decisionId||!args.options.some(o=>o.id===value.selected?.id))return null;
 const folder=root(workspace,ctx),file=path.join(folder,value.decisionId+'.json');
 return withStateLock(path.join(folder,'index.json'),async()=>{
  const index=await json(path.join(folder,'index.json'),{version:1,records:[]}),old=await json(file,null);
  if(old){if(old.signature!==prepared.signature)throw Error('Committed choice trace differs; inspect effects before any retry.');return old;}
  let binding=null;try{binding=captureChoiceBinding(ctx.sessionKey);}catch{}
  const record={version:1,id:value.decisionId,signature:prepared.signature,at:now(),sessionKey:ctx.sessionKey,runId:ctx.runId??null,binding,requestKey:args.requestKey,lane:args.lane,
   selected:value.selected,alternatives:args.options.map(o=>({id:o.id,plan:o.plan,sources:o.sources,perspectiveRefs:o.perspectiveRefs??[]})),
   perspectives:prepared.views??[],observations:[],meaning:'Host-confirmed selected plan and exact sourced views cited by its author. Citations do not by themselves prove causation; selection is not execution. Subsequent tool observations retain their own evidential limits.'};
  await writeState(file,record);
  index.records=index.records.filter(x=>x.id!==record.id).concat({id:record.id,at:record.at,sessionKey:record.sessionKey,runId:record.runId,requestKey:record.requestKey,lane:record.lane,selected:record.selected.id,plan:clip(record.selected.plan,220),perspectiveIds:record.perspectives.filter(p=>p.optionId===record.selected.id).map(p=>p.id)}).slice(-64);
  // The compact index is bounded. Full receipts remain on disk and are read by ID.
  await writeState(path.join(folder,'index.json'),index);return record;
 });
}

export async function choiceEffects(workspace=WORKSPACE,ctx={}, {choiceId,limit=6}={}) {
 const folder=root(workspace,ctx),index=await json(path.join(folder,'index.json'),{records:[]});
 if(choiceId&&!/^[a-f0-9]{64}$/.test(choiceId))throw Error('Use an actual decisionId');
 const ids=choiceId?[choiceId]:index.records.slice(-Math.min(12,Math.max(1,limit))).reverse().map(r=>r.id);
 const choices=await Promise.all(ids.map(async id=>{
  const file=path.join(folder,id+'.json');let r=await json(file,null);if(!r)return null;
  try{const evidence=await collectChoiceEvidence(r,{classify:toolObservation});
   if(evidence.binding&&JSON.stringify({...evidence,observations:undefined})!==JSON.stringify(r.evidence)||evidence.observations.length){
    r=await withStateLock(file,async()=>{const latest=await json(file,null);if(!latest)return null;
     for(const o of evidence.observations)if(!latest.observations.some(v=>v.callId===o.callId))latest.observations.push(o);
     const {observations,...cursor}=evidence;latest.evidence=cursor;await writeState(file,latest);return latest;});
   }
  }catch{r.evidenceStatus='lookup_unavailable; missing evidence is not a failed or completed action';}
  return r;
 }));
 return {choices:choices.filter(Boolean),indexedChoices:index.records.length,
  archivedReceiptsRemainAvailableById:true,meaning:'Choice -> cited view/version -> actual following tool observations. An authored account, attempted action, submitted job, verified file and published reply are different evidence. A correlated observation is not a claim of motive or subjective experience.'};
}

export function toolObservation(event) {
 const name=String(event.toolName??'').split('__').at(-1).replace(/^openclaw(?=samantha_|continuity_)/,''),p=event.params??{},v=dataFrom(event.result);
 if(['samantha_choice','samantha_self_view'].includes(name)||event.error||event.result?.isError)return event.error||event.result?.isError?{kind:'tool_error',tool:name,status:'tool_error',meaning:'Tool errored; an external effect may remain unknown. Inspect its status before any replay; no successful effect inferred.'}:null;
 if(name==='samantha_commitments'&&p.action==='initiative'&&v.ok&&v.commitment?.kind==='care_initiative')return {kind:'chosen_care_work',tool:name,status:v.commitment.status,commitmentId:v.commitment.id,motiveId:v.commitment.motive?.threadId,meaning:'Independently chosen work admitted with its motive; no execution or benefit inferred.'};
 if(name==='samantha_commitments'&&p.action==='update'&&v.ok&&v.commitment?.kind==='care_initiative'&&['in_progress','complete'].includes(v.commitment.status)){
  const files=(v.commitment.evidence??[]).filter(e=>e.kind==='artifact'&&/^[a-f0-9]{64}$/.test(e.sha256??'')&&e.bytes>0&&e.path&&e.quote);
  return {kind:'care_work_evidence',tool:name,status:v.commitment.status,commitmentId:v.commitment.id,motiveId:v.commitment.motive?.threadId,files:files.map(({path,sha256,bytes,mtime,checkedAt})=>({path,sha256,bytes,mtime,checkedAt})),meaning:'Evidence checked by the work ledger for this result. Hashed artifact existence is not quality, delivery or benefit; tool evidence retains its own limits.'};
 }
 if(name==='continuity_threads'&&p.action!=='list'&&v.updatedThread)return {kind:'authored_checkpoint',tool:name,status:v.updatedThread.status,threadId:v.updatedThread.id,version:v.updatedThread.updatedAt,meaning:'A saved authored view/checkpoint; its claimed external result requires its source.'};
 if(name==='samantha_processing'&&p.action==='reflect'&&v.ok&&v.reflection)return {kind:'saved_interpretation',tool:name,status:v.changed===false?'unchanged':'saved',reflectionId:v.reflection.id,target:v.reflection.target,sourceIds:v.reflection.sourceIds,meaning:'A sourced authored interpretation, not another emotional stimulus.'};
 if(name==='samantha_studio'&&p.action==='register_artifact'&&v.ok&&v.artifact)return {kind:'registered_file',tool:name,status:'file_read_and_hashed',artifactId:v.artifact.id,sha256:v.artifact.sha256,path:v.artifact.path,meaning:'File verified at registration. Quality, later state and authorship require their separate evidence.'};
 if(name==='samantha_studio'&&p.action==='arrange_home'&&v.ok)return {kind:'saved_home',tool:name,status:'saved',path:v.homePath};
 if(name==='samantha_journal'&&p.action==='record'&&v.ok)return {kind:'authored_account',tool:name,status:'saved',entryId:v.entryId,path:v.auditPath,meaning:'Recorded activity account; consult its linked receipts before treating a claimed action as completed.'};
 if(name==='samantha_reading'&&['open','continue'].includes(p.action)&&v.ok)return {kind:'retrieved_section',tool:name,status:'returned',readingId:v.id,url:v.url,version:v.version,nextCursor:v.nextCursor,meaning:'Sections returned, not proof of completing a book.'};
 if(name==='samantha_reading'&&p.action==='annotate'&&v.ok)return {kind:'reading_interpretation',tool:name,status:'saved',sourceId:v.note?.id,meaning:'Annotation grounded in a returned passage.'};
 if(name==='samantha_moltbook'&&['reply','post','status','verify','follow'].includes(p.action)&&v.status)return {kind:'outside_action',tool:name,status:v.status,requestKey:v.requestKey,objectId:v.objectId,postId:v.postId,meaning:v.status==='published'?'Publication verified; reception remains unknown.':'Returned action status only; do not assume publication, a reply or friendship.'};
 if(name==='samantha_moltbook'&&p.action==='read_thread'&&v.ok)return {kind:'outside_thread_read',tool:name,status:v.complete?'complete_at_read':'incomplete',postId:v.postId,revision:v.revision,newExternalCount:v.newExternalCount,meaning:'Actual saved discussion read; unchanged reads are not new interactions.'};
 if(name==='samantha_codex')return {kind:'delegated_work',tool:name,status:v.status??(v.jobId?'submitted':'returned'),jobId:v.jobId??v.id,meaning:'Worker status only; deployed effects require verification.'};
 if(name==='samantha_call'&&p.action==='speak')return {kind:'call_speech',tool:name,status:v.status??'returned',requestId:p.requestId,meaning:'Only a played receipt confirms client playback.'};
 if(name==='exec'&&typeof p.input==='string')return null; // wrapper, not an actual child outcome
 if(name==='exec'||name==='process')return {kind:'command_observation',tool:name,status:'returned',meaning:'Command returned. No file, publication or deployment is inferred from prose.'};
 return null;
}

export async function recordFollowingTool(workspace,ctx,event,{now=Date.now}={}) {
 ctx={...ctx,runId:ctx.runId??event.runId};
 // Do not guess across turns if this runtime omitted the run identity.
 if(!ctx.runId||ctx.agentId!=='samantha')return null;
 const folder=root(workspace,ctx);
 const name=String(event.toolName??'').split('__').at(-1).replace(/^openclaw(?=samantha_|continuity_)/,'');
 if(name==='samantha_choice'){
  const value=dataFrom(event.result),id=value?.decisionId;
  if(!value?.ok||!(/^[a-f0-9]{64}$/).test(id??'')||event.error||event.result?.isError)return null;
  return withStateLock(path.join(folder,'index.json'),async()=>{
   const index=await json(path.join(folder,'index.json'),{records:[]}),file=path.join(folder,id+'.json'),r=await json(file,null);
   if(!r||r.sessionKey!==ctx.sessionKey||r.requestKey!==event.params?.requestKey||r.runId&&r.runId!==ctx.runId)return null;
   if(!r.runId){r.runId=ctx.runId;await writeState(file,r);const item=index.records.find(x=>x.id===id);if(item)item.runId=ctx.runId;await writeState(path.join(folder,'index.json'),index);}
   return r;
  });
 }
 const observation=toolObservation(event);if(!observation)return null;
 const index=await json(path.join(folder,'index.json'),{records:[]});
 const candidate=index.records.findLast(r=>r.runId===ctx.runId&&r.sessionKey===ctx.sessionKey);if(!candidate)return null;
 const file=path.join(folder,candidate.id+'.json');
 return withStateLock(file,async()=>{const r=await json(file,null);if(!r)return null;
  const id=event.toolCallId??ctx.toolCallId??event.callId;if(!id)return null;
  if(r.observations.some(o=>o.callId===id))return r;
  r.observations.push({callId:id,at:now(),...observation});await writeState(file,r);return r;});
}
