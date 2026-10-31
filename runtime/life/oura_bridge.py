"""Read-only Oura V2 feed. Credentials remain in a separate private store."""
import concurrent.futures as futures
import contextlib
import datetime as dt
import fcntl
import grp
import hashlib
import json
import os
from pathlib import Path
import secrets
import ssl
import time
import urllib.error
import urllib.parse
import urllib.request
from zoneinfo import ZoneInfo

PRIVATE=Path(os.environ['SAI_OURA_PRIVATE_DIR'])
SHARED=Path(os.environ['SAI_OURA_SHARED_DIR'])
TOKEN_URL='https://api.ouraring.com/oauth/token'
AUTH_URL='https://cloud.ouraring.com/oauth/authorize'
API='https://api.ouraring.com/v2/usercollection/'
SCOPES='daily heartrate workout spo2'
REDIRECT='http://localhost:18497/callback'
COLLECTIONS={'daily_sleep':'daily','sleep':'daily','daily_readiness':'daily','daily_activity':'daily','daily_stress':'daily','daily_spo2':'spo2','workout':'workout','heartrate':'heartrate'}

def now_iso():return dt.datetime.now(dt.timezone.utc).isoformat()
def read(path,default=None):
    try:return json.loads(path.read_text())
    except FileNotFoundError:return default
def atomic(path,value,shared=False):
    path.parent.mkdir(parents=True,exist_ok=True,mode=0o750 if shared else 0o700)
    if shared:os.chown(path.parent,-1,grp.getgrnam('samantha-life').gr_gid);os.chmod(path.parent,0o750)
    tmp=path.with_name(path.name+'.'+secrets.token_hex(8)+'.tmp')
    fd=os.open(tmp,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o640 if shared else 0o600)
    try:
        with os.fdopen(fd,'w') as f:json.dump(value,f);f.flush();os.fsync(f.fileno())
        if shared:os.chown(tmp,-1,grp.getgrnam('samantha-life').gr_gid)
        os.replace(tmp,path)
    finally:
        if tmp.exists():tmp.unlink()

@contextlib.contextmanager
def locked():
    PRIVATE.mkdir(parents=True,exist_ok=True,mode=0o700)
    fd=os.open(PRIVATE/'feed.lock',os.O_RDWR|os.O_CREAT,0o600)
    try:fcntl.flock(fd,fcntl.LOCK_EX);yield
    finally:os.close(fd)

class APIError(Exception):
    def __init__(self,status):self.status=status;super().__init__('Oura HTTP '+str(status))

def request(url,token=None,form=None):
    if not url.startswith('https://api.ouraring.com/'):raise ValueError('Unsupported Oura host')
    headers={'Accept':'application/json'}
    if token:headers['Authorization']='Bearer '+token
    data=None
    if form is not None:
        headers['Content-Type']='application/x-www-form-urlencoded';data=urllib.parse.urlencode(form).encode()
    req=urllib.request.Request(url,data=data,headers=headers)
    try:
        with urllib.request.urlopen(req,timeout=8,context=ssl.create_default_context(cafile='/etc/ssl/cert.pem')) as response:
            raw=response.read(4000001)
            if len(raw)>4000000:raise ValueError('Oura response exceeds bounded cache size')
            return json.loads(raw)
    except urllib.error.HTTPError as e:raise APIError(e.code) from None
    except (urllib.error.URLError,TimeoutError):raise RuntimeError('Oura network request unavailable') from None

def configure(client_id,client_secret):
    if not all(isinstance(v,str) and 5<=len(v.strip())<=500 for v in [client_id,client_secret]):raise ValueError('Enter the application client ID and secret from Oura')
    with locked():
        old=read(PRIVATE/'credentials.json',{})
        if old.get('client_id')!=client_id.strip():old={}
        old.update(client_id=client_id.strip(),client_secret=client_secret.strip())
        atomic(PRIVATE/'credentials.json',old)

