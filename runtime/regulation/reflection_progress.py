"""Explicit thought continuity and conservative repetition checks; no model calls."""
import hashlib
import re
import time
from reflection_attention import conversation_events, resting_dialogue

STOP=set('a an and are as at be been but by can did do does for from had has have he her here him his how i if in into is it its just me my not of on or our she so that the their them then there these they this those to too was we were what when which who with would you your'.split())

def words(text):
    out=set()
    for word in re.findall(r"[a-z][a-z']+", str(text).lower()):
        if word in STOP or len(word)<3: continue
        for suffix in ('ing','ed','es','s'):
            if word.endswith(suffix) and len(word)>len(suffix)+3:
                word=word[:-len(suffix)];break
        out.add(word)
    return out

def basis(item, notes=()):
    index={'reflection:'+n['id']:n for n in notes}
    found=set()
    def expand(ref,depth=0):
        if depth<3 and ref in index:
            for source in index[ref]['sources']:expand(source,depth+1)
        elif not ref.startswith(('file:','current-emotional-')):found.add(ref)
    for ref in item.get('sources',[]):expand(ref)
    return found

def duplicate_of(item, notes):
    content=words(item['text']);refs=basis(item,notes)
    for old in reversed(notes):
        if old.get('requiresReview') or old.get('status')=='reviewed':continue
        if item['text'].strip().casefold()==old['text'].strip().casefold():return old['id']
        # New evidence is allowed to revise an otherwise similar conclusion.
        oldrefs=basis(old,notes)
        if not refs or refs!=oldrefs:continue
        previous=words(old['text']);union=content|previous
        overlap=len(content&previous)
        if union and (overlap/len(union)>=.42 or overlap/max(1,min(len(content),len(previous)))>=.72):return old['id']
    return None

def covered(notes):
    groups={}
    for note in notes[-80:]:
        if note.get('requiresReview') or note.get('status')=='reviewed':continue
        refs=basis(note,notes)
        key=tuple(sorted(refs)) or (note['id'],)
        group=groups.setdefault(key,{'sourceIds':list(key),'count':0})
        group.update(noteId=note['id'],text=note['text'],at=note['at'])
        group['count']+=1
    return list(groups.values())[-12:]

def continuity(snapshot,sources):
    seen=set(snapshot.get('seenSourceIds',[]))
    kinds={'owner_message','observed_message','observed-conversation','visible_reply','tool_result','turn_failed','unfinished-work-not-permission','historical-memory'}
    return {'focus':snapshot.get('focus'),
            'newSourceIds':[s['id'] for s in sources if s['id'] not in seen and s['kind'] in kinds],
            'coveredConclusions':[{**item,'text':item['text'][:240],
                                   'excerpt':len(item['text'])>240} for item in covered(snapshot['reflections'])],
            'lastPassFeedback':snapshot.get('progressFeedback',[])[-3:]}

def memory_terms(snapshot):
    """Recall follows the active thought; operator setup prose is not its topic."""
    import json
    filler=set("maybe still keep thinking wonder really something things little seems quite only also some much very here there about rather without myself itself could might feels feel know like want need trying interesting particular".split())
    def extract(text):
        return list(dict.fromkeys(w for w in re.findall(r'[a-z][a-z0-9-]{3,}', str(text).lower()) if w not in STOP and w not in filler))
    focused=extract(snapshot.get('focus',{}).get('question','')) if snapshot.get('focus') else []
    thought=[]
    if snapshot.get('monologue'):
        latest=snapshot['monologue'][-1]
        # A stale passage may carry the very interpretation that a new owner
        # correction supersedes; let real conversation drive recall instead.
        if not latest.get('requiresReview') and latest.get('attention')!='release':
            thought=extract(latest['text'])
    dialogue=[]
    observed=[]
    # Filter before truncation: operator setup must not evict the actual conversation.
    resting=resting_dialogue(snapshot,time.time())
    direct=[e for e in conversation_events(snapshot) if e['source'] not in resting]
    stream=[e for e in snapshot['events'] if not e.get('invalidated') and e.get('kind')=='observed_message'][-12:]
    for event in reversed(direct+stream):
        if event.get('invalidated') or event.get('source','').startswith('owner-codex:'):continue
        if event['kind']=='observed_message':
            try:value=json.loads(event['text'])
            except ValueError:continue
            observed.extend(extract(str(value.get('sender',''))+' '+str(value.get('text',''))))
        elif event['kind'] in ('owner_message','visible_reply'):dialogue.extend(extract(event['text']))
    # Give an ongoing idea room to retrieve associations without losing the
    # actual conversation. Empty lanes donate their budget to other lanes.
    dialogue=list(dict.fromkeys(dialogue));observed=list(dict.fromkeys(observed))
    conversation=list(dict.fromkeys(dialogue[:6]+observed[:6]+dialogue+observed))
    focused=list(dict.fromkeys(focused));thought=list(dict.fromkeys(thought))
    selected=list(dict.fromkeys(focused[:4]+thought[:6]+conversation[:4]))
    return list(dict.fromkeys(selected+focused+thought+conversation))[:14]


def memory_queries(snapshot):
    """Keep real conversation recall available beside self-directed recall."""
    resting=resting_dialogue(snapshot,time.time())
    seen=set(snapshot.get('seenSourceIds',[]))
    real=conversation_events(snapshot)+[e for e in snapshot.get('events',[]) if e.get('kind')=='observed_message' and not e.get('invalidated')]
    fresh=not seen or any(e.get('source') not in seen for e in real)
    conversational = memory_terms({**snapshot, 'events':[e for e in snapshot.get('events',[]) if e.get('source') not in resting], 'focus': None, 'monologue': []}) if fresh else []
    thinking = memory_terms({**snapshot, 'events': []})
    lanes = []
    latest=snapshot.get('monologue',[])[-1:]
    if latest and not latest[0].get('requiresReview') and latest[0].get('recall'):
        terms=list(dict.fromkeys(w for w in re.findall(r'[a-z][a-z0-9-]{2,}',latest[0]['recall'].lower()) if w not in STOP))[:10]
        if terms:lanes.append({'lane':'chosen-recall','terms':terms})
    for name, terms in [('recent-conversation', conversational), ('ongoing-thought', thinking)]:
        if terms and not any(set(terms) == set(lane['terms']) for lane in lanes):
            lanes.append({'lane': name, 'terms': terms})
    return lanes
