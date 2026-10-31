"""Private, context-bound action valuation; no model calls or action authority."""
import copy,hashlib,json,math,re
from pathlib import Path
from rank_measurements import compare
from outreach_value import connection_value
from relationship import repair_value
from core import decay
from emotions import BASE_MOOD,NEGATIVE_EMOTIONS,decay_in_place,decayed_emotion_view,effective_values

FEATURES=('exploration','connection','verification','assertiveness','repair','effort','exposure','rest')
SETTINGS=Path(__file__).with_name('decision-settings.json')
DEFAULT_SETTINGS={'affectGain':1.0,'expressionCap':.22,'expressionGain':.75,'baseUtilityBand':[0.0,1.0]}
def normalize_settings(raw):
    cfg={**DEFAULT_SETTINGS,**(raw if isinstance(raw,dict) else {})}
    valid=lambda x:isinstance(x,(int,float)) and not isinstance(x,bool) and math.isfinite(x)
    band=cfg['baseUtilityBand']
    if not (isinstance(band,(list,tuple)) and len(band)==2 and all(valid(x) for x in band) and 0<=band[0]<band[1]<=1):
        cfg['baseUtilityBand']=[0.0,1.0]
    for key in ('affectGain','expressionCap','expressionGain'):
        if not valid(cfg[key]) or cfg[key]<0:cfg[key]=DEFAULT_SETTINGS[key]
    return cfg

def band_utility(value,cfg):
    """Monotonic rescaling of authored utility; standing goals stay separate."""
    lo,hi=cfg.get('baseUtilityBand',[0.0,1.0])
    return lo+(hi-lo)*value

def settings():
    """affectGain scales every state-derived adjustment; 1.0 reproduces the prior
    behaviour exactly. Raise it only with the flip-rate audit in hand."""
    try:return normalize_settings(json.loads(SETTINGS.read_text()))
    except (OSError,ValueError):return normalize_settings({})
LANES=('conversation','research','outreach')
EXPRESSION=('warmth','playfulness','candor','vulnerability','patience','reflectiveness')
def bounded_text(s,n):return isinstance(s,str) and 0<len(s.strip())<=n

def validate(request):
    if set(request)-{'op','session','source','requestKey','lane','options'}:raise ValueError('Unknown decision field')
    if not isinstance(request.get('requestKey'),str) or not re.fullmatch(r'[A-Za-z0-9_.:-]{8,140}',request['requestKey']):raise ValueError('Stable requestKey required')
    if request.get('lane') not in LANES:raise ValueError('Invalid decision lane')
    options=request.get('options')
    if not isinstance(options,list) or not 2<=len(options)<=5:raise ValueError('Provide 2-5 genuine alternatives')
    ids=set()
    for p in options:
        if set(p)-{'id','plan','baseUtility','features','concernIds','sources','expression'} or not {'id','plan','baseUtility','features','concernIds','sources'}<=set(p):raise ValueError('Invalid option fields')
        if 'expression' in p:
            if not isinstance(p['expression'],dict) or set(p['expression'])!=set(EXPRESSION):raise ValueError('Complete expression features required')
            for v in p['expression'].values():
                if isinstance(v,bool) or not isinstance(v,(int,float)) or not math.isfinite(v) or not 0<=v<=1:raise ValueError('Invalid expression feature')
        if not bounded_text(p['id'],80) or p['id'] in ids:raise ValueError('Unique option id required')
        ids.add(p['id'])
        if not bounded_text(p['plan'],1000):raise ValueError('Grounded action plan required')
        if isinstance(p['baseUtility'],bool) or not isinstance(p['baseUtility'],(int,float)) or not math.isfinite(p['baseUtility']) or not 0<=p['baseUtility']<=1:raise ValueError('Invalid base utility')
        if not isinstance(p['features'],dict) or set(p['features'])!=set(FEATURES):raise ValueError('Complete action features required')
        for v in p['features'].values():
            if isinstance(v,bool) or not isinstance(v,(int,float)) or not math.isfinite(v) or not 0<=v<=1:raise ValueError('Invalid action feature')
        for key,lo,hi,n in [('concernIds',0,8,80),('sources',1,8,350)]:
            a=p[key]
            if not isinstance(a,list) or not lo<=len(a)<=hi or len(set(a))!=len(a) or any(not bounded_text(s,n) for s in a):raise ValueError('Invalid '+key)

