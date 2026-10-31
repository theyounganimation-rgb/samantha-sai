// Native resume and browser visibility share one foreground episode ID.
export function createForegroundReporter({send,now=Date.now,id=()=>crypto.randomUUID(),device='web'}={}){
 let active=false,ready=false,pending=null,opening=null,inflight=false;
 async function flush(){
  if(!ready||!pending||inflight)return;inflight=true;const event=pending;
  try{await send(event);if(pending===event)pending=null;}catch(e){if(e.status>=400&&e.status<500&&pending===event)pending=null;}finally{inflight=false;if(pending&&pending!==event&&active)void flush();}
 }
 function open(){if(!active){active=true;opening={id:id(),kind:'open',device,observedAt:new Date(now()).toISOString()};pending=opening;}void flush();}
 function hide(){if(!active)return;active=false;pending=null;if(ready&&opening)void send({...opening,kind:'hidden',observedAt:new Date(now()).toISOString()}).catch(()=>{});}
 return {open,hide,ready(visible){ready=true;if(visible)open();else hide();},check(){if(pending)void flush();else if(ready&&active&&opening)void send({...opening,kind:'visible',observedAt:new Date(now()).toISOString()}).catch(()=>{});},get opening(){return opening;}};
}
