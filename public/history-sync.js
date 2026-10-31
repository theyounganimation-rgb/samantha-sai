// Reconcile saved messages with bubbles already streaming on this device.
// Never clear the active reply, input draft, or call to show an iMessage update.
export function reconcileHistory(container,messages,makeMessage,{now=Date.now(),setText=(el,text)=>{el.textContent=text;},setMedia=()=>{},setGame=()=>{}}={}) {
  const old=[...container.querySelectorAll('.message')],used=new Set(),nodes=[];
  const epoch=x=>{const n=typeof x==='number'?x:Date.parse(x);return Number.isFinite(n)?n:now;};
  for(const m of messages){
    const id=String(m.id),at=epoch(m.timestamp);
    // October 25 (Owner): a reply saved under a different run id (the gateway re-ran a turn after the phone's stream detached) is
    // still the same reply; the text and people decide, and the turn id only when it is actually bound. Otherwise the saved copy
    // appeared beside the streamed one and she looked like she said the same thing twice.
    const samePeopleLoose=n=>!n.classList.contains('chess-reply')&&(!n.dataset.personId||n.dataset.personId===(m.speaker?.personId||(m.role==='user'?'owner':'samantha')))&&(!n.dataset.recipientId||n.dataset.recipientId===(m.recipient?.personId||(m.role==='assistant'?'owner':'samantha')));
    const samePeople=n=>samePeopleLoose(n)&&(!Object.hasOwn(m,'turnId')||!n.dataset.turnId||m.turnId===n.dataset.turnId);
    const bound=n=>!m.game&&!n.classList.contains('has-chess')&&samePeople(n)&&!used.has(n)&&!n.dataset.historyId&&n.classList.contains(m.role)&&m.turnId&&n.dataset.turnId===m.turnId;
    // Only a finished local bubble with the identical text may merge across run ids; a failed or still-pending one keeps its own turn.
    const sameReply=n=>samePeople(n)||(samePeopleLoose(n)&&!n.classList.contains('failed')&&!n.classList.contains('pending'));
    const matching=n=>!m.game&&!n.classList.contains('has-chess')&&sameReply(n)&&!used.has(n)&&!n.dataset.historyId&&n.classList.contains(m.role)&&n.querySelector('.message-text')?.textContent===m.text&&(m.text.trim()||n.dataset.mediaSignature===JSON.stringify(m.media??[]))&&at>Number(n.dataset.historyAfter||0)&&Math.abs(Number(n.dataset.at||now)-at)<180000;
    // A reply still appearing on screen holds the start of the saved text. Adopt that bubble and let
    // the rest arrive the same way, instead of adding a finished copy beside it and dropping it later.
    const appearing=n=>{if(m.game||n.classList.contains('has-chess'))return false;const shown=n.querySelector('.message-text')?.textContent||'';return samePeople(n)&&!used.has(n)&&!n.dataset.historyId&&n.classList.contains(m.role)&&(n.classList.contains('pending')||n.classList.contains('failed')||n.querySelector('.w'))&&shown.length>=12&&shown!==m.text&&m.text.startsWith(shown)&&at>Number(n.dataset.historyAfter||0)&&Math.abs(Number(n.dataset.at||now)-at)<180000;};
    let node=old.find(n=>n.dataset.historyId===id)||old.find(bound)||old.find(matching)||old.find(appearing);
    if(!node)node=makeMessage(m.role,m.text,m.timestamp,{turnId:m.turnId,speaker:m.speaker,recipient:m.recipient,media:m.media,game:m.game}).wrap;
    used.add(node);node.dataset.personId=m.speaker?.personId||(m.role==='user'?'owner':'samantha');node.dataset.recipientId=m.recipient?.personId||(m.role==='assistant'?'owner':'samantha');if(m.role==='user'){const name=m.speaker?.personId==='person-example'?'Guest':m.speaker?.name||'Owner';node.querySelector('.message-label').textContent=name+' · '+new Date(at).toLocaleTimeString([],{hour:'numeric',minute:'2-digit'});}
    node.dataset.historyId=id;node.dataset.at=String(at);
    if(m.turnId)node.dataset.turnId=m.turnId;
    if(m.role==='assistant'&&node.classList.contains('failed')){node.classList.remove('failed');if(!node.classList.contains('flagged'))node.querySelector('.message-label').textContent='Samantha';}
    const content=node.querySelector('.message-text');if(content.textContent!==m.text)setText(content,m.text);
    setMedia(node,m.media??[]);setGame(node,m.game);
    nodes.push(node);
    // A canonical event can arrive just before the last streamed fragment.
    // On the next reconciliation, collapse that now-complete local duplicate.
    for(const other of old)if(other!==node&&(bound(other)||matching(other)||appearing(other)))used.add(other);
  }
  for(const node of old)if(!used.has(node)&&!node.dataset.historyId)nodes.push(node);
  // A pending reply is live UI, not a dated historical message. Server
  // acceptance can be later than its local creation (or the phone clock can
  // lag), so timestamp sorting alone moves the typing bubble above its input.
  nodes.sort((a,b)=>Number(a.classList.contains('pending'))-Number(b.classList.contains('pending'))||Number(a.dataset.at)-Number(b.dataset.at));
  // Reparenting all bubbles through a fragment restarts CSS animations and
  // invalidates the phone's scroll anchor on every incoming history event.
  const dividers=[...container.querySelectorAll('.day-divider')],desired=[];let day='';
  for(const node of nodes){
    const label=node.classList.contains('pending')&&day?day:new Date(Number(node.dataset.at)||now).toLocaleDateString([],{month:'long',day:'numeric'});
    if(label!==day){let divider=dividers.find(d=>d.textContent===label&&!desired.includes(d));if(!divider){divider=document.createElement('div');divider.className='day-divider';divider.textContent=label;}desired.push(divider);day=label;}
    desired.push(node);
  }
  const keep=new Set(desired);
  for(const node of [...container.childNodes])if(!keep.has(node))node.remove();
  let cursor=container.firstChild;
  for(const node of desired){if(node!==cursor)container.insertBefore(node,cursor);cursor=node.nextSibling;}
}

