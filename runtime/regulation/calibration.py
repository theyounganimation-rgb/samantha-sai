"""Delayed aggregate feedback and sourced lessons; no affect writes/model calls."""
import copy,datetime,hashlib,json,math,re
from collections import Counter
from emotions import NAMES
DAY=86400;WEEK=7*DAY;MIN_SAMPLES=12;MIN_DAYS=3;MIN_COMPONENT=5
def stamp(t):return datetime.datetime.fromtimestamp(t,datetime.timezone.utc).isoformat()
def store(state,now):
 model=state.setdefault('self_model',{'version':1,'assessments':{}});model.setdefault('assessments',{})
 return model.setdefault('calibration',{'version':1,'startedAt':now,'lastMeasurementAt':now,'samples':{},'reports':{},'lessons':{}})
def measurement_seen(state,now):store(state,now)['lastMeasurementAt']=now
def add_sample(state,ident,prediction,truth,now):
 c=store(state,now)
 if ident in c['samples']:return
 reasons=[]
 if now-c.get('lastMeasurementAt',now)<7200:reasons.append('recent-shared-measurement')
 eligible=[r for r in c['samples'].values() if r['eligible']]
 day=int(now//DAY);today=[r for r in eligible if int(r['at']//DAY)==day]
 if len(today)>=2:reasons.append('daily-sample-cap')
 previous=max(eligible,key=lambda r:r['at']) if eligible else None
 if previous:
  if now-previous['at']<1800:reasons.append('too-close-to-previous-sample')
  if not set(prediction['sources'])-set(previous['sources']):reasons.append('no-new-activity-evidence')
 if not prediction['sources']:reasons.append('no-activity-evidence')
 c['samples'][ident]={'at':now,'eligible':not reasons,'reasons':reasons,'sources':prediction['sources'][:8],
  'confidence':prediction['confidence'],'overall':prediction['overall'],'emotions':copy.deepcopy(prediction['emotions']),
  'truthOverall':truth['overall']['wellbeing'],'truthEmotions':{r['emotion']:r['intensity'] for r in truth['current']['emotions']}}
 ineligible=[key for key,row in c['samples'].items() if not row['eligible']]
 for key in ineligible[:-128]:c['samples'].pop(key)
 while len(c['samples'])>1024:c['samples'].pop(next(iter(c['samples'])))
def rate(hits,total):return round(hits/total,3) if total>=MIN_COMPONENT else None
def component(hits,total):return {'attempts':total,'correct':hits if total>=MIN_COMPONENT else None,'accuracy':rate(hits,total)}
def aggregate(rows,training):
 totals=Counter();by_name={};bins={'low':[],'medium':[],'high':[]}
 for r in rows:
  overall=r['overall']!='uncertain';guesses=r['emotions'];truth=r['truthEmotions'];named={g['emotion']:g['intensity'] for g in guesses}
  totals['overallAnswered']+=overall;totals['overallCorrect']+=overall and r['overall']==r['truthOverall']
  definite=[]
  for g in guesses:
   name=g['emotion'];actual=truth.get(name,'absent');strength=g['intensity'];known=strength!='uncertain'
   totals['labels']+=1;totals['present']+=name in truth;totals['bands']+=known;totals['bandCorrect']+=known and strength==actual;totals['uncertainBands']+=not known
   if known:
    definite.append(strength==actual);b=by_name.setdefault(name,Counter());b['attempts']+=1;b['correct']+=strength==actual;b['understated']+=actual in ('strong','intense') and strength not in ('strong','intense');b['overstated']+=strength in ('strong','intense') and actual not in ('strong','intense')
  substantial={n for n,v in truth.items() if v in ('strong','intense')};recognised={n for n in substantial if named.get(n) in ('strong','intense')}
  totals['substantial']+=len(substantial);totals['recognised']+=len(recognised)
  if overall or definite:
   matched=(not overall or r['overall']==r['truthOverall']) and all(definite)
   bins['low' if r['confidence']<.4 else 'high' if r['confidence']>=.7 else 'medium'].append((r['confidence'],matched))
 baseline={'available':False,'meaning':'Previous-period majority bands evaluated on the same committed claims; not a uniform random-chance estimate.'}
 if len(training)>=MIN_SAMPLES and len({int(r['at']//DAY) for r in training})>=MIN_DAYS:
  mode=lambda values:Counter(values).most_common(1)[0][0]
  typical_overall=mode(r['truthOverall'] for r in training);typical={name:mode(r['truthEmotions'].get(name,'absent') for r in training) for name in NAMES}
  b_over=sum(r['overall']!='uncertain' and r['truthOverall']==typical_overall for r in rows)
  b_band=sum(g['intensity']!='uncertain' and r['truthEmotions'].get(g['emotion'],'absent')==typical[g['emotion']] for r in rows for g in r['emotions'])
  baseline.update(available=True,overallAccuracy=rate(b_over,totals['overallAnswered']),intensityAccuracy=rate(b_band,totals['bands']))
 return {'samples':len(rows),'distinctDays':len({int(r['at']//DAY) for r in rows}),
  'overall':{**component(totals['overallCorrect'],totals['overallAnswered']),'uncertain':len(rows)-totals['overallAnswered']},
  'current':{'labelPresence':component(totals['present'],totals['labels']),'intensity':component(totals['bandCorrect'],totals['bands']),'uncertainIntensities':totals['uncertainBands'],
             'substantialRecognition':{'examples':totals['substantial'] if totals['substantial']>=MIN_COMPONENT else '<5','recognised':totals['recognised'] if totals['substantial']>=MIN_COMPONENT else None,'rate':rate(totals['recognised'],totals['substantial'])}},
  'patterns':[{'emotion':name,**component(v['correct'],v['attempts']),'understatedSubstantial':v['understated'],'overstatedSubstantial':v['overstated']} for name,v in sorted(by_name.items()) if v['attempts']>=MIN_COMPONENT],
  'confidence':[{'band':name,'examples':len(values),'meanDeclaredConfidence':round(sum(v[0] for v in values)/len(values),3),'structuredAgreement':round(sum(v[1] for v in values)/len(values),3)} for name,values in bins.items() if len(values)>=MIN_COMPONENT],
  'baseline':baseline}
def review(state,now):
 c=store(state,now);start=c.get('lastReviewedEnd',c['startedAt']);steps=math.floor((now-c['startedAt']-DAY)/WEEK);end=c['startedAt']+max(0,steps)*WEEK
 rows=[r for r in c['samples'].values() if r['eligible'] and start<=r['at']<end]
 days=len({int(r['at']//DAY) for r in rows});latest=c.get('latestReportId');report=c['reports'].get(latest)
 if end>start and len(rows)>=MIN_SAMPLES and days>=MIN_DAYS:
  training=[r for r in c['samples'].values() if r['eligible'] and r['at']<start]
  excluded=Counter(reason for r in c['samples'].values() if start<=r['at']<end and not r['eligible'] for reason in r['reasons'])
  summary=aggregate(rows,training);ident=hashlib.sha256(json.dumps({'start':start,'end':end,'summary':summary},sort_keys=True).encode()).hexdigest()
  report={'kind':'weekly_self_calibration','reportId':ident,'period':{'from':stamp(start),'to':stamp(end)},'releasedAt':stamp(now),**summary,
          'excluded':dict(excluded),'limits':'Historical aggregate only. No individual answers or current state are returned. Self-selected observations and confidence estimates are not independent proof of skill or calibrated probabilities. Component scores need at least five claims; fewer are withheld. Missing substantial reactions count separately from label hits.'}
  c['reports'][ident]=report;c['latestReportId']=ident;c['lastReviewedEnd']=end
  while len(c['reports'])>32:c['reports'].pop(next(iter(c['reports'])))
 pending=[r for r in c['samples'].values() if r['eligible'] and r['at']>=c.get('lastReviewedEnd',c['startedAt'])]
 attempts_today=sum(int(r['at']//DAY)==int(now//DAY) for r in c['samples'].values())
 latest_attempt=max((r['at'] for r in c['samples'].values()),default=0)
 time_gate=max(c.get('lastMeasurementAt',now)+7200,latest_attempt+1800)
 return {'status':'available' if report else 'collecting','report':copy.deepcopy(report),
         'practice':{'attemptsToday':attempts_today,'remainingDailyAttempts':max(0,2-attempts_today),'permittedBySpacing':now>=time_gate and attempts_today<2,'nextTimeGateAt':stamp(time_gate)},
         'pending':{'eligibleSamples':len(pending),'distinctDays':len({int(r['at']//DAY) for r in pending}),'minimumSamples':MIN_SAMPLES,'minimumDays':MIN_DAYS,'delayHours':24,'nextWindowCloses':stamp(c['startedAt']+(max(0,steps)+1)*WEEK+DAY)},
         'lessons':[copy.deepcopy(r['public']) for r in list(c['lessons'].values())[-3:]]}
def learn(state,request,now):
 c=store(state,now);key=request.get('requestKey');note=request.get('note');report_id=request.get('reportId');confidence=request.get('confidence')
 if not isinstance(key,str) or not re.fullmatch(r'[A-Za-z0-9_.:-]{8,140}',key):raise ValueError('Use a stable requestKey for a lesson')
 if not isinstance(note,str) or not 1<=len(note.strip())<=700:raise ValueError('Use a brief revisable lesson grounded in the aggregate review')
 if isinstance(confidence,bool) or not isinstance(confidence,(int,float)) or not math.isfinite(confidence) or not 0<=confidence<=1:raise ValueError('Use confidence between 0 and 1')
 if not isinstance(report_id,str) or report_id not in c['reports']:raise ValueError('A released reportId from this self-view scope is required')
 ident=hashlib.sha256((request['session']+':'+key).encode()).hexdigest();signature=hashlib.sha256(json.dumps({'note':note,'confidence':confidence,'reportId':report_id},sort_keys=True).encode()).hexdigest();old=c['lessons'].get(ident)
 if old:
  if old['signature']!=signature:raise ValueError('Lesson key already committed; use a new key for a revision')
  return {'ok':True,'recorded':True,'lessonId':ident,'replayed':True}
 from behavior_view import clean
 public={'at':stamp(now),'lessonId':ident,'reportId':report_id,'note':clean(note,700),'confidence':confidence,'meaning':'authored revisable lesson from historical aggregate feedback, not a current emotion or new event'}
 c['lessons'][ident]={'signature':signature,'public':public}
 while len(c['lessons'])>16:c['lessons'].pop(next(iter(c['lessons'])))
 return {'ok':True,'recorded':True,'lessonId':ident}
