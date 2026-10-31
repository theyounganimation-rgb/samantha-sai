// Bounded metadata from actual returned tool calls. No prompt, output body,
// command text, credential, inferred motive or claim of comprehension is stored.
import path from 'node:path';
export const ENCOUNTER_VERSION=1;
const name=v=>String(v??'').split('__').at(-1).replace(/^openclaw(?=samantha_|continuity_)/,'');
const payload=e=>{if(e.result?.details)return e.result.details;try{return JSON.parse(e.result?.content?.find(c=>c.type==='text')?.text??'{}');}catch{return {};}};
const textResult=e=>e.result?.content?.some(c=>c.type==='text'&&c.text?.trim()&&!/^Error\b/i.test(c.text));
export function encounterEvidence(event,{workspace,now=Date.now()}={}){
 const tool=name(event.toolName),p=event.params??{},v=payload(event);
 if(event.error||event.result?.isError||v.ok===false||v.success===false||v.error||['pending','running','queued','prepared','unknown','error','failed'].includes(v.status))return [];
 if(v.status==='paused'||v.paused===true||v.control?.paused===true)return [];
 const out=[],add=(kind,source,version)=>{if(typeof source==='string'&&source.trim()&&source.length<=1000)out.push({kind,source,...(version?{version:String(version).slice(0,160)}:{}),at:now});};
 if(tool==='samantha_reading'&&['open','continue','read_many'].includes(p.action)&&v.ok){
  for(const r of p.action==='read_many'?v.sections??[]:[v])if(r.ok&&r.id&&r.version&&r.paragraphs?.some(x=>x.text?.trim())&&!r.finished)add('reading',r.id,r.version);
 }
 if(tool==='samantha_moltbook'&&p.action==='read_thread'&&v.ok&&v.messages?.length&&v.revision)add('outside_thread',v.postId,v.revision);
 if(tool==='samantha_ears'&&v.ok&&v.description){for(const f of v.files??[v.file])add('audio_analysis',f);}
 if(tool==='samantha_vision'&&['status','recent','look'].includes(p.operation)){
  for(const r of [v,v.latest,v.observation,...(v.recent??[])].filter(r=>r&&typeof r==='object')){
   const at=Date.parse(r.capturedAt);if(r.source&&(r.description||r.observation)&&Number.isFinite(at)&&at<=now+3000&&now-at<=150000&&!['paused','stale','offline','unavailable'].includes(r.status))add('perception',r.source,r.capturedAt);
  }
 }
 if(tool==='samantha_processing'&&p.action==='reflect'&&v.ok&&v.changed!==false&&v.reflection?.sourceIds?.length)add('reflection',v.reflection.id);
 if(tool==='read'&&textResult(event)&&workspace){
  const source=p.path??p.file_path,rel=typeof source==='string'?path.relative(workspace,path.resolve(workspace,source)):null;
  if(rel&&!rel.startsWith('..')&&!rel.split(path.sep).some(p=>p.startsWith('.'))&&!/(?:^|\/)(?:state\.json|continuity-threads\.json|receipts|transcripts)(?:\/|$)/.test(rel))add('saved_source',path.resolve(workspace,source));
 }
 if(tool==='web_fetch'&&textResult(event)&&/^https?:\/\//.test(p.url??''))add('web_source',p.url);
 return [...new Map(out.map(r=>[r.kind+':'+r.source,r])).values()].slice(0,6);
}
export function runEncounters(run){return (run?.observations??[]).flatMap(o=>o.encounters??[]);}
export function selectEncounterProof(run,refs,{prior,now}={}){
 if(!Array.isArray(refs)||!refs.length||refs.length>4||refs.some(r=>typeof r!=='string'||!r.trim()||r.length>1000))throw Error('Use encounterRefs with the exact source IDs or paths returned by actual calls in this wake. Quiet uses quiet=true and a short reason.');
 const records=runEncounters(run).filter(r=>r.at>=run.at&&r.at<=now);
 const chosen=refs.map(source=>{const r=records.findLast(r=>r.source===source);if(!r)throw Error('No successful encounter with that source in this wake. Read, listen, look or reflect first, or choose quiet now.');return r;});
 if(prior&&!chosen.some(r=>(prior.encounters??[]).some(p=>p.source===r.source&&(!p.version||!r.version||p.version===r.version))))throw Error('That encounter is not a continuation of the prior moment. Keep a new moment if something happened, or choose quiet now.');
 return chosen;
}
