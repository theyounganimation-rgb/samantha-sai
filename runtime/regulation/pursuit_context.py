"""Bounded factual context for appraisal, never new emotional events."""
import re

def words(text):
    return set(re.findall(r'[a-z][a-z0-9_-]{2,}', str(text).lower()))

def pursuit_goal(thread, clean):
    # Reserve space for the latest checkpoint. A long old outcome must not
    # truncate the new exposure, uncertainty, or next observable outcome.
    fields = [('title', 120), ('want', 220), ('whyItMatters', 240),
              ('currentView', 220), ('resumeFrom', 360), ('nextStep', 260)]
    text = '\n'.join(k+': '+clean(str(thread[k]), limit)
                     for k, limit in fields if thread.get(k))
    return {'id': 'thread:'+thread['id'], 'source': thread.get('source', ''),
            'updatedAt': thread.get('updatedAt'), 'text': text,
            'authority': 'Authored pursuit and checkpoint, not a new observation, verified outcome, emotional impulse or action permission. Current tool evidence wins.'}

def prior_situations(episodes, events):
    query = words(' '.join(e.get('text', '') for e in events))
    grouped = {}
    for p in episodes:
        key = (p.get('subject'), p.get('context_key'))
        old = grouped.get(key)
        if not old or p.get('at', 0) >= old.get('at', 0): grouped[key] = p
    ranked = sorted(grouped.values(), key=lambda p: (
        len(query & words(' '.join([str(p.get('subject', '')), str(p.get('context_key', '')),
                                   ' '.join(p.get('evidence', []))]))), p.get('at', 0)), reverse=True)
    return [{k: p.get(k) for k in ('context_key', 'subject', 'source', 'evidence')}
            for p in ranked[:6]]
