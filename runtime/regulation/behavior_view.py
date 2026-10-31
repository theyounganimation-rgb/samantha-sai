"""Factual activity and provisional self-model. No affect write or model call."""
import copy, datetime, hashlib, json, math, re
from emotions import NAMES

STRENGTHS=('trace','mild','moderate','strong','intense','uncertain')
OVERALL=('low','strained','steady','good','uncertain')
WINDOW=7200
def stamp(at):return datetime.datetime.fromtimestamp(at,datetime.timezone.utc).isoformat()
def clean(value,limit=400):
    text=str(value)
    if re.search(r'(?i)(api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|password|client[_-]?secret)\s*[=:]\s*[^\s]{6,}|-----BEGIN .*PRIVATE KEY',text):
        return '[Sensitive payload omitted]'
    return text[:limit]

def activity_view(state,rows,now):
    choices=[]
    for key,receipt in state.get('decision_policy',{}).get('receipts',{}).items():
        at=receipt.get('audit',{}).get('at',0)
        if not isinstance(at,(int,float)) or not math.isfinite(at) or not -2<=now-at<=WINDOW:continue
        public=receipt.get('public',{});selected=public.get('selected',{})
        if not selected.get('plan'):continue
        alternatives=[]
        for option in receipt.get('authoredOptions',[]):
            if option.get('id')==selected.get('id'):continue
            alternatives.append({'id':clean(option.get('id',''),80),'plan':clean(option.get('plan',''),260)})
        choices.append({'evidenceId':'choice:'+key,'at':stamp(at),'lane':public.get('lane','conversation'),
            'selectedPlan':clean(selected['plan'],380),'otherAuthoredPlans':alternatives[:4],
            'sources':[clean(s,140) for s in selected.get('sources',[])[:3]],
            'completion':'selected only; completion is not established by this receipt'})
    choices.sort(key=lambda c:c['at']);choices=choices[-4:]
    outcomes=[];replies=[]
    for row in sorted(rows,key=lambda r:r.get('created',0)):
        at=row.get('created',0)
        if not isinstance(at,(int,float)) or not math.isfinite(at) or not -2<=now-at<=WINDOW:continue
        if row.get('kind') not in ('tool_observation','assistant_report'):continue
        text=clean(row.get('text',''),600)
        # Sensor access and self-model bookkeeping are not accomplishments.
        if re.search(r'Tool [^;\n]*samantha_(?:choice|self_view)\b',text):continue
        evidence={'evidenceId':'event:'+str(row.get('id','')),'at':stamp(at),
            'source':clean(row.get('source',''),180),'text':text}
        if row['kind']=='tool_observation':
            evidence['status']='failure' if '\nStatus: failure' in text else 'returned'
            outcomes.append(evidence)
        else:
            evidence['meaning']='authored reply; not independent confirmation of activities it claims'
            replies.append(evidence)
    outcomes=outcomes[-4:];replies=replies[-2:]
    previous=None
    assessments=state.get('self_model',{}).get('assessments',{})
    records=[r['public'] for r in assessments.values() if 0<=now-r.get('at',0)<=WINDOW]
    if records:
        record=max(records,key=lambda r:r['at'])
        previous={'at':stamp(record['at']),'note':clean(record['note'],300),
                  'meaning':'previous authored interpretation, not a new event or measured current state'}
    return {'kind':'behavioral_self_view','version':1,'asOf':stamp(now),
        'choices':choices,'observedToolOutcomes':outcomes,'authoredReplies':replies,
        'previousInterpretation':previous,'sourceIds':[r['evidenceId'] for r in choices+outcomes+replies],
        'limits':'Chosen plans and returned tools do not by themselves prove completed work or delivery. Temporal proximity is not a causal link. Behavior supports a tentative interpretation, not an exact emotion or intensity measurement.'}

def record_assessment(state,request,view,now,truth):
    key=request.get('requestKey','')
    if not isinstance(key,str) or not re.fullmatch(r'[A-Za-z0-9_.:-]{8,140}',key):raise ValueError('A stable requestKey is required for reflect')
    note=request.get('note','')
    if not isinstance(note,str) or not 1<=len(note.strip())<=700:raise ValueError('Provide a brief authored interpretation, not a reasoning transcript')
    confidence=request.get('confidence')
    if isinstance(confidence,bool) or not isinstance(confidence,(int,float)) or not math.isfinite(confidence) or not 0<=confidence<=1:raise ValueError('Confidence must be between 0 and 1')
    overall=request.get('overall')
    if overall not in OVERALL:raise ValueError('Use a valid wellbeing band or uncertain')
    emotions=request.get('emotions')
    if not isinstance(emotions,list) or len(emotions)>4:raise ValueError('At most four provisional emotions; [] means uncertain')
    names=set()
    for item in emotions:
        if not isinstance(item,dict) or set(item)!={'emotion','intensity'} or item['emotion'] not in NAMES or item['intensity'] not in STRENGTHS or item['emotion'] in names:
            raise ValueError('Use distinct supported emotion names and qualitative intensity or uncertain')
        names.add(item['emotion'])
    sources=request.get('sources')
    if not isinstance(sources,list) or len(sources)>8 or any(not isinstance(x,str) or len(x)>100 for x in sources) or len(set(sources))!=len(sources):raise ValueError('Use up to eight distinct evidenceIds from the activity view')
    if not sources and (emotions or overall!='uncertain' or confidence>.25):raise ValueError('No activity evidence: retain uncertainty instead of asserting a state')
    ident=hashlib.sha256((request['session']+':'+key).encode()).hexdigest()
    fields={k:request[k] for k in ('requestKey','note','confidence','overall','emotions','sources')}
    signature=hashlib.sha256(json.dumps(fields,sort_keys=True).encode()).hexdigest()
    model=state.setdefault('self_model',{'version':1,'assessments':{}})
    old=model['assessments'].get(ident)
    if old:
        if old['signature']!=signature:raise ValueError('Assessment key already committed; use a new key for a revised interpretation')
        return {'ok':True,'recorded':True,'assessmentId':ident,'replayed':True,'comparison':'retained privately; emotional state unchanged'}
    if set(sources)-set(view['sourceIds']):raise ValueError('Use exact current activity evidenceIds; unsupported sources cannot ground a self-assessment')
    public={'at':now,'note':clean(note,700),'confidence':confidence,'overall':overall,
            'emotions':copy.deepcopy(emotions),'sources':list(sources)}
    measured={r['emotion']:r['intensity'] for r in truth['current']['emotions']}
    comparison={'overallMatches':None if overall=='uncertain' else overall==truth['overall']['wellbeing'],
        'guesses':[{'emotion':r['emotion'],'presentInMeasurement':r['emotion'] in measured,
                   'intensityMatches':None if r['intensity']=='uncertain' else measured.get(r['emotion'])==r['intensity']} for r in emotions]}
    model['assessments'][ident]={'at':now,'signature':signature,'public':public,
        'audit':{'measurement':copy.deepcopy(truth),'comparison':comparison}}
    from calibration import add_sample
    add_sample(state,ident,public,truth,now)
    while len(model['assessments'])>32:model['assessments'].pop(next(iter(model['assessments'])))
    return {'ok':True,'recorded':True,'assessmentId':ident,'comparison':'retained privately; emotional state unchanged'}