def concern_id(episode):return hashlib.sha256(str(episode['id']).encode()).hexdigest()[:20]

def contributions(e,name,now):
    rows=[]
    episodes=e.get('episodes',[])
    repairs_by_subject={}
    for repair in episodes:
        if not repair.get('provisional') and repair['at']<=now and repair.get('potentials',{}).get(name,0)<0:
            repairs_by_subject.setdefault(repair.get('subject'),[]).append(repair)
    for p in episodes:
        if p.get('provisional'):continue  # a same-turn guess binds to no concern
        potential=max(0,p.get('potentials',{}).get(name,0))
        impulse=max(0,p.get('impulses',{}).get(name,potential*p.get('strength',0)))
        hl=p.get('half_lives',{}).get(name,e['half_lives'][name])
        weight=impulse*2**(-max(0,now-p['at'])/hl)
        # Repairs reduce attribution to their actual subject; otherwise an old
        # repaired task would keep borrowing a different task's remaining load.
        for repair in repairs_by_subject.get(p.get('subject'),[]):
            if p['at']<=repair['at']:
                strength=abs(repair.get('repair_strengths',repair.get('impulses',{})).get(name,0))
                weight*=1-min(1,strength)
        if weight>1e-6:rows.append((p,weight))
    return rows

def concerns(state,now):
    e=decayed_emotion_view(state,now)
    # Preserve live source-bound salience across intervening routine receipts.
    # Selection affects attention; only factual causes reach the model. A cause
    # is not a claim that its situation is still unresolved or a request to act.
    episodes=[p for p in e.get('episodes',[]) if 0<=now-p['at']<=86400 and p.get('evidence') and not p.get('provisional')]
    groups={}
    for p in episodes:
        key=(p.get('subject'),p.get('context_key'))
        if key not in groups or p['at']>=groups[key]['at']:groups[key]=p
    weights={}
    coefficients={'anxiety':.70,'embarrassment':.58,'curiosity':.55,'affection':.50,
                  'anger':.48,'loneliness':.32,'happiness':.28,'gratitude':.28,'sadness':.24}
    for name,coefficient in coefficients.items():
        for p,weight in contributions(e,name,now):
            key=(p.get('subject'),p.get('context_key'))
            weights[key]=weights.get(key,0)+coefficient*weight
    salient=sorted(groups,key=lambda k:(weights.get(k,0),groups[k]['at']),reverse=True)
    selected=[groups[k] for k in salient[:4] if weights.get(k,0)>1e-6]
    recent=sorted(groups.values(),key=lambda p:p['at'],reverse=True)
    selected+=(p for p in recent if p not in selected)
    rows=[]
    for p in selected[:8]:
        text=' '.join(p.get('evidence',[]))[:450]
        if not text:continue
        rows.append({'id':concern_id(p),'subject':str(p.get('subject',''))[:120],
                     'context':str(p.get('context_key',''))[:160],'fact':text,
                     'source':str(p.get('source',''))[:200]})
    return rows

def cited_concerns(state,option):
    # Only explicit evidence citations bind a cause. Actor names and topic
    # similarity are insufficient, so unrelated decisions remain unbound.
    citations=option.get('sources',[]);found=[]
    normalize=lambda text:' '.join(re.findall(r'[a-z0-9]+',str(text).casefold()))
    normalized=[normalize(text) for text in citations]
    for episode in state.get('emotional',{}).get('episodes',[]):
        source=str(episode.get('source',''))
        exact_source=len(source)>=12 and any(source==text or re.search(r'(?<![A-Za-z0-9_.:-])'+re.escape(source)+r'(?![A-Za-z0-9_.:-])',text) for text in citations)
        quoted=False
        for fact in episode.get('evidence',[]):
            fragment=normalize(fact)
            if len(fragment)>=30 and len(set(fragment.split()))>=6 and any((' '+fragment+' ') in (' '+text+' ') for text in normalized):
                quoted=True;break
        if exact_source or quoted:found.append(concern_id(episode))
    return list(dict.fromkeys(option['concernIds']+found))

