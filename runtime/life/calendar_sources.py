"""Calendar provenance can come from any input, independently of Messages."""
import json
from pathlib import Path
import re
import subprocess

HELPER = Path(__file__).with_name('calendar-conversation-source.mjs')
NODE = '/opt/homebrew/opt/node@24/bin/node'

def conversation_id(reference):
    value = reference.removeprefix('conversation:')
    return value if re.fullmatch(r'[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}|[0-9]{13}', value) else None

def read_conversation(ids):
    if not ids: return {}
    result = subprocess.run(['/usr/bin/sudo','-n','-H','-u','samantha',NODE,str(HELPER),json.dumps(ids)],
                            capture_output=True,text=True,timeout=10,cwd='/')
    if result.returncode: raise RuntimeError('Saved conversation evidence is unavailable; calendar writes remain available without citations or with reported context')
    return {row['id']:row for row in json.loads(result.stdout)}

def calendar_source_lookup(sources, legacy_lookup, read_rows=read_conversation):
    """Exact legacy citations stay exact; context is explicitly model-reported."""
    if not isinstance(sources,list) or len(sources)>12: raise ValueError('At most twelve optional calendar sources are supported')
    candidates = list(dict.fromkeys(x for source in sources if isinstance(source,dict)
                                   for x in [conversation_id(str(source.get('guid','')))] if x))
    context = {source.get('guid'):source for source in sources if isinstance(source,dict)}
    rows = None
    def lookup(reference):
        nonlocal rows
        if not isinstance(reference,str) or not reference or len(reference)>2000: return None
        if reference.startswith('context:'):
            source = context.get(reference,{})
            quote = source.get('quote','')
            if not isinstance(quote,str) or not quote.strip() or len(quote)>4000: return None
            return {'text':quote,'sender_name':'Context','created_at':'',
                    'sourceKind':'reported_context','evidenceStatus':'agent_reported_interpretation'}
        # Namespace-qualified conversation IDs must not be sent to the Messages
        # database. Bare IDs remain compatible with Samantha's existing calls.
        if not reference.startswith('conversation:'):
            old = legacy_lookup(reference)
            if old: return old
        identifier = conversation_id(reference)
        if not identifier: return None
        if rows is None: rows = read_rows(candidates)
        row = rows.get(identifier)
        if not row: return None
        return {'text':row['text'],'sender_name':row.get('speaker',{}).get('name',row.get('role','')),
                'created_at':row.get('timestamp',''),'sourceKind':'conversation',
                'evidenceStatus':'verified_conversation_quote','speakerId':row.get('speaker',{}).get('personId')}
    return lookup
