"""Bounded observation reads and passive latency measurements. No model work."""
from collections import deque
import contextlib,math,sqlite3,threading,time

FIELDS='id,kind,text,source,created'
HISTORY_SQL="SELECT "+FIELDS+" FROM observations WHERE scope=? AND status='done' ORDER BY created DESC LIMIT 6"
HUMAN_SQL="SELECT source,created,text,kind FROM observations WHERE scope=? AND kind='human_input'"
# The redundant lower bound makes the existing timestamp/rowid cursor use an
# index range even when the cursor has caught up and there are no new records.
REFLECTION_SQL="SELECT rowid,source,kind,text,created FROM observations WHERE scope='live' AND created>=? AND (created>? OR (created=? AND rowid>?)) AND created<=? ORDER BY created,rowid LIMIT 100"
# Bound each kind before merging. An arbitrarily long gap filled with other
# kinds must not turn a LIMIT 2/32 read into a walk through the whole history.
REQUESTS_SQL=("SELECT * FROM (SELECT "+FIELDS+" FROM observations WHERE scope=? AND kind='human_input' ORDER BY created DESC LIMIT 2) UNION ALL "
              "SELECT * FROM (SELECT "+FIELDS+" FROM observations WHERE scope=? AND kind='system_input' ORDER BY created DESC LIMIT 2) ORDER BY created DESC LIMIT 2")
ACTIVITY_SQL=("SELECT * FROM (SELECT "+FIELDS+" FROM observations WHERE scope=? AND kind='tool_observation' AND created>=? ORDER BY created DESC LIMIT 32) UNION ALL "
              "SELECT * FROM (SELECT "+FIELDS+" FROM observations WHERE scope=? AND kind='assistant_report' AND created>=? ORDER BY created DESC LIMIT 32) ORDER BY created DESC LIMIT 32")
LATEST_INPUT_SQL=("SELECT max(created) FROM (SELECT * FROM (SELECT created FROM observations WHERE session=? AND kind='human_input' ORDER BY created DESC LIMIT 1) UNION ALL "
                  "SELECT * FROM (SELECT created FROM observations WHERE session=? AND kind='system_input' ORDER BY created DESC LIMIT 1))")
REQUIRED_INDEXES={
 'observation_scope_time':['scope','created'],
 'observation_scope_kind_time':['scope','kind','created'],
 'observation_scope_status_time':['scope','status','created'],
 'observation_session_kind_time':['session','kind','created'],
 'observation_scope_source_kind':['scope','source','kind'],
}
LIMITS_MS={'prepare':2500,'queue_wait':250,'queue_hold':250,'state_wait':500,'state_hold':1200,'observer':2000,'canonical_observer':2000,'native_observer':2000,'reflection_observer':2000}
DB_OPERATIONS={'__init__','enqueue','watch','scan','scan_native','recent_activity','observe_relationship','find_quote','last_human_at','input_status','wait_for_input','step','status','track'}

class Latencies:
    def __init__(self,clock=time.time):
        self.clock=clock;self.started=clock();self.lock=threading.Lock()
        self.rows={name:deque(maxlen=512) for name in LIMITS_MS}
        self.counts=dict.fromkeys(LIMITS_MS,0)
        self.slow={name:deque(maxlen=32) for name in LIMITS_MS}

    def record(self,name,ms,operation=None):
        if name not in self.rows or not math.isfinite(ms) or ms<0:return
        at=self.clock()
        with self.lock:
            self.rows[name].append((at,ms));self.counts[name]+=1
            if ms>LIMITS_MS[name]:self.slow[name].append((at,ms,operation if operation in DB_OPERATIONS else None))

    @contextlib.contextmanager
    def measure(self,name,operation=None):
        began=time.monotonic()
        try:yield
        finally:self.record(name,(time.monotonic()-began)*1000,operation)

    def snapshot(self):
        now=self.clock();result={};issues=[]
        with self.lock:
            for name,rows in self.rows.items():
                fresh=[r for r in rows if 0<=now-r[0]<=1800]
                slow=[r for r in self.slow[name] if 0<=now-r[0]<=1800]
                values=sorted(r[1] for r in fresh)
                p95=values[math.ceil(len(values)*.95)-1] if values else None
                # A small window of ordinary samples must not erase repeated
                # long stalls before the ten-minute watchdog can observe them.
                degraded=(len(fresh)>=3 and p95>LIMITS_MS[name]) or len(slow)>=3
                if degraded:issues.append(name)
                result[name]={'samples':len(fresh),'lifetimeSamples':self.counts[name],
                    'p95Ms':round(p95,2) if p95 is not None else None,
                    'lastMs':round(fresh[-1][1],2) if fresh else None,
                    'lastAt':fresh[-1][0] if fresh else None,
                    'slowSamples':len(slow),'warningMs':LIMITS_MS[name],
                    'lastSlow':[{'at':r[0],'ms':round(r[1],2),'operation':r[2]} for r in slow[-3:]]}
        return {'version':1,'ok':not issues,'issues':issues,'startedAt':self.started,
                'checkedAt':now,'windowSeconds':1800,'metrics':result,
                'note':'Passive completed-operation timings; no recent samples do not prove response speed.'}

METRICS=Latencies()

def index_health(database):
    """Read-only structural check. Never rebuild indexes during a health probe."""
    problems=[]
    with sqlite3.connect('file:'+str(database)+'?mode=ro',uri=True,timeout=.5) as db:
        db.execute('PRAGMA query_only=ON')
        actual={row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='index'")}
        for name,columns in REQUIRED_INDEXES.items():
            if name not in actual:problems.append('missing:'+name);continue
            got=[row[2] for row in db.execute('PRAGMA index_info('+name+')')]
            if got!=columns:problems.append('wrong-columns:'+name)
    return {'ok':not problems,'issues':problems,'expectedIndexes':len(REQUIRED_INDEXES)}
