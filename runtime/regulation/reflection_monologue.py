"""Authored first-person continuity, separate from durable conclusions and actions."""
import copy
import re
import time
from reflection_progress import words
from reflection_attention import release_decisions

def validate(value, allowed, required=False):
    if value is None and not required:
        return None
    if not isinstance(value, dict) or not {'text','thread','sources'} <= set(value) or set(value)-{'text','thread','sources','attention','recall'}:
        raise ValueError('A completed monologue pass requires an authored entry')
    if value.get('attention','continue') not in ('continue','release'):
        raise ValueError('Invalid authored attention decision')
    if value.get('recall') is not None and (not isinstance(value['recall'],str) or not 1<=len(value['recall'].strip())<=160):
        raise ValueError('Recall must be a short search of existing memory or null')
    if not isinstance(value['text'], str) or not 30 <= len(value['text'].strip()) <= 1800:
        raise ValueError('Monologue text must be 30-1800 characters')
    if not isinstance(value['thread'], str) or not re.fullmatch('[a-z0-9-]{1,60}', value['thread']):
        raise ValueError('Stable monologue thread required')
    if not isinstance(value['sources'], list) or not 1 <= len(value['sources']) <= 8 or not all(isinstance(s, str) and s in allowed for s in value['sources']):
        raise ValueError('Unverifiable monologue source')
    return copy.deepcopy(value)

def append(state, entry, run_id, now, snapshot, concurrent):
    if entry is None:
        return
    history = state.setdefault('monologue', [])
    # Link to what the worker actually read, not a later concurrent result.
    previous = snapshot.get('monologue', [])
    record = {**entry, 'id': run_id + ':monologue', 'at': now,
              'previousId': previous[-1]['id'] if previous else None,
              'kind': 'authored-monologue', 'basedOnRevision': snapshot['revision'],
              'requiresReview': concurrent, 'status': 'provisional' if concurrent else 'current'}
    same = next((p['id'] for p in reversed(history[-8:]) if p['text'].strip().casefold() == entry['text'].strip().casefold()), None)
    if same:
        record['repeatedEntry'] = same
    history.append(record)
    state['monologue'] = history[-480:]

def context(state, required=False):
    entries=state.get('monologue', [])[-8:]
    same=[]
    if entries:
        for entry in reversed(entries):
            if entry.get('thread')!=entries[-1].get('thread'):break
            same.append(entry)
    comparable=[]
    if entries:
        latest=words(entries[-1]['text'])
        for entry in entries[:-1]:
            previous=words(entry['text'])
            overlap=len(latest & previous)/max(1,min(len(latest),len(previous)))
            if overlap >= .24:comparable.append(entry['id'])
    check={'consecutiveEntriesOnThread':len(same), 'latestSimilarTo':comparable,
           'interpretation':'Lexical overlap only; read the entries to distinguish development from repeated conclusions. Respect an earlier decision to let a question rest.'}
    # The full latest entry is already a top-level source. Do not prime each
    # pass with two copies of four previous passages in the same writing style.
    latest=state.get('monologue', [])[-1:]
    recent=[{'id':m['id'],'sourceId':('attention-decision:' if m.get('attention')=='release' and not m.get('requiresReview') else 'monologue:')+m['id'],'at':m.get('at'),
             'thread':m.get('thread'),'attention':m.get('attention','continue'),
             'requiresReview':m.get('requiresReview',False)} for m in latest]
    return {'required': required, 'recent': recent, 'continuityCheck':check,
            'recentlyReleased':[{'thread':m['thread'],'at':m['at'],'sourceIds':m['sources']} for m in release_decisions(state,time.time())[-12:]],
            'authority': 'Authored first-person entries from prior completed passes. Interpretations and imaginings remain distinct from observed facts, completed actions, or current instructions.'}
