import {createChessUI,pendingChessReply} from './chess.js';
import {reconcileHistory,connectHistory,createHistoryRefresh,captureViewport,restoreViewport} from './history-sync.js';
import {followTextTurn} from './text-reconnect.js';
import {requestJSON} from './request-json.js';
import {createForegroundReporter} from './app-presence.js';
import {setMessageMedia} from './message-media.js';
import {createOrb} from './orb.js';
const $=s=>document.querySelector(s),$$=s=>[...document.querySelectorAll(s)];
let chessUI=null,chessGames=[],chessReply=null;
let historyFeed=null,latestTimeline=null,participant=null;
const speakerLabel=p=>p?.personId==='person-example'?'Guest':p?.name||'Owner';
function showSpeaker(value){if(!value?.speaker)return;showSpeakerChoices(value.choices);participant=value;const b=$('#speaker-button');b.disabled=false;b.textContent='Speaking as '+speakerLabel(value.speaker)+' ▾';b.dataset.guest=String(value.speaker.personId!=='owner');for(const choice of $$('[data-speaker]'))choice.setAttribute('aria-pressed',String(choice.dataset.speaker===value.speaker.personId));if(chessUI)chessUI.speakerChanged();else syncChessReply();}
$('#speaker-button').onclick=async()=>{$('#speaker-dialog').showModal();try{showSpeaker(await api('speaker'));}catch(e){$('#speaker-feedback').textContent=e.message;}};
$('#close-speaker').onclick=()=>$('#speaker-dialog').close();
$('.speaker-choices').onclick=async event=>{const button=event.target.closest('[data-speaker]');if(!button||button.disabled)return;for(const b of $$('[data-speaker]'))b.disabled=true;try{const next=await api('speaker',{method:'POST',body:JSON.stringify({personId:button.dataset.speaker,revision:participant?.revision})});showSpeaker(next);$('#speaker-dialog').close();$('#speaker-feedback').textContent=next.speaker.anonymous?'Samantha will ask who’s speaking. You can also stay anonymous.':'Switch back when it’s your turn again.';}catch(e){$('#speaker-feedback').textContent=e.message;await refreshStatus();}finally{for(const b of $$('[data-speaker]'))b.disabled=false;}};
function showSpeakerChoices(choices){
 if(!Array.isArray(choices))return;
 const box=$('.speaker-choices');
 for(const b of box.querySelectorAll('[data-profile]'))b.remove();
 for(const p of choices.filter(p=>p.personId.startsWith('guest-'))){
  const button=document.createElement('button');button.type='button';button.dataset.speaker=p.personId;button.dataset.profile='true';
  const avatar=document.createElement('span');avatar.className='speaker-avatar';avatar.setAttribute('aria-hidden','true');avatar.textContent=Array.from(p.name)[0];
  const name=document.createElement('span');name.className='speaker-name';name.textContent=p.name;
  const duplicates=choices.filter(other=>other.name===p.name).length>1;
  if(duplicates)name.textContent+=' · '+p.personId.slice(-6);
  button.append(avatar,name);box.insertBefore(button,box.querySelector('[data-speaker="guest"]'));
 }
}

