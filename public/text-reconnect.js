const terminal=s=>['completed','failed','stopped','interrupted'].includes(s);
const sleep=(ms,signal)=>new Promise((resolve,reject)=>{signal?.throwIfAborted();const stop=()=>{clearTimeout(timer);reject(signal.reason);};const timer=setTimeout(()=>{signal?.removeEventListener('abort',stop);resolve();},ms);signal?.addEventListener('abort',stop,{once:true});});
async function request(fetcher,url,options,signal){
  const ac=new AbortController(),abort=()=>ac.abort(signal.reason);signal?.throwIfAborted();signal?.addEventListener('abort',abort,{once:true});
  const timer=setTimeout(()=>ac.abort(new DOMException('Connection timed out','TimeoutError')),25000);
  try{return await fetcher(url,{...options,signal:ac.signal});}finally{clearTimeout(timer);signal?.removeEventListener('abort',abort);}
}
async function checked(response){
  if(response.ok)return response;
  const body=await response.json().catch(()=>({}));
  const err=Object.assign(new Error(body.error||'Connection unavailable.'),{status:response.status});
  // Transient server/network failures are resumable with the same request ID.
  err.final=response.status>=400&&response.status<500&&response.status!==408&&response.status!==429;throw err;
}
export async function followTextTurn({turn,signal,onSnapshot=()=>{},onConnection=()=>{},fetcher=fetch,wait=sleep,pollMs=15000,requestTimeoutMs=12000,now=Date.now}) {
  let admitted=false,attempt=0;
  let latest=null;
  const snapshot=row=>{
    if(latest&&Number.isFinite(row.updatedAt)&&row.updatedAt<latest.updatedAt)return;
    latest=row;onSnapshot(row);
    onConnection(!terminal(row.status)&&!row.reply&&now()-Number(row.createdAt||now())>=20000?'waiting':'connected');
  };
  const readJSON=async(url,options={})=>{
    const {response,data}=await requestJSON(url,{...options,fetcher,signal,timeoutMs:requestTimeoutMs});
    if(!response.ok)await checked(new Response(JSON.stringify(data),{status:response.status}));
    return data;
  };
  for(;;){
    signal?.throwIfAborted();
    try{
      if(turn.cancelled){
        const row=await readJSON('/api/chat/'+turn.id+'/stop',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});snapshot(row);return row;
      }
      if(!admitted){
        const row=await readJSON('/api/chat',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({requestId:turn.id,text:turn.text,speakerId:turn.speaker?.personId,...(turn.photoIds?.length?{photoIds:turn.photoIds}:{})})});
        admitted=true;snapshot(row);if(terminal(row.status))return row;
      }
      const response=await checked(await request(fetcher,'/api/chat/'+turn.id+'/events',{},signal));
      if(latest)snapshot(latest);else onConnection('connected');attempt=0;
      const reader=response.body.getReader(),decoder=new TextDecoder();let buffer='';
      const cancel=()=>reader.cancel().catch(()=>{});signal?.addEventListener('abort',cancel,{once:true});
      try{
        let pendingRead=null,nextPoll=now()+pollMs;
        for(;;){
          signal?.throwIfAborted();let timer;
          pendingRead??=reader.read();
          const result=await Promise.race([pendingRead,new Promise(resolve=>{timer=setTimeout(()=>resolve(null),Math.max(0,nextPoll-now()));})]).finally(()=>clearTimeout(timer));
          if(result===null){
            // A proxy can keep an SSE connection open while its final event was
            // lost. Ask for this same durable turn, never submit another one.
            const row=await readJSON('/api/chat/'+turn.id);snapshot(row);
            if(terminal(row.status))return row;
            nextPoll=now()+pollMs;continue;
          }
          pendingRead=null;
          const {done,value}=result;if(done)break;
          buffer+=decoder.decode(value,{stream:true});let boundary;
          while((boundary=/\r?\n\r?\n/.exec(buffer))){
            const block=buffer.slice(0,boundary.index);buffer=buffer.slice(boundary.index+boundary[0].length);
            const line=block.split(/\r?\n/).find(l=>l.startsWith('data:'));if(!line)continue;
            const row=JSON.parse(line.slice(5));if(row.type!=='snapshot')continue;
            snapshot(row);if(terminal(row.status))return row;
          }
          if(buffer.length>262144)throw Error('Reply stream could not be read.');
        }
      }finally{signal?.removeEventListener('abort',cancel);await reader.cancel().catch(()=>{});}
      // EOF without completion is a dropped stream, never a finished reply.
      throw Error('Connection interrupted.');
    }catch(error){
      signal?.throwIfAborted();if(error.final)throw error;
      onConnection('reconnecting');await wait(Math.min(6000,700*2**Math.min(attempt++,4)),signal);
    }
  }
}
import {requestJSON} from './request-json.js';
