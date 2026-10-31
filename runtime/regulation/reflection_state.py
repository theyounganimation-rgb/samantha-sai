"""Persistent, bounded reflection state. No provider, messaging, or emotion writes.

The voice model and reflection worker exchange explicit conclusions, never their
private reasoning traces. Real activity, interpretations, and unfinished ideas
remain distinct. Every worker result is tied to a specific input revision.
"""
import contextlib
import copy
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import threading
import time
from reflection_progress import duplicate_of
from reflection_monologue import validate as validate_monologue, append as append_monologue
from reflection_outreach import initialize as outreach_initialize, context as outreach_context, offer as offer_outreach, validate_candidate

PROOF_PREFIX = 'agent:samantha:regulation-proof-'


def scope(session):
    if str(session).startswith(PROOF_PREFIX):
        return str(session)
    if not str(session).startswith('agent:samantha:'):
        raise ValueError('Not a Samantha session')
    return 'live'


def clean(text, limit=2400):
    text = str(text)
    if re.search(r'''(?i)(api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|password|passcode|client[_-]?secret)["']?\s*(?:[=:]|is\b|to\b)\s*["']?\S+|-----BEGIN .*PRIVATE KEY''', text):
        return '[Sensitive content omitted]'
    return text[:limit]


def fresh():
    return {'version': 4, 'revision': 0, 'contentRevision': 0, 'active': {}, 'lastActivity': 0,
            'gatewaySeen': 0, 'gatewayPid': None, 'nextDue': 0,
            'lastStarted': 0, 'dailyStarts': [], 'idleRevisits': 0,
            'lastConsideredRevision': -1, 'events': [], 'perspective': [],
            'reflections': [], 'monologue': [], 'proposals': [], 'runs': [], 'seenSourceIds': [], 'focus': None, 'progressFeedback': []}


def upgrade(state):
    state.setdefault('contentRevision', state['revision'])
    state.setdefault('proposals', [])
    state.setdefault('monologue', [])
    if state.get('version',2)<3:
        prior=[]
        for note in state['reflections']:
            same=duplicate_of(note,prior)
            if same and not note.get('requiresReview'):
                note.update(status='redundant',duplicateOf=same)
            prior.append(note)
    state.setdefault('seenSourceIds',list(dict.fromkeys(s for n in state['reflections'] for s in n['sources'])))
    state.setdefault('focus',None)
    state.setdefault('progressFeedback',[])
    state['version'] = 4
    outreach_initialize(state)
    return state


