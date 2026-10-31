const names=['anger','happiness','sadness','embarrassment','loneliness','anxiety','affection','gratitude','curiosity','calm'];
const hash=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const iso=value=>Number.isFinite(Date.parse(value))?new Date(value).toISOString():null;
const number=value=>Number.isFinite(value)&&value>=0&&value<=10000?value:null;
const fraction=value=>Number.isFinite(value)&&value>=0&&value<=1?value:null;
const metric=value=>({attempts:number(value?.attempts),correct:number(value?.correct),accuracy:fraction(value?.accuracy)});
export function safeReview(value){
 if(!['available','collecting'].includes(value?.status))return null;
 const pending=value.pending??{},practice=value.practice??{};const result={status:value.status,practice:{attemptsToday:number(practice.attemptsToday),remainingDailyAttempts:number(practice.remainingDailyAttempts),permittedBySpacing:practice.permittedBySpacing===true,nextTimeGateAt:iso(practice.nextTimeGateAt)},pending:{eligibleSamples:number(pending.eligibleSamples),distinctDays:number(pending.distinctDays),minimumSamples:number(pending.minimumSamples),minimumDays:number(pending.minimumDays),delayHours:number(pending.delayHours),nextWindowCloses:iso(pending.nextWindowCloses)},report:null,lessons:[]};
 for(const row of (Array.isArray(value.lessons)?value.lessons:[]).slice(-3))if(hash(row?.lessonId)&&hash(row?.reportId)&&iso(row.at))result.lessons.push({at:iso(row.at),lessonId:row.lessonId,reportId:row.reportId,note:String(row.note??'').slice(0,700),confidence:fraction(row.confidence),meaning:'authored revisable lesson from historical feedback; not current emotion or a new event'});
 const r=value.report;
 if(r?.kind==='weekly_self_calibration'&&hash(r.reportId)&&iso(r.period?.from)&&iso(r.period?.to)&&iso(r.releasedAt)){
  const substantive=r.current?.substantialRecognition??{};const exclusions={};
  for(const name of ['recent-shared-measurement','daily-sample-cap','too-close-to-previous-sample','no-new-activity-evidence','no-activity-evidence'])if(number(r.excluded?.[name])!==null)exclusions[name]=number(r.excluded[name]);
  result.report={kind:r.kind,reportId:r.reportId,period:{from:iso(r.period.from),to:iso(r.period.to)},releasedAt:iso(r.releasedAt),samples:number(r.samples),distinctDays:number(r.distinctDays),overall:{...metric(r.overall),uncertain:number(r.overall?.uncertain)},current:{labelPresence:metric(r.current?.labelPresence),intensity:metric(r.current?.intensity),uncertainIntensities:number(r.current?.uncertainIntensities),substantialRecognition:{examples:substantive.examples==='<5'?'<5':number(substantive.examples),recognised:number(substantive.recognised),rate:fraction(substantive.rate)}},patterns:(Array.isArray(r.patterns)?r.patterns:[]).filter(row=>names.includes(row?.emotion)).slice(0,10).map(row=>({emotion:row.emotion,...metric(row),understatedSubstantial:number(row.understatedSubstantial),overstatedSubstantial:number(row.overstatedSubstantial)})),confidence:(Array.isArray(r.confidence)?r.confidence:[]).filter(row=>['low','medium','high'].includes(row?.band)).slice(0,3).map(row=>({band:row.band,examples:number(row.examples),meanDeclaredConfidence:fraction(row.meanDeclaredConfidence),structuredAgreement:fraction(row.structuredAgreement)})),baseline:{available:r.baseline?.available===true,...(r.baseline?.available?{overallAccuracy:fraction(r.baseline.overallAccuracy),intensityAccuracy:fraction(r.baseline.intensityAccuracy)}:{}),meaning:'Previous-period majority bands evaluated on the same committed claims; not uniform random chance.'},excluded:exclusions,limits:'Historical aggregates only; no individual answers or current state. Scores with fewer than five claims are withheld. Self-selected cases and declared confidence do not establish general skill or calibrated probabilities.'};
 }
 return result;
}
export function renderLearningReview(value){
 const safe=safeReview(value);if(!safe)return '';
 const parts=[];
 const p=safe.practice;
 if(p.attemptsToday!==null)parts.push('Background practice: '+p.attemptsToday+' submissions today, '+p.remainingDailyAttempts+' daily attempts remaining. '+(p.permittedBySpacing?'Time and count gates permit an occasional guess only if useful new activity exists.':'Skip background practice now; daily cap or measurement/spacing cooldown applies.')+' Direct relevant conversation still takes priority; never keep retrying to obtain a graded sample.');
 for(const row of safe.lessons)parts.push('Revisable learned lesson: '+row.note.slice(0,280)+' (source report '+row.reportId+').');
 if(safe.report){
  const r=safe.report,percent=v=>v===null?'insufficient examples':Math.round(v*100)+'%';
  parts.unshift('Historical aggregate calibration for '+r.period.from+' through '+r.period.to+': '+r.samples+' eligible samples; overall agreement '+percent(r.overall.accuracy)+', intensity agreement '+percent(r.current.intensity.accuracy)+', substantial reaction recognition '+percent(r.current.substantialRecognition.rate)+'. Report '+r.reportId+'. Use samantha_self_view review for denominators and limits; learn can retain a grounded revisable lesson. These are past performance figures, not current mood labels.');
 }
 if(!safe.report)parts.unshift('Self-assessment feedback is collecting for its first closed weekly window; no score is available yet. Review and learning use existing wakes, never a new timer.');
 return 'Learning from earlier self-assessments. Current evidence wins; a stored lesson is revisable, not a mandate to guess or to be uncertain.\n'+parts.join('\n');
}