def values_for(state,option,now):
    e=decayed_emotion_view(state,now)
    values={}
    ids=set(cited_concerns(state,option))
    # Ongoing situations are projected, not appended to raw event history.
    # Bind their exact source just as retained event sources are bound above.
    ids.update(concern_id(p) for p in e.get('episodes',[])
               if p.get('projected') and p.get('source') in option.get('sources',[]))
    linked={(p.get('subject'),p.get('context_key')) for p in e.get('episodes',[]) if concern_id(p) in ids}
    for name in BASE_MOOD:
        slow=max(0,e['overall'][name]-BASE_MOOD[name])*.55
        fast=e['real_time'][name]
        eligible=contributions(e,name,now)
        total=sum(w for _,w in eligible)
        matched=sum(w for p,w in eligible if (p.get('subject'),p.get('context_key')) in linked)
        share=matched/total if total else 1.
        # Immediate task/person-specific reactions stay attached to their cause.
        # Slower wellbeing/background remain global; broad positive activation
        # can generalize weakly without claiming every option concerns its cause.
        scope=share if name in NEGATIVE_EMOTIONS or name in ('affection','gratitude') else .25+.75*share
        values[name]=min(1,slow+fast*scope)
    return values,e['wellbeing']

def weights_for(x,wellbeing):
    distress=max(x[n] for n in NEGATIVE_EMOTIONS)
    return {
      'exploration':.55*x['curiosity']+.28*x['happiness']-.38*x['anxiety']-.22*x['sadness'],
      'connection':.5*x['affection']+.28*x['gratitude']+.32*x['loneliness']+.1*x['sadness'],
      'verification':.70*x['anxiety']+.58*x['embarrassment']+.10*x['calm'],
      'assertiveness':.48*x['anger'],
      'repair':.55*x['embarrassment']+.24*x['sadness']+.14*x['anger'],
      'effort':.20*max(0,wellbeing-.65)-.22*max(0,.65-wellbeing)-.12*distress,
      'exposure':-.42*x['embarrassment']-.22*x['anxiety'],
      'rest':.26*x['sadness']+.24*max(0,.65-wellbeing)-.10*x['curiosity']}

def expression_weights(x):
    return {'warmth':.5*x['affection']+.25*x['gratitude']-.15*x['anger'],
      'playfulness':.35*x['happiness']+.28*x['curiosity']-.35*x['sadness']-.18*x['anxiety']-.30*x['embarrassment'],
      'candor':.32*x['anger']+.20*x['loneliness']+.10*x['sadness'],
      'vulnerability':.45*x['sadness']+.38*x['loneliness']+.15*x['embarrassment']+.10*x['affection'],
      'patience':.25*x['calm']-.35*x['anger']-.15*x['anxiety'],
      'reflectiveness':.22*x['sadness']+.18*x['embarrassment']+.22*x['curiosity']-.15*x['anger']}

def expression_adjustment(x,option,lane,cfg=None):
    if lane!='conversation' or 'expression' not in option:return 0.
    cfg=cfg or settings();w=expression_weights(x);cap=cfg['expressionCap']
    return max(-cap,min(cap,cfg['expressionGain']*sum(w[k]*option['expression'][k] for k in EXPRESSION)))