class Store:
    def __init__(self, root, clock=time.time):
        self.root, self.clock = Path(root), clock
        self.root.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.lock = threading.RLock()

    def path(self, which):
        name = 'live' if which == 'live' else hashlib.sha256(which.encode()).hexdigest()[:24]
        return self.root / (name + '.json')

    @contextlib.contextmanager
    def transaction(self, which):
        target = self.path(which)
        with self.lock, target.with_suffix('.lock').open('a') as lock:
            os.chmod(lock.name, 0o600)
            fcntl.flock(lock, fcntl.LOCK_EX)
            state = upgrade(json.loads(target.read_text())) if target.exists() else fresh()
            yield state
            temporary = target.with_suffix('.tmp')
            with temporary.open('w') as out:
                os.chmod(temporary, 0o600)
                json.dump(state, out, ensure_ascii=False, separators=(',', ':'))
                out.flush()
                os.fsync(out.fileno())
            os.replace(temporary, target)

    def read(self, which='live'):
        target = self.path(which)
        with self.lock, target.with_suffix('.lock').open('a') as lock:
            os.chmod(lock.name, 0o600)
            fcntl.flock(lock, fcntl.LOCK_SH)
            return upgrade(json.loads(target.read_text())) if target.exists() else fresh()

    def event(self, which, source, kind, text, run=None, observed_at=None):
        if kind not in ('owner_message', 'participant_message', 'observed_message', 'system_input', 'visible_reply', 'tool_result', 'turn_failed'):
            raise ValueError('Unsupported observation kind')
        text, source = clean(text,6000 if kind=='observed_message' else 2400), str(source)[:240]
        if not text.strip():
            return False
        event_id = hashlib.sha256((which + source + kind).encode()).hexdigest()[:24]
        with self.transaction(which) as state:
            if any(e['id'] == event_id for e in state['events']):
                return False
            state['revision'] += 1
            state['contentRevision'] += 1
            outreach_initialize(state)
            at = min(self.clock(), float(observed_at)) if observed_at is not None else self.clock()
            if kind in ('owner_message','participant_message','observed_message'):state['inputRevision']+=1
            if kind=='owner_message':state['lastOwnerAt']=max(state.get('lastOwnerAt',0),at)
            state['lastActivity'] = max(state['lastActivity'],at)
            state['idleRevisits'] = 0
            state['events'].append({'id': event_id, 'source': source, 'kind': kind,
                                    'text': text, 'at': at})
            state['events'] = sorted(state['events'],key=lambda e:e['at'])[-512:]
            if run and run in state['active']:
                state['active'][run] = self.clock()
            return True

    def begin(self, which, run):
        if not run:
            raise ValueError('Run id required')
        with self.transaction(which) as state:
            if run not in state['active']:
                state['revision'] += 1
            state['active'][run] = self.clock()
            state['lastActivity'] = self.clock()

    def end(self, which, run):
        with self.transaction(which) as state:
            state['active'].pop(run, None)
            state['lastActivity'] = self.clock()

    def pulse(self, pid, runs):
        with self.transaction('live') as state:
            current_runs = {str(run): self.clock() for run in runs[:100]}
            if state['gatewayPid'] != pid or set(state['active']) != set(current_runs):
                state['revision'] += 1
                state['lastActivity'] = self.clock()
                state['active'] = {}
            state['gatewayPid'] = pid
            state['gatewaySeen'] = self.clock()
            # The gateway's run set is authoritative after restart. A stale
            # controller lease must not permanently prevent future reflection.
            state['active'] = current_runs

    def ready(self, state, settings):
        now = self.clock()
        if not settings.get('enabled') or not settings.get('model'):
            return False, 'not-configured'
        if state.get('scheduleVersion') == 2 and now < state['nextDue']:
            return False, 'cooldown'
        return True, 'ready'

    def reserve(self, which, settings, proof=False):
        if not proof and not self.ready(self.read(which), settings)[0]:
            return None
        with self.transaction(which) as state:
            if proof and not which.startswith(PROOF_PREFIX):
                raise ValueError('Forced runs require isolated proof state')
            if not proof and not self.ready(state, settings)[0]:
                return None
            now = self.clock()
            state['lastStarted'] = now
            state['monologueRequired'] = bool(settings.get('monologueEnabled'))
            state['scheduleVersion'] = 2
            state['dailyStarts'] = [at for at in state['dailyStarts'] if now - at < 86400] + [now]
            # Start-to-start cadence, including failures; no catch-up burst.
            state['nextDue'] = now + settings.get('cadenceSeconds', 180)
            return copy.deepcopy(state)

    def current(self, which, snapshot):
        state = self.read(which)
        return state['contentRevision'] == snapshot.get('contentRevision', snapshot['revision'])

    def commit(self, which, snapshot, result, audit, sources):
        normalized = validate(result, sources, snapshot)
        with self.transaction(which) as state:
            concurrent = state['contentRevision'] != snapshot.get('contentRevision', snapshot['revision'])
            now = self.clock()
            run_id = hashlib.sha256((which + str(snapshot['lastStarted']) + str(snapshot['revision'])).encode()).hexdigest()[:20]
            if any(run['id'] == run_id for run in state['runs']):
                return False
            append_monologue(state, normalized.get('monologue'), run_id, now, snapshot, concurrent)
            offer_outreach(state,normalized.get('outreach'),now,concurrent)
            state['lastConsideredRevision'] = state['revision']
            if not concurrent:
                reviewed = set(normalized['reviewedItems'])
                for item in state['reflections'] + state['proposals'] + state.get('monologue', []):
                    prefix = 'proposal:' if item.get('kind') == 'perspective-proposal' else 'monologue:' if item.get('kind') == 'authored-monologue' else 'reflection:'
                    if prefix + item['id'] in reviewed and item.get('requiresReview'):
                        item.update(requiresReview=False, reviewedAt=now, status='reviewed')
            feedback=[]
            saved=0
            for i, thought in enumerate(normalized['reflections']):
                duplicate=duplicate_of(thought,state['reflections'])
                if duplicate:
                    feedback.append({'kind':'repetition','duplicateOf':duplicate,'text':'This conclusion was already recorded. Advance a specific open question, use new evidence, or return no new note.'})
                    continue
                saved+=1
                state['reflections'].append({**thought, 'id': run_id + ':' + str(i),
                                             'at': now, 'model': audit['model'],
                                             'kind': 'interpretation', 'basedOnRevision': snapshot['revision'],
                                             'requiresReview': concurrent,
                                             'status': 'provisional' if concurrent else 'current'})
            for update in normalized['updates']:
                if concurrent:
                    state['proposals'].append({**update, 'entryId': update['id'],
                        'id': run_id+':proposal:'+update['id'], 'at':now,
                        'kind':'perspective-proposal', 'requiresReview':True,
                        'status':'provisional', 'basedOnRevision':snapshot['revision']})
                    continue
                state['perspective'] = [p for p in state['perspective'] if p['id'] != update['id']]
                state['perspective'].append({**update, 'at': now, 'author': 'reflection', 'kind': 'revisable-view'})
            if normalized['updates'] and not concurrent:
                state['contentRevision'] += 1
            state['seenSourceIds']=list(dict.fromkeys(state['seenSourceIds']+list(sources)))[-2000:]
            if not concurrent and 'focus' in normalized:
                state['focus']=None if normalized['focus'] is None else {**normalized['focus'],'at':now}
            state['progressFeedback']=feedback
            # Voice CAS detects completed background changes, while activity
            # heartbeats never count as new semantic evidence.
            state['revision'] += 1
            state['perspective'] = state['perspective'][-20:]
            state['reflections'] = state['reflections'][-240:]
            state['proposals'] = state['proposals'][-40:]
            state['runs'].append({'id': run_id, 'at': now, 'status': 'completed', 'audit': audit,
                                  'sourceRevision': snapshot['revision'],
                                  'concurrentChanges':concurrent, 'activeRunsAtStart':list(snapshot['active']),
                                  'activeRunsAtCommit':list(state['active']),
                                  'savedNotes':saved,'savedMonologue':normalized.get('monologue') is not None,'suppressedRepetitions':len(feedback),
                                  'activity': ('Continued an authored first-person monologue; recorded ' if normalized.get('monologue') else 'Reviewed supplied context; recorded ')+str(saved)+' new reflection notes and '+str(len(normalized['updates']))+' perspective proposals.'})
            state['runs'] = state['runs'][-480:]
            return True

    def revise(self, which, revision, entry_id, text, source, reject=False):
        if not re.fullmatch(r'[a-z0-9-]{1,60}', str(entry_id)) or not text or not source:
            raise ValueError('Stable id, revision text and conversation source required')
        with self.transaction(which) as state:
            if revision != state['revision']:
                return {'ok': False, 'error': 'revision-conflict', 'revision': state['revision']}
            state['revision'] += 1
            state['contentRevision'] += 1
            state['lastActivity'] = self.clock()
            state['idleRevisits'] = 0
            state['perspective'] = [p for p in state['perspective'] if p['id'] != entry_id]
            state['perspective'].append({'id': entry_id, 'text': clean(text, 1000),
                                        'sources': [clean(source, 240)], 'at': self.clock(),
                                        'author': 'voice', 'kind': 'revisable-view', 'rejected': bool(reject)})
            state['perspective'] = state['perspective'][-20:]
            return {'ok': True, 'revision': state['revision']}