let currentView='chat',chatController=null,lastHistory='',settings={},voices=[],callSocket=null,micStream=null,audioContext=null,micNode=null,sourceNode=null,mute=false,callStart=0,clock=null,voiceState='idle',playAt=0,audioNodes=new Set(),currentAssistant=null,userLive=null,voiceGeneration=0,playbackTimer=null,callAttempt=0,discardAudio=false,currentVoiceTurn=null,currentVoiceDelivered=true,currentVoiceError=null;
const nativeNotice=(event,data={})=>window.webkit?.messageHandlers?.sai?.postMessage({event,...data});
const appPresence=createForegroundReporter({device:window.webkit?.messageHandlers?.sai?(navigator.maxTouchPoints>1&&/Macintosh|iPad/.test(navigator.userAgent)?'ipad':'iphone'):'web',send:event=>api('app-presence',{method:'POST',body:JSON.stringify(event),keepalive:true})});
window.saiDeviceCheck=data=>api('device-check',{method:'POST',body:JSON.stringify({...data,presenceProtocol:1})}).catch(()=>{});
window.saiResume=()=>{setTimeout(reviveOrbs,50);historyLoader.cancel();chessUI?.resume();appPresence.open();refreshStatus();void fetchMood();historyFeed?.reconnect();refreshHistory();void acknowledgeText();if(!chatController&&savedTurn())void beginText(savedTurn(),true);};
window.saiSuspend=()=>{historyLoader.cancel();historyFeed?.close();appPresence.hide();if(!callSocket?.native&&(callSocket||micStream))endCall();};
document.addEventListener('visibilitychange',()=>{if(document.hidden){historyLoader.cancel();historyFeed?.close();appPresence.hide();}else{appPresence.open();historyFeed?.reconnect();void refreshHistory();}});
window.addEventListener('pagehide',()=>{historyLoader.cancel();historyFeed?.close();appPresence.hide();});
window.addEventListener('pageshow',event=>{if(!document.hidden){appPresence.open();if(event.persisted){historyFeed?.reconnect();void refreshHistory();}}});
if(window.webkit?.messageHandlers?.sai){$('#phone-settings-copy').textContent='Connected through Tailscale. Keep it switched on to use SAI away from home.';$('#pair-phone').hidden=true;}
function fitPhoneViewport(){
  if(window.webkit?.messageHandlers?.sai||!window.visualViewport||innerWidth>650)return;
  document.documentElement.style.setProperty('--phone-height',window.visualViewport.height+'px');
  document.body.classList.toggle('keyboard-open',innerHeight-window.visualViewport.height>140);
}
document.addEventListener('pointerdown',e=>{if(document.body.classList.contains('keyboard-open')&&e.target.closest('.messages,.topbar'))document.activeElement?.blur();});
document.addEventListener('focusin',e=>{if(window.webkit?.messageHandlers?.sai&&e.target.matches('textarea,input'))document.body.classList.add('keyboard-open');});
document.addEventListener('focusout',e=>{if(window.webkit?.messageHandlers?.sai&&e.target.matches('textarea,input'))document.body.classList.remove('keyboard-open');});
window.visualViewport?.addEventListener('resize',fitPhoneViewport);window.addEventListener('resize',fitPhoneViewport);fitPhoneViewport();
const reduced=matchMedia('(prefers-reduced-motion: reduce)').matches;
// Native builds 9+ keep the web view full height and report keyboard overlap.
// Keep safe-area-inset-top live; measuring and freezing it at startup can capture zero.
addEventListener('scroll',()=>{if(scrollY||scrollX)scrollTo(0,0);},{passive:true});
document.body.classList.toggle('native-keyboard',!!window.saiNativeKeyboard);
// The keyboard slide runs on the compositor: layout snaps once at the end, and in
// between only `transform` animates on the list and composer (see keyboardSlide
// below). Animating main's padding re-laid out the whole conversation every frame.
let keyboardSlide=null,keyboardApplied=0,nativeSafeBottom=0;
// The composer keeps its home-indicator padding; the keyboard offset absorbs that
// space instead, so the composer still sits 8px above the keyboard without a
// padding change that would move it a different distance than the list.
const keyboardOffset=covered=>Math.max(0,covered-(covered>0?nativeSafeBottom:0));
function keyboardSnap(covered){
  keyboardApplied=covered;
  const root=document.documentElement.style;
  root.setProperty('--keyboard',keyboardOffset(covered)+'px');
  root.setProperty('--keyboard-full',covered+'px');
  document.body.classList.toggle('keyboard-up',covered>0);
}
window.saiKeyboard=({height=0,duration=.25,safeTop,safeBottom}={})=>{
  const root=document.documentElement.style,covered=Math.max(0,Number(height)||0),time=Math.max(0,Number(duration)||0);
  // Ignore unlaid-out startup zeros. Native sends fresh window insets after
  // layout, including rotation; this is not a one-time measurement or freeze.
  if(Number.isFinite(safeTop)&&safeTop>0){
    root.setProperty('--native-safe-top',safeTop+'px');
    if(Number.isFinite(safeBottom)&&safeBottom>=0){root.setProperty('--native-safe-bottom',safeBottom+'px');nativeSafeBottom=safeBottom;}
  }
  root.setProperty('--keyboard-time',time+'s');
  if(keyboardSlide)keyboardSlide(covered,time);else keyboardSnap(covered);
  // Settings have a separate scroll container. Reveal their focused field there,
  // without allowing WebKit to pan the entire page and carry the header with it.
  clearTimeout(window.saiKeyboard.focusTimer);
  window.saiKeyboard.focusTimer=setTimeout(()=>{
    const field=document.activeElement,dialog=field?.closest('dialog[open]');
    if(!dialog||!covered)return;
    const frame=field.getBoundingClientRect(),sheet=dialog.getBoundingClientRect();
    const top=sheet.top+(dialog.querySelector('.dialog-header')?.offsetHeight||0)+8,bottom=sheet.bottom-12;
    if(frame.bottom>bottom)dialog.scrollTop+=frame.bottom-bottom;
    else if(frame.top<top)dialog.scrollTop-=top-frame.top;
  },time*1000);
};
if(window.saiNativeKeyboard)window.saiKeyboard(window.saiKeyboardState||{height:0,duration:0});
function toast(text){$('#toast').textContent=text;$('#toast').hidden=false;clearTimeout(toast.timer);toast.timer=setTimeout(()=>$('#toast').hidden=true,6000);}
async function api(route,options={}){const {response:r,data:d}=await requestJSON('/api/'+route,{...options,headers:{'Content-Type':'application/json',...options.headers}});if(r.status===401)nativeNotice('unauthorized');if(!r.ok)throw Object.assign(new Error(d.error||'Connection failed.'),{status:r.status});return d;}
function view(name){currentView=name;document.body.dataset.view=name;$('#chat-view').hidden=name!=='chat';$('#voice-view').hidden=name!=='voice';$$('[data-view]').forEach(b=>b.classList.toggle('active',b.dataset.view===name));if(name==='chat'){refreshHistory();scrollEnd();}}
$$('[data-view]').forEach(b=>b.onclick=()=>view(b.dataset.view));$('#call-shortcut').onclick=()=>view('voice');
function scrollEnd(){const m=$('#messages');m.scrollTop=m.scrollHeight;$('#new-message-pill').hidden=true;}
$('#new-message-pill').onclick=scrollEnd;
const renderMedia=(wrap,media)=>setMessageMedia(wrap,media,{onLayout:()=>{if(atEnd&&currentView==='chat')scrollEnd();}});
function message(role,text,timestamp,flags={}){const wrap=document.createElement('article');wrap.className='message '+role+(flags.pending?' pending':'');wrap.dataset.at=String(timestamp?new Date(timestamp).getTime():Date.now());if(flags.turnId)wrap.dataset.turnId=flags.turnId;const label=document.createElement('div');label.className='message-label';const actor=flags.speaker||(role==='user'?{personId:'owner',name:'Owner'}:{personId:'samantha',name:'Samantha'});wrap.dataset.personId=actor.personId;wrap.dataset.recipientId=flags.recipient?.personId||'';label.textContent=role==='assistant'?'Samantha':speakerLabel(actor)+(timestamp?' · '+new Date(timestamp).toLocaleTimeString([],{hour:'numeric',minute:'2-digit'}):'');const content=document.createElement('div');content.className='message-text';content.textContent=text;if(text===PHOTO_ONLY)wrap.classList.add('photo-only');wrap.append(label,content);$('#messages').append(wrap);renderMedia(wrap,flags.media);chessUI?.setCard(wrap,flags.game);return {wrap,content,label};}
function syncChessReply(){
  const game=pendingChessReply(chessGames,participant?.speaker?.personId),el=$('#messages'),viewport=captureViewport(el);let changed=false;
  if(game&&!chatController){
    if(!chessReply){$('.empty')?.remove();chessReply=message('assistant','',null,{pending:true,recipient:participant.speaker}).wrap;chessReply.classList.add('chess-reply');chessReply.setAttribute('role','status');chessReply.setAttribute('aria-label','Samantha is choosing her chess move');changed=true;}
    chessReply.dataset.gameId=game.id;
    if(el.lastElementChild!==chessReply){el.append(chessReply);changed=true;}
  }else if(chessReply){chessReply.remove();chessReply=null;changed=true;}
  // Text keeps its own reconnect/stop controls. Chess only shares the normal
  // reply indicator, so it never disables writing or creates a second bubble.
  if(!chatController)$('#reply-status').textContent=game?'Samantha is responding…':'Text here. Talk whenever.';
  if(changed){if(viewport.nearEnd)scrollEnd();else restoreViewport(el,viewport);}
}
let lastHers;
function applyHistory(data,force=false,forceScroll=force){
  if(data.epoch&&data.epoch===latestTimeline?.epoch&&data.sequence<latestTimeline.sequence)return;
  latestTimeline=data;const {messages}=data,signature=JSON.stringify(messages);if(signature===lastHistory&&!force)return;
  const el=$('#messages'),viewport=captureViewport(el);
  reconcileHistory(el,messages,message,{setText:manifest,setMedia:renderMedia,setGame:(wrap,game)=>chessUI?.setCard(wrap,game)});lastHistory=signature;syncChessReply();
  const hers=messages.filter(m=>m.role==='assistant').at(-1)?.id??null;if(lastHers!==undefined&&hers&&hers!==lastHers)orbFlare();lastHers=hers;
  if(!el.querySelector('.message')){const empty=document.createElement('div');empty.className='empty';empty.textContent='Start wherever you are.';el.append(empty);}
  if(viewport.nearEnd||forceScroll)scrollEnd();else{restoreViewport(el,viewport);$('#new-message-pill').hidden=false;}
  if(data.revision)nativeNotice('history_synced',{revision:data.revision,count:messages.length});
  if(data.revision)void api('history-seen',{method:'POST',body:JSON.stringify({revision:data.revision,lastMessageId:messages.at(-1)?.id||null})}).catch(()=>{});
}
let statusRefresh=null;
const historyLoader=createHistoryRefresh({load:signal=>api('history',{signal}),onHistory:applyHistory,onError:error=>{
  if(!lastHistory&&!$('#messages .message')){const div=document.createElement('div');div.className='empty';div.textContent='Your conversation will be here when the Mac reconnects.';$('#messages').replaceChildren(div);}
}});
function refreshHistory(force=false){return historyLoader.refresh(force);}
function refreshStatus(){if(statusRefresh)return statusRefresh;return statusRefresh=loadStatus().finally(()=>{statusRefresh=null;});}
async function loadStatus(){try{const s=await api('status');if(s.participant)showSpeaker(s.participant);settings=s.voice;voiceMode=s.voiceMode||'classic';appPresence.ready(!document.hidden);appPresence.check();nativeNotice('ready');document.body.dataset.link=s.gateway?'online':'waiting';$('#connection-label').textContent=s.gateway?'Connected to Samantha':'Mac reconnecting';$('#side-status').textContent=s.gateway?'Here, in your corner of the world':'Waiting for the connection';$('#connection-dot').classList.toggle('online',s.gateway);$('#owner-dot').classList.toggle('online',s.gateway);const fresh=s.camera.status==='ready'&&Date.now()-Date.parse(s.camera.asOf)<12000;$('#camera-status').classList.toggle('ready',fresh);$('#camera-status').title=fresh?'Mac camera is connected':s.camera.status==='paused'?'Mac camera is paused':'Mac camera is unavailable';if(!callSocket)$('#voice-subtitle').textContent=settings.connected&&settings.voiceId?'':'Connect her voice in Settings to begin.';}catch(e){document.body.dataset.link='offline';$('#connection-label').textContent='Connection unavailable';$('#connection-dot').classList.remove('online');}}
$('#camera-status').onclick=()=>toast($('#camera-status').title);
const input=$('#message-input');// Keep the newest message in view whenever the list changes height: the keyboard opening or closing, the
// composer growing, the phone rotating. The list is re-pinned in the same frame it resizes, so it rides
// up with the keyboard instead of being covered and then snapping into place a moment later.
const thread=$('#messages');let atEnd=true,holdEnd=0;
thread.addEventListener('scroll',()=>{if(performance.now()>holdEnd)atEnd=thread.scrollHeight-thread.scrollTop-thread.clientHeight<90;},{passive:true});
if(window.ResizeObserver)new ResizeObserver(()=>{if(atEnd&&currentView==='chat')thread.scrollTop=thread.scrollHeight;}).observe(thread);
// Compositor-only keyboard slide (native builds). Opening: nothing re-lays out
// until the end; list and composer translate up by the keyboard height, then the
// layout snaps (list shrinks from the bottom, pinned to its end) in the same
// frame the transforms clear, which is pixel-identical to the last animated
// frame. Closing: the list first grows upward under the header (one layout) so
// its content is ready, then both slide down, then the layout snaps. Any new
// keyboard state mid-slide finishes the current one first.
const composerArea=$('.composer-area');let slideState=null;
function finishSlide(){
  if(!slideState)return;const {covered,timer,snapped}=slideState;slideState=null;clearTimeout(timer);
  for(const el of [thread,composerArea]){el.style.transition='';el.style.transform='';el.style.willChange='';}
  thread.style.marginTop='';
  if(!snapped)keyboardSnap(covered);
  // Pin in this same frame rather than waiting for the ResizeObserver.
  if(atEnd)thread.scrollTop=thread.scrollHeight;
}
keyboardSlide=(covered,time)=>{
  finishSlide();
  const delta=keyboardOffset(covered)-keyboardOffset(keyboardApplied);
  if(!delta||!time||reduced||$('#chat-view').hidden||document.querySelector('dialog[open]')||!document.body.classList.contains('native-keyboard')){keyboardSnap(covered);return;}
  // At the end of the conversation the list rides with the composer. Reading
  // older messages, the content stays put and only the composer moves: on
  // opening it covers the bottom of the list, on closing it uncovers it.
  let parts,startY=0,endY=-delta,snapped=false;
  if(atEnd){if(delta<0)thread.style.marginTop=delta+'px';parts=[thread,composerArea];}
  else if(delta>0)parts=[composerArea];
  else{keyboardSnap(covered);snapped=true;parts=[composerArea];startY=delta;endY=0;}
  const ease='cubic-bezier(.38,.7,.125,1)';
  for(const el of parts){el.style.transition='none';el.style.willChange='transform';el.style.transform='translateY('+startY+'px)';}
  void composerArea.offsetHeight;
  for(const el of parts){el.style.transition='transform '+time+'s '+ease;el.style.transform='translateY('+endY+'px)';}
  slideState={covered,timer:setTimeout(finishSlide,time*1000+40),snapped};
  composerArea.addEventListener('transitionend',e=>{if(e.target===composerArea&&e.propertyName==='transform')finishSlide();},{once:true});
};
input.addEventListener('focus',()=>{const gap=thread.scrollHeight-thread.scrollTop-thread.clientHeight;atEnd=true;holdEnd=performance.now()+900;$('#new-message-pill').hidden=true;if(gap>2)thread.scrollTo({top:thread.scrollHeight,behavior:gap>90&&gap<1500&&!reduced?'smooth':'auto'});});input.oninput=()=>{input.style.height='auto';input.style.height=Math.min(input.scrollHeight,160)+'px';};input.onkeydown=e=>{if(e.key==='Enter'&&!e.shiftKey&&!e.isComposing){e.preventDefault();$('#chat-form').requestSubmit();}};
const OUTBOX='sai.pendingText.v1',ACK='sai.pendingTextAck.v1';
function savedTurn(){try{const r=JSON.parse(localStorage.getItem(OUTBOX));return r&&/^[a-zA-Z0-9_-]{16,100}$/.test(r.id)&&typeof r.text==='string'&&r.text.length<=20000?r:null;}catch{return null;}}
function keepTurn(turn){try{turn?localStorage.setItem(OUTBOX,JSON.stringify(turn)):localStorage.removeItem(OUTBOX);}catch{}}
async function acknowledgeText(){let id;try{id=localStorage.getItem(ACK);}catch{return;}if(!id)return;try{await api('delivered',{method:'POST',body:JSON.stringify({id})});if(localStorage.getItem(ACK)===id)localStorage.removeItem(ACK);nativeNotice('text_delivered');}catch{/* A failed receipt must never turn a received reply into a failed message. */}}
// Reply text arrives in uneven bursts. manifest() puts every new word into the page at once, so the
// text in the page is always complete and current, but keeps each word out of the layout until its
// turn. One loop (drawDust) then brings words in at an even pace: a few motes of dust drift to where
// the word will be and the word comes into focus as they land. The same loop eases the reply's
// height toward what it needs and keeps the view pinned to the end, so the conversation glides up
// instead of jumping a block at a time. settle() turns the finished reply back into plain text.
const NOTICE=800,manifesting=new Map(),dust={canvas:null,ctx:null,words:[],running:false,follow:false,last:0};
function manifest(el,text){
  const shown=el.textContent;if(shown===text)return;
  let state=manifesting.get(el);
  if(state&&shown.trim()===text.trim())return; // same words, different trailing space: not worth restarting
  if(shown.length>text.length&&shown.startsWith(text))return; // the page already holds more of this reply than this update does
  if(reduced||(shown&&!text.startsWith(shown))){manifesting.delete(el);el.style.height='';el.classList.remove('growing');el.textContent=text;return;}
  const tail=text.slice(shown.length),parts=tail.split(/(\s+)/).filter(Boolean),words=parts.filter(p=>/\S/.test(p)).length||1,now=performance.now();
  if(!state){const h=el.offsetHeight;state={clock:0,h,waiting:0,floor:h,next:null,from:0,fromH:h,until:0};manifesting.set(el,state);el.classList.add('growing');}
  // Each word waits a moment after it arrives. That notice is what lets the space for a coming line open
  // gradually (see drawDust) instead of all at once when the line begins.
  let start=Math.max(now+NOTICE,state.clock);if(start-now>2800)start=now+2800; // never fall far behind what she has written
  const gap=Math.min(90,1700/words);let i=0,beat=0;
  for(const [k,part] of parts.entries()){
    if(!/\S/.test(part)){
      el.append(part);
      // A blank line is a second text: it lands a beat later, the way a person sends two messages.
      if(/\n\s*\n/.test(part)){const next=parts.slice(k+1).join('').split(/\n\s*\n/)[0]?.length??0;beat+=Math.min(2200,700+next*22);}
      continue;
    }
    const span=document.createElement('span');span.className='w';span.textContent=part;el.append(span);
    dust.words.push({span,el,at:start+beat+i++*gap,on:false,motes:null});state.waiting++;
  }
  state.clock=start+beat+words*gap;el.style.height=state.h+'px';
  if(!dust.running){dust.running=true;dust.last=now;requestAnimationFrame(drawDust);}
}
function settle(){} // the loop below returns a finished reply to plain text by itself
function drawDust(now){
  if(!dust.canvas){dust.canvas=document.createElement('canvas');dust.canvas.className='word-dust';dust.canvas.setAttribute('aria-hidden','true');document.body.append(dust.canvas);dust.ctx=dust.canvas.getContext('2d');}
  const c=dust.canvas,g=dust.ctx,scale=Math.min(2,devicePixelRatio||1),w=Math.round(innerWidth*scale),h=Math.round(innerHeight*scale),dt=Math.min(.05,(now-dust.last)/1000)||.016;dust.last=now;
  if(c.width!==w||c.height!==h){c.width=w;c.height=h;}
  const list=$('#messages'),LIFE=1250;
  // Bring in the words whose turn has come. Every word is already laid out (invisible) from the moment
  // it arrives, so where each line will sit, and when its first word is due, is known in advance.
  for(const word of dust.words)if(!word.on&&now>=word.at){
    word.on=true;word.span.classList.add('on');const state=manifesting.get(word.el);
    if(state){state.waiting--;const bottom=word.span.offsetTop+word.span.offsetHeight;if(bottom>state.floor)state.floor=bottom;}
  }
  // Grow each reply at a steady rate timed to reach the next line just as that line's first word is
  // due, so the space opens continuously instead of a line at a time. Stay at the end while it grows.
  for(const [el,state] of manifesting){
    if(!el.isConnected){manifesting.delete(el);continue;}
    let next=null,nextBottom=0;
    if(state.waiting)for(const word of dust.words){if(word.el!==el||word.on)continue;const bottom=word.span.offsetTop+word.span.offsetHeight;if(bottom>state.floor+1){next=word;nextBottom=bottom;break;}}
    if(next!==state.next){state.next=next;state.from=now;state.fromH=state.h;if(next)state.until=Math.max(next.at,now+200);}
    let goal=state.floor;
    if(next){const p=Math.max(0,Math.min(1,(now-state.from)/(state.until-state.from)));goal=state.fromH+(nextBottom-state.fromH)*p;if(goal<state.floor)goal=state.floor;}
    state.h+=(goal-state.h)*Math.min(1,dt*10);if(Math.abs(goal-state.h)<.3)state.h=goal;
    if(!state.waiting&&state.h===goal&&now>state.clock+1300){el.style.height='';el.classList.remove('growing');manifesting.delete(el);if(el.querySelector('.w'))el.textContent=el.textContent;}
    else el.style.height=state.h+'px';
  }
  if(dust.follow&&manifesting.size)list.scrollTop=list.scrollHeight;
  // dust
  g.clearRect(0,0,w,h);const bounds=list.getBoundingClientRect();
  dust.words=dust.words.filter(word=>word.span.isConnected&&(!word.on||now-word.at<LIFE));
  for(const word of dust.words){
    if(!word.on)continue;
    const r=word.span.getBoundingClientRect();if(r.bottom<bounds.top||r.top>bounds.bottom)continue;
    if(!word.motes){const n=Math.max(7,Math.min(38,Math.round(r.width/2.1)));word.motes=[];for(let i=0;i<n;i++)word.motes.push({tx:Math.random()*r.width,ty:r.height*(.22+Math.random()*.6),ox:(Math.random()-.35)*54,oy:-(6+Math.random()*30)*(Math.random()<.8?1:-.6),wait:Math.random()*.4,size:.7+Math.random()*1.1,sway:Math.random()*6.283,warm:Math.random()<.62});}
    const p=(now-word.at)/LIFE;
    for(const m of word.motes){
      const q=(p-m.wait)/(1-m.wait);if(q<=0||q>=1)continue;
      const ease=1-Math.pow(1-q,3),left=1-ease,x=r.left+m.tx+m.ox*left+Math.sin(m.sway+q*5)*3*left,y=r.top+m.ty+m.oy*left,alpha=Math.pow(Math.sin(Math.PI*q),.7)*(m.warm?.8:.55);
      if(y<bounds.top||y>bounds.bottom)continue;
      g.fillStyle=m.warm?`rgba(214,120,66,${alpha})`:`rgba(70,56,48,${alpha})`;g.fillRect(x*scale,y*scale,m.size*scale,m.size*scale);
    }
  }
  if(dust.words.length||manifesting.size)requestAnimationFrame(drawDust);else{dust.running=false;g.clearRect(0,0,w,h);}
}
function glideEnd(){dust.follow=true;$('#new-message-pill').hidden=true;if(!dust.running)scrollEnd();}
for(const moved of ['wheel','touchmove'])$('#messages').addEventListener(moved,()=>{dust.follow=false;},{passive:true});
async function beginText(turn,resume=false){
  if(chatController)return;$('.empty')?.remove();
  let inHistory=false;try{inHistory=JSON.parse(lastHistory||'[]').some(m=>m.role==='user'&&(m.speaker?.personId||'owner')===(turn.speaker?.personId||'owner')&&m.text===turn.text&&Math.abs(new Date(m.timestamp).getTime()-turn.createdAt)<300000);}catch{}
  // Keep the pre-send boundary across reloads, even if this reply is now saved.
  const historyAfter=Number.isFinite(turn.historyAfter)?turn.historyAfter:resume?0:Math.max(0,...(latestTimeline?.messages??[]).map(m=>new Date(m.timestamp).getTime()).filter(Number.isFinite));
  turn.historyAfter=historyAfter;keepTurn(turn);
  let userBubble=document.querySelector('[data-text-turn="'+turn.id+'"]');
  if((!resume||!inHistory)&&!userBubble){userBubble=message('user',turn.text,turn.createdAt,{speaker:turn.speaker,media:turn.attachments}).wrap;if(!resume)userBubble.classList.add('sent');userBubble.dataset.textTurn=turn.id;userBubble.dataset.turnId=turn.id;userBubble.dataset.historyAfter=String(historyAfter);}
  const existing=[...document.querySelectorAll('.message.assistant')].find(n=>n.dataset.turnId===turn.id&&!n.classList.contains('chess-reply'));
  const output=existing?{wrap:existing,content:existing.querySelector('.message-text'),label:existing.querySelector('.message-label')}:message('assistant','',null,{pending:true,recipient:turn.speaker,turnId:turn.id});output.wrap.dataset.historyAfter=String(historyAfter);if(resume||reduced)scrollEnd();else{const m=$('#messages');m.scrollTo({top:m.scrollHeight,behavior:'smooth'});$('#new-message-pill').hidden=true;}
  const ac=new AbortController();chatController=ac;ac.turn=turn;syncChessReply();
  $('#send-button').hidden=true;$('#stop-button').hidden=false;$('#reply-status').textContent=turn.cancelled?'Stopping response…':'Samantha is responding…';
  try{
    const row=await followTextTurn({turn,signal:ac.signal,onSnapshot:r=>{
      if(userBubble&&!userBubble.dataset.historyId&&Number.isFinite(r.createdAt)){userBubble.dataset.at=String(r.createdAt);userBubble.querySelector('.message-label').textContent=speakerLabel(r.speakerBinding?.speaker||turn.speaker)+' · '+new Date(r.createdAt).toLocaleTimeString([],{hour:'numeric',minute:'2-digit'});}
      // Saved conversation evidence wins over late snapshots from a stopped stream.
      if(output.wrap.dataset.historyId)return;
      if(Number.isFinite(r.updatedAt))output.wrap.dataset.at=String(r.updatedAt);
      if(r.media)renderMedia(output.wrap,r.media);
      if(r.reply){const el=$('#messages'),viewport=captureViewport(el);manifest(output.content,r.reply);if(viewport.nearEnd)glideEnd();else{dust.follow=false;restoreViewport(el,viewport);}}
    },onConnection:state=>{$('#reply-status').textContent=state==='reconnecting'?'Reconnecting · your message is saved':state==='waiting'?'Still waiting for Samantha · your message is saved':'Samantha is responding…';}});
    keepTurn(null);
    if(output.wrap.dataset.historyId){if(row.status==='completed'){try{localStorage.setItem(ACK,row.id);}catch{}void acknowledgeText();}}
    else if(row.status==='completed'&&row.quiet){output.wrap.classList.add('quiet');output.label.textContent='Samantha · read, no reply';output.content.textContent='She read this and chose not to reply right now.';try{localStorage.setItem(ACK,row.id);}catch{}void acknowledgeText();}
    else if(row.status==='completed'){orbFlare();manifest(output.content,row.reply);renderMedia(output.wrap,row.media);settle(output.content);try{localStorage.setItem(ACK,row.id);}catch{}void acknowledgeText();}
    else{output.wrap.classList.add('failed');output.label.textContent=row.status==='stopped'?'Response stopped':'Reply interrupted';if(!row.reply)output.content.textContent=row.error||'Your message is saved, but the reply did not finish.';else toast(row.error);}
  }catch(error){
    if(error.name==='AbortError'&&turn.cancelled){return;}
    if(!output.wrap.dataset.historyId){output.wrap.classList.add('failed');if(!output.content.textContent)output.content.textContent=error.message;}
    if(error.status===401)nativeNotice('unauthorized');
    else if(error.final){keepTurn(null);if(!output.content.textContent||error.status===409)input.value=turn.text;}
    if(!output.wrap.dataset.historyId)toast(error.message);
  }finally{
    output.wrap.classList.remove('pending');chatController=null;$('#send-button').hidden=false;$('#stop-button').hidden=true;syncChessReply();
    if(ac.signal.aborted&&turn.cancelled&&savedTurn()?.id===turn.id){if(!output.wrap.dataset.historyId)output.wrap.remove();void beginText(turn,true);}
    else{if(latestTimeline)applyHistory(latestTimeline,true,false);void refreshHistory();}
  }
}
$('#chat-form').onsubmit=e=>{e.preventDefault();const typed=input.value.trim(),photos=pendingPhotos.filter(p=>p.media);if(chatController)return;if(pendingPhotos.some(p=>!p.media&&!p.error))return toast('Still preparing your photo…');if(!typed&&!photos.length)return;if(!participant)return toast('Wait for the speaker selection to connect.');if(callSocket){toast('Finish the call before sending a text.');return;}input.value='';input.style.height='auto';if(typingAtSend){typingAtSend=false;input.focus({preventScroll:true});}const text=typed||PHOTO_ONLY;clearPhotos();void beginText({id:crypto.randomUUID(),text,createdAt:Date.now(),speaker:participant.speaker,...(photos.length?{photoIds:photos.map(p=>p.media.id),attachments:photos.map(p=>p.media)}:{})});};
// ── Photos ──────────────────────────────────────────────────────────────
// A photo from the camera or the library is shrunk on the phone, uploaded as soon as it is
// chosen, and travels with the next message. Samantha receives the pixels with the message, the
// same way she gets pictures over iMessage; the conversation shows it in your bubble.
const PHOTO_ONLY='[photo]';let pendingPhotos=[];
$('#attach-photo').onclick=()=>{if(pendingPhotos.length>=4)return toast('Up to four photos per message.');$('#photo-input').click();};
$('#photo-input').onchange=e=>{const files=[...e.target.files].slice(0,4-pendingPhotos.length);e.target.value='';for(const f of files)void addPhoto(f);};
function clearPhotos(){pendingPhotos=[];renderTray();}
function renderTray(){const tray=$('#attachment-tray');tray.replaceChildren();tray.hidden=!pendingPhotos.length;for(const p of pendingPhotos){const chip=document.createElement('div');chip.className='attachment'+(p.error?' failed':p.media?'':' preparing');if(p.dataUrl){const img=document.createElement('img');img.src=p.dataUrl;img.alt='';chip.append(img);}const remove=document.createElement('button');remove.type='button';remove.className='attachment-remove';remove.setAttribute('aria-label','Remove photo');remove.textContent='×';remove.onclick=()=>{pendingPhotos=pendingPhotos.filter(x=>x!==p);renderTray();};chip.append(remove);if(p.error){const note=document.createElement('span');note.className='attachment-note';note.textContent=p.error;chip.append(note);}tray.append(chip);}}
async function shrinkPhoto(file){
  const bitmap=await createImageBitmap(file,{imageOrientation:'from-image'});
  let scale=Math.min(1,1600/Math.max(bitmap.width,bitmap.height)),quality=.85,blob;
  for(let attempt=0;attempt<5;attempt++){
    const w=Math.max(1,Math.round(bitmap.width*scale)),h=Math.max(1,Math.round(bitmap.height*scale));
    const c=document.createElement('canvas');c.width=w;c.height=h;const g=c.getContext('2d');g.fillStyle='#fff';g.fillRect(0,0,w,h);g.drawImage(bitmap,0,0,w,h);
    blob=await new Promise(r=>c.toBlob(r,'image/jpeg',quality));
    if(blob&&blob.size<=1200000)return {blob,width:w,height:h,dataUrl:c.toDataURL('image/jpeg',.6)};
    if(quality>.65)quality-=.1;else scale*=.8;
  }
  throw new Error('That photo is too large to send.');
}
async function addPhoto(file){
  if(!file.type.startsWith('image/'))return toast('Choose a photo.');
  const entry={dataUrl:null,media:null,error:null};pendingPhotos.push(entry);renderTray();
  try{
    const {blob,width,height,dataUrl}=await shrinkPhoto(file);entry.dataUrl=dataUrl;renderTray();
    const content=await new Promise((resolve,reject)=>{const r=new FileReader();r.onload=()=>resolve(String(r.result).split(',')[1]);r.onerror=()=>reject(new Error('Could not read the photo.'));r.readAsDataURL(blob);});
    const r=await api('photo',{method:'POST',body:JSON.stringify({content,width,height,fileName:file.name||'photo.jpg'})});
    entry.media=r.media;renderTray();
  }catch(err){entry.error=err.message||'Could not add the photo.';renderTray();toast(entry.error);}
}
// Tapping send must not take focus from the message box. On iPhone that closes the keyboard, which resizes
// the screen in the middle of the send animation. If focus is lost anyway, the submit above takes it straight back.
let typingAtSend=false;for(const press of ['pointerdown','mousedown','touchstart'])$('#send-button').addEventListener(press,e=>{if(document.activeElement===input){typingAtSend=true;if(press!=='touchstart')e.preventDefault();}},{passive:false});
$('#stop-button').onclick=()=>{if(chatController){chatController.turn.cancelled=true;keepTurn(chatController.turn);chatController.abort();}};
async function openSettings(){const d=$('#settings-dialog');d.showModal();$('#settings-feedback').textContent='';try{settings=await api('settings');$('#model-select').value=settings.model;$('#key-form').hidden=settings.connected;$('#account-state').textContent=settings.connected?'ElevenLabs connected':'Connect your ElevenLabs account to get started.';if(settings.connected)await loadVoices();await loadFish();await loadAgent();}catch(e){$('#settings-feedback').textContent=e.message;}}
$('#settings-button').onclick=openSettings;$('#mobile-settings').onclick=openSettings;$('#close-settings').onclick=()=>$('#settings-dialog').close();$('#settings-dialog').onclick=e=>{if(e.target===$('#settings-dialog')){const r=e.target.getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)e.target.close();}};
async function loadVoices(){const d=await api('voices');voices=d.voices;const select=$('#voice-select');select.replaceChildren();const blank=document.createElement('option');blank.value='';blank.textContent='Choose her voice';select.append(blank);for(const v of voices){const o=document.createElement('option');o.value=v.id;o.textContent=v.name;select.append(o);}select.value=settings.voiceId||'';voiceDescription();try{const c=await api('credits');$('#account-state').textContent=`ElevenLabs connected · ${c.remaining.toLocaleString()} included credits remaining`;}catch(e){$('#account-state').textContent='ElevenLabs connected · credit balance unavailable';}try{const m=await api('models');for(const o of $('#model-select').options){const listed=m.models.some(v=>v.id===o.value);if(o.value==='eleven_v4_turbo'&&!listed)o.disabled=true;}}catch{}}
function voiceDescription(){const v=voices.find(v=>v.id===$('#voice-select').value);$('#voice-description').textContent=v?.description||Object.values(v?.labels||{}).join(' · ');}
$('#voice-select').onchange=voiceDescription;$('#key-form').onsubmit=async e=>{e.preventDefault();const b=e.target.querySelector('button');b.disabled=true;$('#settings-feedback').textContent='Connecting…';try{settings=await api('settings',{method:'POST',body:JSON.stringify({apiKey:$('#api-key').value.trim()})});$('#api-key').value='';$('#key-form').hidden=true;await loadVoices();$('#settings-feedback').textContent='Connected. Choose a voice below.';}catch(err){$('#settings-feedback').textContent=err.message;}finally{b.disabled=false;}};
$('#preview-voice').onclick=()=>{const v=voices.find(v=>v.id===$('#voice-select').value);if(!v?.preview)return toast('Choose a voice with a preview first.');const a=$('#preview-audio');a.src=v.preview;a.play().catch(()=>toast('Could not play this preview.'));};
$('#save-voice').onclick=async()=>{const v=voices.find(v=>v.id===$('#voice-select').value);if(!v)return toast('Choose a voice first.');try{settings=await api('settings',{method:'POST',body:JSON.stringify({provider:'elevenlabs',voiceId:v.id,voiceName:v.name,model:$('#model-select').value})});$('#settings-feedback').textContent='ElevenLabs voice saved. Ready for a conversation.';refreshStatus();if(settings.fishConnected)await loadFish();}catch(e){$('#settings-feedback').textContent=e.message;}};
async function loadFish(){
 const panel=$('#fish-voice-panel');if(!panel)return;panel.hidden=!settings.fishConnected;if(!settings.fishConnected)return;
 $('#fish-state').textContent='Checking Fish Audio…';$('#use-fish').disabled=true;
 try{
  const f=await api('fish'),samples=$('#fish-sample');samples.replaceChildren();
  for(const s of f.samples||[]){const o=document.createElement('option');o.value=s.url;o.textContent=s.name;samples.append(o);}
  $('#preview-fish').disabled=!samples.options.length;
  const active=settings.provider==='fish';$('#use-fish').disabled=active||!(f.credit>0);$('#use-eleven').disabled=!active;
  $('#fish-state').textContent=`Calls use ${active?'Fish Audio':'ElevenLabs'}. Fish API credit: $${Number(f.credit).toFixed(2)}.${f.credit>0?'':' Add API credit to try a call; saved samples still play.'}`;
 }catch(e){$('#fish-state').textContent=e.message;$('#use-eleven').disabled=settings.provider!=='fish';}
}
if($('#refresh-fish'))$('#refresh-fish').onclick=loadFish;
if($('#preview-fish'))$('#preview-fish').onclick=()=>{const url=$('#fish-sample').value;if(!url)return;const a=$('#preview-audio');a.src=url;a.play().catch(()=>toast('Could not play the Fish sample. Refresh the balance and try again.'));};
async function chooseProvider(provider){try{settings=await api('settings',{method:'POST',body:JSON.stringify({provider})});await loadFish();refreshStatus();$('#settings-feedback').textContent=`Your next call will use ${provider==='fish'?'Fish Audio':'your saved ElevenLabs voice'}.`;}catch(e){$('#settings-feedback').textContent=e.message;}}
if($('#use-fish'))$('#use-fish').onclick=()=>chooseProvider('fish');if($('#use-eleven'))$('#use-eleven').onclick=()=>chooseProvider('elevenlabs');
let voiceMode='classic';
async function loadAgent(){
 $('#engine-select').value=voiceMode;
 try{const a=await api('eleven/agent');$('#agent-llm-select').value=a.realtimeModel||'eleven_realtime_v1_max';
  $('#agent-state').textContent=!a.connected?'Connect ElevenLabs first.':a.reason==='not-synced'?'The agent has not been created yet. Create it to use realtime calls.':a.reason==='missing-permissions'?'The saved ElevenLabs key has no ElevenAgents permission. Create a key with ElevenAgents read and write in the ElevenLabs dashboard and connect it on the Mac.':a.reason==='native-realtime-not-enabled'?'Native Realtime is not enabled on this agent. Create or update it to apply the selected model.':a.reason?('Agent unreachable: '+(a.error||a.reason)):`Agent ready · ${a.name||'Samantha · SAI'} · ${a.modelName||a.realtimeModel} · voice ${settings.voiceName||'saved'} · synced ${a.syncedAt?new Date(a.syncedAt).toLocaleString():''}`;
 }catch(e){$('#agent-state').textContent=e.message;}
}
$('#refresh-agent').onclick=loadAgent;
$('#sync-agent').onclick=async()=>{const b=$('#sync-agent');b.disabled=true;$('#agent-state').textContent='Syncing the agent with ElevenLabs…';try{const a=await api('eleven/agent',{method:'POST',body:JSON.stringify({realtimeModel:$('#agent-llm-select').value})});$('#agent-state').textContent=`Agent ready · ${a.modelName||a.realtimeModel} · synced just now`;refreshStatus();}catch(e){$('#agent-state').textContent=e.message;}finally{b.disabled=false;}};
$('#engine-select').onchange=async()=>{try{const r=await api('voice-mode',{method:'POST',body:JSON.stringify({mode:$('#engine-select').value})});voiceMode=r.mode;$('#settings-feedback').textContent=voiceMode==='phonic'?'Calls will use Phonic 1.':voiceMode==='eleven'?'Calls will use native Eleven Realtime.':'Calls will use the classic pipeline.';}catch(e){$('#settings-feedback').textContent=e.message;$('#engine-select').value=voiceMode;}};
$('#pair-phone').onclick=async()=>{try{const d=await api('pair-link',{method:'POST',body:'{}'});$('#phone-link').hidden=false;$('#phone-link').value=d.url;$('#phone-link').select();try{await navigator.clipboard.writeText(d.url);$('#pair-note').textContent='Link copied. Open it on your iPhone within 10 minutes. Tailscale must be connected.';}catch{$('#pair-note').textContent='Copy this link and open it on your iPhone within 10 minutes.';}}catch(e){toast(e.message);}};
function setVoiceState(state){voiceState=state;document.body.dataset.voice=state;thinkingTone(state==='thinking');nativeNotice('voice',{state});const text={idle:'',connecting:'Connecting her voice',reconnecting:'Reconnecting microphone',listening:mute?'Microphone muted':'Listening',thinking:'Samantha is thinking',speaking:'Samantha is speaking'};$('#voice-state').textContent=text[state]||state;}
// A quiet, slowly swelling chord while she is thinking, so silence on the call reads as "working on it".
// It goes straight to the speaker, not through the voice analyser, so the ring only ever shows real voices.
let thinking=null;
function thinkingTone(on){
  if(on){
    if(thinking||!audioContext)return;
    try{
      const c=audioContext,now=c.currentTime,out=c.createGain();out.gain.setValueAtTime(0,now);out.gain.linearRampToValueAtTime(.02,now+.7);out.connect(c.destination);
      const swell=c.createGain();swell.gain.value=.55;swell.connect(out);
      const breath=c.createOscillator(),depth=c.createGain();breath.frequency.value=.4;depth.gain.value=.4;breath.connect(depth);depth.connect(swell.gain);breath.start();
      const voices=[[329.63,1],[330.5,.55],[493.88,.5],[659.25,.16]].map(([hz,gain])=>{const o=c.createOscillator(),g=c.createGain();o.type='sine';o.frequency.value=hz;g.gain.value=gain;o.connect(g);g.connect(swell);o.start();return o;});
      thinking={c,out,sources:[...voices,breath]};
    }catch{thinking=null;}
  }else if(thinking){
    const n=thinking;thinking=null;
    try{const now=n.c.currentTime;n.out.gain.cancelScheduledValues(now);n.out.gain.setValueAtTime(n.out.gain.value,now);n.out.gain.linearRampToValueAtTime(0,now+.3);for(const o of n.sources)o.stop(now+.35);}catch{}
  }
}
function voiceTap(){try{if(!outAnalyser||outAnalyser.context!==audioContext){outAnalyser=audioContext.createAnalyser();outAnalyser.fftSize=2048;outAnalyser.smoothingTimeConstant=.5;outAnalyser.connect(audioContext.destination);}return outAnalyser;}catch{return audioContext.destination;}}
function clearAudio(){voiceGeneration++;clearTimeout(playbackTimer);for(const n of audioNodes){try{n.stop();}catch{}}audioNodes.clear();playAt=audioContext?.currentTime||0;}
async function audioChunk(m){if(!audioContext||discardAudio)return;const raw=atob(m.audio),len=Math.floor(raw.length/2),buf=audioContext.createBuffer(1,len,m.sampleRate),data=buf.getChannelData(0);for(let i=0;i<len;i++){let v=raw.charCodeAt(i*2)|(raw.charCodeAt(i*2+1)<<8);if(v&32768)v-=65536;data[i]=v/32768;}const source=audioContext.createBufferSource();source.buffer=buf;source.connect(voiceTap());const start=Math.max(audioContext.currentTime+.025,playAt);source.start(start);playAt=start+buf.duration;audioNodes.add(source);source.onended=()=>audioNodes.delete(source);}
function schedulePlaybackDone(complete=true){const generation=voiceGeneration;clearTimeout(playbackTimer);playbackTimer=setTimeout(()=>{if(generation!==voiceGeneration)return;if(callSocket?.readyState===WebSocket.OPEN){callSocket.send(JSON.stringify({type:complete?'playback_done':'playback_failed',turn:currentVoiceTurn}));if(complete){currentVoiceDelivered=true;nativeNotice('voice_played');}}setVoiceState('listening');},Math.max(0,(playAt-(audioContext?.currentTime||0))*1000)+80);}
function handleVoiceEvent(m,native=false){if(m.type==='live_transcript'){message(m.role,m.text,Date.now(),m.role==='user'?{speaker:m.speakerBinding?.speaker}:{recipient:m.speakerBinding?.recipient});$('#live-caption').textContent=m.text;return;}if(m.type==='live_ready'){$('#voice-subtitle').textContent=m.model==='phonic-1'?'Phonic 1 · Sabrina':m.model==='eleven_realtime_v1_max'?'Eleven Realtime v1 Max':m.model==='eleven_realtime_v1_mini'?'Eleven Realtime v1 Mini':m.model==='elevenlabs-agent'?'Realtime · her own voice':'GPT-Live · Gleam';return;}if(m.type==='speaker'){showSpeaker(m);$('#live-caption').textContent='';}if(m.type==='outing'||m.type==='outing_camera')showOuting(m);if(m.type==='mood')applyMood(m);if(m.type==='state')setVoiceState(m.state);if(m.type==='partial')$('#live-caption').textContent=m.text;if(m.type==='assistant_start'){nativeHeard.her.length=0;discardAudio=false;clearAudio();currentAssistant=null;currentVoiceDelivered=false;currentVoiceTurn=m.turn;currentVoiceError=null;$('#live-caption').textContent='';}if(m.type==='user'){discardAudio=false;userLive=m.text;currentAssistant=null;currentVoiceDelivered=false;currentVoiceTurn=null;currentVoiceError=null;$('#live-caption').textContent=m.text;message('user',m.text,Date.now(),{speaker:m.speakerBinding?.speaker});}if(m.type==='assistant'){currentVoiceTurn=m.turn;if(!currentAssistant)currentAssistant=message('assistant','',null,{recipient:m.speakerBinding?.recipient});currentAssistant.content.textContent=m.text;$('#live-caption').textContent=m.text;}if(m.type==='voice_error'){currentVoiceError=m.error;currentVoiceTurn=m.turn;if(!currentAssistant)currentAssistant=message('assistant','');currentAssistant.wrap.classList.add('flagged');currentAssistant.label.textContent=m.partial?'Samantha · audio incomplete':'Samantha · voice unavailable';const note=document.createElement('div');note.className='voice-error-note';note.textContent=m.error;currentAssistant.wrap.append(note);(!native&&schedulePlaybackDone(false));toast(m.error);}if(m.type==='audio'&&!native)audioChunk(m);if(m.type==='audio_done'&&!native&&!discardAudio){schedulePlaybackDone();if(m.cue!=='ready'){if(latestTimeline)applyHistory(latestTimeline,true);void refreshHistory();}}if(m.type==='interrupted'){if(currentAssistant&&!currentVoiceDelivered&&!currentVoiceError){currentAssistant.wrap.classList.add('flagged');currentAssistant.label.textContent='Samantha · playback interrupted';}discardAudio=true;clearAudio();}if(m.type==='error')toast(m.error);if(m.type==='ended')endCall(true);}
let outingEnabled=false;
function showOuting(event){
 if(event.type==='outing_camera')outingEnabled=event.enabled===true;
 else if(event.active===false)outingEnabled=false;
 const button=$('#outing-toggle');button.setAttribute('aria-pressed',String(outingEnabled));button.querySelector('span').textContent=outingEnabled?'Stop sharing':'Bring me along';
 $('#outing-status').textContent=event.error||(event.quiet?'Sharing your view · quiet company':event.cameraStatus==='paused'?'Camera paused while SAI is in the background. Your call continues.':outingEnabled?(event.analysisStatus==='interpreting'||event.analysisStatus==='waiting'?'Camera connected · interpreting your view…':event.cameraStatus==='on'?'Sharing your view. Keep SAI open for the camera.':'Connecting your camera…'):'Share your phone’s view with Samantha.');
}
$('#outing-toggle').onclick=()=>{if(!window.saiPhoneCamera)return toast('This needs the new SAI iPhone build. Your voice call can continue.');nativeNotice(outingEnabled?'native_outing_stop':'native_outing_start');};
function showActiveCall(started=Date.now()){
  $('#outing-controls').hidden=!window.saiNativeCalls;
  document.body.classList.add('call-active');watchMood(true);$('#start-call').hidden=true;$('#end-call').hidden=false;$('#mute-button').hidden=false;$('#interrupt-button').hidden=false;
  callStart=started;clearInterval(clock);const update=()=>{const seconds=Math.max(0,Math.floor((Date.now()-callStart)/1000));$('#call-time').textContent=`${Math.floor(seconds/60)}:${String(seconds%60).padStart(2,'0')}`;};update();clock=setInterval(update,1000);
}
function nativeTransport(){return {native:true,readyState:WebSocket.OPEN,send(raw){const m=JSON.parse(raw);if(m.type==='end')nativeNotice('native_call_end');if(m.type==='interrupt')nativeNotice('native_call_interrupt');},close(){}};}
let lastNativeSeq=0;
// Sound levels reported by the iPhone app during a native call. Yours arrive live, about eight a second.
// Hers arrive one per chunk of speech as the chunk is RECEIVED, which is ahead of when it is heard, so
// they are kept in order and replayed across the time she is speaking. If the app also sends a live
// `bands` array (a spectrum, 0..1 per band, low to high) with a level, that is used directly instead.
const nativeHeard={user:0,userAt:0,userBands:null,her:[],herFrom:0,herBands:null,herBandsAt:0};
function nativeLevelEvent(m){
  const now=performance.now(),bands=Array.isArray(m.bands)&&m.bands.length>3?m.bands:null;
  if(m.speaker==='assistant'){
    if(bands){nativeHeard.herBands=bands;nativeHeard.herBandsAt=now;return;}
    if(!nativeHeard.her.length)nativeHeard.herFrom=now;
    nativeHeard.her.push(Number(m.level)||0);if(nativeHeard.her.length>600)nativeHeard.her.shift();
  }else{nativeHeard.user=Number(m.level)||0;nativeHeard.userAt=now;nativeHeard.userBands=bands;}
}
// Fills `bands` for the ring from the native reports; returns [loudness, isYours].
function nativeHearing(){
  const now=performance.now(),spread=(source,gain)=>{let sum=0;for(let i=0;i<BANDS;i++){const v=Math.min(1,(Number(source[Math.min(source.length-1,Math.floor(i/BANDS*source.length))])||0)*gain);bands[i]+=(v-bands[i])*(v>bands[i]?.6:.16);sum+=bands[i];}return Math.min(1,sum/BANDS*2.4);};
  if(voiceState!=='speaking')nativeHeard.her.length=0;
  if(nativeHeard.herBands&&now-nativeHeard.herBandsAt<250)return [spread(nativeHeard.herBands,1),false];
  if(voiceState==='speaking'&&nativeHeard.her.length){
    // step through her chunk levels at a steady rate; if they run out before she finishes, sway over the last few
    const q=nativeHeard.her,n=q.length;let at=(now-nativeHeard.herFrom)/230;
    if(at>n-1&&n>1){const tail=Math.min(6,n-1),over=(at-(n-1))%(tail*2);at=n-1-(over<tail?over:tail*2-over);}
    const i=Math.max(0,Math.min(n-1,Math.floor(at))),f=Math.max(0,Math.min(1,at-i)),v=Math.min(1,(q[i]+(q[Math.min(n-1,i+1)]-q[i])*f)*5);
    for(let b=0;b<BANDS;b++)bands[b]+=(v-bands[b])*(v>bands[b]?.5:.2);return [v,false];
  }
  if(now-nativeHeard.userAt<250&&voiceState!=='speaking'){
    if(nativeHeard.userBands)return [spread(nativeHeard.userBands,1),true];
    const v=Math.min(1,nativeHeard.user*5);for(let b=0;b<BANDS;b++)bands[b]=v;return [v,v>.03];
  }
  for(let b=0;b<BANDS;b++)bands[b]*=.88;return [0,false];
}
window.saiNativeEvent=m=>{
  if(m.type==='native_snapshot'){
    if(m.active){callSocket??=nativeTransport();showActiveCall(m.startedAt);setVoiceState(m.state);applyMute(m.muted);}
    for(const e of m.events||[])window.saiNativeEvent(e);
    if(!m.active&&callSocket?.native)endCall(true);
    return;
  }
  if(m.seq&&m.seq<=lastNativeSeq){nativeNotice('native_call_ack',{seq:m.seq});return;}
  if(m.type==='native_open'){callSocket=nativeTransport();showActiveCall(m.startedAt);}
  else if(m.type==='native_mute')applyMute(m.muted);
  else if(m.type==='native_played'){currentVoiceDelivered=m.success;setVoiceState('listening');if(m.success)nativeNotice('voice_played');if(latestTimeline)applyHistory(latestTimeline,true);void refreshHistory();}
  else if(m.type==='native_level')nativeLevelEvent(m);
  else handleVoiceEvent(m,true);
  if(m.seq){lastNativeSeq=m.seq;nativeNotice('native_call_ack',{seq:m.seq});}
};
function applyMute(value){mute=!!value;$('#mute-button').classList.toggle('muted',mute);$('#mute-button').setAttribute('aria-label',mute?'Unmute microphone':'Mute microphone');if(voiceState==='listening')setVoiceState('listening');}
$('#start-call').onclick=async()=>{
  if(chatController)return toast('Let the current text reply finish first.');
  if(voiceMode!=='phonic'&&(!settings.connected||!settings.voiceId)){await openSettings();return;}
  const attempt=++callAttempt;$('#start-call').disabled=true;$('#start-call').hidden=true;$('#end-call').hidden=false;setVoiceState('connecting');
  try{
    if(window.saiNativeCalls){callSocket=nativeTransport();nativeNotice('native_call_start',{mode:voiceMode});return;}
    if(!navigator.mediaDevices?.getUserMedia)throw new Error('Microphone access needs localhost or a secure HTTPS connection.');
    const stream=await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:true,noiseSuppression:true,autoGainControl:true},video:false});if(attempt!==callAttempt){stream.getTracks().forEach(t=>t.stop());return;}micStream=stream;
    audioContext=new AudioContext();await audioContext.resume();await audioContext.audioWorklet.addModule('/microphone.js');sourceNode=audioContext.createMediaStreamSource(micStream);micNode=new AudioWorkletNode(audioContext,'sai-microphone');sourceNode.connect(micNode);const quiet=audioContext.createGain();quiet.gain.value=0;micNode.connect(quiet);quiet.connect(audioContext.destination);try{micAnalyser=audioContext.createAnalyser();micAnalyser.fftSize=2048;micAnalyser.smoothingTimeConstant=.6;sourceNode.connect(micAnalyser);micAnalyser.connect(quiet);}catch{micAnalyser=null;}
    if(attempt!==callAttempt)return;const socket=callSocket=new WebSocket(`${location.protocol==='https:'?'wss':'ws'}://${location.host}/live`);callSocket.binaryType='arraybuffer';
    micNode.port.onmessage=e=>{if(callSocket?.readyState===WebSocket.OPEN){const b=mute?new ArrayBuffer(e.data.byteLength):e.data;callSocket.send(b);}};
    callSocket.onopen=()=>{if(socket!==callSocket)return;socket.send(JSON.stringify({type:'hello',capabilities:['proactive-voice-v1']}));document.body.classList.add('call-active');$('#start-call').hidden=true;$('#end-call').hidden=false;$('#mute-button').hidden=false;$('#interrupt-button').hidden=false;callStart=Date.now();clock=setInterval(()=>{const seconds=Math.floor((Date.now()-callStart)/1000);$('#call-time').textContent=`${Math.floor(seconds/60)}:${String(seconds%60).padStart(2,'0')}`;},1000);};
    callSocket.onmessage=e=>{if(socket!==callSocket)return;try{handleVoiceEvent(JSON.parse(e.data));}catch{toast('Voice connection returned an unreadable event.');}};
    callSocket.onerror=()=>{if(socket===callSocket)toast('Voice connection interrupted.');};callSocket.onclose=()=>{if(socket===callSocket)endCall();};
  }catch(e){if(attempt!==callAttempt)return;toast(e.name==='NotAllowedError'?'Allow microphone access to talk with Samantha.':e.message);endCall();}
  finally{if(attempt===callAttempt)$('#start-call').disabled=false;}
};
function endCall(remote=false){$('#outing-controls').hidden=true;showOuting({active:false});callAttempt++;discardAudio=false;const socket=callSocket;callSocket=null;if(socket&&socket.readyState<2&&!(remote&&socket.native)){try{socket.send(JSON.stringify({type:'end'}));}catch{}socket.close();}clearAudio();micNode?.disconnect();sourceNode?.disconnect();micStream?.getTracks().forEach(t=>t.stop());audioContext?.close().catch(()=>{});audioContext=null;micStream=null;micNode=null;sourceNode=null;outAnalyser=null;micAnalyser=null;clearInterval(clock);$('#call-time').textContent='';document.body.classList.remove('call-active');watchMood(true);$('#start-call').hidden=false;$('#start-call').disabled=false;$('#end-call').hidden=true;$('#mute-button').hidden=true;$('#interrupt-button').hidden=true;$('#mute-button').classList.remove('muted');mute=false;setVoiceState('idle');refreshStatus();}
$('#end-call').onclick=()=>endCall();$('#interrupt-button').onclick=()=>{discardAudio=true;clearAudio();callSocket?.send(JSON.stringify({type:'interrupt'}));};$('#mute-button').onclick=()=>{if(callSocket?.native)nativeNotice('native_call_mute',{muted:!mute});else applyMute(!mute);};window.addEventListener('pagehide',()=>{if(!callSocket?.native)endCall();});
document.addEventListener('keydown',e=>{if((e.metaKey||e.ctrlKey)&&['1','2'].includes(e.key)){e.preventDefault();view(e.key==='1'?'chat':'voice');}});
// ── The orb ─────────────────────────────────────────────────────────────
// A sphere of sky and cloud (orb.js, on the GPU) that is Samantha's presence in the app.
// The same state drives every copy of it: the large one in the voice view, the small one
// in the header of the conversation, the sidebar one on a wide screen. Its sky takes the
// colour of her present functional state (the snapshot that also sets her voice delivery),
// read through /api/call/mood and pushed as a `mood` event when a reply starts. Her voice
// (outAnalyser, on its way to the speaker) lifts and billows the cloud; yours (micAnalyser)
// lays a cool haze over the sky. While she composes, the sky brightens from within and the
// cloud turns faster; when a message of hers arrives it flares for a moment; when the Mac
// is out of reach the colour drains and the sphere goes still.
let canvas=$('#presence');
const BANDS=48,bands=new Float32Array(BANDS);let outAnalyser=null,micAnalyser=null,spectrum=null,level=0,slow=0,whose=0,voiced=0;
function readBands(analyser,gain){
  if(!spectrum||spectrum.length!==analyser.frequencyBinCount)spectrum=new Uint8Array(analyser.frequencyBinCount);
  analyser.getByteFrequencyData(spectrum);const nyquist=analyser.context.sampleRate/2;let sum=0;
  for(let i=0;i<BANDS;i++){ // 80 Hz – 6 kHz, log-spaced: the range a voice lives in
    const lo=80*Math.pow(75,i/BANDS),hi=80*Math.pow(75,(i+1)/BANDS);const a=Math.min(spectrum.length-1,Math.floor(lo/nyquist*spectrum.length)),b=Math.min(spectrum.length,Math.max(a+1,Math.ceil(hi/nyquist*spectrum.length)));
    let peak=0;for(let j=a;j<b;j++)if(spectrum[j]>peak)peak=spectrum[j];
    const v=Math.pow(peak/255,1.7)*gain;bands[i]+=(v-bands[i])*(v>bands[i]?.6:.16);sum+=bands[i];
  }
  return Math.min(1,sum/BANDS*2.4);
}
function hear(){
  let heard=0,mine=false;const micLive=micAnalyser&&voiceState==='listening'&&!mute;
  if(outAnalyser)heard=readBands(outAnalyser,1);
  if(heard<.015&&micLive){heard=readBands(micAnalyser,.75);mine=heard>.03;}
  if(!outAnalyser&&!micLive)for(let i=0;i<BANDS;i++)bands[i]*=.88;
  if(callSocket?.native)[heard,mine]=nativeHearing();
  level+=(heard-level)*(heard>level?.5:.1);
  if(level>.04)whose+=((mine?1:0)-whose)*.14; // whose voice is holding the orb
  voiced+=(Math.min(1,level*3.2)-voiced)*.22;slow+=(level-slow)*.06;
}
// colour: a saturated sky for each feeling; SAI's terracotta and peach when she is settled
const MOOD_COLORS={calm:[79,127,224],curiosity:[31,180,160],happiness:[242,169,59],affection:[226,109,143],gratitude:[232,139,74],anxiety:[123,99,201],sadness:[90,111,168],loneliness:[128,112,170],anger:[226,84,62],embarrassment:[236,120,150]};
const SETTLED=[206,96,66];
const WEIGHT={trace:.3,mild:.55,moderate:.8,strong:1,intense:1};
const AROUSED=['anxiety','anger','curiosity','happiness','embarrassment'];
const orb={paint:[...SETTLED],want:[...SETTLED],energy:.15,wantEnergy:.15,mood:null,moodAt:0,drift:0,churn:0,glow:0,dim:0,swell:0,veil:0,breath:0,flareAt:-1e9,finger:null,views:[]};
// Turn a qualitative state into one sky colour and an energy: the strongest feeling colours
// the sky (background mood at half weight), the second only leans it; settled fills the rest.
function moodPalette(mood){
  if(!mood?.ok)return {sky:SETTLED,energy:.15};
  const score=new Map();
  // October 29 (Owner): a feeling that sits at her standing mood all day (affection, most days) tints the sky; the one that is fresh
  // above it paints it. lift is real_time minus overall from the controller; an older server without it keeps the old weighting.
  const fresh=v=>v.lift==null?1:.5+Math.min(1,Math.max(0,v.lift)/.3);
  for(const [items,scale] of [[mood.current??[],1],[mood.background??[],.5]])for(const v of items){const w=(WEIGHT[v.intensity]??0)*scale*(scale===1?fresh(v):1);if(w>0&&MOOD_COLORS[v.emotion])score.set(v.emotion,Math.max(score.get(v.emotion)??0,w));}
  const ranked=[...score].sort((a,b)=>b[1]-a[1]).slice(0,2);
  if(!ranked.length)return {sky:SETTLED,energy:.15};
  // the feeling's own hue carries: a trace only tints her settled sky, anything mild or more is that colour
  const [name,w]=ranked[0],c=MOOD_COLORS[name],mix=Math.max(.45,Math.min(1,.5+(w-.3)*1.8));
  let sky=SETTLED.map((v,j)=>v+(c[j]-v)*mix);
  if(ranked[1]){const d=MOOD_COLORS[ranked[1][0]],k=.15*Math.min(1,ranked[1][1]);sky=sky.map((v,j)=>v+(d[j]-v)*k);}
  const arousal=Math.max(0,...ranked.filter(([n])=>AROUSED.includes(n)).map(([,w])=>w));
  const low=mood.wellbeing==='low'||mood.wellbeing==='strained';
  return {sky:sky.map(Math.round),energy:Math.min(1,.15+arousal*.6-(low?.05:0))};
}
function applyMood(mood){orb.mood=mood;orb.moodAt=performance.now();const {sky,energy}=moodPalette(mood);orb.want=[...sky];orb.wantEnergy=energy;}
let moodTimer=null,moodPending=null;
function fetchMood(){if(moodPending)return moodPending;return moodPending=api('call/mood').then(applyMood).catch(error=>applyMood({ok:false,reason:(error.status?'HTTP '+error.status+' ':'')+error.message})).finally(()=>{moodPending=null;});}
// Her state is read whenever the app is open: every 20 s, 8 s during a call, and as soon as a message of hers arrives.
function watchMood(on){clearInterval(moodTimer);moodTimer=null;if(on){void fetchMood();moodTimer=setInterval(()=>{if(!document.hidden)void fetchMood();},callSocket?8000:20000);}}
function orbFlare(){orb.flareAt=performance.now();void fetchMood();}
// Tap a small orb and it says what it is showing: the strongest present feelings, what sits underneath, how she is overall.
function moodLabel(mood){
  if(!mood)return 'Her state has not been read yet.';
  if(!mood.ok)return 'Her state is not readable right now'+(mood.reason?' ('+mood.reason.replace(/-/g,' ')+').':'.');
  const rank=items=>(items??[]).filter(v=>(WEIGHT[v.intensity]??0)>0&&MOOD_COLORS[v.emotion]).sort((a,b)=>WEIGHT[b.intensity]-WEIGHT[a.intensity]);
  const current=rank(mood.current),background=rank(mood.background);
  const parts=[];
  if(current.length)parts.push(current.slice(0,2).map(v=>v.emotion+' · '+v.intensity).join(', '));else parts.push('nothing in particular right now');
  if(background.length)parts.push(background[0].emotion+' underneath');
  if(mood.wellbeing&&mood.wellbeing!=='uncertain')parts.push('feeling '+mood.wellbeing);
  return parts.join(' · ');
}
function showMoodLabel(){toast(moodLabel(orb.mood));fetchMood().then(()=>{if(!$('#toast').hidden)toast(moodLabel(orb.mood));});}
function bindMoodClick(el){el?.addEventListener('click',showMoodLabel);}
for(const id of ['#header-orb','#side-orb'])bindMoodClick($(id));
// Every orb on the page: a canvas, its renderer, and how to size it. The voice orb fills the open
// space between the heading and the controls; the others are the size their CSS gives them.
function addOrb(el,size){if(!el)return;const r=createOrb(el);if(!r){el.classList.add('orb-fallback');return;}orb.views.push({el,r,size,px:0});}
// October 25 (Owner): after the app sat in the background (a switch to another app mid-call), iOS drops the WebGL context and the
// orb came back as a black square. When the page is visible again, any orb whose context is gone gets a fresh renderer.
function reviveOrbs(){const now=Date.now();for(const v of orb.views){if(!v.r.dead||now-(v.revivedAt||0)<2000)continue;v.revivedAt=now;try{v.r.destroy();}catch{}
  // A canvas whose context is gone hands back the same dead context, so the orb moves to a fresh canvas with the same id, classes and handlers.
  const fresh=v.el.cloneNode(false);fresh.classList.remove('drawn','orb-fallback');v.el.replaceWith(fresh);if(v.el===canvas){canvas=fresh;bindPresencePointer(fresh);}else bindMoodClick(fresh);v.el=fresh;
  const r=createOrb(fresh);if(!r){fresh.classList.add('orb-fallback');continue;}v.r=r;v.px=0;v.css=null;v.paper=null;v.drawn=false;}}
