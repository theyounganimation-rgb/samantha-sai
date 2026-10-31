import {compactRecallMessages} from './conversation-recall.mjs';
// The tool host truncates oversized results as text, potentially losing entire
// fields and invalidating JSON. Select complete records here instead. Saved
// history stays intact and every omitted record is counted for follow-up reads.
const bytes=x=>Buffer.byteLength(JSON.stringify(x));
const budgetReport=result=>JSON.stringify({bytes:bytes(result),sections:Object.fromEntries(Object.entries(result).filter(([,v])=>v!==undefined).map(([k,v])=>[k,bytes(v)]))});
// The snapshot is a view, not the memory store. A large optional section must
// not make all current conversation unavailable. Every displaced section has
// an explicit recovery route, backed by the full immutable tool-read snapshot.
export function fitConversationView(result,maxBytes=40000) {
  if(bytes(result)<=maxBytes)return result;
  result.projection ??= {maxBytes,omitted:{}};
  result.projection.deferredSections ??= [];
  const defer=key=>{
    if(result[key]===undefined)return;
    result.projection.deferredSections.push({section:key,bytes:bytes(result[key]),recovery:'samantha_conversation page with snapshotId and section'});
    delete result[key];
  };
  for(const key of ['calendarAgenda','development','messageDecisions','timeAndActions','workingContext','oura','conversationInterests','socialContext','shared','greetingsToday','situatedMemory']) {
    if(bytes(result)<=maxBytes)break;
    // Preserve current perception even when historical shared work is huge.
    if(key==='shared'&&result.shared?.currentPerception){
      const kept={currentPerception:result.shared.currentPerception,unavailable:result.shared.unavailable};
      defer(key);result.shared=kept;
    }else defer(key);
  }
  // Pathological individual source records also remain fetchable in full.
  // Never cut an exact quote or silently return an empty evidence collection.
  for(const key of ['earlierConversation','factualMemory','settledCorrections','recent','shared']){
    if(bytes(result)<=maxBytes)break;
    defer(key);
  }
  return result;
}

