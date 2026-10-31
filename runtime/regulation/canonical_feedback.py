"""Observe visible native tool records, including compressed canonical events.

Never project assistant thinking/text as tool outcomes. Code-mode wrappers and
their actual child calls coexist in the transcript; only child outcomes count.
"""
import ctypes,datetime,json,re,sqlite3,time
from observation_performance import LATEST_INPUT_SQL

_ZSTD=None
def decode_event(plain,compressed):
    global _ZSTD
    if plain:return json.loads(plain)
    if not compressed:return {}
    if _ZSTD is None:
        z=ctypes.CDLL('/opt/homebrew/lib/libzstd.dylib')
        z.ZSTD_getFrameContentSize.argtypes=[ctypes.c_void_p,ctypes.c_size_t];z.ZSTD_getFrameContentSize.restype=ctypes.c_ulonglong
        z.ZSTD_decompress.argtypes=[ctypes.c_void_p,ctypes.c_size_t,ctypes.c_void_p,ctypes.c_size_t];z.ZSTD_decompress.restype=ctypes.c_size_t
        z.ZSTD_isError.argtypes=[ctypes.c_size_t];z.ZSTD_isError.restype=ctypes.c_uint
        _ZSTD=z
    src=ctypes.create_string_buffer(compressed);size=_ZSTD.ZSTD_getFrameContentSize(src,len(compressed))
    if size>2_000_000:raise ValueError('Canonical event exceeds observation bound')
    dst=ctypes.create_string_buffer(size);n=_ZSTD.ZSTD_decompress(dst,size,src,len(compressed))
    if _ZSTD.ZSTD_isError(n):raise ValueError('Canonical event decompression failed')
    return json.loads(dst.raw[:n])

def tool_observation(event,calls,clean):
    message=event.get('message',{});blocks=message.get('content',[])
    if not isinstance(blocks,list):return None
    if message.get('role')=='assistant':
        for b in blocks:
            if b.get('type') not in ('toolCall','tool_use'):continue
            name=str(b.get('name','unknown')).split('__')[-1]
            args=b.get('arguments',b.get('input',{}))
            calls[b.get('id','')]={'name':name,'input':clean(json.dumps(args),1500),
                'wrapper':name=='exec' and isinstance(args,dict) and isinstance(args.get('input'),str)}
        return None
    if message.get('role') not in ('toolResult','tool'):return None
    call=calls.pop(message.get('toolCallId',''),{'name':message.get('toolName','unknown'),'input':''})
    name=call['name']
    if name in ('samantha_choice','samantha_self_view','samantha_moltbook','samantha_processing') or call.get('wrapper') or re.search(r'secret|auth|credential',name,re.I):return None
    result='\n'.join(str(b.get('text','')) for b in blocks if b.get('type')=='text')
    return 'Tool '+name+'; request: '+call['input']+'\nStatus: '+('failure' if message.get('isError') else 'returned')+'\nObserved result: '+clean(result,4000)

