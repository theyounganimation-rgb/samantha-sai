import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import {withStateLock,writeState} from './durable-state.js';
import {researchProperties,researchBrief,researchEvaluation,researchHandoff,hasResearchResult,RESEARCH_GUIDANCE} from './research-work.mjs';
import {isOwnTimeKey} from './own-time-keys.mjs';

const hash=v=>crypto.createHash('sha256').update(JSON.stringify(v)).digest('hex');
const text=(v,n,label)=>{if(typeof v!=='string'||!v.trim()||v.length>n)throw Error('Provide '+label+' within '+n+' characters');return v.trim();};
const norm=n=>String(n??'').split('__').at(-1).replace(/^openclaw(?=samantha_)/,'');
const background=ctx=>isOwnTimeKey(ctx.sessionKey);
const empty=()=>({revision:0,currentId:null,sessions:{},observations:[],requests:{}});
const active=s=>s.sessions[s.currentId]??null;
const binding=ctx=>ctx.runId??ctx.sessionKey;
const boundWork=(w,ctx)=>w.sessions[w.runBindings?.[binding(ctx)]]??null;
const sourceFor=e=>e.params?.path??e.params?.file_path??e.params?.url??e.params?.query??e.params?.threadId??e.params?.postId??e.params?.title??null;
const accounting=new Set(['samantha_studio','samantha_commitments','samantha_conversation','samantha_processing','samantha_development','samantha_attention','samantha_choice','samantha_journal','samantha_call','samantha_oura','samantha_life','continuity_threads','sessions_list','sessions_history']);

export const WORK_GUIDANCE='Keep an ongoing activity in samantha_studio work_start/work_checkpoint rather than deciding again from scratch next heartbeat. This is an optional continuation, not an assigned hobby or a requirement to keep working. Choose your own question and want; a project thread is optional. Continue a worthwhile line through several steps when it holds your interest. A timer tick, completed substep, or saved note need not end the larger activity. work_read returns its exact checkpoint and tool observations; work_checkpoint records what actually changed plus your next step, supported by new evidenceIds returned there. A checkpoint with outcome=blocked can retain a real failed attempt. work_pause, work_finish, or work_abandon preserve the history. Unchanged context needs no checkpoint. These actions neither send messages nor create another model, timer, persona, or emotion. Full original projects and memories remain authoritative. Every work mutation requires workId, expectedWorkRevision from work_read.revision, and a stable requestKey. A NEW work_start also requires title, want, question, source (actual evidence or your authored motivation), and nextStep. Start successfully before executing work so observations attach to it. Resume an unfinished activity in a later run using work_start with its existing workId and a new requestKey; this binds observations to that run. Original title/want/question fields need not be repeated. Several activities may remain active. Starting another changes focus without pausing earlier work. Each run is bound to its own workId so concurrent observations cannot mix. Pause only when you actually choose to pause. Use samantha_codex purpose=personal with workId for parallel delegated work; collect and review its durable results. work_checkpoint requires result, nextStep and new evidenceIds; work_finish requires result and new evidenceIds; work_pause/work_abandon require reason. Writes use expectedWorkRevision and a stable requestKey; after uncertain outcomes reuse the identical request, never replay the external operation.';

export const workProperties={
 ...researchProperties,
 workId:{type:'string',description:'Required for every work mutation. Choose a stable lowercase ID for new work; reuse it to resume.',pattern:'^[a-z0-9-]{1,80}$'},expectedWorkRevision:{type:'integer',minimum:0,description:'Required for every work mutation; use revision returned by work_read.'},
 want:{type:'string',maxLength:1200},question:{type:'string',maxLength:1200},nextStep:{type:'string',maxLength:1600},
 result:{type:'string',maxLength:2200},reason:{type:'string',maxLength:1200},
 outcome:{type:'string',enum:['progress','blocked']},evidenceIds:{type:'array',items:{type:'string'},maxItems:12}
};

