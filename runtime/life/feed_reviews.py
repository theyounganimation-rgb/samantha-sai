"""A reviewed historical failure stays preserved; it is never called delivered."""
import hashlib, re
from pathlib import Path

def reviewed_batches(unresolved,registry,root,read_bytes=None):
    read_bytes=read_bytes or (lambda p:Path(p).read_bytes())
    reviewed=[]
    for row in unresolved:
        ident=row.get('id','');review=registry.get(ident,{})
        if not re.fullmatch(r'[a-f0-9]{24}',ident):continue
        expected=Path(root)/(ident+'.json')
        if row.get('file')!=str(expected):continue
        if review.get('disposition')!='reviewed-no-replay-outcome-not-assumed':continue
        if not review.get('reviewedAt') or not review.get('evidence'):continue
        try:actual=hashlib.sha256(read_bytes(expected)).hexdigest()
        except OSError:continue
        if actual==review.get('sha256'):reviewed.append(ident)
    return reviewed
