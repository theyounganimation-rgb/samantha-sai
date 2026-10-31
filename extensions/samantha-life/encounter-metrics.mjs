import {runEncounters,ENCOUNTER_VERSION} from './encounter-evidence.mjs';
import {momentFocus} from './moment-memory.mjs';
const day=at=>new Date(at).toLocaleDateString('en-CA',{timeZone:'America/Chicago'});
export function summarizeOwnTime(runs,{now=Date.now(),days=1}={}){
 if(!Number.isInteger(days)||days<1||days>7)throw Error('Use one to seven days');
 const rows=runs.filter(r=>r.independent&&r.at>=now-days*86400000&&r.at<=now),buckets=new Map(),seenMoments=new Set();
 for(const r of rows){const key=day(r.at);if(!buckets.has(key))buckets.set(key,{date:key,wakes:0,instrumentedWakes:0,legacyWakes:0,encounters:0,encounterKinds:{},freshQuiet:0,freshMoments:0,evidencedContinuations:0,legacyCarries:0,momentFocus:{self_experience:0,relational_response:0,attention_bookkeeping:0},returnedCommands:0,unclassifiedReads:0,omittedRecords:0});
  const b=buckets.get(key);b.wakes++;r.encounterVersion===ENCOUNTER_VERSION?b.instrumentedWakes++:b.legacyWakes++;
  for(const e of runEncounters(r)){b.encounters++;b.encounterKinds[e.kind]=(b.encounterKinds[e.kind]??0)+1;}
  const d=r.timeDecision;
  if(d?.quiet)b.freshQuiet++;
  else if(d?.continuedNow)b.evidencedContinuations++;
  else if(d?.mode==='being'&&d.continuedAt)b.legacyCarries++;
  if(d?.moment&&!d.continuedAt&&!d.continuedNow&&!seenMoments.has(d.observationSource??d.moment)){seenMoments.add(d.observationSource??d.moment);b.freshMoments++;const focus=d.momentFocus??momentFocus(d.moment);b.momentFocus[focus]=(b.momentFocus[focus]??0)+1;}
  b.returnedCommands+=(r.observations??[]).filter(o=>o.kind==='command_observation'&&o.status==='returned').length;
  b.unclassifiedReads+=(r.observations??[]).filter(o=>o.tool==='read'&&o.status==='returned'&&!o.encounters?.length).length;
  b.omittedRecords+=r.omitted??0;
 }
 for(const b of buckets.values()){b.encountersAreLowerBound=Boolean(b.legacyWakes||b.omittedRecords);if(!b.instrumentedWakes)b.encounters=null;}
 return {version:1,days,asOf:new Date(now).toISOString(),daily:[...buckets.values()].sort((a,b)=>a.date.localeCompare(b.date)),coverage:{runs:rows.length,limit:1024,possiblyTruncated:rows.length>=1024},meaning:'Encounters are actual returned exposures, not comprehension, continuous occupation, work quality or felt experience. Quiet is valid and has no quota. Legacy zero activityCount does not establish zero activity; commands and unclassified reads remain separate. Moment focus is a labeled text heuristic, not an objective grade. Omitted records make counts lower bounds.'};
}