export function workHandoff(s={}, {maxBytes=1500}={}){
 const w=s.workSessions??empty(),v=active(w);
 const out={revision:w.revision,current:v?{id:v.id,status:v.status,title:v.title,want:v.want,question:v.question,
   nextStep:v.nextStep,lastResult:v.lastResult??null,lastOutcome:v.lastOutcome??null,source:v.source,
   threadId:v.threadId??null,updatedAt:v.updatedAt,checkpointCount:v.checkpoints?.length??0}:null,
  activeCount:Object.values(w.sessions).filter(v=>v.status==='active').length,
  active:Object.values(w.sessions).filter(v=>v.status==='active').slice(-6).map(v=>({id:v.id,title:v.title,nextStep:v.nextStep})),
  resumable:Object.values(w.sessions).filter(v=>v.status==='paused').slice(-3).map(v=>({id:v.id,title:v.title,nextStep:v.nextStep})),
  meaning:'A saved chosen activity and actual checkpoints. Intention is not completed work. Continue, change direction, pause or stop from your present perspective; there is no assigned topic.'};
 const fits=()=>Buffer.byteLength(JSON.stringify(out))<=maxBytes;
 if(!fits()){
  out.deferred=[];out.fullRecord='samantha_studio action=work_read'+(v?' workId='+v.id:'');
  // Whole fields only. Never shorten a result into a different apparent claim.
  while(out.active.length&&!fits()){out.deferred.push('active:'+out.active.pop().id);}
  while(out.resumable.length&&!fits()){out.deferred.push('paused:'+out.resumable.pop().id);}
  for(const key of ['source','lastResult','want','question','nextStep']){
   if(fits())break;
   if(out.current?.[key]!=null){out.deferred.push(key);delete out.current[key];}
  }
 }
 return out;
}

