"""Bounded persistent controller. No model calls, mood instructions, or outreach."""
import copy
import json
from pathlib import Path
from emotions import decay_in_place, effects

BASE = {'drive': .5, 'load': .2, 'affiliation': .5, 'steadiness': .6}
HALF_LIFE = {'drive': 7200, 'load': 5400, 'affiliation': 14400, 'steadiness': 21600}
CADENCE_SETTINGS = Path(__file__).with_name('cadence-settings.json')
# wake_minutes used to range 45-360 and was consumed by nothing. It now spans a
# band around the real background cadence so drive, load and affiliation show
# up as how often she turns up, with the plugin applying it to the actual job.
CADENCE_DEFAULTS = {'enabled': False, 'minMinutes': 6, 'maxMinutes': 30, 'baseMinutes': 10,
                    'recallMinChars': 1800, 'recallMaxChars': 4800}

def cadence_settings():
    try: return {**CADENCE_DEFAULTS, **json.loads(CADENCE_SETTINGS.read_text())}
    except (OSError, ValueError): return dict(CADENCE_DEFAULTS)

def fresh(now):
    state = {'version': 3, 'revision': 0, 'updated_at': now, 'levels': dict(BASE),
            'seen': [], 'last_kind': {}, 'trials': {}}
    decay_in_place(state,now)
    return state

def decay(state, now):
    out = copy.deepcopy(state)
    out['levels'] = decayed_levels(state, now)
    out['updated_at'] = max(now, state['updated_at'])
    decay_in_place(out,now)
    return out

def decayed_levels(state, now):
    """Project the four levels without copying unrelated retained history."""
    levels = dict(state['levels'])
    elapsed = max(0, now - state['updated_at'])
    for key, baseline in BASE.items():
        levels[key] = baseline + (state['levels'][key] - baseline) * 2 ** (-elapsed / HALF_LIFE[key])
    return levels

def wake_minutes(levels, cfg=None):
    cfg = cfg or cadence_settings()
    drive, load, social = (levels[k] for k in ('drive', 'load', 'affiliation'))
    lo, hi, base = cfg['minMinutes'], cfg['maxMinutes'], cfg['baseMinutes']
    # Same sign structure as before: load lengthens the gap, drive and
    # affiliation shorten it. Scaled to the configured band around the base.
    span = hi - lo
    minutes = base + span * (.55 * (load - .2) - .40 * (drive - .5) - .30 * (social - .5))
    return max(lo, min(hi, round(minutes)))

def actuators(levels):
    drive, load, social, steady = (levels[k] for k in ('drive', 'load', 'affiliation', 'steadiness'))
    cfg = cadence_settings()
    breadth = max(0, min(1, .50 + .55 * (drive - .5) - .75 * (load - .2)))
    return {'recall_count': max(2, min(6, round(2 + 4 * breadth))),
            'recall_chars': max(cfg['recallMinChars'], min(cfg['recallMaxChars'], round(cfg['recallMinChars'] + (cfg['recallMaxChars'] - cfg['recallMinChars']) * breadth))),
            'thread_count': max(1, min(3, round(1 + 2 * breadth))),
            'wake_minutes': wake_minutes(levels, cfg),
            'work_weight': .25 * drive + .15 * steady,
            'personal_weight': .25 * social,
            'continuity_weight': .20 * steady}

def select_context(state, request, now):
    levels = decayed_levels(state, now)
    trial = state.get('trials', {}).get(request.get('session', ''))
    if trial and trial.get('expires', 0) > now:
        levels = trial['levels']
    policy = actuators(levels)
    emotional=effects(state,now)
    change=emotional['breadth_delta']
    cfg=cadence_settings()
    policy['recall_count']=max(2,min(6,policy['recall_count']+round(4*change)))
    policy['recall_chars']=max(cfg['recallMinChars'],min(cfg['recallMaxChars'],policy['recall_chars']+round(2200*change)))
    policy['thread_count']=max(1,min(3,policy['thread_count']+round(2*change)))
    policy['personal_weight']+=emotional['personal_delta']
    policy['continuity_weight']+=emotional['continuity_delta']
    # wake_delta was +-100 minutes on a 45-360 scale; scale it to the band.
    span=cfg['maxMinutes']-cfg['minMinutes']
    policy['wake_minutes']=max(cfg['minMinutes'],min(cfg['maxMinutes'],policy['wake_minutes']+round(emotional['wake_delta']*span/315)))
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
            'wakeMinutes': policy['wake_minutes'], 'cadenceEnabled': bool(cfg['enabled']), 'cadenceBaseMinutes':cfg['baseMinutes'], 'cadenceBounds':{k:cfg[k] for k in ('minMinutes','maxMinutes')},
            'levels': {k: round(v, 4) for k, v in levels.items()}}