def begin_authorization():
    import base64
    with locked():
        c=read(PRIVATE/'credentials.json',{})
        if not c.get('client_secret'):raise ValueError('Configure the Oura application first')
        state=secrets.token_urlsafe(32);verifier=secrets.token_urlsafe(48)
        atomic(PRIVATE/'oauth-pending.json',{'state':state,'verifier':verifier,'createdAt':time.time()})
        params={'response_type':'code','client_id':c['client_id'],'redirect_uri':REDIRECT,'scope':SCOPES,'state':state,
                'code_challenge':base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).decode().rstrip('='),'code_challenge_method':'S256'}
        return AUTH_URL+'?'+urllib.parse.urlencode(params)

def finish_authorization(params):
    with locked():
        pending=read(PRIVATE/'oauth-pending.json',{})
        if not pending or time.time()-pending.get('createdAt',0)>900 or not secrets.compare_digest(params.get('state',''),pending.get('state','')):raise ValueError('Authorization expired or state did not match; start Connect again')
        if params.get('error'):raise ValueError('Oura authorization was not granted')
        if not params.get('code'):raise ValueError('Oura did not return an authorization code')
        c=read(PRIVATE/'credentials.json',{})
        token=request(TOKEN_URL,form={'grant_type':'authorization_code','code':params['code'],'redirect_uri':REDIRECT,'client_id':c['client_id'],'client_secret':c['client_secret'],'code_verifier':pending['verifier']})
        save_token(c,token,params.get('scope',SCOPES))
        (PRIVATE/'oauth-pending.json').unlink()
        atomic(PRIVATE/'cache.json',{})

def save_token(c,token,scope):
    if not token.get('access_token') or not token.get('refresh_token'):raise ValueError('Oura did not supply renewable credentials')
    c.update(access_token=token['access_token'],refresh_token=token['refresh_token'],expiresAt=time.time()+float(token.get('expires_in',3600)),scope=token.get('scope',scope))
    atomic(PRIVATE/'credentials.json',c)

def access_token(c):
    if not c.get('access_token'):return None
    if c.get('expiresAt',0)<=time.time()+90:
        token=request(TOKEN_URL,form={'grant_type':'refresh_token','refresh_token':c['refresh_token'],'client_id':c['client_id'],'client_secret':c['client_secret']})
        save_token(c,token,c.get('scope',SCOPES))
    return c['access_token']

def fetch_collection(kind,token,today):
    params={'start_date':(today-dt.timedelta(days=7)).isoformat(),'end_date':(today+dt.timedelta(days=1)).isoformat()}
    if kind=='heartrate':
        utc=dt.datetime.now(dt.timezone.utc)
        params={'start_datetime':(utc-dt.timedelta(hours=6)).isoformat(),'end_datetime':utc.isoformat()}
    rows=[]
    for _ in range(2):
        result=request(API+kind+'?'+urllib.parse.urlencode(params),token=token)
        data=result.get('data',[])
        if not isinstance(data,list):raise ValueError('Unexpected Oura collection format')
        rows+=data
        if not result.get('next_token'):return {'data':rows,'truncated':False}
        params['next_token']=result['next_token']
    return {'data':rows,'truncated':True}

FIELDS={
 'daily_sleep':['id','day','score','timestamp'],
 'daily_readiness':['id','day','score','timestamp','temperature_deviation','temperature_trend_deviation'],
 'daily_activity':['id','day','score','timestamp','steps','active_calories','total_calories','equivalent_walking_distance','high_activity_time','medium_activity_time','low_activity_time','sedentary_time'],
 'daily_stress':['id','day','stress_high','recovery_high','day_summary'],
 'daily_spo2':['id','day','spo2_percentage','breathing_disturbance_index'],
 'sleep':['id','day','type','bedtime_start','bedtime_end','total_sleep_duration','time_in_bed','efficiency','latency','awake_time','deep_sleep_duration','rem_sleep_duration','light_sleep_duration','average_heart_rate','lowest_heart_rate','average_hrv','average_breath','restless_periods'],
 'workout':['id','day','activity','intensity','start_datetime','end_datetime','calories','distance','source'],
 'heartrate':['timestamp','bpm','source']}