export function captureViewport(container) {
  const value={nearEnd:container.scrollHeight-container.scrollTop-container.clientHeight<150,scrollTop:container.scrollTop,anchors:[]};
  if(value.nearEnd)return value;
  const top=container.getBoundingClientRect().top;
  for(const node of container.querySelectorAll('.message')){const rect=node.getBoundingClientRect();if(rect.bottom>top)value.anchors.push({node,offset:rect.top-top});if(value.anchors.length===3)break;}
  return value;
}

export function restoreViewport(container,before) {
  const anchor=before.anchors.find(a=>a.node.parentNode===container);
  if(anchor)container.scrollTop+=anchor.node.getBoundingClientRect().top-container.getBoundingClientRect().top-anchor.offset;
  else container.scrollTop=before.scrollTop;
}

// An iOS resume must not join an HTTP read started before suspension. Ignore
// even a late response from a transport that did not honor cancellation.
export function createHistoryRefresh({load,onHistory,onError=()=>{}}) {
  let active=null;
  return {
    refresh(force=false){
      if(active)return active.promise;
      const current={controller:new AbortController()};active=current;
      current.promise=Promise.resolve().then(()=>load(current.controller.signal)).then(data=>{
        if(active===current&&!current.controller.signal.aborted)onHistory(data,force);
        return data;
      }).catch(error=>{if(active===current&&!current.controller.signal.aborted)onError(error);}).finally(()=>{if(active===current)active=null;});
      return current.promise;
    },
    cancel(){const old=active;active=null;old?.controller.abort(new DOMException('History refresh suspended.','AbortError'));}
  };
}

export function connectHistory({onHistory,onError=()=>{},EventSourceClass=EventSource}) {
  let source;
  const connect=()=>{
    source?.close();source=new EventSourceClass('/api/history/events');
    source.onmessage=e=>{try{const data=JSON.parse(e.data);if(Array.isArray(data.messages))onHistory(data);}catch(error){onError(error);}};
    source.onerror=onError; // EventSource reconnects and the server sends a fresh snapshot.
  };
  connect();return {reconnect:connect,close:()=>source?.close()};
}