export function createWorkSessions({statePath,initial,now=Date.now}={}){
 const load=async ctx=>{try{return JSON.parse(await fs.readFile(statePath(ctx),'utf8'));}catch(e){if(e.code==='ENOENT')return initial();throw e;}};
 async function read(ctx,workId){
  const s=await load(ctx),w=s.workSessions??empty();
  return {ok:true,...workHandoff(s,{maxBytes:Infinity}),...(workId?{selected:w.sessions[workId]??null}:{}),
   research:researchHandoff(s),observations:w.observations.filter(e=>workId?e.workId===workId:w.currentId?e.workId===w.currentId:e.at>=now()-86400000).slice(-80),guidance:WORK_GUIDANCE+'\n'+RESEARCH_GUIDANCE};
 }
 async function execute(ctx,p){
  if(ctx.agentId!=='samantha')throw Error('Private to Samantha');ctx.assertInvocationCurrent?.();
  if(p.action==='work_read')return read(ctx,p.workId);
  const key=text(p.requestKey,140,'stable requestKey'),sig=hash({...p,expectedWorkRevision:undefined});
  return withStateLock(statePath(ctx),async()=>{
   const s=await load(ctx),w=s.workSessions??=empty(),prior=w.requests[key];
   if(prior){if(prior.signature!==sig)throw Error('Request key already belongs to different work');return {...prior.result,duplicate:true};}
   if(p.expectedWorkRevision!==w.revision)throw Error('Work changed; use work_read and reconcile the exact checkpoint');
   const workId=text(p.workId,80,'workId');if(!/^[a-z0-9-]+$/.test(workId))throw Error('Use a lowercase workId');
   let v=w.sessions[workId];const at=now();
   if(p.action==='work_start'){
    if(v&&['complete','abandoned'].includes(v.status))throw Error('That activity is closed. Use a new ID for a genuinely new question; its previous record remains');
    // A current focus is not a limit on independent concurrent activity.
    if(!v){v={id:workId,title:text(p.title,160,'title'),want:text(p.want,1200,'your want'),question:text(p.question,1200,'your question'),
      source:text(p.source,1200,'actual source or authored motivation'),nextStep:text(p.nextStep,1600,'next step'),
      threadId:p.threadId??null,startedAt:at,checkpoints:[]};w.sessions[workId]=v;}
    if(p.researchBrief){const brief=researchBrief(p.researchBrief);if(v.researchBrief&&hash(v.researchBrief)!==hash(brief))throw Error('Revise a researchBrief through work_checkpoint with new evidence, not by overwriting it on resume');v.researchBrief=brief;}
    v.status='active';v.updatedAt=at;w.currentId=workId;
    w.runBindings??={};w.runBindings[binding(ctx)]=workId;
    w.runBindings=Object.fromEntries(Object.entries(w.runBindings).slice(-128));
   }else{
    if(!v||['complete','abandoned'].includes(v.status))throw Error('Read an existing unfinished work session');
    if(p.action==='work_checkpoint'||p.action==='work_finish'){
     const used=new Set(v.checkpoints.flatMap(c=>c.evidenceIds));
     const ids=[...new Set(p.evidenceIds??[])];
     const observations=ids.map(id=>w.observations.find(e=>e.id===id));
     if(!ids.length||observations.some(e=>!e||e.at<v.startedAt||e.at>at+60000||e.workId!==v.id)||ids.some(id=>used.has(id)))throw Error('Use new actual observations from this activity; bookkeeping or old evidence cannot establish progress');
     const blocked=p.outcome==='blocked';
     if(!blocked&&!observations.some(e=>e.outcome==='observed'))throw Error('Failed, pending, or uncertain operations cannot count as progress/completion');
     if(p.action==='work_finish'&&blocked)throw Error('Blocked work remains resumable; pause it instead of claiming completion');
     const evaluation=p.researchEvaluation?researchEvaluation(p.researchEvaluation):null;
     if(evaluation&&!v.researchBrief&&!p.researchBrief)throw Error('Attach the researchBrief before evaluating research');
     if(p.action==='work_finish'&&v.researchBrief&&!evaluation)throw Error('Research completion needs researchEvaluation with the actual comparison, limitations and next question; use a checkpoint for an intermediate step');
     if(p.action==='work_finish'&&v.researchBrief&&!hasResearchResult([...v.checkpoints.flatMap(c=>c.observations??[]),...observations]))throw Error('Research has only retrieval, interpretation or pending work evidence. Retain a checked experiment, built artifact, written synthesis or reviewed worker result before completing; intermediate reading can be checkpointed');
     if(p.researchBrief&&p.action!=='work_checkpoint')throw Error('Revise researchBrief in an evidence-linked checkpoint');
     if(p.researchBrief){const brief=researchBrief(p.researchBrief);v.researchBriefHistory??=[];if(v.researchBrief)v.researchBriefHistory.push({at,brief:v.researchBrief,evidenceIds:ids});v.researchBrief=brief;}
     const result=text(p.result,2200,'actual result and any limit');
     const next=p.action==='work_finish'?null:text(p.nextStep,1600,'specific continuation');
     v.checkpoints.push({at,result,nextStep:next,outcome:blocked?'blocked':'progress',evidenceIds:ids,observations,...(evaluation?{researchEvaluation:evaluation}:{}),sessionKey:ctx.sessionKey});
     if(evaluation)v.lastResearchEvaluation={at,...evaluation,evidenceIds:ids};
     Object.assign(v,{lastResult:result,lastOutcome:blocked?'blocked':'progress',nextStep:next,updatedAt:at});
     if(p.action==='work_finish'){v.status='complete';v.finishedAt=at;if(w.currentId===v.id)w.currentId=null;}
    }else if(['work_pause','work_abandon'].includes(p.action)){
     v.status=p.action==='work_pause'?'paused':'abandoned';v.pauseReason=text(p.reason,1200,'reason');v.updatedAt=at;
     if(w.currentId===v.id)w.currentId=null;
    }else throw Error('Unknown work action');
   }
   w.revision++;s.revision++;
   const value={ok:true,...workHandoff(s),workId,action:p.action,...(v.researchBrief?{researchStatus:{kind:p.researchEvaluation?'evaluated_claim':'research_step',status:v.status,verdict:v.lastResearchEvaluation?.verdict??null,meaning:'Evidence-linked authored claim; not host verification of scientific quality or generalization.'}}:{}),dispatchPerformed:false};
   w.requests[key]={signature:sig,result:value};await writeState(statePath(ctx),s);return value;
  });
 }
 async function observe(event,ctx){
  if(ctx.agentId!=='samantha')return;
  const tool=norm(event.toolName);
  // Host tool factories omit runId; after-tool hooks carry it. Bind the
  // acknowledged work_start to this exact run before observing later tools.
  if(tool==='samantha_studio'&&event.params?.action==='work_start'&&ctx.runId){
   let value=event.result?.details;try{value??=JSON.parse(event.result?.content?.find(c=>c.type==='text')?.text??'{}');}catch{}
   if(value?.ok&&value.workId&&!event.error&&!event.result?.isError)await withStateLock(statePath(ctx),async()=>{
    const s=await load(ctx),w=s.workSessions??empty(),saved=w.requests[event.params.requestKey];
    if(saved?.result?.workId!==value.workId||w.sessions[value.workId]?.status!=='active')return;
    w.runBindings??={};w.runBindings[ctx.runId]=value.workId;w.runBindings=Object.fromEntries(Object.entries(w.runBindings).slice(-128));s.workSessions=w;await writeState(statePath(ctx),s);
   });
   return;
  }
  if(accounting.has(tool)||tool==='exec'&&!event.params?.command)return;
  if(tool==='samantha_reading'&&event.params?.action==='overview')return;
  if(!boundWork((await load(ctx)).workSessions??empty(),ctx))return;
  // Receipt summaries, not copied tool bodies, authentication or reasoning.
  let d=event.result?.details;
  if(!d)try{d=JSON.parse((event.result?.content??[]).filter(c=>c.type==='text').map(c=>c.text).join(''));}catch{}
  const annotation=tool==='samantha_reading'&&event.params?.action==='annotate';
  // A retained interpretation is real authored work, not proof of a new read.
  // Require the reading tool's saved-note receipt; prose or unchanged bookkeeping is insufficient.
  if(annotation&&!(d?.ok===true&&d?.note?.id&&d?.changed!==false))return;
  const code=d?.exitCode??d?.exit_code,status=d?.status??d?.result?.status;
  const failed=Boolean(event.error||event.result?.isError||d?.ok===false||d?.success===false||d?.error||['failed','error','timeout','cancelled'].includes(status)||Number.isInteger(code)&&code!==0);
  const uncertain=['pending','running','prepared','queued','unknown','submitted'].includes(status);
  await withStateLock(statePath(ctx),async()=>{
   const s=await load(ctx),w=s.workSessions??empty(),v=boundWork(w,ctx);if(!v||v.status!=='active')return;
   // Only operations issued in a personal-time or isolated proof turn are
   // automatically attributed to this activity, never unrelated foreground work.
   if(!background(ctx)&&!ctx.sessionKey?.startsWith('agent:samantha:regulation-proof-'))return;
   const id=hash([ctx.runId??ctx.sessionKey,event.toolCallId??null,tool,event.params,event.result]);
   if(w.observations.some(e=>e.id===id))return;
   w.observations.push({id,workId:v.id,at:now(),tool,action:event.params?.action??event.params?.operation??null,
     source:annotation?d.note.id:sourceFor(event),...(annotation?{kind:'reading_interpretation'}:{}),outcome:failed?'failed':uncertain?'pending':'observed',
     meaning:annotation?'Saved interpretation grounded by the reading tool. Not evidence of a new reading, completed book, or resolved question.':'Observed tool outcome, not proof of human reception, a scientific conclusion, or overall completion.'});
   w.observations=w.observations.slice(-80);s.workSessions=w;s.revision++;await writeState(statePath(ctx),s);
  });
 }
 return {read,execute,observe};
}
