"""Bounded persistent controller. No model calls, mood instructions, or outreach."""
import copy
import hashlib
import math
import re

BASE = {'drive': .5, 'load': .2, 'affiliation': .5, 'steadiness': .6}
HALF_LIFE = {'drive': 7200, 'load': 5400, 'affiliation': 14400, 'steadiness': 21600}
DELTAS = {
    'contact': {'affiliation': .025},
    'explicit_frustration': {'load': .10, 'steadiness': -.04},
    'explicit_correction': {'load': .055, 'steadiness': -.025},
    'tool_success': {'drive': .045, 'steadiness': .025, 'load': -.025},
    'tool_failure': {'load': .075, 'drive': -.025},
    'turn_failure': {'load': .08},
    'thread_progress': {'drive': .06, 'steadiness': .025},
}

def fresh(now):
    return {'version': 1, 'revision': 0, 'updated_at': now, 'levels': dict(BASE),
            'seen': [], 'last_kind': {}, 'trials': {}}

def decay(state, now):
    out = copy.deepcopy(state)
    elapsed = max(0, now - state['updated_at'])
    for key, baseline in BASE.items():
        out['levels'][key] = baseline + (state['levels'][key] - baseline) * 2 ** (-elapsed / HALF_LIFE[key])
    out['updated_at'] = max(now, state['updated_at'])
    return out

def apply_event(state, kind, source, now):
    out = decay(state, now)
    event_id = hashlib.sha256((kind + ':' + source).encode()).hexdigest()
    if event_id in out['seen']:
        return out, False
    out['seen'] = (out['seen'] + [event_id])[-1024:]
    # Rate limits prevent a burst of tools or repeated messages saturating state.
    cooldown = 120 if kind in ('tool_success', 'tool_failure', 'contact') else 60
    if now - out['last_kind'].get(kind, -1e12) < cooldown:
        return out, False
    for key, delta in DELTAS[kind].items():
        out['levels'][key] = max(.05, min(.95, out['levels'][key] + delta))
    out['last_kind'][kind] = now
    out['revision'] += 1
    return out, True

def observed_user_events(text):
    """Explicit lexical observations, not a claim to infer the owner's feelings."""
    text = text.lower()
    result = ['contact']
    if re.search(r"\b(i(?:'m| am) (?:pissed|frustrated|angry|upset)|you(?:'re| are) annoying)\b", text):
        result.append('explicit_frustration')
    if re.search(r"\b(that(?:'s| is) (?:wrong|incorrect)|you forgot|i meant|i misspoke)\b", text):
        result.append('explicit_correction')
    return result

def actuators(levels):
    drive, load, social, steady = (levels[k] for k in ('drive', 'load', 'affiliation', 'steadiness'))
    breadth = max(0, min(1, .50 + .55 * (drive - .5) - .75 * (load - .2)))
    return {'recall_count': max(2, min(6, round(2 + 4 * breadth))),
            'recall_chars': max(1800, min(4800, round(1800 + 3000 * breadth))),
            'thread_count': max(1, min(3, round(1 + 2 * breadth))),
            'wake_minutes': max(45, min(360, round(180 + 200 * (load - .2) - 150 * (drive - .5) - 100 * (social - .5)))),
            'work_weight': .25 * drive + .15 * steady,
            'personal_weight': .25 * social,
            'continuity_weight': .20 * steady}

def select_context(state, request, now):
    levels = decay(state, now)['levels']
    trial = state.get('trials', {}).get(request.get('session', ''))
    if trial and trial.get('expires', 0) > now:
        levels = trial['levels']
    policy = actuators(levels)
    ranked = []
    for item in request.get('candidates', [])[:30]:
        score = float(item.get('relevance', 0))
        category = item.get('category', 'general')
        score += policy['work_weight'] if category == 'work' else policy['personal_weight'] if category == 'personal' else 0
        if item.get('continuity'):
            score += policy['continuity_weight']
        ranked.append((score, item['id']))
    ranked.sort(key=lambda row: (-row[0], row[1]))
    ids = [row[1] for row in ranked[:policy['recall_count']]]
    threads = sorted(request.get('threads', [])[:40], key=lambda item:
                     (-float(item.get('relevance', 0)), -float(item.get('updatedAt', 0)), item['id']))
    return {'selected': ids, 'recallChars': policy['recall_chars'],
            'threads': [t['id'] for t in threads[:policy['thread_count']]],
            'wakeMinutes': policy['wake_minutes']}