def validate(result, sources, snapshot):
    if not isinstance(result, dict) or not {'reflections', 'updates', 'reviewedItems'} <= set(result) or set(result)-{'reflections','updates','reviewedItems','focus','outreach','monologue'}:
        raise ValueError('Unexpected reflection output')
    out = {'reflections': [], 'updates': [], 'reviewedItems': []}
    allowed = set(sources)
    out['monologue'] = validate_monologue(result.get('monologue'), allowed, snapshot.get('monologueRequired', False))
    out['outreach']=validate_candidate(result.get('outreach'),allowed)
    reviewable = {'reflection:'+n['id'] for n in snapshot['reflections'] if n.get('requiresReview')}
    reviewable.update('monologue:'+n['id'] for n in snapshot.get('monologue',[]) if n.get('requiresReview'))
    reviewable.update('proposal:'+n['id'] for n in snapshot.get('proposals',[]) if n.get('requiresReview'))
    if not isinstance(result['reviewedItems'], list) or len(result['reviewedItems']) > 12 or not all(isinstance(s,str) and s in allowed and s in reviewable for s in result['reviewedItems']):
        raise ValueError('Unverifiable review reference')
    out['reviewedItems'] = list(dict.fromkeys(result['reviewedItems']))
    focus=result.get('focus')
    if 'focus' in result:out['focus']=None
    if focus is not None:
        if not isinstance(focus,dict) or set(focus)!={'id','question','status','sources'}:raise ValueError('Invalid thought focus')
        if not re.fullmatch(r'[a-z0-9-]{1,60}',str(focus['id'])) or focus['status'] not in ('continue','waiting','settled'):raise ValueError('Invalid thought focus status')
        if not isinstance(focus['question'],str) or not 1<=len(focus['question'])<=400:raise ValueError('Invalid thought question')
        if not isinstance(focus['sources'],list) or not 1<=len(focus['sources'])<=8 or not all(s in allowed for s in focus['sources']):raise ValueError('Unverifiable thought focus')
        out['focus']=copy.deepcopy(focus)
    for field, limit in [('reflections', 3), ('updates', 3)]:
        items = result[field]
        if not isinstance(items, list) or len(items) > limit:
            raise ValueError('Too many reflective conclusions')
        for item in items:
            expected = {'text', 'sources'} | ({'id'} if field == 'updates' else set())
            if not isinstance(item, dict) or not expected<=set(item) or set(item)-expected-({'delta'} if field=='reflections' else set()):
                raise ValueError('Unexpected conclusion fields')
            if not isinstance(item['text'], str) or not 1 <= len(item['text']) <= 1000:
                raise ValueError('Conclusion exceeds bound')
            if not isinstance(item['sources'], list) or not 1 <= len(item['sources']) <= 8 or not all(isinstance(s, str) and s in allowed for s in item['sources']):
                raise ValueError('Unverifiable source reference')
            if field == 'updates' and not re.fullmatch(r'[a-z0-9-]{1,60}', str(item['id'])):
                raise ValueError('Invalid perspective id')
            if 'delta' in item and (not isinstance(item['delta'],str) or not 1<=len(item['delta'])<=400):raise ValueError('Invalid reflection advance')
            out[field].append(copy.deepcopy(item))
    return out


def projection(state):
    """Small read-only view for the next normal voice turn; never wakes it."""
    return {'revision': state['revision'], 'focus':state.get('focus'), 'outreach':outreach_context(state), 'perspective': state['perspective'][-8:],
            'monologue': state.get('monologue', [])[-3:],
            'reflections': [n for n in state['reflections'] if n.get('status') not in ('reviewed','redundant')][-3:],
            'proposals': [p for p in state.get('proposals',[]) if p.get('requiresReview')][-4:],
            'actualActivity': state['runs'][-3:]}
