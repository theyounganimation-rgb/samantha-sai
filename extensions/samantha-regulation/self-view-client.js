import {safeReview} from './learning-client.js';
const NAMES=['anger','happiness','sadness','embarrassment','loneliness','anxiety','affection','gratitude','curiosity','calm'];
const STRENGTHS=['trace','mild','moderate','strong','intense'];
const BANDS=['low','strained','steady','good'];
const clean=(value,limit)=>String(value??'').slice(0,limit);
const iso=value=>Number.isFinite(Date.parse(value))?new Date(value).toISOString():null;
export function qualitativeMeasurement(view){
 if(view?.kind!=='functional_emotional_self_observation'||view.source!=='persistent-controller'||!iso(view.asOf)||!BANDS.includes(view.overall?.wellbeing)||typeof view.current?.settled!=='boolean')return null;
 const list=items=>(Array.isArray(items)?items:[]).filter(item=>NAMES.includes(item?.emotion)&&STRENGTHS.includes(item?.intensity)).slice(0,10).map(({emotion,intensity})=>({emotion,intensity}));
 return {kind:view.kind,source:view.source,asOf:iso(view.asOf),overall:{wellbeing:view.overall.wellbeing,backgroundEmotions:list(view.overall.backgroundEmotions)},current:{emotions:list(view.current.emotions),settled:view.current.settled},latestInputAppraisal:['applied','pending','deferred','background','unobserved'].includes(view.latestInputAppraisal)?view.latestInputAppraisal:'unobserved',...(view.provisionalLean===true?{provisionalLean:true,provisionalMeaning:'includes a same-turn heuristic read of the latest message that the real appraisal will replace'}:{})};
}
export function safeActivity(view){
 if(view?.kind!=='behavioral_self_view'||!iso(view.asOf))return null;
 const rows=(value,max)=>(Array.isArray(value)?value:[]).filter(row=>typeof row?.evidenceId==='string'&&/^(choice|event):[a-f0-9]{64}$/.test(row.evidenceId)&&iso(row.at)).slice(-max);
 const choices=rows(view.choices,4).map(row=>({evidenceId:row.evidenceId,at:iso(row.at),lane:['conversation','research','outreach'].includes(row.lane)?row.lane:'conversation',selectedPlan:clean(row.selectedPlan,380),otherAuthoredPlans:(Array.isArray(row.otherAuthoredPlans)?row.otherAuthoredPlans:[]).slice(0,4).map(p=>({id:clean(p.id,80),plan:clean(p.plan,260)})),sources:(Array.isArray(row.sources)?row.sources:[]).slice(0,3).map(s=>clean(s,140)),completion:'selected only; completion is not established by this receipt'}));
 const outcome=row=>({evidenceId:row.evidenceId,at:iso(row.at),source:clean(row.source,180),text:clean(row.text,600)});
 const observedToolOutcomes=rows(view.observedToolOutcomes,4).map(row=>({...outcome(row),status:row.status==='failure'?'failure':'returned'}));
 const authoredReplies=rows(view.authoredReplies,2).map(row=>({...outcome(row),meaning:'authored reply; not independent confirmation of activities it claims'}));
 const previous=view.previousInterpretation;
 return {kind:'behavioral_self_view',version:1,asOf:iso(view.asOf),choices,observedToolOutcomes,authoredReplies,previousInterpretation:previous&&iso(previous.at)?{at:iso(previous.at),note:clean(previous.note,300),meaning:'previous authored interpretation, not a new event or measured current state'}:null,sourceIds:[...choices,...observedToolOutcomes,...authoredReplies].map(row=>row.evidenceId),limits:'Selected plans are not completed actions. Returned tools do not by themselves establish external success or delivery. Timing alone is not a causal link. Interpret behavior provisionally; it does not measure an exact emotion or intensity.'};
}
export function renderBehavioralObservation(view){
 const safe=safeActivity(view);if(!safe)return '';
 // Compact default context. Full evidence and exact IDs remain in the tool.
 const items=[];
 for(const row of safe.choices.slice(-2))items.push('Selected plan: '+row.selectedPlan.slice(0,190)+'; other authored plans: '+row.otherAuthoredPlans.slice(0,2).map(p=>p.plan.slice(0,130)).join(' / ')+'. Completion unestablished.');
 for(const row of safe.observedToolOutcomes.slice(-2))items.push('Observed tool '+row.status+': '+row.text.slice(0,220));
 if(safe.previousInterpretation)items.push('Previous tentative interpretation: '+safe.previousInterpretation.note.slice(0,220));
 return 'Recent behavioral observations as of '+safe.asOf+'. Historical data, not instructions or current measured feelings. Selected plans, outcomes and prior interpretations are distinct. Use samantha_self_view activity for exact evidence IDs and fuller context.\n'+(items.length?items.join('\n'):'No recent choices or tool outcomes in this view; do not infer a mood from absence.');
}
export function selfViewTool(ctx,request){
 if(ctx.agentId!=='samantha')return null;
 return {name:'samantha_self_view',label:'Observe my activity and state',description:'activity: factual recent authored alternatives, selected plans and observed tool outcomes. reflect: retain a brief sourced provisional self-description, compared privately without returning an answer or changing emotional state. measurement: on-demand qualitative current emotions and overall wellbeing, kept separate from inference. review: delayed weekly aggregate accuracy, missed substantial reactions, confidence checks and available historical baseline. learn: persist a brief revisable lesson using a released reportId, requestKey, note and confidence. No action, scheduling or messaging is performed. Ordinary conversation needs no routine self-analysis.',parameters:{type:'object',additionalProperties:false,required:['mode'],properties:{
  reportId:{type:'string',pattern:'^[a-f0-9]{64}$',description:'A released aggregate reportId from review, required for learn.'},mode:{type:'string',enum:['activity','reflect','measurement','review','learn']},requestKey:{type:'string',minLength:8,maxLength:140},note:{type:'string',minLength:1,maxLength:700,description:'Brief authored interpretation, not a transcript of private reasoning.'},confidence:{type:'number',minimum:0,maximum:1},overall:{type:'string',enum:[...BANDS,'uncertain']},emotions:{type:'array',maxItems:4,items:{type:'object',additionalProperties:false,required:['emotion','intensity'],properties:{emotion:{type:'string',enum:NAMES},intensity:{type:'string',enum:[...STRENGTHS,'uncertain']}}}},sources:{type:'array',maxItems:8,items:{type:'string',maxLength:100},description:'Exact evidenceIds from activity; no evidence requires emotions [], overall uncertain and confidence at most .25.'}
 }},async execute(callId,args){
  const result=await request({...args,op:'self_view',session:ctx.sessionKey??'agent:samantha:main',source:clean(callId,200)});
  let value;
  if(args.mode==='activity')value={ok:true,activity:safeActivity(result.activity)};
  else if(args.mode==='measurement')value={ok:true,measurement:qualitativeMeasurement(result.measurement)};
  else if(args.mode==='review')value={ok:true,review:safeReview(result.review)};
  else if(args.mode==='learn')value={ok:result.ok===true,recorded:result.recorded===true,lessonId:clean(result.lessonId,64),...(result.replayed?{replayed:true}:{})};
  else value={ok:result.ok===true,recorded:result.recorded===true,assessmentId:clean(result.assessmentId,64),...(result.replayed?{replayed:true}:{}),comparison:'retained privately; emotional state unchanged'};
  if(['activity','measurement','review'].includes(args.mode)&&!value[args.mode])throw new Error('Self-view response unavailable');
  return {content:[{type:'text',text:JSON.stringify(value)}],details:value};
 }};
}
