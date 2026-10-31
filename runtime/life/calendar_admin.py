"""Owner-authorized existing event actions, independent of Samantha plan ownership."""
import datetime as dt
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
from zoneinfo import ZoneInfo

SCRIPT=Path(__file__).with_name('calendar-actions.js')
OPS={'calendar_access','calendar_search','calendar_event','update_event','delete_event'}
EDITABLE={'title','start','end','allDay','location','notes','url'}

def native(request):
 from calendar_recovery import execute
 return execute(request,SCRIPT)

def digest(value):
 return hashlib.sha256(json.dumps(value,sort_keys=True,separators=(',',':'),ensure_ascii=False).encode()).hexdigest()

def revision(event):
 return {**event,'revision':digest(event)} if event else None

def normalize_changes(p,event):
 changes=p.get('changes')
 if not isinstance(changes,dict) or not changes or set(changes)-EDITABLE:raise ValueError('changes must contain supported event fields')
 out={}
 for k in ('title','location','notes','url'):
  if k in changes:
   v=changes[k];limit={'title':250,'location':1000,'notes':20000,'url':4000}[k]
   if not isinstance(v,str) or len(v)>limit or (k=='title' and not v.strip()):raise ValueError('Invalid '+k)
   out[k]=v
 if 'allDay' in changes and type(changes['allDay']) is not bool:raise ValueError('allDay must be boolean')
 all_day=changes.get('allDay',event['allDay'])
 if 'allDay' in changes and all_day!=event['allDay'] and not all(k in changes for k in ('start','end')):raise ValueError('Changing all-day mode requires explicit start and end')
 if 'allDay' in changes:out['allDay']=all_day
 zone=ZoneInfo(p.get('timeZone','America/Chicago'))
 for k in ('start','end'):
  if k not in changes:continue
  if all_day:
   value=dt.datetime.combine(dt.date.fromisoformat(changes[k]),dt.time(),zone)
  else:
   value=dt.datetime.fromisoformat(changes[k].replace('Z','+00:00'))
   if value.tzinfo is None:raise ValueError('Timed dates need explicit UTC offsets')
  # Calendar.app persists whole seconds; normalize before write/readback.
  out[k+'Epoch']=value.replace(microsecond=0).timestamp()-(1 if all_day and k=='end' else 0)
 start=out.get('startEpoch',event['startEpoch']);end=out.get('endEpoch',event['endEpoch'])
 if end<=start:raise ValueError('Event end must follow start; all-day end is exclusive YYYY-MM-DD')
 return out

def matches(event,changes):
 return all(abs(event.get(k,0)-v)<0.01 if k.endswith('Epoch') else event.get(k)==v for k,v in changes.items())