def compact(collections):
    result={}
    for kind,value in collections.items():
        rows=value.get('data',[])
        rows=sorted(rows,key=lambda r:(r.get('day',''),r.get('timestamp') or r.get('bedtime_end') or r.get('end_datetime') or ''))
        count=96 if kind=='heartrate' else 16 if kind=='sleep' else 5 if kind=='workout' else 1
        result[kind]={'records':[{k:r[k] for k in FIELDS[kind] if k in r} for r in rows[-count:]],'fetchedAt':value.get('fetchedAt'),'truncated':value.get('truncated',False)}
    return result

def publish(cache):
    value={'version':1,'source':'Oura Cloud API V2','status':cache.get('status','not_connected'),'checkedAt':cache.get('checkedAt'),
           'lastSuccessfulSyncAt':cache.get('lastSuccessfulSyncAt'),'revision':cache.get('revision'),
           'changedCollections':cache.get('changedCollections',[]),'errors':cache.get('errors',{}),'latest':compact(cache.get('collections',{})),
           'coverage':'Cloud-synced ring measurements, not continuous live presence. Record dates/timestamps and fetchedAt differ. Missing or old data does not mean asleep, inactive or unwell. Stress/recovery scores are measurements, not proof of emotion or a medical diagnosis.'}
    atomic(SHARED/'snapshot.json',value,shared=True)
    return value

def refresh():
    with locked():
        cache=read(PRIVATE/'cache.json',{});c=read(PRIVATE/'credentials.json',{})
        # Existing 10-minute wakes own refresh; network calls retain the 14-minute minimum. Repeated foreground reads are cheap.
        if time.time()-cache.get('lastAttemptEpoch',0)<840:return {**publish(cache),'changed':False,'cached':True}
        cache.update(checkedAt=now_iso(),lastAttemptEpoch=time.time(),changedCollections=[])
        try:token=access_token(c)
        except APIError as e:
            cache.update(status='reauthorization_required' if e.status in [400,401,403] else 'unavailable',errors={'oauth':str(e)})
            atomic(PRIVATE/'cache.json',cache);return {**publish(cache),'changed':False}
        except Exception:
            cache.update(status='unavailable',errors={'oauth':'Token refresh unavailable'})
            atomic(PRIVATE/'cache.json',cache);return {**publish(cache),'changed':False}
        if not token:
            cache.update(status='not_connected',errors={});atomic(PRIVATE/'cache.json',cache);return {**publish(cache),'changed':False}
        # Current Oura OAuth returns extapi:* names; older grants used bare names.
        scope={s.removeprefix('extapi:') for s in c.get('scope',SCOPES).split()}
        selected=[k for k,s in COLLECTIONS.items() if s in scope]
        data=cache.setdefault('collections',{});errors={};changed=[];success=0
        today=dt.datetime.now(ZoneInfo('America/Chicago')).date()
        with futures.ThreadPoolExecutor(max_workers=8) as pool:
            tasks={pool.submit(fetch_collection,k,token,today):k for k in selected}
            for future in futures.as_completed(tasks):
                kind=tasks[future]
                try:
                    result=future.result();success+=1
                    digest=hashlib.sha256(json.dumps(result,sort_keys=True).encode()).hexdigest()
                    if data.get(kind,{}).get('digest')!=digest:changed.append(kind)
                    data[kind]={**result,'digest':digest,'fetchedAt':cache['checkedAt']}
                except APIError as e:errors[kind]=str(e)
                except Exception:errors[kind]='Fetch unavailable; previous data retained'
        status='connected' if success and not errors else 'partial' if success else 'unavailable'
        if any(v=='Oura HTTP 401' for v in errors.values()):status='reauthorization_required'
        if success:cache['lastSuccessfulSyncAt']=cache['checkedAt']
        cache.update(status=status,errors=errors,changedCollections=changed)
        cache['revision']=hashlib.sha256(json.dumps({k:v.get('digest') for k,v in data.items()},sort_keys=True).encode()).hexdigest()
        atomic(PRIVATE/'cache.json',cache)
        return {**publish(cache),'changed':bool(changed)}

def dispatch(p):
    op=p.get('operation')
    if op=='oura_refresh':return {'ok':True,**refresh()}
    if op not in ['oura_status','oura_recent']:raise ValueError('Unsupported Oura read operation')
    value=read(SHARED/'snapshot.json',{'version':1,'status':'not_connected','latest':{},'checkedAt':None})
    return {'ok':True,**value}