export function conversationOrientation(snapshot,maxBytes=15000) {
  const full=conversationProjection(snapshot,40000,{pages:true});
  const result={ok:full.ok,source:full.source,checkedAt:full.checkedAt,localDay:full.localDay,revision:full.revision,
    lastMessageId:full.lastMessageId,lastMessageAt:full.lastMessageAt,recent:full.recent?.slice(-4),
    ...(full.activationContinuity?{activationContinuity:full.activationContinuity}:{}),...(full.contactPattern?{contactPattern:full.contactPattern}:{}),
    runtimeSchedule:full.runtimeSchedule,...(full.bedtime?{bedtime:full.bedtime}:{}),calendarAgenda:full.calendarAgenda,greetingsToday:full.greetingsToday,
    socialContext:full.socialContext,
    situatedMemory:full.situatedMemory,
    shared:full.shared?{currentPerception:full.shared.currentPerception,outing:full.shared.outing,unavailable:full.shared.unavailable}:undefined,
    conversationInterests:full.conversationInterests,
    projection:{maxBytes,omitted:{},view:'orientation',recovery:'Current orientation only. Full read/query and page preserve every source section. Missing detail is not absence or a resolved interest.'}};
  return fitConversationView(result,maxBytes);
}
export function conversationProjection(snapshot,maxBytes=40000,{pages=false}={}) {
  const s=structuredClone(snapshot),omitted={};
  const note=(key,n=1)=>{omitted[key]=(omitted[key]??0)+n;};
  const list=(rows,key,limit,budget,{newestLast=false}={})=>{
    const selected=[];let used=2;
    for(const row of newestLast?[...(rows??[])].reverse():rows??[]) {
      const size=bytes(row)+1;
      if(selected.length>=limit||used+size>budget){note(key);continue;}
      selected.push(row);used+=size;
    }
    return newestLast?selected.reverse():selected;
  };
  const group=(value,key,budget)=>{
    if(value==null||bytes(value)<=budget)return value;
    note(key);return {omittedFromSnapshot:true,reason:'Section exceeds the compact read budget; use its source tool or saved source for details.'};
  };
  const shared=s.shared??{},interest=s.conversationInterests??{},working=s.workingContext??{};
  // Put present conversation and authored intentions before optional old work.
  const result={ok:s.ok,source:s.source,checkedAt:s.checkedAt,localDay:s.localDay,revision:s.revision,
    ...(s.activationContinuity?{activationContinuity:s.activationContinuity}:{}),
    exchangedToday:s.exchangedToday,lastMessageId:s.lastMessageId,lastMessageAt:s.lastMessageAt,...(s.bedtime?{bedtime:s.bedtime}:{}),
    recent:list(s.recent,'recent',8,9000,{newestLast:true}),
    development:s.development?{...s.development,trials:list(s.development.trials,'development.trials',3,3500),relationships:list(s.development.relationships,'development.relationships',3,3000),newConversation:list(s.development.newConversation,'development.newConversation',3,1600)}:undefined,
    messageDecisions:s.messageDecisions?{...s.messageDecisions,entries:list(s.messageDecisions.entries,'messageDecisions.entries',6,6500)}:undefined,
    conversationInterests:{...interest,items:list(interest.items,'conversationInterests.items',8,9000),candidates:list(interest.candidates,'conversationInterests.candidates',4,5000)},
    workingContext:{...working,assumptions:list([...(working.assumptions??[])].sort((a,b)=>Number(['active','review_due'].includes(b.status))-Number(['active','review_due'].includes(a.status))||Date.parse(b.updatedAt)-Date.parse(a.updatedAt)),'workingContext.assumptions',8,6500)},
    ...(s.calendarAgenda?{calendarAgenda:group(s.calendarAgenda,'calendarAgenda',6500)}:{}),oura:group(s.oura,'oura',6500),runtimeSchedule:s.runtimeSchedule,timeAndActions:group(s.timeAndActions,'timeAndActions',7500),socialContext:group(s.socialContext,'socialContext',3500),
    shared:{checkedAt:shared.checkedAt,revision:shared.revision,threadRevision:shared.threadRevision,perspectiveRevision:shared.perspectiveRevision,
      currentPerception:group(shared.currentPerception,'shared.currentPerception',4500),
      outing:group(shared.outing,'shared.outing',2500),activityWindow:shared.activityWindow,unavailable:shared.unavailable,
      carriedInterests:list(shared.carriedInterests,'shared.carriedInterests',4,4500),
      actualActivity:list(shared.actualActivity,'shared.actualActivity',6,5000),
      perspective:list(shared.perspective,'shared.perspective',3,2000)},
    earlierConversation:s.earlierConversation?{...s.earlierConversation,messages:compactRecallMessages(s.earlierConversation.messages)}:undefined,
    greetingsToday:list(s.greetingsToday,'greetingsToday',8,2000,{newestLast:true}),
    projection:{maxBytes,omitted,recovery:'This is a bounded view, not the full history. interest_read returns compact question evidence. Use read with query for earlier conversation or relevant carried interests; journal/audit paths and memory/transcripts retain full activity and messages. Omission is not absence or a resolved interest.'}};
  if(s.earlierConversation&&s.earlierConversation.messages.length>result.earlierConversation.messages.length)note('earlierConversation.messages',s.earlierConversation.messages.length-result.earlierConversation.messages.length);
  // Factual testimony is part of the protected source core, not leftover space.
  if(s.situatedMemory)result.situatedMemory=s.situatedMemory;
  if(s.factualMemory){
    const fm={...s.factualMemory,facts:[...(s.factualMemory.facts??[])],originals:[...(s.factualMemory.originals??[])],annotations:[...(s.factualMemory.annotations??[])]};
    result.factualMemory=fm;
    for(const [key,rows] of [['originals',fm.originals],['annotations',fm.annotations],['facts',fm.facts]])while(rows.length&&bytes(fm)>6000){rows.pop();note('factualMemory.'+key);}
  }
  if(s.settledCorrections?.unavailable)result.settledCorrections=s.settledCorrections;
  else if(s.settledCorrections?.records?.length){
    // Append only after selecting existing memories: corrections must not
    // silently reduce factual recall, recent turns or other evidence budgets.
    result.settledCorrections={...s.settledCorrections,records:s.settledCorrections.records.map(r=>({id:r.id,personId:r.personId,sourceId:r.sourceId,supersededQuote:r.supersededQuote,correctedQuote:r.correctedQuote,notificationId:r.notificationId,sharedAt:r.sharedAt,...(r.visibility?{visibility:r.visibility,recordedAt:r.recordedAt}:{}),evidence:r.evidence}))};
    if(bytes(result)>maxBytes){
      // Keep every corrected clause/source link; omit bulky paths and excerpts
      // first. They remain in the original existing commitment ledger.
      result.settledCorrections.records=result.settledCorrections.records.map(({evidence,...r})=>r);
      result.settledCorrections.evidenceOmitted=true;
    }
  }
  // Section budgets prevent one historical source swallowing all the others;
  // the final budget also protects against simultaneous large sections.
  const trims=[['development.newConversation',result.development?.newConversation,0],['development.trials',result.development?.trials,1],['development.relationships',result.development?.relationships,1],['messageDecisions.entries',result.messageDecisions?.entries,1],['shared.actualActivity',result.shared.actualActivity,1],['shared.carriedInterests',result.shared.carriedInterests,1],['shared.perspective',result.shared.perspective,0],['greetingsToday',result.greetingsToday,0],['conversationInterests.candidates',result.conversationInterests.candidates,1],['workingContext.assumptions',result.workingContext.assumptions,1],['conversationInterests.items',result.conversationInterests.items,1]];
  // These existing collections grew outside the original section budgets.
  // Trim derived elapsed-time anchors and optional old lesson/position detail
  // before the legacy final cap rejects the entire conversation lookup.
  const trimExtraDetail=()=>{
    const anchors=result.workingContext.temporalEvidence;
    while(anchors?.length>3&&bytes(result)>maxBytes){anchors.shift();note('workingContext.temporalEvidence');}
    for(const [key,rows] of [['development.lessons',result.development?.lessons],['development.ownPositions',result.development?.ownPositions]])
      while(rows?.length>1&&bytes(result)>maxBytes){rows.pop();note(key);}
  };
  trimExtraDetail();
  for(const [key,rows,min] of trims)while(rows?.length>min&&bytes(result)>maxBytes){if(key==='recent')rows.shift();else if(key==='earlierConversation.messages'){const kept=compactRecallMessages(rows,{limit:rows.length-1,maxBytes:Infinity});rows.splice(0,rows.length,...kept);}else rows.pop();note(key);}
  trimExtraDetail();
  for(const [key,rows,min] of [['timeAndActions.entries',result.timeAndActions?.entries,3],['earlierConversation.messages',result.earlierConversation?.messages,5],['recent',result.recent,4]])while(rows?.length>min&&bytes(result)>maxBytes){if(key==='recent')rows.shift();else if(key==='earlierConversation.messages'){const kept=compactRecallMessages(rows,{limit:rows.length-1,maxBytes:Infinity});rows.splice(0,rows.length,...kept);}else rows.pop();note(key);}
  // Defer complete sections only after the existing source-preserving selection.
  // The full source snapshot is available through the paged tool interface.
  if(s.contactPattern){
    result.contactPattern=s.contactPattern;
    if(bytes(result)>maxBytes){delete result.contactPattern;note('contactPattern');if(bytes(result)>maxBytes)delete omitted.contactPattern;}
  }
  if(s.personalPresent){
    result.personalPresent=s.personalPresent;
    if(bytes(result)>maxBytes){delete result.personalPresent;note('personalPresent');if(bytes(result)>maxBytes)delete omitted.personalPresent;}
  }
  // Real long-running sessions can fill the baseline budget. Retain current
  // conversation, earlier source excerpts and factual memory byte-for-byte.
  // Make room only in optional older background detail, with explicit counts.
  const correctionRoom=[['shared.actualActivity',result.shared.actualActivity,1],['shared.carriedInterests',result.shared.carriedInterests,1],['shared.perspective',result.shared.perspective,0],['development.newConversation',result.development?.newConversation,0],['development.trials',result.development?.trials,1],['development.relationships',result.development?.relationships,1],['greetingsToday',result.greetingsToday,0],['conversationInterests.candidates',result.conversationInterests.candidates,1],['messageDecisions.entries',result.messageDecisions?.entries,1],['workingContext.assumptions',result.workingContext.assumptions,1]];
  for(const [key,rows,min] of correctionRoom)while(rows?.length>min&&bytes(result)>maxBytes){rows.pop();note(key);}
  // Elapsed-time anchors are a derived convenience, not stored memories. The
  // long-lived snapshot can carry twelve of them after other lists are at
  // minimum. Retain the newest three and count any older anchors omitted.
  trimExtraDetail();
  if(bytes(result)>maxBytes&&!pages)throw Error('Conversation exceeds the compact snapshot budget; a complete source-page recovery handle is required.');
  return fitConversationView(result,maxBytes);
}