class CanonicalTools:
    def __init__(self,experiences,agent_db,clean):
        self.ex,self.agent_db,self.clean=experiences,agent_db,clean
        with self.ex.db() as db:
            db.execute("CREATE TABLE IF NOT EXISTS canonical_cursors(session TEXT NOT NULL,native TEXT NOT NULL,seq INTEGER NOT NULL,since REAL NOT NULL,calls TEXT NOT NULL DEFAULT '{}',PRIMARY KEY(session,native))")
            db.execute('CREATE TABLE IF NOT EXISTS canonical_observer_meta(name TEXT PRIMARY KEY,value REAL NOT NULL)')
            db.execute('INSERT OR IGNORE INTO canonical_observer_meta VALUES(?,?)',('installed_at',time.time()))
            self.installed_at=db.execute("SELECT value FROM canonical_observer_meta WHERE name='installed_at'").fetchone()[0]

    def track(self,session,native=None,since=None,baseline=True):
        with sqlite3.connect('file:'+self.agent_db+'?mode=ro',uri=True,timeout=2) as db:
            if native is None:
                row=db.execute('SELECT current_session_id,entry_json FROM session_nodes WHERE session_key=?',(session,)).fetchone()
                if not row or json.loads(row[1]).get('modelProvider')!='openai':return False
                native=row[0]
            if not isinstance(native,str) or not re.fullmatch(r'[0-9a-f-]{36}',native):raise ValueError('Invalid canonical binding')
            seq=db.execute('SELECT max(seq) FROM transcript_events WHERE session_id=?',(native,)).fetchone()[0] if baseline else -1
        if since is None:since=time.time()
        with self.ex.db() as db:
            db.execute('INSERT OR IGNORE INTO canonical_cursors(session,native,seq,since) VALUES(?,?,?,?)',(session,native,seq if seq is not None else -1,since))
        return True

    def scan(self):
        with self.ex.db() as db:
            # History is retained, but only a newly bound cursor needs its input
            # baseline looked up. Old/deleted sessions cause no history query.
            watches=db.execute('SELECT session,since FROM watched').fetchall()
            tracked={(r[0],r[1]) for r in db.execute('SELECT session,native FROM canonical_cursors')}
        by_session={row['session']:row for row in watches}
        pending=[]
        with sqlite3.connect('file:'+self.agent_db+'?mode=ro',uri=True,timeout=2) as native_db:
            sessions=list(by_session)
            for start in range(0,len(sessions),400):
                batch=sessions[start:start+400]
                rows=native_db.execute('SELECT session_key,current_session_id,entry_json FROM session_nodes WHERE session_key IN ('+','.join('?'*len(batch))+')',batch).fetchall()
                for session,native,raw in rows:
                    if json.loads(raw).get('modelProvider')!='openai':continue
                    if not isinstance(native,str) or not re.fullmatch(r'[0-9a-f-]{36}',native):raise ValueError('Invalid canonical binding')
                    if (session,native) in tracked:continue
                    watch=by_session[session]
                    with self.ex.db() as db:
                        latest=db.execute(LATEST_INPUT_SQL,(session,session)).fetchone()[0]
                    since=max(watch['since'],latest or watch['since'])
                    # Keep the existing installation baseline and new-run
                    # catch-up rules. A new binding always gets its own cursor.
                    seq=native_db.execute('SELECT max(seq) FROM transcript_events WHERE session_id=?',(native,)).fetchone()[0] if since<self.installed_at else -1
                    pending.append((session,native,seq if seq is not None else -1,since))
        if pending:
            with self.ex.db() as db:
                db.executemany('INSERT OR IGNORE INTO canonical_cursors(session,native,seq,since) VALUES(?,?,?,?)',pending)
        with self.ex.db() as db:
            cursors=db.execute('SELECT * FROM canonical_cursors ORDER BY since DESC LIMIT 64').fetchall()
        with sqlite3.connect('file:'+self.agent_db+'?mode=ro',uri=True,timeout=2) as native_db:
            for cursor in cursors:
                rows=native_db.execute('SELECT seq,event_json,event_zstd FROM transcript_events WHERE session_id=? AND seq>? ORDER BY seq LIMIT 100',(cursor['native'],cursor['seq'])).fetchall()
                calls=json.loads(cursor['calls']);seq=cursor['seq']
                for row in rows:
                    event=decode_event(row[1],row[2]);text=tool_observation(event,calls,self.clean)
                    if text:
                        try:at=datetime.datetime.fromisoformat(event.get('timestamp','').replace('Z','+00:00')).timestamp()
                        except (ValueError,AttributeError):at=0
                        if at>=cursor['since']-2:
                            self.ex.enqueue(cursor['session'],'canonical:'+cursor['native']+':'+str(row[0]),'tool_observation',text,created=at)
                    seq=row[0]
                if rows:
                    with self.ex.db() as db:
                        db.execute('UPDATE canonical_cursors SET seq=?,calls=? WHERE session=? AND native=?',(seq,json.dumps(dict(list(calls.items())[-100:])),cursor['session'],cursor['native']))
