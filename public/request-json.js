// Bound the complete request, including a body that stalls after HTTP headers.
// A timeout describes an unknown transport outcome; callers must not invent a
// successful mutation or retry it with a different identity.
export async function requestJSON(url,{fetcher=fetch,timeoutMs=12000,signal,...options}={}) {
  signal?.throwIfAborted();
  const controller=new AbortController();
  const abort=()=>controller.abort(signal.reason);
  signal?.addEventListener('abort',abort,{once:true});
  let timer,onAbort;
  const cancelled=new Promise((_,reject)=>{
    onAbort=()=>reject(controller.signal.reason);
    controller.signal.addEventListener('abort',onAbort,{once:true});
    timer=setTimeout(()=>controller.abort(new DOMException('Connection timed out. Your saved messages are unchanged.','TimeoutError')),timeoutMs);
  });
  try {
    return await Promise.race([cancelled,(async()=>{
      const response=await fetcher(url,{...options,signal:controller.signal});
      const data=await response.json();
      return {response,data};
    })()]);
  } finally {
    clearTimeout(timer);signal?.removeEventListener('abort',abort);
    controller.signal.removeEventListener('abort',onAbort);
  }
}
