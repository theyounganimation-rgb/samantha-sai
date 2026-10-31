// Supported Calendar.app API. IDs come from EventKit's verified calendar catalog.
function sameSnapshot(a,b) {
 if(!a||!b||typeof a!=='object'||typeof b!=='object')return false;
 const keys=Object.keys(a).sort(),other=Object.keys(b).sort();
 return JSON.stringify(keys)===JSON.stringify(other)&&keys.every(k=>JSON.stringify(a[k])===JSON.stringify(b[k]));
}
function run(argv) {
 const p=JSON.parse(argv[0]), app=Application('Calendar');
 const known=p.calendars || [];
 function calendar(id) {
  if (!known.some(c=>c.id===id)) throw Error('Unknown calendarId');
  const c=app.calendars.byId(id); c.name(); return c;
 }
 function nullable(fn, fallback) { const v=fn(); return v===null || v===undefined ? fallback : v; }
 function snapshot(c,e,id,writable) {
  const v=e.properties();
  return {eventId:v.uid,calendarId:id,title:v.summary || '',
   startEpoch:v.startDate.getTime()/1000,endEpoch:v.endDate.getTime()/1000,
   allDay:v.alldayEvent,location:v.location || '',notes:v.description || '',
   url:v.url || '',recurrence:v.recurrence || '',
   excludedDates:(v.excludedDates || []).map(d=>d.toISOString()),sequence:v.sequence,
   stampDate:v.stampDate.toISOString(),writable:writable===undefined ? c.writable() : writable};
 }
 function find(c,id) {
  // Stable UID lookup avoids repeatedly resolving a filtered collection.
  const e=c.events.byId(id);
  try {e.uid();return e;}
  catch(err) {if(err.errorNumber===-1728 || /\(-1728\)/.test(String(err)))return null;throw err;}
 }
 function apply(e,v) {
  // Set all-day mode before setting dates to avoid Calendar's inclusive-date conversion.
  if ('allDay' in v) e.alldayEvent=v.allDay;
  if ('startEpoch' in v && 'endEpoch' in v) {
   // Calendar validates each setter. Move the end first when advancing past it.
   if(v.startEpoch>=e.endDate().getTime()/1000) {e.endDate=new Date(v.endEpoch*1000);e.startDate=new Date(v.startEpoch*1000);}
   else {e.startDate=new Date(v.startEpoch*1000);e.endDate=new Date(v.endEpoch*1000);}
  } else {
   if ('startEpoch' in v) e.startDate=new Date(v.startEpoch*1000);
   if ('endEpoch' in v) e.endDate=new Date(v.endEpoch*1000);
  }
  const keys={title:'summary',location:'location',notes:'description',url:'url'};
  Object.keys(keys).forEach(k=>{if(k in v)e[keys[k]]=v[k];});
 }
 if(p.operation==='access') {
  return JSON.stringify({ok:true,calendars:known.map(k=>{const c=calendar(k.id);return {id:k.id,title:c.name(),writable:c.writable()};}),scope:'All writable calendars, regardless of event creator; recurring events use explicit series scope.'});
 }
 if(p.operation==='search') {
  const out=[],seen={};let truncated=false,truncatedReason=null;
  // Return an honest partial result before the outer read deadline, rather than
  // spending the whole request on historical matches and returning no evidence.
  const deadline=Date.now()+8000;let lastQueryMs=0;
  const title=p.query ? {summary:p.titleMatch==='exact' ? p.query : {_contains:p.query}} : null;
  const recurring={recurrence:{_contains:'FREQ='}};
  const and=parts=>parts.length===1 ? parts[0] : {_and:parts};
  const dated=p.startEpoch!==undefined;
  const dates=dated ? [{startDate:{_lessThan:new Date(p.endEpoch*1000)}},{endDate:{_greaterThan:new Date(p.startEpoch*1000)}}] : [];
  const base=and([...(title ? [title] : []),...dates,...(p.recurringOnly===true ? [recurring] : [])]);
  // A title-only lookup must include old recurring masters. Prioritize them so
  // old one-off events cannot hide the active series behind a result limit.
  const groups=!dated && title && p.recurringOnly!==true ? [and([title,recurring]),base] : [base];
  outer:for(const k of known.filter(k=>!p.calendarId || k.id===p.calendarId)) {
   if(Date.now()>=deadline){truncated=true;truncatedReason='time_budget';break;}
   const c=calendar(k.id),writable=c.writable();
   for(const predicate of groups) {
    if(Date.now()+lastQueryMs>=deadline){truncated=true;truncatedReason='time_budget';break outer;}
    const queryStarted=Date.now();const es=c.events.whose(predicate)();lastQueryMs=Math.max(lastQueryMs,Date.now()-queryStarted);
    for(const e of es) {
     if(Date.now()>=deadline){truncated=true;truncatedReason='time_budget';break outer;}
     const value=snapshot(c,e,k.id,writable),key=k.id+':'+value.eventId;
     if(seen[key])continue;seen[key]=true;
     // Recheck literal title semantics independently of Calendar's comparison.
     const titleText=value.title.toLowerCase(),query=(p.query || '').toLowerCase();
     if(query && (p.titleMatch==='exact' ? titleText!==query : titleText.indexOf(query)===-1))continue;
     if(p.recurringOnly===true && !value.recurrence)continue;
     out.push(value);
     if(out.length>=p.limit){truncated=true;truncatedReason='limit';break outer;}
    }
   }
  }
  return JSON.stringify({ok:true,events:out,truncated,truncatedReason,recurrenceSearch:'Title-only searches prioritize recurring masters, including old anchors. Use titleMatch=exact and recurringOnly=true to isolate a named series. Date windows match master dates, not expanded occurrences. A truncated result is incomplete; narrow the calendar/title/date or recurring filter.'});
 }
 const c=calendar(p.calendarId), e=find(c,p.eventId);
 if(p.operation==='get')return JSON.stringify({ok:true,event:e ? snapshot(c,e,p.calendarId) : null});
 if(!e)throw Error('Event no longer exists');
 if(!c.writable())throw Error('Calendar is read-only');
 const before=snapshot(c,e,p.calendarId);
 if(!sameSnapshot(before,p.expectedSnapshot))throw Error('Event changed before write; read it again');
 if(before.recurrence && p.scope!=='series')throw Error('Recurring event requires explicit series scope');
 if(p.operation==='delete') {e.delete();app.save();return JSON.stringify({ok:true,deleted:find(c,p.eventId)===null});}
 if(p.operation!=='update')throw Error('Unsupported Calendar action');
 try {apply(e,p.changes);app.save();}
 catch(err) {
  try {apply(e,before);app.save();}catch(rollback){throw Error('Calendar update failed and rollback failed; reconcile event: '+String(err));}
  throw Error('Calendar update failed; original editable fields restored: '+String(err));
 }
 return JSON.stringify({ok:true,event:snapshot(c,e,p.calendarId)});
}