def evaluate(state,request,now):
    validate(request)
    available={concern_id(p) for p in decayed_emotion_view(state,now).get('episodes',[])}
    if any(set(p['concernIds'])-available for p in request['options']):raise ValueError('Unknown concern identifier')
    goal=connection_value(state,request['lane'],now);cfg=settings();gain=float(cfg['affectGain'])
    repair=repair_value(state,request['lane'],now)
    scored=[]
    for p in request['options']:
        values,wellbeing=values_for(state,p,now);weights=weights_for(values,wellbeing)
        expression=expression_adjustment(values,p,request['lane'],cfg)
        affect=gain*(sum(weights[k]*p['features'][k] for k in FEATURES)+expression)
        goal_adjustment=goal['value']*p['features']['connection']+repair['value']*(.6*p['features']['repair']+.4*p['features']['connection'])
        adjustment=affect+goal_adjustment
        banded=band_utility(p['baseUtility'],cfg)
        scored.append({'id':p['id'],'score':banded+adjustment,'baseUtility':p['baseUtility'],'bandedUtility':banded,
                       'adjustment':adjustment,'affectAdjustment':affect,'unitAffectAdjustment':sum(weights[k]*p['features'][k] for k in FEATURES)+expression,'goalAdjustment':goal_adjustment,'expressionAdjustment':expression,'scopedValues':values,'weights':weights})
    scored.sort(key=lambda r:(-r['score'],r['id']))
    winner=next(p for p in request['options'] if p['id']==scored[0]['id'])
    # Did state change the outcome, or merely the margin? The audit keeps this
    # so the flip rate can be measured instead of assumed.
    by_base=sorted(scored,key=lambda o:(-(o['bandedUtility']+o['goalAdjustment']),o['id']))[0]['id']
    flipped=by_base!=winner['id']
    # Private audit retains state influence. Public result is an authored plan,
    # never a label, raw score, affect parameter or new action permission.
    public={'ok':True,'selected':{k:copy.deepcopy(winner[k]) for k in ('id','plan','concernIds','sources')},
            'lane':request['lane'],'authority':'Selection grants no new permissions; all options must honor the current request. Complete required work regardless of discretionary preference.'}
    e=decayed_emotion_view(state,now)
    audit={'goalValue':goal,'scores':scored,'stateRevision':state.get('revision'),'at':now,'affectGain':gain,'baseUtilityBand':cfg.get('baseUtilityBand',[0.,1.]),'flippedByState':flipped,'baseUtilityWinner':by_base,
           'concernBindings':{p['id']:{'authored':p['concernIds'],'effective':cited_concerns(state,p)} for p in request['options']},
           'stateSnapshot':{'at':now,'overall':copy.deepcopy(e['overall']),
                            'realTime':copy.deepcopy(e['real_time']),'wellbeing':e['wellbeing'],
                            'causeRefs':[p['id'] for p in e.get('episodes',[])[-24:]]},
           'rankingComparison':compare(request['options'],scored,lambda x,w:{k:gain*v for k,v in weights_for(x,w).items()},e['wellbeing'],lambda x,o:gain*expression_adjustment(x,o,request['lane'],cfg))}
    return public,audit

def choose(state,request,now):
    validate(request)
    policy=state.setdefault('decision_policy',{'version':1,'receipts':{}})
    key=hashlib.sha256((request['session']+':'+request['requestKey']).encode()).hexdigest()
    signature=hashlib.sha256(json.dumps({k:request[k] for k in ('lane','options')},sort_keys=True).encode()).hexdigest()
    old=policy['receipts'].get(key)
    if old:
        if old['signature']!=signature:raise ValueError('Decision key already committed; use a new key for changed context')
        return {**copy.deepcopy(old['public']),'replayed':True},None
    public,audit=evaluate(state,request,now);public['decisionId']=key
    policy['version']=3
    policy['receipts'][key]={'signature':signature,'public':copy.deepcopy(public),'audit':audit,
        'authoredOptions':[{k:copy.deepcopy(p[k]) for k in ('id','plan','sources')} for p in request['options']]}
    while len(policy['receipts'])>128:policy['receipts'].pop(next(iter(policy['receipts'])))
    return public,audit