window.saiReviveOrbs=reviveOrbs;window.saiOrbState=()=>orb.views.map(v=>({id:v.el.id,dead:v.r.dead,px:v.px,drawn:!!v.drawn}));
for(const when of ['visibilitychange','pageshow','focus'])window.addEventListener(when,()=>{if(!document.hidden)setTimeout(reviveOrbs,50);});
addOrb($('#presence'),()=>{const sp=$('.voice-spacer');const w=sp.clientWidth,h=sp.clientHeight;if(!w||!h)return 0;return Math.min(w*.8,h*.92,480);});
addOrb($('#header-orb'),()=>46);addOrb($('#side-orb'),()=>92);
function sizeOrb(v){const css=v.size();if(!css)return false;const want=Math.round(css);if(v.css!==want){v.css=want;v.el.style.width=v.el.style.height=want+'px';}
  const px=Math.min(720,Math.round(want*Math.min(2,devicePixelRatio||1)));if(px!==v.px)v.px=v.r.resize(px);return true;}
function orbTouch(e){const v=orb.views[0];if(!v||!v.px)return;const b=v.el.getBoundingClientRect(),R=b.width*.39;orb.finger=[(e.clientX-b.left-b.width/2)/R,-(e.clientY-b.top-b.height/2)/R];}
function bindPresencePointer(el){el.addEventListener('pointerdown',orbTouch);el.addEventListener('pointermove',e=>{if(e.pointerType==='mouse'&&!e.buttons){orb.finger=null;return;}orbTouch(e);});for(const end of ['pointerup','pointercancel','pointerleave'])el.addEventListener(end,()=>orb.finger=null);}
bindPresencePointer(canvas);
// each orb takes the colour of whatever is behind it
function behind(el){for(let e=el.parentElement;e;e=e.parentElement){const m=getComputedStyle(e).backgroundColor.match(/rgba?\((\d+), ?(\d+), ?(\d+)(?:, ?([\d.]+))?\)/);if(m&&(m[4]===undefined||+m[4]>0))return [+m[1],+m[2],+m[3]];}return [246,241,234];}
let lastFrame=performance.now();
function draw(){
  const now=performance.now(),dt=Math.min(.05,(now-lastFrame)/1000);lastFrame=now;
  const inVoice=currentView==='voice',live=!document.hidden;
  const next=()=>{if(live&&inVoice)requestAnimationFrame(draw);else if(live)setTimeout(()=>requestAnimationFrame(draw),42);else setTimeout(draw,400);};
  if(!orb.views.length||!live)return next();
  hear();
  const t=now/1000,still=reduced?.35:1;
  const thinking=inVoice?(voiceState==='thinking'||voiceState==='connecting'):!!chatController;
  const away=document.body.dataset.link!=='online';
  const flare=Math.exp(-(now-orb.flareAt)/1400);
  // ease everything toward where it should be
  for(let j=0;j<3;j++)orb.paint[j]+=(orb.want[j]-orb.paint[j])*Math.min(1,dt*1.6);
  orb.energy+=(orb.wantEnergy-orb.energy)*Math.min(1,dt*1.2);
  orb.glow+=(Math.min(1,(thinking?.7:0)+flare)-orb.glow)*Math.min(1,dt*2.5);
  orb.dim+=((away?1:0)-orb.dim)*Math.min(1,dt*1.5);
  const hers=1-whose,yours=whose;
  orb.swell+=((inVoice?level*hers:0)-orb.swell)*Math.min(1,dt*6);
  orb.veil+=((inVoice?Math.min(.7,yours*level*1.1):0)-orb.veil)*Math.min(1,dt*3);
  const alive=(1-orb.dim*.9)*still;
  orb.drift+=dt*(.03+orb.swell*.1+orb.energy*.025+orb.glow*.03+flare*.08)*alive;
  orb.churn+=dt*(.22+orb.swell*.8+orb.energy*.2+(thinking?.75:0)+flare*.6)*alive;
  const sky=orb.paint,horizon=sky.map(v=>v+(255-v)*.58);
  const state={t,skyTop:sky,skyHorizon:horizon,cloud:[255,249,240],line:.2+Math.sin(t*.37)*.025*still,drift:orb.drift,churn:orb.churn,swell:orb.swell,veil:orb.veil,glow:orb.glow,dim:orb.dim,scale:1+(.012*Math.sin(t*1.05)+orb.swell*.03)*alive};
  for(const v of orb.views){
    const wanted=v.el===canvas?inVoice:v.el.offsetParent!==null;
    if(v.r.dead){reviveOrbs();if(v.r.dead)continue;}
    if(!wanted||!sizeOrb(v))continue;
    if(!v.paper)v.paper=behind(v.el);
    v.r.frame({...state,paper:v.paper,finger:v.el===canvas?orb.finger:null});
    if(!v.drawn){v.drawn=true;v.el.classList.add('drawn');}
  }
  next();
}draw();
// Dark mode (October 25): the orb paints its own paper, sampled once from the page; sample again whenever the theme changes.
window.addEventListener('sai-theme',()=>{for(const v of orb.views)v.paper=null;});
chessUI=createChessUI({api,getSpeaker:()=>participant?.speaker,onHistory:()=>void refreshHistory(),onGames:games=>{chessGames=games;syncChessReply();},notify:toast});
async function init(){const hash=new URLSearchParams(location.hash.slice(1));if(hash.get('pair')){try{await api('pair',{method:'POST',body:JSON.stringify({code:hash.get('pair')})});history.replaceState(null,'','/');toast('Your iPhone is connected to Samantha.');}catch(e){nativeNotice('pairing_failed',{error:e.message});toast(e.message);}}
  // App readiness, pending reply recovery and history are independent. A slow
  // history read must never prevent reconnecting to an already accepted reply.
  void refreshStatus();watchMood(true);historyFeed=connectHistory({onHistory:data=>applyHistory(data)});
  void refreshHistory(true);void acknowledgeText();if(savedTurn())void beginText(savedTurn(),true);
  setInterval(()=>{if(!document.hidden){void refreshStatus();void refreshHistory();}},30000);
  // Recover startup even if the first status request fails while the VPN wakes.
  setInterval(()=>{if(!document.hidden&&document.body.dataset.link!=='online')void refreshStatus();},5000);
}init();
