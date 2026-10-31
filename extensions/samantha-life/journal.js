import {readLifeActivity} from './life-cycle.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createHash,randomUUID} from 'node:crypto';

const properties={
 action:{type:'string',enum:['recent','record']},
 requestKey:{type:'string',minLength:8,maxLength:140},
 focus:{type:'string',minLength:1,maxLength:140,description:'A short human-readable subject, such as Containment boundaries. Keep it on one line and leave technical IDs in audit.'},
 whatDid:{type:'string',maxLength:700,description:'Brief actual activity, including an honest quiet review. No invented work between calls.'},
 whatThought:{type:'string',maxLength:1500,description:'A short first-person authored reflection: a concrete view, what mattered or changed, or an unresolved question. Public interpretation, never a private reasoning transcript or reconstructed past feeling.'},
 outcome:{type:'string',enum:['advanced','refined','no_change','progress'],description:'Your reported outcome, not independently verified completion. progress is accepted as a compatibility spelling of advanced.'},
 next:{type:'string',maxLength:500,description:'Optional continuation if one matters. A private reflection need not have a next task.'},
 outreach:{type:'string',maxLength:500,description:'Optional actual send/hold/drop reason and outcome, only when contact was considered. Do not claim intention is delivery.'},
 sources:{type:'array',minItems:1,maxItems:8,items:{type:'string',maxLength:350}},
 audit:{type:'string',maxLength:10000,description:'Optional technical receipts, timestamps, IDs, read scope, failures and verification details, stored separately from the journal. Sources remain required even without an audit.'},
 limit:{type:'integer',minimum:1,maximum:12}
};
const fields=['focus','whatDid','whatThought','outcome','next','outreach','sources','audit'];
const bounded=(value,max)=>typeof value==='string'&&value.trim().length>0&&value.length<=max;
const machineReceipt=/checkedAt|lastMessageId|deliveryStatus|stateRevision|matched receipt|receipt\/tail|\b[0-9a-f]{20,64}\b|\b[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\b/i;
export function validateEntry(args){
 if(!args||Object.keys(args).some(k=>!Object.hasOwn(properties,k)))throw new Error('Unknown journal field');
 if(!['recent','record'].includes(args.action))throw new Error('Invalid journal action');
 if(args.limit!==undefined&&(!Number.isInteger(args.limit)||args.limit<1||args.limit>12))throw new Error('Invalid journal limit');
 if(args.action==='recent')return;
 if(!/^[A-Za-z0-9_.:-]{8,140}$/.test(args.requestKey??''))throw new Error('A stable journal requestKey is required');
 if(!bounded(args.focus,140)||/[\r\n]/.test(args.focus)||machineReceipt.test(args.focus))throw new Error('Use a short human-readable focus on one line, without technical receipts');
 for(const [key,max] of [['whatDid',700],['whatThought',1500],['next',500],['outreach',500],['audit',10000]]){
  if(!['whatDid','whatThought'].includes(key)&&args[key]===undefined)continue;
  if(!bounded(args[key],max))throw new Error('A bounded '+key+' is required');
  if(key!=='audit'&&machineReceipt.test(args[key]))throw new Error('Keep technical receipts in audit; write '+key+' as a concise human-readable account.');
 }
 if(!['advanced','refined','no_change','progress'].includes(args.outcome))throw new Error('Choose an honest journal outcome');
 if(!Array.isArray(args.sources)||!args.sources.length||args.sources.length>8||args.sources.some(s=>!bounded(s,350)))throw new Error('Journal needs actual source references');
}
async function atomic(file,text){
 await fs.mkdir(path.dirname(file),{recursive:true,mode:0o700});
 const temp=file+'.'+randomUUID()+'.tmp';
 try{const handle=await fs.open(temp,'wx',0o600);try{await handle.writeFile(text);await handle.sync();}finally{await handle.close();}await fs.rename(temp,file);}
 finally{await fs.rm(temp,{force:true});}
}
const digest=text=>createHash('sha256').update(text).digest('hex');
const dateAt=now=>new Intl.DateTimeFormat('en-CA',{timeZone:'America/Chicago',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(now));
const publicEntry=r=>Object.fromEntries(['id','at','focus','whatDid','whatThought','outcome','next','outreach','journalPath','auditPath'].map(k=>[k,r[k]]));

export function createJournal({workspace=path.join(os.homedir(),'.openclaw/workspace-samantha'),now=Date.now}={}){
 let queue=Promise.resolve();
 const serial=fn=>{const pending=queue.then(fn,fn);queue=pending.catch(()=>{});return pending;};
 const rootFor=ctx=>ctx?.sessionKey?.startsWith('agent:samantha:regulation-proof-')
  ?path.join(workspace,'experiments/journal-proof',digest(ctx.sessionKey).slice(0,20)):workspace;
 async function all(root,onlyDate){
  const dir=path.join(root,'memory/journal/entries');let dates;
  try{dates=onlyDate?[onlyDate]:(await fs.readdir(dir)).filter(x=>/^\d{4}-\d{2}-\d{2}$/.test(x)).sort().slice(-7);}catch(e){if(e.code==='ENOENT')return[];throw e;}
  const rows=[];
  for(const date of dates)for(const file of (await fs.readdir(path.join(dir,date))).filter(x=>/^[0-9a-f]{64}\.json$/.test(x))){rows.push(JSON.parse(await fs.readFile(path.join(dir,date,file),'utf8')));}
  return rows.sort((a,b)=>a.at.localeCompare(b.at)||a.id.localeCompare(b.id));
 }
 const recent=async(limit=6,ctx)=>{if(!Number.isInteger(limit)||limit<1||limit>12)throw new Error('Invalid limit');return(await all(rootFor(ctx))).slice(-limit).reverse().map(publicEntry);};
 async function renderDay(root,date){
  const rows=await all(root,date);const file=path.join(root,'memory/journal',date+'.md');
  const marker='<!-- Samantha structured entries -->';let existing='';
  try{existing=await fs.readFile(file,'utf8');}catch(e){if(e.code!=='ENOENT')throw e;}
  const prefix=existing.includes(marker)?existing.slice(0,existing.indexOf(marker)):existing;
  const body=rows.map(r=>{
   const time=new Intl.DateTimeFormat('en-US',{timeZone:'America/Chicago',hour:'2-digit',minute:'2-digit',hour12:false,timeZoneName:'short'}).format(new Date(r.at));
   const evidenceLink=path.relative(path.dirname(r.journalPath),r.auditPath).split(path.sep).join('/');
   return `## ${time}: ${r.focus}\n\n**What I did:** ${r.whatDid}\n\n**What I thought:** ${r.whatThought}\n\n${r.next?'**What comes next:** '+r.next+'\n\n':''}${r.outreach?'**Shared or held:** '+r.outreach+'\n\n':''}Evidence: [source and verification record](${evidenceLink}).\n`;
  }).join('\n');
  await atomic(file,(prefix||`# Journal ${date}\n\nActual activity and reflections authored at each wake.\n\n`)+marker+'\n\n'+body);
 }
 const record=(args,ctx)=>serial(async()=>{
  validateEntry(args);if(ctx.agentId!=='samantha')throw new Error('Private to Samantha');
  const root=rootFor(ctx);const id=digest(ctx.sessionKey+':'+args.requestKey);const content=Object.fromEntries(fields.map(k=>[k,k==='outcome'&&args[k]==='progress'?'advanced':args[k]]).filter(([,v])=>v!==undefined));const signature=digest(JSON.stringify(content));
  const indexFile=path.join(root,'memory/journal/entry-index',id+'.json');let old,value;
  try{old=JSON.parse(await fs.readFile(indexFile,'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;}
  if(old){if(old.signature!==signature)throw new Error('Journal key is already committed; use a new key for changed content.');value=old;}
  else{
   const at=now(),date=dateAt(at);value={id,signature,at:new Date(at).toISOString(),date,author:'Samantha',authorSession:ctx.sessionKey,provenance:'Authored public reflection and reported actual activity, not private model reasoning.',...content,
    journalPath:'memory/journal/'+date+'.md',auditPath:'memory/audit/'+date+'/'+id+'.md'};
   await atomic(indexFile,JSON.stringify(value,null,2)+'\n');
  }
  await atomic(path.join(root,'memory/journal/entries',value.date,id+'.json'),JSON.stringify(value,null,2)+'\n');
  await atomic(path.join(root,value.auditPath),`# Activity evidence ${value.at}\n\nAuthor session: ${value.authorSession}\n\n${value.audit?value.audit+'\n\n':''}Sources:\n${value.sources.map(s=>'- '+s).join('\n')}\n`);
  await renderDay(root,value.date);
  return {ok:true,entryId:id,journalPath:value.journalPath,auditPath:value.auditPath,duplicate:Boolean(old),isolatedProof:root!==workspace};
 });
 const tool=ctx=>ctx.agentId!=='samantha'?null:{name:'samantha_journal',label:'Samantha journal',
  description:'Read recent authored reflections or save one short actual-activity entry with What I thought and a separate technical audit. State a grounded view or question in Samantha’s own voice. No invented work, reconstructed past feelings or private reasoning. This saves notes only, never sends, schedules, changes emotional state or grants permissions. For record, supply requestKey, focus, whatDid, whatThought, outcome and actual sources. next, outreach and audit are optional; a private note owes no contact decision or next task. Stable keys make retries idempotent.',
  parameters:{type:'object',properties,required:['action'],additionalProperties:false},
  async execute(_call,args){
   validateEntry(args);let value;
   if(args.action==='recent'){
    const activity=await readLifeActivity(workspace,{now:now(),sessionKey:ctx?.sessionKey}),limit=args.limit??6;
    const ordered=[...activity.entries].sort((a,b)=>Date.parse(b.at)-Date.parse(a.at));
    const selected=[...new Set([ordered[0],...ordered.filter(r=>r.outcome==='advanced'),...ordered].filter(Boolean))].slice(0,limit);
    value={entries:await recent(limit,ctx),coverage:'entries are authored journal notes only, not all activity. observedActivity contains separate host receipts and authored decisions. Plans, attempts and work remain distinct; missing records are not inactivity.',observedActivity:{entries:selected,omitted:activity.entries.length-selected.length,unavailable:activity.unavailable,windowHours:48}};
   }else value=await record(args,ctx);
   return{content:[{type:'text',text:JSON.stringify(value)}]};
  }
 };
 const register=api=>api.registerTool(tool,{names:['samantha_journal']});
 return{record,recent,tool,register};
}