def dispatch(p,*,config,catalog,root,atomic,source_lookup,script=native):
 op=p['operation']; cfg=config()
 if op in ('update_event','delete_event') and not (cfg.get('calendarWritesEnabled') and cfg.get('calendarExistingEventsEnabled')):raise ValueError('Existing calendar event actions are not enabled')
 calendars=catalog().get('calendars',[])
 base={'calendars':calendars}
 if op=='calendar_access':return script({**base,'operation':'access'})
 if op=='calendar_search':
  query=p.get('query','');cid=p.get('calendarId')
  if cid and not any(c['id']==cid for c in calendars):raise ValueError('Unknown calendarId')
  if not isinstance(query,str) or len(query)>250:raise ValueError('Invalid calendar query')
  req={**base,'operation':'search','query':query,'calendarId':cid,'limit':min(60,max(1,int(p.get('limit',30))))}
  if not query or 'start' in p or 'end' in p:
   if not all(k in p for k in ('start','end')):raise ValueError('Both search start and end are required')
   start,end=(dt.datetime.fromisoformat(p[k].replace('Z','+00:00')) for k in ('start','end'))
   if start.tzinfo is None or end.tzinfo is None or not 0<(end-start).total_seconds()<=31*86400:raise ValueError('Search needs a title query or offset dates within 31 days')
   req.update(startEpoch=start.timestamp(),endEpoch=end.timestamp())
  title_match=p.get('titleMatch','contains')
  if title_match not in ('contains','exact'):raise ValueError('titleMatch must be contains or exact')
  if 'recurringOnly' in p and type(p['recurringOnly']) is not bool:raise ValueError('recurringOnly must be boolean')
  req['titleMatch']=title_match
  if 'recurringOnly' in p:req['recurringOnly']=p['recurringOnly']
  result=script(req);result['events']=[revision(e) for e in result['events']];return result
 cid,eid=p.get('calendarId'),p.get('eventId')
 if not isinstance(eid,str) or not eid or len(eid)>512:raise ValueError('Exact eventId from calendar_search is required')
 cal=next((c for c in calendars if c['id']==cid),None)
 if not cal:raise ValueError('Unknown calendarId')
 req={**base,'calendarId':cid,'eventId':eid}
 if op=='calendar_event':
  result=script({**req,'operation':'get'});result['event']=revision(result['event']);return result
 if op not in ('update_event','delete_event'):raise ValueError('Unsupported calendar operation')
 if p.get('confirmed') is not True:raise ValueError('Clear confirmed intent is required')
 if not cal.get('writable'):raise ValueError('Calendar is read-only')
 key=p.get('requestKey','');reason=p.get('reason','')
 if not re.fullmatch(r'[A-Za-z0-9_.:-]{8,180}',key):raise ValueError('Stable requestKey required')
 if not isinstance(reason,str) or not reason.strip() or len(reason)>2000:raise ValueError('Concise reason with owner intent or confirmed context required')
 for source in p.get('sources',[]):
  msg=source_lookup(source.get('guid',''));quote=source.get('quote','')
  if not msg or not isinstance(quote,str) or not quote.strip() or quote not in msg.get('text',''):raise ValueError('Source quote does not match a real message')
 signature=digest({k:v for k,v in p.items() if k!='expectedRevision'})
 ledger_path=Path(root)/'calendar-actions.json';ledger=json.loads(ledger_path.read_text()) if ledger_path.exists() else {}
 old=ledger.get(key)
 if old:
  if old['signature']!=signature:raise ValueError('requestKey was already used for a different action')
  current=script({**req,'operation':'get'})['event']
  return {**old['receipt'],'action':'already_applied','currentEvent':revision(current),'currentMatchesReceipt':digest(current)==old.get('afterDigest'),'receiptIsHistorical':True}
 current=script({**req,'operation':'get'})['event']
 if not current:raise ValueError('Event no longer exists')
 if p.get('expectedRevision')!=digest(current):raise ValueError('Stale event revision; fetch calendar_event before changing it')
 scope=p.get('scope','event')
 if scope not in ('event','series'):raise ValueError('scope must be event or series')
 if current.get('recurrence') and scope!='series':raise ValueError('Recurring event requires explicit series scope; individual occurrence editing is unavailable through this tool')
 changes=normalize_changes(p,current) if op=='update_event' else {}
 result=script({**req,'operation':'update' if op=='update_event' else 'delete','expectedSnapshot':current,'scope':scope,'changes':changes})
 after=script({**req,'operation':'get'})['event']
 if op=='delete_event' and after is not None:raise RuntimeError('Calendar deletion was not verified; reconcile the event')
 if op=='update_event':
  untouched={'title','location','notes','url','startEpoch','endEpoch','allDay','recurrence','excludedDates'}-set(changes)
  if not after or not matches(after,changes) or any(after[k]!=current[k] for k in untouched):raise RuntimeError('Calendar update readback differs; reconcile event before claiming success')
 receipt={'ok':True,'action':'updated' if after else 'deleted','eventId':eid,'calendarId':cid,'readBackVerified':True,'event':revision(after),'scope':scope,'requestKey':key,'verifiedAt':dt.datetime.now(dt.timezone.utc).isoformat()}
 ledger[key]={'signature':signature,'beforeRevision':digest(current),'afterDigest':digest(after),'reason':reason,'receipt':receipt}
 atomic(ledger_path,ledger)
 return receipt
