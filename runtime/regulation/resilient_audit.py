"""Bounded active audit files, lossless archives, and explicit I/O health."""
import fcntl, gzip, json, os, shutil, threading, time
from pathlib import Path
_errors = {}
_guard = threading.Lock()

def errors():
    with _guard: return dict(_errors)

def append(path, entry, limit=32*1024*1024):
    path=Path(path)
    try:
        with path.with_suffix(path.suffix+'.lock').open('a') as lock:
            fcntl.flock(lock,fcntl.LOCK_EX)
            if path.exists() and path.stat().st_size >= limit:
                archive=path.with_name(path.name+'.'+str(time.time_ns()))
                path.replace(archive)
                # Keep the plain archive if compression fails; no history is lost.
                tmp=Path(str(archive)+'.gz.tmp')
                try:
                    with archive.open('rb') as src, gzip.open(tmp,'wb',compresslevel=1) as dst:
                        shutil.copyfileobj(src,dst,1024*1024)
                    tmp.replace(Path(str(archive)+'.gz'))
                    archive.unlink()
                except OSError:
                    try: tmp.unlink()
                    except OSError: pass
                    raise
            with path.open('a') as out:
                os.chmod(path,0o600)
                out.write(json.dumps(entry,ensure_ascii=False,separators=(',',':'))+'\n')
                out.flush()
        with _guard: _errors.pop(str(path),None)
        return True
    except OSError as error:
        with _guard: _errors[str(path)]={'at':time.time(),'errno':error.errno,'error':str(error)[:240]}
        return False
