import {readSystemUpdates,renderSystemUpdates} from './system-updates.mjs';
import {boostVoicePCM} from './voice-output.mjs';
import {createIncomingCalls} from './incoming-calls.mjs';
import {createMessageNotifications} from './message-notifications.mjs';
import {createIncomingPush} from './incoming-push.mjs';
import {createChessService} from './chess-service.mjs';
import {chessGateway} from './chess-gateway.mjs';
import {createOutingRuntime,OUTING_ROOT} from './outing-runtime.mjs';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import {execFile,spawn} from 'node:child_process';
import {promisify} from 'node:util';
import WebSocket,{WebSocketServer} from 'ws';
import {publicSettings,visibleHistory,sseEvents,originAllowed} from './core.mjs';
import {createSpeakerState} from './speaker-state.mjs';
import {createAppPresence} from './app-presence.mjs';
import {SPEAKERS,speakerBinding} from './integrations/activity-recall/speaker-context.mjs';
import {createContactLedger} from './contact.mjs';
import {conversationWorkContext} from './context.mjs';
import {gatewayChat} from './gateway-chat.mjs';
import {voiceResponsePolicy} from './voice-response-policy.mjs';
import {VoiceEngagement} from './voice-engagement.mjs';
import {VoiceInterruption} from './voice-interruption.mjs';
import {transcriptionURL} from './transcription.mjs';
import {VoicePendingInput} from './voice-pending-input.mjs';
import {prefetchReply} from './prefetched-reply.mjs';
import {describeSpeechFailure} from './speech-failure.mjs';
import {sessionStore,sessionCookie} from './sessions.mjs';
import {readVoiceSnapshot,deliveryFor,EmotionalVoiceStream,dialogueInput,registerFor} from './emotional-voice.mjs';
import {SpeechPhraser} from './speech-phrasing.mjs';
import {CallInitiative,OutreachReceipts} from './proactive-call.mjs';
import {createTextTurns,textOwner,streamTextTurn} from './text-turns.mjs';
import {createBeats} from './beats.mjs';
import {spokenOnCall} from './chess-speech.mjs';
import {liveCameraFrame,createSeenFrameRecorder} from './camera-frame.mjs';
const recordSeenFrame=createSeenFrameRecorder({log:(k,v)=>safeLog(k,v)});
import {CallContinuation,CONTINUE_PROMPT,STANDBY_PROMPT} from './call-continuation.mjs';
import {createConversationFeed,streamConversation} from './conversation-feed.mjs';
import {projectVoiceTurnRepairs} from './voice-turn-repair.mjs';
import {createMessageMediaStore} from './message-media-store.mjs';
import {serveMedia} from './media-response.mjs';
import {CallTransport} from './call-transport.mjs';
import {CallCreditMonitor,transientVoiceFailure} from './voice-recovery.mjs';
import {ElevenAgentCall,ELEVEN_MODE} from './eleven-call.mjs';
import {PhonicCall} from './phonic-call.mjs';
import {resolveVoiceMode} from './phonic-mode.mjs';
import {createSaidNext} from './said-next.mjs';
import {BACKGROUND_JOB} from './app-presence.mjs';
import {FishSpeechSocket,fishCredit,fishStatus,requireFishCredit,FISH_VOICE} from './fish-voice.mjs';
import {DEFAULT_REALTIME_MODEL,REALTIME_MODELS,nativeConversationToken,syncAgent,conversationToken,conversationDetails,agentStatus,DEFAULT_LLM,ALLOWED_LLMS} from './eleven-agent.mjs';
import {LiveVoiceCall} from './live-voice.mjs';
import {runLiveMemory,stopLiveMemory} from './live-context.mjs';
import {announceCallReady} from './ready-cue.mjs';
const exec=promisify(execFile),ROOT=path.dirname(new URL(import.meta.url).pathname);
const DATA=process.env.SAI_DATA_DIR||path.join(os.homedir(),'Library/Application Support/SAI');
const PORT=Number(process.env.SAI_PORT||18506),REMOTE='sai.example.invalid:18507';
const allowedHosts=new Set([`127.0.0.1:${PORT}`,`localhost:${PORT}`,REMOTE]);
process.umask(0o077);await fs.mkdir(DATA,{recursive:true,mode:0o700});
const read=async(name,fallback={})=>{try{return JSON.parse(await fs.readFile(path.join(DATA,name),'utf8'));}catch{return fallback;}};
const save=async(name,v)=>{const p=path.join(DATA,name),temp=p+'.'+crypto.randomUUID()+'.tmp';await fs.writeFile(temp,JSON.stringify(v,null,2),{mode:0o600});await fs.rename(temp,p);};
let settings=await read('settings.json');let fishSettings=await read('fish.json');let elevenAgent=await read('eleven-agent.json');const sessions=await sessionStore(path.join(DATA,'sessions.json'));let pairing=null;let activeCall=null;
const voiceModes=await read('voice-modes.json');
const voiceTurnRepairs=await read('phonic-turn-repairs.json');
const speakers=await createSpeakerState({file:path.join(DATA,'speakers.json')});
const recordContact=createContactLedger({enabled:!process.env.SAI_SESSION_KEY||process.env.SAI_SESSION_KEY==='agent:samantha:main'});
const outreachReceipts=new OutreachReceipts({persist:entries=>save('outreach-receipts.json',entries)});
let outreachAdmission=Promise.resolve();
// One admission path for anything she says on a call unprompted: her own speak requests and (October 22) her chess move.
function admitSpeech(b){
  const admit=async()=>{
    const call=activeCall;
    const result=await outreachReceipts.accept(b,call?.outreachStatus?.()??call?.callStatus()??{active:false});
    if(result.accepted&&!result.duplicate){
      const fresh=call?.outreachStatus?.()??call?.callStatus();
      if(activeCall!==call||!fresh?.canSpeak||fresh.activityRevision!==b.activityRevision){
        return outreachReceipts.update(b.requestId,{accepted:false,status:'not-admitted',reason:'conversation-changed-before-start'});
      }
      call.respond(null,{outreach:b}).catch(e=>{
        if(call.currentOutreach===b.requestId){call.settleOutreach('failed',{error:String(e.message).slice(0,200)});call.interrupt('outreach-error');call.send('error',{error:e.message});}
      });
    }
    return result;
  };
  const next=outreachAdmission.then(admit,admit);outreachAdmission=next.catch(()=>{});
  return next;
}
const safeLog=(event,values={})=>fs.appendFile(path.join(DATA,'events.jsonl'),JSON.stringify({at:new Date().toISOString(),event,...values})+'\n').catch(()=>{});
async function gatewaySecret(){
  const {stdout}=await exec('/usr/bin/sudo',['-n','-u','samantha','/usr/bin/python3','-c',"import json;print(json.load(open('/path/to/agent/.openclaw/openclaw.json'))['gateway']['auth']['token'])"],{timeout:10000});return stdout.trim();
}
async function rpc(method,params={}){
  const env={...process.env,PATH:'/opt/homebrew/opt/node@24/bin:/opt/homebrew/bin:/usr/bin:/bin'};
  const {stdout}=await exec('/usr/bin/sudo',['-n','-H','-u','samantha','/opt/homebrew/bin/openclaw','gateway','call',method,'--params',JSON.stringify(params),'--json','--timeout','20000'],{env,timeout:30000,maxBuffer:16*1024*1024});
  return JSON.parse(stdout.slice(stdout.indexOf('{')));
}
async function eleven(route,{method='GET',body,key=settings.apiKey,signal}={}){
  if(!key)throw new Error('Connect ElevenLabs in Settings first.');
  const response=await fetch('https://api.elevenlabs.io'+route,{method,headers:{'xi-api-key':key,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{}),signal:signal||AbortSignal.timeout(30000)});
  if(!response.ok){let msg;try{const d=await response.json();msg=typeof d.detail==='string'?d.detail:d.detail?.message||d.message;}catch{}throw Object.assign(new Error(`ElevenLabs ${response.status}: ${msg||'request unavailable'}`),{status:response.status});}
  return response.json();
}
function cookie(req){return (req.headers.cookie||'').split(';').map(s=>s.trim()).find(s=>s.startsWith('sai_session='))?.slice(12);}
function local(req){return ['127.0.0.1','::1','::ffff:127.0.0.1'].includes(req.socket.remoteAddress)&&[`127.0.0.1:${PORT}`,`localhost:${PORT}`].includes(req.headers.host)&&!req.headers['x-forwarded-for'];}
function authorized(req){return local(req)||sessions.valid(cookie(req));}
async function login(res,secure=false){const token=await sessions.create();res.setHeader('Set-Cookie',sessionCookie(token,secure));}
async function body(req,limit=50000){let raw='';for await(const part of req){raw+=part;if(raw.length>limit)throw new Error('Request too large.');}return JSON.parse(raw||'{}');}
function json(res,data,status=200){res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(data));}
let cachedStatus=null,statusAt=0;
async function status(){
  if(cachedStatus&&Date.now()-statusAt<20000)return {...cachedStatus,voice:publicSettings(settings,fishSettings)};
  let camera={status:'unavailable'},gateway=false;
  try{const {stdout}=await exec('/usr/bin/sudo',['-n','-u','samantha','/usr/bin/python3','-c',"import json,time,datetime; p='/path/to/application-support/SamanthaVision/private/'; c=json.load(open(p+'camera-status.json'));o=json.load(open(p+'observation.json'));v=json.load(open(p+'control.json'));print(json.dumps({'status':'paused' if v.get('paused') else c.get('status'),'capturedAt':o.get('capturedAt'),'asOf':c.get('asOf')}))"],{timeout:5000});camera=JSON.parse(stdout);}catch{}
  try{const r=await fetch('http://127.0.0.1:18789/healthz',{signal:AbortSignal.timeout(3000)});gateway=r.ok;}catch{}
  cachedStatus={gateway,camera};statusAt=Date.now();return {...cachedStatus,voice:publicSettings(settings,fishSettings)};
}
const messageMediaStore=await createMessageMediaStore({directory:path.join(DATA,'message-media'),getToken:gatewaySecret,sessionKey:process.env.SAI_SESSION_KEY||'agent:samantha:main'});
async function* answer(text,{signal,voice=false,interrupted=false,continued=false,voiceEvidence,prepareMessage,requestId,speakerBinding,attachments=[],cameraFrame=null,continuation=null,onReceipt=()=>{},sessionKey=process.env.SAI_SESSION_KEY||'agent:samantha:main'}={}){
  const token=await gatewaySecret();
  if(sessionKey==='agent:samantha:main'&&voiceEvidence?.contact!==false)await recordContact('user',voice?'sai_voice':'sai_text',requestId,speakerBinding);
  // Sent photos travel inline to the model, the same way iMessage pictures do.
  const pixels=(await Promise.all(attachments.map(a=>messageMediaStore.attachment(a.id)))).filter(Boolean);
  if(attachments.length&&pixels.length!==attachments.length)throw new Error('A photo could not be read. Choose it again.');
  // October 24 (Owner): on a voice call the live home camera frame rides along, so she sees him rather than a caption.
  if(cameraFrame?.attachment)pixels.push(cameraFrame.attachment);
  yield* gatewayChat({token,sessionKey,message:text,prepareMessage,attachments:pixels,replyTimeoutMs:voice?180000:300000,allowQuiet:!voice||Boolean(continuation),...(continuation?{systemInputProvenance:{kind:'internal_system',sourceTool:'sai-call-'+continuation}}:{}),workContext:conversationWorkContext({voice,interrupted,continued,voiceEvidence,speakerBinding,outing:outing.view(),cameraFrame:cameraFrame?{capturedAt:cameraFrame.capturedAt,sourceKind:cameraFrame.sourceKind}:null}),signal,requestId,
    responsePolicy:message=>voiceResponsePolicy({voice,text:message,attachments,continued}),
    onTiming:timing=>safeLog('conversation_timing',{...timing,surface:voice?'voice':'text'}),
    onReceipt:async r=>{const {media,...receipt}=r;const prepared=media?.length?await messageMediaStore.register(media):[];await onReceipt({...receipt,...(prepared.length?{media:prepared}:{})});safeLog('conversation_'+r.event,{...receipt,...(media?.length?{photos:prepared.length}:{}),surface:voice?'voice':'text'});}});
}
// The cloud on the voice screen follows her present state. The read-only
// snapshot helper is the same one voice delivery uses; cached briefly so a
// polling client never stacks up sudo reads. Qualitative only: no numbers.
function moodView(snapshot){
  const list=items=>(Array.isArray(items)?items:[]).filter(v=>v&&typeof v.emotion==='string'&&typeof v.intensity==='string').slice(0,6).map(({emotion,intensity,lift})=>({emotion,intensity,...(Number.isFinite(lift)?{lift}:{})})); // lift: how far above her standing mood (October 29)
  return {ok:true,asOf:snapshot.asOf,current:list(snapshot.current?.emotions),background:list(snapshot.overall?.backgroundEmotions),wellbeing:snapshot.overall?.wellbeing??'steady',settled:snapshot.current?.settled!==false,provisional:snapshot.provisionalLean===true};
}
let moodCache={at:0,value:null};
async function currentMood(){
  if(Date.now()-moodCache.at<2500&&moodCache.value)return moodCache.value;
  const snapshot=await readVoiceSnapshot(process.env.SAI_SESSION_KEY||'agent:samantha:main');
  const value=snapshot?.ok?moodView(snapshot):{ok:false,reason:snapshot?.reason||'emotional-state-unavailable'};
  moodCache={at:Date.now(),value};return value;
}
let sentPhotosFor=()=>null;
const withSentPhotos=async messages=>(await messageMediaStore.prepare(messages)).map(m=>{if(m.role!=='user'||m.media?.length)return m;const media=sentPhotosFor(m.text,m.timestamp);return media?{...m,media}:m;});
let chess;
const conversationFeed=createConversationFeed({preferSavedHistory:true,projectMessages:messages=>projectVoiceTurnRepairs(messages,voiceTurnRepairs),getToken:gatewaySecret,sessionKey:process.env.SAI_SESSION_KEY||'agent:samantha:main',isBusy:()=>!!activeCall||textTurns.busy(),prepareMessages:async messages=>{const prepared=await withSentPhotos(messages);return chess?chess.merge(prepared):prepared;},log:safeLog});
// October 27 (Owner): what she says she is about to do gets a chance to happen: recorded, and her own time woken shortly after.
const saidNext=await createSaidNext({file:path.join(DATA,'said-next.json'),wake:()=>rpc('cron.run',{id:BACKGROUND_JOB,mode:'if-enabled'}),log:safeLog});
const textTurns=await createTextTurns({file:path.join(DATA,'text-turns.json'),generate:answer,isBusy:()=>!!activeCall?.controller,log:safeLog,onComplete:row=>{conversationFeed.invalidate();beats.arm(row.id,{completedAt:row.updatedAt});if(row.speakerBinding?.speaker?.personId==='owner'||!row.speakerBinding)void saidNext.record({text:row.reply,turnId:row.id,surface:'text'}).catch(e=>safeLog('said_next_error',{error:String(e?.message??e).slice(0,160)}));},onState:async r=>{await recordContact('user','sai_text',r.id,r.speakerBinding,r.status);if(['failed','stopped','interrupted'].includes(r.status))await beats.drop(r.id,'the reply '+r.status);},onDelivered:(id,row)=>recordContact('assistant','sai_text',id,row.speakerBinding)});
// October 21: held lines (samantha_later). Sent a beat after her reply unless he has written back, a new text reply
// started, or a call is open. Delivery writes the line into the saved conversation as hers and tells her controller.
const beats=await createBeats({file:path.join(DATA,'beats.json'),log:safeLog,
  cancelled:async b=>{
    if(activeCall)return 'a call is open';
    if(textTurns.startedAfter(b.armedAt))return 'he wrote back in the app';
    try{const {contact}=await runLiveMemory({operation:'contact',sessionKey:b.sessionKey});const at=Date.parse(contact?.ownerLastAt??'');if(Number.isFinite(at)&&at>b.armedAt)return 'he wrote back';}catch(e){safeLog('beat_contact_unavailable',{id:b.id,error:String(e.message).slice(0,120)});}
    return null;
  },
  deliver:async b=>{
    const r=await runLiveMemory({operation:'beat',sessionKey:b.sessionKey,id:b.id,text:b.text,timestamp:Date.now(),person:b.speakerBinding?.speaker??'owner',turnId:b.turnId,afterMs:b.afterMs});
    if(r.appended)await recordContact('assistant','sai_text',b.id,b.speakerBinding);
    conversationFeed.invalidate();return r;
  }});
sentPhotosFor=textTurns.photosFor;
const chessConnection=chessGateway({getToken:gatewaySecret});
chess=createChessService({directory:path.join(DATA,'games'),gateway:(method,args)=>chessConnection.request(method,args),isBusy:()=>textTurns.busy(),callStatus:()=>activeCall?.callStatus()??null,
  // October 22: on a call the board shows her move; only a comment she actually wrote is said aloud, in the next quiet
  // moment, the way a person playing while talking says something only when there is something to say.
  onMoved:async({job,game,move})=>{const call=activeCall;if(!call||!move)return;const status=call.callStatus();if(!status.active)return;
    // October 27 (Owner): on the realtime agent her move reaches the agent as context; it speaks as the player who made it.
    if(call.mode===ELEVEN_MODE||call.mode==='phonic'){call.noteChessMove({game,move:{...move,by:move.by??'samantha'}});return;}
    const text=spokenOnCall(move.comment);if(!text){safeLog('chess_move_quiet',{gameId:game.id,revision:game.revision,san:move.san});return;}
    const result=await admitSpeech({requestId:String(job.id).replace(/[^a-zA-Z0-9_-]/g,'').slice(0,100),text,callId:status.callId,activityRevision:status.activityRevision});
    safeLog('chess_move_spoken',{gameId:game.id,revision:game.revision,san:move.san,accepted:!!result?.accepted,reason:result?.reason??null});},
  onChange:()=>conversationFeed.invalidate(),sessionKey:process.env.SAI_SESSION_KEY||'agent:samantha:main',auto:process.env.SAI_CHESS_AUTO!=='0',log:safeLog});
const appPresence=await createAppPresence({file:path.join(DATA,'app-presence.json'),gateway:rpc,isBusy:()=>textTurns.busy()||!!activeCall,enabled:!process.env.SAI_DATA_DIR&&!process.env.SAI_SESSION_KEY,log:safeLog});
async function availableCredits(){const d=await eleven('/v1/user/subscription');const remaining=Math.max(0,(d.character_limit||0)-(d.character_count||0));return {tier:d.tier,remaining,limit:d.character_limit,used:d.character_count,status:d.status};}
async function callCredits(voice,fish){
 const [credits,balance]=await Promise.all([availableCredits(),voice.provider==='fish'?fishCredit(fish):null]);
 if(balance)requireFishCredit(balance);return credits;
}
const outing=await createOutingRuntime({
 root:process.env.SAI_DATA_DIR?path.join(DATA,'outing'):OUTING_ROOT,
 proofSession:process.env.SAI_SESSION_KEY?process.env.SAI_SESSION_KEY+'-outing':undefined,
 getCall:()=>activeCall?.callStatus(),rpc,getToken:gatewaySecret,log:safeLog,
 notify:s=>activeCall?.send('outing',{active:s.active,id:s.id,cameraStatus:s.cameraStatus,analysisStatus:s.analysisStatus,quiet:s.quiet,error:s.lastError??null}),
 speak:async p=>{const response=await fetch(`http://127.0.0.1:${PORT}/api/call/speak`,{method:'POST',headers:{'content-type':'application/json',origin:`http://127.0.0.1:${PORT}`},body:JSON.stringify(p)});const v=await response.json();if(!response.ok)throw Error(v.error);return v;}
});
const incomingCalls=await createIncomingCalls({file:path.join(DATA,'incoming-calls.json'),push:createIncomingPush({readConfig:()=>read('incoming-push.json')}),busy:()=>!!activeCall||textTurns.busy()});
const messageNotifications=await createMessageNotifications({file:path.join(DATA,'message-notifications.json'),push:createIncomingPush({kind:'alert',readConfig:()=>read('incoming-push.json')}),eligibleOwner:owner=>sessions.validOwner(owner)&&speakers.read(owner).speaker.personId==='owner',inCall:()=>!!activeCall,log:safeLog});
const stopMessageNotifications=conversationFeed.subscribe(snapshot=>{void messageNotifications.observe(snapshot).catch(e=>safeLog('message_notification_error',{error:String(e.message).slice(0,120)}));});
const server=http.createServer(async(req,res)=>{
  try{
    if(!allowedHosts.has(req.headers.host)){res.writeHead(403);return res.end('Unknown host');}
    res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');
    res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; media-src 'self' blob: data: https://*.elevenlabs.io https://storage.googleapis.com https://*.fish.audio https://*.r2.cloudflarestorage.com; connect-src 'self'; frame-ancestors 'none'; object-src 'none'; base-uri 'self'");
    const u=new URL(req.url,`http://${req.headers.host}`);
    if(req.method!=='GET'&&!(req.method==='HEAD'&&/^\/api\/media\/[a-f0-9]{64}$/.test(u.pathname))&&!originAllowed(req.headers.origin,req.headers.host,allowedHosts))return json(res,{error:'Untrusted origin.'},403);
    if(req.method==='POST'&&u.pathname==='/api/pair'){
      const b=await body(req);if(!pairing||pairing.expires<Date.now()||typeof b.code!=='string'||b.code!==pairing.code)return json(res,{error:'Pairing link expired. Make a new one from SAI on your Mac.'},403);
      pairing=null;await login(res,!local(req));return json(res,{ok:true});
    }
    if(u.pathname.startsWith('/api/')&&!authorized(req)){
      safeLog('authorization_rejected',{route:u.pathname,hasCookie:!!cookie(req)});
      return json(res,{error:'Open a pairing link from SAI on your Mac.'},401);
    }
    if(!local(req)&&u.pathname.startsWith('/api/')&&await sessions.refresh(cookie(req)))res.setHeader('Set-Cookie',sessionCookie(cookie(req)));
    if(u.pathname.startsWith('/api/notifications/')){
      const route=u.pathname.slice('/api/notifications/'.length);
      if(route==='register'&&req.method==='POST'){
        if(!sessions.valid(cookie(req)))return json(res,{error:'A paired device is required.'},403);
        return json(res,await messageNotifications.register(textOwner(cookie(req)),await body(req)));
      }
      if(route==='status'&&req.method==='GET'&&local(req))return json(res,await messageNotifications.status());
      return json(res,{error:'Unsupported notification operation.'},403);
    }
    if(u.pathname.startsWith('/api/call/incoming/')){
      const owner=textOwner(cookie(req)),route=u.pathname.slice('/api/call/incoming/'.length);
      if(route==='status'&&req.method==='GET'){if(!local(req))return json(res,{error:'Call control is local to Samantha.'},403);return json(res,await incomingCalls.status());}
      if(route==='invite'&&req.method==='POST'){if(!local(req))return json(res,{error:'Only Samantha can initiate a call locally.'},403);return json(res,await incomingCalls.invite(await body(req)));}
      if(route==='register'&&req.method==='POST')return json(res,await incomingCalls.register(owner,await body(req)));
      if(route==='act'&&req.method==='POST')return json(res,await incomingCalls.act(owner,await body(req)));
      if(route==='events'&&req.method==='GET'){incomingCalls.events(owner,u.searchParams.get('deviceId'),res);return;}
      return json(res,{error:'Unsupported incoming call operation.'},405);
    }
    if(u.pathname==='/api/chess/control'&&req.method==='POST'){
      if(!local(req))return json(res,{error:'Samantha controls her moves locally.'},403);
      return json(res,chess.control(await body(req)));
    }
    if(u.pathname==='/api/chess/proof'&&req.method==='POST'){
      if(!local(req))return json(res,{error:'Local verification only.'},403);
      return json(res,chess.proofAct(await body(req)));
    }
    if(u.pathname==='/api/games/chess/events'&&req.method==='GET'){chess.events(res);return;}
    if(u.pathname==='/api/games/chess'){
      if(req.method==='GET')return json(res,chess.list());
      if(req.method==='POST'){
        const b=await body(req),owner=textOwner(cookie(req));
        const binding=await speakers.capture(owner,b.speakerId);
        return json(res,chess.act(b,{id:binding.speaker.personId,name:binding.speaker.name}));
      }
      return json(res,{error:'Unsupported chess operation.'},405);
    }
    const chessMatch=u.pathname.match(/^\/api\/games\/chess\/([a-zA-Z0-9_-]{8,100})$/);
    if(chessMatch&&req.method==='GET')return json(res,chess.get(chessMatch[1]));
    if(u.pathname==='/api/app-presence'){
      if(req.method==='GET'){if(!local(req))return json(res,{error:'Presence context is local to Samantha.'},403);return json(res,appPresence.view());}
      if(req.method==='POST'){const owner=textOwner(cookie(req));return json(res,await appPresence.ingest(owner,await body(req),speakers.read(owner).speaker));}
      return json(res,{error:'Unsupported presence operation'},405);
    }
    if(u.pathname==='/api/app-presence/observed'&&req.method==='POST'){
      if(!local(req))return json(res,{error:'Only Samantha can acknowledge presence context.'},403);
      const b=await body(req);return json(res,await appPresence.observed(b.ids,b.runId));
    }
    if(u.pathname==='/api/live/end'&&req.method==='POST'){
      const b=await body(req);
      if(activeCall?.transport?.matches(b.callId,textOwner(cookie(req))))activeCall.close('client-end-request');
      return json(res,{ok:true});
    }
    if(u.pathname==='/api/device-check'&&req.method==='POST'){
      const b=await body(req);
      if(b.platform!=='ios'||!['checking','offline','cellular','wifi','ethernet','vpn-or-other'].includes(b.network)||!['page_ready','network_changed','connection_check','foreground','voice_idle','voice_connecting','voice_listening','voice_thinking','voice_speaking','text_delivered','voice_played'].includes(b.event))return json(res,{error:'Invalid device check.'},400);
      // Existing installed pages report genuine resumes too. New pages use
      // stable IDs through app-presence; page_ready is a periodic status check.
      if(b.event==='foreground'&&b.presenceProtocol!==1){const owner=textOwner(cookie(req));await appPresence.ingest(owner,{id:crypto.randomUUID(),kind:'open',device:b.device==='ipad'?'ipad':'iphone',observedAt:new Date().toISOString()},speakers.read(owner).speaker);}
      await safeLog('iphone_check',{network:b.network,expensive:b.expensive===true,phase:b.event});return json(res,{ok:true});
    }
    if(u.pathname==='/api/outing/control'&&req.method==='POST'){
      if(!local(req))return json(res,{error:'Samantha controls this mode locally.'},403);
      const b=await body(req);
      if(b.operation==='status')return json(res,outing.view());
      if(b.operation==='look'){if(typeof b.question!=='string'||!b.question.trim()||b.question.length>600)throw Error('Provide a specific visual question');return json(res,await outing.look(b.question));}
      if(b.operation==='quiet'||b.operation==='resume')return json(res,await outing.setQuiet(b.operation==='quiet'));
      if(b.operation==='stop')return json(res,await outing.stop('samantha-request'));
      return json(res,{error:'Unknown outing control'},400);
    }
    if(u.pathname.startsWith('/api/outing/')&&req.method==='POST'){
      const b=await body(req,u.pathname==='/api/outing/frame'?260000:50000);
      if(!activeCall?.transport?.matches(b.callId,textOwner(cookie(req))))return json(res,{error:'Start a call on this phone before sharing its camera.'},409);
      if(u.pathname==='/api/outing/start')return json(res,await outing.start(b.callId));
      if(!outing.state?.active||b.id!==outing.state.id)return json(res,{error:'This camera session has ended.'},409);
      if(u.pathname==='/api/outing/frame')return json(res,outing.ingest(b),202);
      if(u.pathname==='/api/outing/status'){await outing.cameraStatus(b.status);return json(res,{ok:true});}
      if(u.pathname==='/api/outing/stop')return json(res,await outing.stop('phone-request'));
      return json(res,{error:'Unknown outing operation'},404);
    }
    // Read-only mood is available to paired devices. Keep it after the shared
    // pairing check, before Samantha's local-only call-control catch-all.
    if(u.pathname==='/api/call/mood'&&req.method==='GET')return json(res,await currentMood());
    // October 21: samantha_later holds one line for the reply being written right now.
    if(u.pathname==='/api/text/later'&&req.method==='POST'){
      if(!local(req))return json(res,{error:'Held lines are local to Samantha on this Mac.'},403);
      const b=await body(req);const row=textTurns.current();
      if(!row)return json(res,{error:'No SAI text reply is being written right now; say it in the reply, or keep it for later yourself.'},409);
      const sessionKey=process.env.SAI_SESSION_KEY||'agent:samantha:main';
      if(b.sessionKey&&b.sessionKey!==sessionKey)return json(res,{error:'Held lines belong to the live conversation.'},409);
      try{const held=beats.hold({turnId:row.id,text:b.text,afterMs:Math.round(Number(b.afterSeconds??75)*1000),speakerBinding:row.speakerBinding,sessionKey});
        return json(res,{held:true,id:held.id,afterSeconds:Math.round(held.afterMs/1000),note:'Sent only if he has not written back by then; dropped unsent otherwise. Do not refer to it as said.'});}
      catch(e){return json(res,{error:e.message},400);}
    }
    if(u.pathname.startsWith('/api/call/')){
      if(!local(req))return json(res,{error:'Call control is local to Samantha on this Mac.'},403);
      if(u.pathname==='/api/call/status'&&req.method==='GET')return json(res,{...(activeCall?.callStatus()??{active:false,canSpeak:false,reason:'no-active-call'}),foregroundBusy:textTurns.busy()||!!activeCall});
      if(u.pathname==='/api/call/receipt'&&req.method==='GET')return json(res,outreachReceipts.get(u.searchParams.get('requestId'))??{status:'unknown',accepted:false});
      // October 21: Samantha can end a call from her side. The client sees an 'error' toast with her reason and the ordinary 'ended'.
      if(u.pathname==='/api/call/end'&&req.method==='POST'){
        const b=await body(req);const call=activeCall;
        if(!call)return json(res,{ok:false,ended:false,reason:'no-active-call'});
        const status=call.callStatus();
        if(typeof b.callId!=='string'||!b.callId)return json(res,{ok:false,ended:false,reason:'call-id-required'},400);
        if(!status.active||b.callId!==status.callId)return json(res,{ok:false,ended:false,reason:'call-changed'},409);
        if(Number.isInteger(status.activityRevision)&&b.activityRevision!==status.activityRevision)return json(res,{ok:false,ended:false,reason:'conversation-changed'},409);
        safeLog('call_ended_by_samantha',{reason:String(b?.reason??'').slice(0,120),turn:call.serial,speaking:!!call.speaking});
        try{call.send('error',{error:'Samantha ended the call.'});}catch{}
        call.close('samantha-ended');
        return json(res,{ok:true,ended:true});
      }
      if(u.pathname==='/api/call/speak'&&req.method==='POST'){
        const b=await body(req);
        return json(res,await admitSpeech(b));
      }
      return json(res,{error:'Unknown call operation.'},404);
    }
    if(u.pathname==='/api/photo'&&req.method==='POST'){
      const b=await body(req,2600000),owner=textOwner(cookie(req));
      if(typeof b.content!=='string'||b.content.length>2100000||!/^[A-Za-z0-9+/=]+$/.test(b.content))return json(res,{error:'The photo could not be read.'},400);
      const media=await messageMediaStore.addUpload({bytes:Buffer.from(b.content,'base64'),owner,width:b.width,height:b.height,fileName:b.fileName,alt:'Photo from '+(speakers.read(owner)?.speaker?.name||'Owner')});
      await safeLog('photo_uploaded',{id:media.id,width:media.width,height:media.height});
      return json(res,{media});
    }
    if(u.pathname==='/api/said-next'&&req.method==='GET'){if(!local(req))return json(res,{error:'Local only.'},403);return json(res,{entries:saidNext.list({sinceMs:Math.min(Number(u.searchParams.get('sinceMs'))||10800000,86400000),markShown:u.searchParams.get('shown')==='1'})});}
    if(u.pathname==='/api/status')return json(res,{...await status(),participant:speakers.read(textOwner(cookie(req))),voiceMode:voiceModes[textOwner(cookie(req))]??'classic'});
    if(u.pathname==='/api/voice-mode'&&req.method==='POST'){
      const b=await body(req),owner=textOwner(cookie(req));
      if(!['classic','eleven','gpt-live','phonic'].includes(b.mode))return json(res,{error:'Choose a voice mode.'},400);
      if(b.mode==='phonic'&&!(await read('phonic.json')).apiKey)return json(res,{error:'Phonic is not configured.'},409);
      if(b.mode==='eleven'&&!elevenAgent.agentId)return json(res,{error:'Create Samantha\'s ElevenLabs agent in Settings first.'},409);
      if(activeCall)return json(res,{error:'End the current call before switching voice modes.'},409);
      const previous=voiceModes[owner];voiceModes[owner]=b.mode;
      try{await save('voice-modes.json',voiceModes);}catch(e){if(previous===undefined)delete voiceModes[owner];else voiceModes[owner]=previous;throw e;}
      return json(res,{mode:b.mode});
    }
    if(u.pathname==='/api/speaker/identify'&&req.method==='POST'){
      if(!local(req))return json(res,{error:'Guest identification must come through Samantha.'},403);
      const b=await body(req),history=await conversationFeed.read({fresh:true});
      const source=history.messages?.find(row=>row.id===b.sourceMessageId),at=Number.isFinite(source?.timestamp)?source.timestamp:Date.parse(source?.timestamp);
      if(!source||source.role!=='user'||source.speaker?.personId!==b.personId||typeof b.quote!=='string'||!source.text.includes(b.quote)||!b.quote.toLocaleLowerCase().includes(String(b.name??'').trim().toLocaleLowerCase())||!Number.isFinite(at)||Date.now()-at>600000||at>Date.now()+60000)return json(res,{error:'Use this guest’s recent saved introduction and exact quote.'},400);
      const result=await speakers.identify(b);
      if(activeCall&&speakers.read(activeCall.owner).speaker.personId===b.personId){
        const current=speakers.read(activeCall.owner);
        if(activeCall.renameSpeaker)activeCall.renameSpeaker(current);
        else activeCall.send('speaker',current);
      }
      return json(res,result);
    }
    if(u.pathname==='/api/speaker'){
      const owner=textOwner(cookie(req));
      if(req.method==='GET')return json(res,{...speakers.read(owner),choices:speakers.choices()});
      if(req.method==='POST'){
        const b=await body(req),before=speakers.read(owner);
        const current=await speakers.set(owner,b.personId,b.revision);
        if(activeCall?.owner===owner&&before.speaker.personId!==current.speaker.personId)activeCall.switchSpeaker(current);
        return json(res,current);
      }
      return json(res,{error:'Unsupported speaker operation.'},405);
    }
    if(u.pathname.startsWith('/api/media/')&&['GET','HEAD'].includes(req.method)){
      const id=u.pathname.slice('/api/media/'.length);if(!/^[a-f0-9]{64}$/.test(id))return json(res,{error:'Media not found.'},404);
      const media=await messageMediaStore.get(id);if(!media)return json(res,{error:'Media not found.'},404);
      return serveMedia(req,res,media);
    }
    if(u.pathname==='/api/history')return json(res,await conversationFeed.read({fresh:true}));
    if(u.pathname==='/api/history/events'&&req.method==='GET'){streamConversation(conversationFeed,res);return;}
    if(u.pathname==='/api/history-seen'&&req.method==='POST'){
      const b=await body(req);if(!/^[a-f0-9]{64}$/.test(b.revision??'')||b.lastMessageId!==null&&(typeof b.lastMessageId!=='string'||b.lastMessageId.length>160))return json(res,{error:'Invalid history receipt.'},400);
      await safeLog('history_rendered',{revision:b.revision,lastMessageId:b.lastMessageId});return json(res,{ok:true});
    }
    if(u.pathname==='/api/settings'&&req.method==='GET')return json(res,publicSettings(settings,fishSettings));
    if(u.pathname==='/api/settings'&&req.method==='POST'){
      const b=await body(req);if(b.apiKey&&!local(req))return json(res,{error:'Add account keys on the Mac.'},403);
      const next={...settings};if(b.apiKey){if(typeof b.apiKey!=='string'||b.apiKey.length>512)throw new Error('Invalid API key.');await eleven('/v1/user',{key:b.apiKey});next.apiKey=b.apiKey;}
      if(b.provider!==undefined){
        if(!['elevenlabs','fish'].includes(b.provider))throw new Error('Unsupported voice provider.');
        if(activeCall)throw new Error('Finish the current call before switching voices.');
        if(b.provider==='fish')requireFishCredit(await fishCredit(fishSettings));
        next.provider=b.provider;
      }
      if(b.voiceId!==undefined){if(!/^[a-zA-Z0-9_-]{1,100}$/.test(b.voiceId))throw new Error('Choose a valid voice.');next.voiceId=b.voiceId;next.voiceName=String(b.voiceName||'Samantha').slice(0,100);}
      if(b.model!==undefined){if(!['eleven_v4_turbo','eleven_v3_conversational','eleven_flash_v2_5'].includes(b.model))throw new Error('Unsupported voice model.');next.model=b.model;}
      await save('settings.json',next);settings=next;return json(res,publicSettings(settings,fishSettings));
    }
    // October 27 (Owner): the ElevenLabs realtime agent that speaks for her on calls; created and kept in step from Settings.
    if(u.pathname==='/api/fish'&&req.method==='GET')return json(res,await fishStatus(fishSettings));
    if(u.pathname==='/api/eleven/agent'&&req.method==='GET')return json(res,{...(await agentStatus({key:settings.apiKey,record:elevenAgent})),voiceId:settings.voiceId||''});
    if(u.pathname==='/api/eleven/agent'&&req.method==='POST'){
      const b=await body(req);const realtimeModel=b.realtimeModel??elevenAgent.realtimeModel??DEFAULT_REALTIME_MODEL;if(!REALTIME_MODELS.includes(realtimeModel))return json(res,{error:'Choose a native Eleven Realtime model.'},400);
      if(activeCall)return json(res,{error:'End the current call before changing the agent.'},409);
      if(!settings.voiceId)return json(res,{error:'Choose Samantha\'s voice first.'},400);
      const record=await syncAgent({key:settings.apiKey,voiceId:settings.voiceId,realtimeModel,store:{read:async()=>elevenAgent.agentId?elevenAgent:null,write:async r=>{await save('eleven-agent.json',r);elevenAgent=r;}},log:safeLog,force:b.force===true});
      const view=await agentStatus({key:settings.apiKey,record});if(!view.nativeRealtime||view.realtimeModel!==realtimeModel)return json(res,{error:view.error||'ElevenLabs did not confirm the selected native Realtime model.'},502);return json(res,view);
    }
    if(u.pathname==='/api/voices'){const d=await eleven('/v2/voices?page_size=100');return json(res,{voices:(d.voices||[]).map(v=>({id:v.voice_id,name:v.name,description:v.description,labels:v.labels,preview:v.preview_url}))});}
    if(u.pathname==='/api/credits')return json(res,await availableCredits());
    if(u.pathname==='/api/models'){const d=await eleven('/v1/models');return json(res,{models:d.map(m=>({id:m.model_id,name:m.name}))});}
    if(u.pathname==='/api/delivered'&&req.method==='POST'){
      const b=await body(req);return json(res,await textTurns.delivered(b.id,textOwner(cookie(req))));
    }
    if(u.pathname==='/api/pair-link'&&req.method==='POST'){
      if(!local(req))return json(res,{error:'Pair devices from your Mac.'},403);
      pairing={code:crypto.randomBytes(24).toString('hex'),expires:Date.now()+600000};return json(res,{url:`https://${REMOTE}/#pair=${pairing.code}`,expires:pairing.expires});
    }
    if(u.pathname==='/api/chat'&&req.method==='POST'){
      const b=await body(req),id=b.requestId??crypto.randomUUID(),owner=textOwner(cookie(req));
      // Finish ASR and canonical writes before admitting the first text turn.
      // Merely closing a socket is not evidence that the last spoken line saved.
      if(activeCall?.mode==='gpt-live'){const handoff=await activeCall.close('switch-to-text');if(handoff?.saved===false)return json(res,{error:handoff.error},409);}
      const photoIds=Array.isArray(b.photoIds)?b.photoIds.slice(0,4):[];
      const attachments=photoIds.map(pid=>typeof pid==='string'?messageMediaStore.uploaded(pid,owner):null);
      if(attachments.some(a=>!a))return json(res,{error:'That photo is no longer available. Choose it again.'},400);
      const turn=await textTurns.start(id,owner,b.text,{captureSpeaker:()=>speakers.capture(owner,b.speakerId),attachments});
      if(b.requestId)return json(res,turn,202);
      // Older installed pages still stream here. A disconnect only detaches them.
      streamTextTurn(textTurns,id,owner,res,{legacy:true,log:safeLog});return;
    }
    const turnRoute=u.pathname.match(/^\/api\/chat\/([a-zA-Z0-9_-]{16,100})(?:\/(events|stop))?$/);
    if(turnRoute){
      const [,id,operation]=turnRoute,owner=textOwner(cookie(req));
      if(operation==='stop'&&req.method==='POST')return json(res,await textTurns.stop(id,owner));
      const turn=textTurns.get(id,owner);if(!turn)return json(res,{error:'Message not found.'},404);
      if(!operation&&req.method==='GET')return json(res,turn);
      if(operation==='events'&&req.method==='GET'){streamTextTurn(textTurns,id,owner,res,{log:safeLog});return;}
      return json(res,{error:'Unsupported message operation.'},405);
    }
    if(u.pathname.startsWith('/api/'))return json(res,{error:'Not found'},404);
    const file=u.pathname==='/'?'index.html':u.pathname.slice(1);
    if(file.includes('..')||!/^[-a-zA-Z0-9_./]+$/.test(file))return json(res,{error:'Not found'},404);
    const mime={'.html':'text/html','.css':'text/css','.js':'text/javascript','.svg':'image/svg+xml','.json':'application/json','.webmanifest':'application/manifest+json','.png':'image/png'}[path.extname(file)]||'application/octet-stream';
    const content=await fs.readFile(path.join(ROOT,'public',file));res.writeHead(200,{'Content-Type':mime,'Cache-Control':'no-cache'});res.end(content);
  }catch(e){if(!res.headersSent)json(res,{error:String(e.message||e).slice(0,350)},e.status||500);else res.end();}
});
// October 27 (Owner): what she is in the middle of, for the realtime agent's prompt and its samantha_now tool. Read-only, bounded, hers.
async function readStanding(){
  const samanthaFile=async(file,max)=>{try{const {stdout}=await exec('/usr/bin/sudo',['-n','-u','samantha','/bin/cat',file],{timeout:2500,maxBuffer:200000});return String(stdout).slice(0,max);}catch{return null;}};
  const WS='/path/to/agent/.openclaw/workspace-samantha/';
  const [bookmark,chessRaw,updates]=await Promise.all([samanthaFile(WS+'bookmark.md',3000),samanthaFile(WS+'personal-life/chess-online.json',60000),readSystemUpdates().catch(()=>({ok:false}))]);
  let chessOnline=[];try{const s=JSON.parse(chessRaw);const moves=s.moves??[];const when=t=>new Date(t).toLocaleString('en-US',{timeZone:'America/Chicago',month:'short',day:'numeric',hour:'numeric',minute:'2-digit'});
   chessOnline=Object.values(s.games??{}).map(g=>{const mine=moves.filter(m=>m.url===g.url).slice(-3).map(m=>m.lastMove+' at '+when(m.at));return `vs ${g.opponent} on chess.com (you are ${g.myColor}): last move ${g.lastMove??'none'} by ${g.lastBy==='me'?'you':g.opponent}; ${g.myTurn?'your move':g.opponent+"'s move, you are waiting"}.${mine.length?' Your recent moves: '+mine.join(', ')+'.':''}`;});}catch{}
  const sharedChess=(chess?.list?.()?.games??[]).filter(g=>g.status==='active').map(g=>{const samanthaColor=g.samanthaColor??(g.humanColor==='w'?'b':'w');const moves=(g.moves??[]).map((m,i)=>({san:m.san,by:m.by??(((i%2===0)===(samanthaColor==='w'))?'samantha':g.human?.id??'human'),comment:m.comment??null}));return {id:g.id,human:g.human,humanColor:g.humanColor,samanthaColor,status:g.status,paused:g.paused,turn:g.turn,moves:moves.slice(-60),lastMove:moves.at(-1)??null};});
  return {systemUpdates:renderSystemUpdates(updates),systemUpdatesCompact:renderSystemUpdates(updates,{maxChars:1600}),bookmark:bookmark?bookmark.replace(/^#.*$|^\{.*\}$/gm,'').trim():null,chessOnline,sharedChess};
}
class VoiceCall{
  constructor(client,transport=null,owner){this.owner=owner;this.voiceSettings={...settings};this.fishSettings={...fishSettings};this.client=client;this.transport=transport;this.stt=null;this.tts=null;this.controller=null;this.serial=0;this.closed=false;this.started=Date.now();this.pendingAudio=[];this.audioBytes=0;this.speaking=false;this.lastText='';this.lastCommit=0;this.keepalive=null;this.interruption=new VoiceInterruption();this.engagement=new VoiceEngagement();this.replyText='';this.initiative=new CallInitiative();this.capable=false;this.pendingPlayback=false;this.currentOutreach=null;
    // October 25 (Owner): continue after ~30 s of his quiet; standby after his goodnight.
    this.continuation=new CallContinuation({log:safeLog,
      canRun:()=>{if(this.closed||textTurns.busy()||this.controller||this.speaking||this.pendingPlayback)return false;const s=this.callStatus();return s.active&&s.canSpeak;},
      canLook:()=>!(this.closed||textTurns.busy()||this.controller||this.speaking||this.pendingPlayback),
      onContinue:({idleSeconds})=>{const v=outing.view();this.respond(CONTINUE_PROMPT(idleSeconds,{sharing:Boolean(v?.active&&v.cameraStatus==='on')}),{continuation:'continue'}).catch(e=>safeLog('call_continuation_error',{error:String(e?.message||e).slice(0,200)}));},
      onStandbyLook:({minutes})=>{this.respond(STANDBY_PROMPT(minutes),{continuation:'standby'}).catch(e=>safeLog('call_standby_error',{error:String(e?.message||e).slice(0,200)}));}});}
  callStatus(){if(this.engagement.resting)return {...this.initiative.status(),...this.engagement.status(),canSpeak:false,reason:'participant-resting'};const participant=speakers.read(this.owner);if(participant.speaker.personId!=='owner')return {...this.initiative.status(),participant,canSpeak:false,reason:'different-conversation-participant'};if(outing.state?.active&&outing.state.quiet)return {...this.initiative.status(),canSpeak:false,reason:'owner-requested-quiet'};if(this.transport&&!this.transport.connected)return {...this.initiative.status(),canSpeak:false,reason:'call-reconnecting'};return this.initiative.status({closed:this.closed,busy:!!this.controller||textTurns.busy()||this.pendingPlayback,speaking:this.speaking,capable:this.capable,quietMs:outing.state?.active?3000:12000});}
  settleOutreach(status,extra={}){const id=this.currentOutreach;if(!id)return;if(['played','interrupted','failed'].includes(status))this.currentOutreach=null;outreachReceipts.update(id,{status,...extra}).catch(e=>safeLog('outreach_receipt_error',{requestId:id,error:e.message}));safeLog('voice_outreach_'+status,{requestId:id,turn:this.serial,...extra});}
  send(type,data={}){if(this.transport)this.transport.send(type,data);else if(this.client.readyState===WebSocket.OPEN)this.client.send(JSON.stringify({type,...data}));}
  async start(){
    const settings=this.voiceSettings,fish=this.fishSettings;
    if(!settings.apiKey||!settings.voiceId)throw new Error('Choose and connect a voice in Settings.');
    const credits=await callCredits(settings,fish);if(credits.remaining<2000)throw new Error('Too few included credits for a call. More included credits are needed.');
    if(this.closed)return;
    this.send('state',{state:'connecting'});
    this.send('speaker',speakers.read(this.owner));
    this.startTranscription();
    this.creditCheck=new CallCreditMonitor({check:()=>callCredits(settings,fish),onFailure:e=>this.fail(e,'credit-check'),onRetry:()=>safeLog('voice_credit_retry',{turn:this.serial}),onRecovered:()=>safeLog('voice_credit_recovered',{turn:this.serial})});this.creditCheck.start();
    // Fresh silence keeps transcription alive during a brief client outage; it
    // is never presented as user speech or counted as microphone activity.
    this.silenceKeepalive=setInterval(()=>{if(this.transport&&!this.transport.connected&&this.stt?.readyState===WebSocket.OPEN&&this.stt.bufferedAmount<64000)this.stt.send(JSON.stringify({message_type:'input_audio_chunk',audio_base_64:Buffer.alloc(3200).toString('base64'),sample_rate:16000,commit:false}));},100);
    safeLog('call_started');
  }
  switchSpeaker(current){
    this.clearTranscriptionRecovery();
    this.interrupt('speaker-changed');
    this.engagement=new VoiceEngagement();this.pendingInput=new VoicePendingInput();this.wasInterrupted=false;this.wasContinued=false;
    this.lastText='';this.lastCommit=0;this.pendingAudio=[];this.audioBytes=0;
    const previous=this.stt;this.stt=null;previous?.terminate();
    this.initiative.ready=false;this.send('speaker',current);this.send('state',{state:'connecting'});
    this.startTranscription();
  }
  clearTranscriptionRecovery(){clearTimeout(this.sttReadyTimer);clearTimeout(this.sttRetry);clearTimeout(this.sttDeadline);this.sttRecovering=false;this.sttAttempts=0;}
  recoverTranscription(stt,reason){
    if(this.closed||this.stt!==stt)return;
    this.stt=null;clearTimeout(this.sttReadyTimer);stt.terminate();this.initiative.ready=false;
    // Never replay ambiguous microphone audio or carry a partial hypothesis
    // across a transcription reconnect. The active answer and playback survive.
    this.pendingAudio=[];this.audioBytes=0;this.interruption.reset();this.interruption.partialEvidence=null;this.engagement.hypothesis=null;
    if(!this.sttRecovering){
      this.sttRecovering=true;this.sttAttempts=0;
      this.sttDeadline=setTimeout(()=>this.fail(new Error('The microphone connection could not recover. Please start a new call.'),'transcription-recovery-timeout'),60000);
    }
    const attempt=++this.sttAttempts,delayMs=Math.min(4000,500*2**Math.min(attempt-1,3));
    safeLog('voice_transcription_reconnecting',{turn:this.serial,reason,attempt,delayMs,replyActive:!!this.controller,speaking:this.speaking});
    if(!this.speaking)this.send('state',{state:'reconnecting'});
    this.sttRetry=setTimeout(()=>{if(!this.closed)this.startTranscription();},delayMs);
  }
  startTranscription(){
    const previous=this.stt;this.stt=null;previous?.terminate();
    const settings=this.voiceSettings;
    const url=transcriptionURL();
    const stt=this.stt=new WebSocket(url,{headers:{'xi-api-key':settings.apiKey},handshakeTimeout:12000,maxPayload:1048576});
    this.sttReadyTimer=setTimeout(()=>this.recoverTranscription(stt,'session-start-timeout'),15000);
    stt.on('message',raw=>{if(this.stt!==stt||this.closed)return;try{const m=JSON.parse(raw);if(m.message_type==='session_started'){const recovered=this.sttRecovering;this.clearTranscriptionRecovery();this.initiative.ready=true;if(!this.readyCueSent){this.readyCueSent=true;announceCallReady((...args)=>this.send(...args));}for(const b of this.pendingAudio)this.sendAudio(b);this.pendingAudio=[];this.audioBytes=0;this.send('state',{state:this.speaking?'speaking':this.controller||this.pendingPlayback?'thinking':'listening'});if(recovered)safeLog('voice_transcription_recovered',{turn:this.serial,replyActive:!!this.controller,speaking:this.speaking});safeLog('voice_input_profile',{vadThreshold:m.config?.vad_threshold??null,minSpeechDurationMs:m.config?.min_speech_duration_ms??null,silenceThresholdSeconds:m.config?.vad_silence_threshold_secs??null,requestedSilenceThresholdSeconds:Number(url.searchParams.get('vad_silence_threshold_secs')),requestedVadThreshold:Number(url.searchParams.get('vad_threshold')),requestedMinSpeechDurationMs:Number(url.searchParams.get('min_speech_duration_ms'))});}
      if(m.message_type==='partial_transcript'){
        this.engagement.partial(m.text);
        if(this.engagement.resting)return;
        const decision=this.interruption.partial(m.text,{busy:!!this.controller||this.speaking||this.pendingPlayback,speaking:this.speaking,assistant:this.replyText});
        if(decision.reason!=='playback-echo'&&m.text?.trim())this.initiative.activity();
        if(decision.reason!=='playback-echo'&&(decision.interrupt||(!this.controller&&!this.speaking&&!this.pendingPlayback))&&m.text?.trim())this.send('partial',{text:m.text});
        if(decision.interrupt)this.interrupt(decision.reason);
        else if((this.controller||this.speaking||this.pendingPlayback||decision.reason==='playback-echo')&&m.text?.trim())safeLog('voice_partial_held',{turn:this.serial,reason:decision.reason,characters:m.text.length,echoKind:decision.echoKind,echoScore:decision.echoScore});
      }
      if(m.message_type==='committed_transcript'&&m.text?.trim()){
        const text=m.text.trim(),decision=this.interruption.committed(text,{speaking:this.speaking,assistant:this.replyText});
        if(!decision.accept){safeLog('voice_input_ignored',{turn:this.serial,reason:decision.reason,characters:text.length,echoKind:decision.echoKind,echoScore:decision.echoScore});return;}
        const engagement=this.engagement.committed(text);
        if(!engagement.accept){safeLog('voice_input_ignored',{turn:this.serial,reason:engagement.reason,characters:text.length});return;}
        if(engagement.reason==='control-command'){this.interrupt('explicit-stop');return;}
        this.continuation.userSpoke(text,{resting:this.engagement.resting});
        if(text===this.lastText&&Date.now()-this.lastCommit<1500)return;
        this.lastText=text;this.lastCommit=Date.now();this.respond(text,{voiceEvidence:engagement}).catch(e=>this.fail(e));
      }
      if(m.error||/_error$|^quota_exceeded$|^unaccepted_terms$/.test(m.message_type)){
        if(['input_error','transcriber_error','server_error'].includes(m.message_type))this.recoverTranscription(stt,m.message_type);
        else this.fail(new Error(typeof m.error==='string'?m.error:'Transcription failed.'),'transcription-provider-error');
      }
    }catch(e){this.fail(e,'transcription-message');}});
    stt.on('error',error=>{if(this.closed||this.stt!==stt)return;if(/401|403/.test(error.message))this.fail(new Error('The transcription account needs attention.'),'transcription-auth');else this.recoverTranscription(stt,'socket-error');});
    stt.on('close',code=>this.recoverTranscription(stt,'socket-close-'+code));
  }
  sendAudio(bytes){this.initiative.input(bytes);if(this.initiative.ready&&this.stt?.readyState===WebSocket.OPEN)this.stt.send(JSON.stringify({message_type:'input_audio_chunk',audio_base_64:bytes.toString('base64'),sample_rate:16000,commit:false}));else if(!this.sttRecovering&&this.audioBytes<160000){this.pendingAudio.push(bytes);this.audioBytes+=bytes.length;}}
  interrupt(reason='user-button'){
    const turn=this.serial,hadReply=!!this.controller||this.speaking||this.pendingPlayback;
    const continued=hadReply&&!this.speaking&&!this.currentOutreach&&['continued-user-speech','sustained-user-speech','committed-user-speech'].includes(reason);
    this.settleOutreach('interrupted',{reason});this.pendingPlayback=false;this.initiative.activity();
    this.completedDelivery=null;
    if(hadReply){
      // Cancelling a reply before audio is a continuation, not evidence that
      // Samantha spoke over Owner. Retain context through repeated cancellations
      // until the replacement reply actually starts sending audio.
      this.wasInterrupted ||= this.speaking;
      this.wasContinued ||= continued;
      safeLog('voice_interrupted',{turn,reason,audioStarted:this.speaking,generatedCharacters:this.replyText.length});
    }
    outing.playback(`call:${this.initiative.callId}:${this.serial}`,'interrupted');this.interruption.playbackEnded();this.interruption.reset();this.serial++;this.controller?.abort();this.controller=null;this.tts?.terminate();this.tts=null;clearInterval(this.keepalive);clearTimeout(this.phraseTimer);this.speaking=false;
    this.send('interrupted',{turn,reason});this.send('state',{state:'listening'});
  }
  async respond(text,{outreach=null,voiceEvidence,continuation=null}={}){
    const settings=this.voiceSettings,fish=this.fishSettings;
    if(this.closed)return;
    const binding=speakerBinding(speakers.read(this.owner).speaker);
    if(outreach&&binding.recipient.personId!=='owner')throw Error('Owner is not the selected participant.');
    if(!outreach&&!continuation){outing.noteUser(text);this.pendingInput??=new VoicePendingInput();this.pendingInput.append(text);}
    if(outreach){this.serial++;this.currentOutreach=outreach.requestId;this.initiative.activity();}
    else if(continuation){this.serial++;this.initiative.activity();}
    else this.interrupt('committed-user-speech');
    this.replyText='';if(textTurns.busy()){this.send('error',{error:'A text reply is in progress. Try again when it finishes.'});return;}
    const n=this.serial,ac=new AbortController();const wasInterrupted=!!this.wasInterrupted,wasContinued=!!this.wasContinued&&!wasInterrupted;this.controller=ac;this.pendingPlayback=true;
    if(outreach||continuation)this.send('assistant_start',{turn:n,proactive:true});else this.send('user',{text,speakerBinding:binding});
    this.send('state',{state:'thinking'});
    let all='',first=null,firstAudio=null;const begun=Date.now();let pending=[],ttsReady=false,done=false,audioDone=false,generatedAudioBytes=0,speechFailed=false,quietEnd=false;
    let voiceDelivery,deliveryStream=new EmotionalVoiceStream({enabled:false});
    // Account checks are required before synthesis, but need not postpone the
    // unchanged Samantha response. Prefetch one chunk while both checks run.
    const pendingReply=outreach?null:prefetchReply(answer(text,{signal:ac.signal,voice:true,voiceEvidence:continuation?{...(voiceEvidence??{}),contact:false,resting:this.engagement.resting}:voiceEvidence,speakerBinding:binding,interrupted:wasInterrupted,continued:wasContinued,continuation,prepareMessage:()=>this.pendingInput?.take(),cameraFrame:await liveCameraFrame({status:(await status()).camera,phone:outing.latestFrame?.()??null}).catch(()=>null)}),{cancel:()=>ac.abort()});
    try{
    const credits=await callCredits(settings,fish);safeLog('voice_preflight',{turn:n,elapsedMs:Date.now()-begun,replyStartedInParallel:!!pendingReply});if(credits.remaining<2000)throw new Error('Call stopped: included credits are low.');const replyLimit=Math.min(5000,Math.floor((credits.remaining-1200)/2));if(this.closed||n!==this.serial)return;
    const useFish=settings.provider==='fish',model=useFish?(fish.model||'s2.1-pro'):(settings.model||'eleven_v4_turbo');const flash=!useFish&&model==='eleven_flash_v2_5';const voiceId=useFish?(fish.voiceId||FISH_VOICE):settings.voiceId;
    const url=flash?`wss://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(settings.voiceId)}/stream-input?model_id=${model}&output_format=pcm_24000`:`wss://api.elevenlabs.io/v1/text-to-dialogue/stream-input?model_id=${model}&output_format=pcm_24000`;
    const tts=useFish?new FishSpeechSocket({apiKey:fish.apiKey,voiceId,model}):new WebSocket(url,{headers:{'xi-api-key':settings.apiKey},handshakeTimeout:12000,maxPayload:5*1048576});this.tts=tts;
    const push=text=>{if(speechFailed)return;if(!ttsReady){pending.push(text);return;}tts.send(JSON.stringify(flash?{text,try_trigger_generation:true}:dialogueInput(text,voiceId,deliveryStream)));};
    const phrasing=new SpeechPhraser();
    const flushPhrases=(final=false)=>{clearTimeout(this.phraseTimer);this.phraseTimer=null;if(this.closed||n!==this.serial||speechFailed)return;for(const part of phrasing.drain({timed:!final,final}))push(part);};
    const queueSpeech=text=>{if(flash){push(text);return;}for(const part of phrasing.push(text))push(part);if(phrasing.buffer&&!this.phraseTimer)this.phraseTimer=setTimeout(()=>flushPhrases(),180);};
    const finish=()=>{flushPhrases(true);if(!speechFailed&&ttsReady&&tts.readyState===WebSocket.OPEN)tts.send(JSON.stringify(flash?{text:''}:{close_socket:true}));};
    tts.on('open',()=>{if(this.closed||n!==this.serial||speechFailed){tts.terminate();return;}tts.send(JSON.stringify(flash?{text:' ',voice_settings:{stability:.45,similarity_boost:.75},generation_config:{chunk_length_schedule:[80,120,160,200]}}:{voices:[voiceId],voice_settings:{stability:.5}}));ttsReady=true;for(const s of pending)push(s);pending=[];if(done)finish();});
    const keepalive=setInterval(()=>{if(!speechFailed&&ttsReady&&!done&&tts.readyState===WebSocket.OPEN)tts.send(JSON.stringify(flash?{text:' '}:{keep_alive:true}));},10000);this.keepalive=keepalive;
    const audioFinished=()=>{if(audioDone||speechFailed||n!==this.serial||this.closed)return;if(!generatedAudioBytes){speechFailure(new Error('Voice synthesis produced no audio.'));return;}audioDone=true;this.settleOutreach('audio-generated');this.completedDelivery={id:crypto.randomUUID(),speakerBinding:binding};if(binding?.speaker?.personId==='owner')void saidNext.record({text:all,turnId:String(n),surface:'voice'}).catch(()=>{});clearInterval(keepalive);safeLog('voice_audio_complete',{turn:n,audioBytes:generatedAudioBytes,audioSeconds:generatedAudioBytes/48000});this.send('audio_done',{turn:n});};
    const speechFailure=error=>{
      if(speechFailed||this.closed||n!==this.serial)return;
      speechFailed=true;this.pendingPlayback=false;this.settleOutreach('failed',{reason:'speech-synthesis-failed'});pending=[];clearInterval(keepalive);clearTimeout(this.phraseTimer);this.completedDelivery=null;
      const failure=describeSpeechFailure(error,useFish?fish.apiKey:settings.apiKey);
      safeLog('voice_synthesis_failed',{turn:n,...failure,audioBytes:generatedAudioBytes});
      this.send('voice_error',{turn:n,code:failure.code,error:failure.notice,partial:generatedAudioBytes>0});
      tts.terminate();
      // A speech-service failure must not abort or regenerate Samantha's words.
    };
    tts.on('message',raw=>{if(this.closed||n!==this.serial||speechFailed)return;try{const m=JSON.parse(raw);if(m.error){speechFailure(m);return;}if(m.audio){generatedAudioBytes+=Buffer.from(m.audio,'base64').length;if(!firstAudio){firstAudio=Date.now();this.wasInterrupted=false;this.wasContinued=false;safeLog('voice_first_audio',{latencyMs:firstAudio-begun,turn:n});}this.interruption.rememberPlayback(this.replyText);this.speaking=true;this.send('state',{state:'speaking'});this.send('audio',{audio:boostVoicePCM(m.audio),sampleRate:24000,turn:n});}if(m.is_final||m.isFinal){audioFinished();}}catch(e){speechFailure(e);}});
    tts.on('error',speechFailure);
    tts.on('close',(code)=>{clearInterval(keepalive);if(n!==this.serial||this.closed||audioDone||speechFailed||quietEnd)return;if(!ac.signal.aborted)speechFailure({code,message:'Voice synthesis ended before the audio completed.'});});
    try{
      const proactiveSource=async function*(){
        // Append assistant-authored words, never a fabricated user input or an
        // extra foreground model turn. Playback is recorded separately.
        await rpc('chat.inject',{sessionKey:process.env.SAI_SESSION_KEY||'agent:samantha:main',message:outreach.text});
        if(ac.signal.aborted)return;
        yield outreach.text;
      };
      for await(const delta of (outreach?proactiveSource():pendingReply)){
        if(n!==this.serial||this.closed)return;first??=Date.now();all+=delta;this.replyText=all;
        if(all.length>replyLimit)throw new Error('Voice answer exceeded the call’s response limit.');
        this.send('assistant',{text:all,turn:n,speakerBinding:binding});
        if(!voiceDelivery){
          // Read after Samantha begins answering, so the latest input appraisal
          // has had the same opportunity to update state as in the text path.
          const snapshot=flash?null:await readVoiceSnapshot(process.env.SAI_SESSION_KEY||'agent:samantha:main');
          if(n!==this.serial||this.closed||ac.signal.aborted)return;
          voiceDelivery=deliveryFor(snapshot,{model});deliveryStream=new EmotionalVoiceStream(voiceDelivery,{baseTag:registerFor(model)});
          if(snapshot?.ok)this.send('mood',moodView(snapshot));
          await safeLog('voice_delivery',{turn:n,model,enabled:voiceDelivery.enabled,reason:voiceDelivery.reason,
            stateDigest:voiceDelivery.stateDigest,direction:voiceDelivery.tag,register:registerFor(model),phraseWaitMaxMs:flash?0:180,readMs:snapshot?.readMs});
        }
        queueSpeech(delta);
      }
      // A continuation she answers with NO_REPLY ends quietly: no audio, no error, the planner may try once more later.
      if(continuation&&n===this.serial&&!all.trim()){quietEnd=true;done=true;clearInterval(keepalive);clearTimeout(this.phraseTimer);this.pendingPlayback=false;tts.terminate();this.send('state',{state:'listening'});await safeLog('call_'+continuation+'_quiet',{turn:n});if(continuation==='continue')this.continuation.assistantDone();return;}
      if(n===this.serial){this.engagement.assistant(all);done=true;finish();outing.noteAssistant(`call:${this.initiative.callId}:${n}`,all);this.send('answer_done',{turn:n});await safeLog('voice_reply',{firstTextMs:first?first-begun:null,firstAudioMs:firstAudio?firstAudio-begun:null,totalTextMs:Date.now()-begun,characters:all.length,textSha256:crypto.createHash('sha256').update(all).digest('hex')});}
    }catch(e){if(!ac.signal.aborted)this.responseFailed(e,n);}
    finally{if(this.controller===ac){this.controller=null;if(speechFailed&&!this.speaking&&n===this.serial&&!this.closed)this.send('state',{state:'listening'});}}
    }catch(e){if(!ac.signal.aborted){if(transientVoiceFailure(e))this.responseFailed(e,n);else throw e;}}
    finally{await pendingReply?.close();}
  }
  failureDetail(e){return String(e?.message||e).split(this.voiceSettings.apiKey||'\0').join('[redacted]').split(this.fishSettings.apiKey||'\0').join('[redacted]').slice(0,300);}
  responseFailed(e,turn){if(this.closed||turn!==this.serial)return;safeLog('voice_response_failed',{turn,error:this.failureDetail(e),audioStarted:this.speaking});const pending=e?.code==='reply_cleanup_pending';this.send('voice_error',{turn,code:pending?'reply_cleanup_pending':'response_unavailable',error:pending?'The previous reply is taking too long to stop. The call is still open; your latest words have not been submitted.':'The reply connection failed. The call is still open; your message has not been resent automatically.',partial:this.speaking});this.interrupt('response-error');}
  fail(e,source='call'){if(this.closed)return;const error=this.failureDetail(e);safeLog('call_failed',{source,error,turn:this.serial,replyActive:!!this.controller,speaking:this.speaking});this.send('error',{error});this.close(source);}
  close(reason='call-ended'){if(this.closed)return;void outing.stop('call-ended').catch(e=>safeLog('outing_stop_error',{error:e.message}));this.closed=true;this.continuation?.stop();this.interrupt('call-ended');clearTimeout(this.limit);this.creditCheck?.stop();clearInterval(this.silenceKeepalive);this.clearTranscriptionRecovery();this.stt?.terminate();if(activeCall===this)activeCall=null;this.send('ended');if(this.transport)this.transport.close();else this.client.close();safeLog('call_ended',{reason,durationMs:Date.now()-this.started});}
}
const wss=new WebSocketServer({noServer:true,maxPayload:131072});
server.on('upgrade',(req,socket,head)=>{
  const u=new URL(req.url,'http://localhost');
  if(u.pathname!=='/live'||!authorized(req)||!originAllowed(req.headers.origin,req.headers.host,allowedHosts)){socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');socket.destroy();return;}
  wss.handleUpgrade(req,socket,head,client=>wss.emit('connection',client,req));
});
wss.on('connection',async(client,req)=>{
  const u=new URL(req.url,'http://localhost'),id=u.searchParams.get('callId'),owner=textOwner(cookie(req));
  const reject=message=>{client.send(JSON.stringify({type:'error',error:message}));client.close();};
  if(activeCall?.mode==='gpt-live'&&activeCall.closed){const handoff=await activeCall.closePromise;if(handoff?.saved===false)return reject('The last call transcript did not finish saving. Please check the conversation before starting another call.');}
  if(client.readyState!==WebSocket.OPEN)return;
  if(id&&!/^[a-fA-F0-9-]{36}$/.test(id))return reject('Invalid call identifier.');
  let call=activeCall,isNew=false;
  if(call){
    if(!call.transport?.matches(id,owner))return reject('SAI already has an active call.');
  }else{
    if(u.searchParams.get('resume')==='1')return reject('This call has ended on the Mac. Please start a new call.');
    if(u.searchParams.get('incoming')==='1'&&!incomingCalls.canConnect(owner,id))return reject('The incoming call was not accepted or has expired.');
    let transport=null;
    if(id)transport=new CallTransport({id,owner,log:safeLog,onExpire:message=>call.fail(new Error(message))});
    const requestedMode=resolveVoiceMode({requested:u.searchParams.get('mode')??undefined,selected:voiceModes[owner],callId:id,incoming:u.searchParams.get('incoming')==='1'});
    if(requestedMode==='eleven'||requestedMode==='phonic'){
      if(requestedMode==='phonic'&&!(await read('phonic.json')).apiKey)return reject('Phonic is not configured.');
      if(requestedMode==='eleven'&&!elevenAgent.agentId)return reject('Samantha\'s ElevenLabs agent has not been created yet. Open Settings on the Mac and create it.');
      const sessionKey=process.env.SAI_SESSION_KEY||'agent:samantha:main';
      const participant=speakerBinding(speakers.read(owner).speaker);
      call=new (requestedMode==='phonic'?PhonicCall:ElevenAgentCall)({client,transport,owner,participant,sessionKey,realtimeModel:elevenAgent.realtimeModel??DEFAULT_REALTIME_MODEL,log:(event,values)=>safeLog(requestedMode==='phonic'?event.replace(/^eleven_/, 'phonic_'):event,values),recordContact,readStanding:async()=>({...await readStanding(),incomingCall:u.searchParams.get('incoming')==='1'?incomingCalls.intention(owner,id):null}),
        readContext:(options={})=>runLiveMemory({operation:'context',sessionKey,personId:participant.speaker.personId,person:participant.speaker,...(requestedMode==='phonic'?{includeVoiceContext:true,...(options.query?{query:options.query}:{})}:{})}),
        readHistory:()=>conversationFeed.read({fresh:true}),readEmotion:()=>readVoiceSnapshot(sessionKey),
        persist:async request=>{const result=await runLiveMemory(request);conversationFeed.invalidate();return result;},
        token:async()=>({...(await nativeConversationToken({key:settings.apiKey,agentId:elevenAgent.agentId})),agentId:elevenAgent.agentId}),
        conversationDetails:id=>conversationDetails({key:settings.apiKey,conversationId:id}),
        delegate:async function*(message,options){if(requestedMode==='phonic')options={...options,requestId:options.requestId?.replace(/^sai-eleven-/, 'sai-phonic-')};const frame=await liveCameraFrame({status:(await status()).camera,phone:outing.latestFrame?.()??null}).catch(()=>null);if(frame)recordSeenFrame(frame,outing.view()).catch(e=>safeLog('seen_frame_error',{error:String(e?.message||e).slice(0,200)}));yield* gatewayChat({token:await gatewaySecret(),sessionKey,message,...options,...(frame?{attachments:[frame.attachment]}:{}),
          workContext:conversationWorkContext({voice:true,speakerBinding:options.speakerBinding??participant,outing:outing.view(),cameraFrame:frame?{capturedAt:frame.capturedAt,sourceKind:frame.sourceKind}:null}),
          systemInputProvenance:{kind:'internal_system',sourceSessionKey:sessionKey,sourceTool:requestedMode==='phonic'?'sai_phonic_voice_delegation':'sai_eleven_voice_delegation'}});},
        onClose:ended=>{if(activeCall===ended)activeCall=null;if(u.searchParams.get('incoming')==='1')void incomingCalls.finishCall(owner,id).catch(()=>{});void outing.stop('call-ended').catch(()=>{});}
      });
      call.onOutreach=(id,status,extra)=>outreachReceipts.update(id,{status,...extra}).catch(e=>safeLog('outreach_receipt_error',{requestId:id,error:e.message}));
    }else if(requestedMode==='gpt-live'){
      const sessionKey=process.env.SAI_SESSION_KEY||'agent:samantha:main';
      const participant=speakerBinding(speakers.read(owner).speaker);
      call=new LiveVoiceCall({client,transport,owner,participant,sessionKey,log:safeLog,recordContact,
        readContext:()=>runLiveMemory({operation:'context',sessionKey,personId:participant.speaker.personId,person:participant.speaker}),
        readHistory:()=>conversationFeed.read({fresh:true}),readEmotion:()=>readVoiceSnapshot(sessionKey),
        persist:async request=>{const result=await runLiveMemory(request);conversationFeed.invalidate();return result;},
        delegate:async function*(message,options){const frame=await liveCameraFrame({status:(await status()).camera,phone:outing.latestFrame?.()??null}).catch(()=>null);if(frame)recordSeenFrame(frame,outing.view()).catch(e=>safeLog('seen_frame_error',{error:String(e?.message||e).slice(0,200)}));yield* gatewayChat({token:await gatewaySecret(),sessionKey,message,...options,...(frame?{attachments:[frame.attachment]}:{}),
          workContext:conversationWorkContext({voice:true,speakerBinding:options.speakerBinding??participant,outing:outing.view(),cameraFrame:frame?{capturedAt:frame.capturedAt,sourceKind:frame.sourceKind}:null}),
          systemInputProvenance:{kind:'internal_system',sourceSessionKey:sessionKey,sourceTool:'sai_live_voice_delegation'}});},
        onClose:ended=>{if(activeCall===ended)activeCall=null;if(u.searchParams.get('incoming')==='1')void incomingCalls.finishCall(owner,id).catch(()=>{});void outing.stop('call-ended').catch(()=>{});}
      });
    }else call=new VoiceCall(client,transport,owner);
    activeCall=call;isNew=true;
  }
  if(call.transport&&!call.transport.attach(client,Number(u.searchParams.get('after')||0))){
    if(isNew)call.close();
    return reject('This call can no longer resume safely. Please start a new call.');
  }
  if(!isNew)safeLog('call_transport_resumed',{turn:call.serial});
  let alive=true;client.on('pong',()=>alive=true);
  const heartbeat=setInterval(()=>{if(!alive){client.terminate();return;}alive=false;client.ping();},10000);
  client.on('error',()=>{}); // close owns detachment; transient TCP errors are recoverable.
  client.on('close',code=>{
    clearInterval(heartbeat);
    safeLog('call_socket_closed',{code,turn:call.serial,alreadyEnded:call.closed,resumable:!!call.transport});
    if(call.transport){
      if(call.transport.client!==client)return;
      if(code===1000||call.mode==='gpt-live'||call.mode==='phonic')call.close('client-disconnected');else call.transport.detach(client);
    }else call.close('client-unresumable-close');
  });
  client.on('message',(raw,binary)=>{
    if(call.closed||(call.transport&&call.transport.client!==client))return;
    if(binary){if(call.mode!==ELEVEN_MODE)call.sendAudio(raw);return;}
    try{
      const m=JSON.parse(raw);
      if(m.type==='transport_ack'){call.transport?.acknowledge(m.seq);return;}
      if(m.controlId&&call.transport){
        const fresh=call.transport.acceptControl(m.controlId);
        client.send(JSON.stringify({type:'control_ack',controlId:m.controlId}));
        if(!fresh)return;
      }
      if(call.mode===ELEVEN_MODE||call.mode==='gpt-live'||call.mode==='phonic'){call.control(m);return;}
      if(m.type==='hello')call.capable=Array.isArray(m.capabilities)&&m.capabilities.includes('proactive-voice-v1');
      if(m.type==='end')call.close('client-end-control');
      if(m.type==='interrupt')call.interrupt();
      if(m.type==='playback_failed'&&m.turn===call.serial){outing.playback(`call:${call.initiative.callId}:${call.serial}`,'failed');call.settleOutreach('failed',{reason:'client-playback-failed'});call.pendingPlayback=false;call.initiative.activity();call.completedDelivery=null;call.interruption.playbackEnded();call.speaking=false;call.send('state',{state:call.controller?'thinking':'listening'});}
      if(m.type==='playback_done'&&(m.turn===undefined||m.turn===call.serial)){
        if(call.completedDelivery){outing.playback(`call:${call.initiative.callId}:${call.serial}`,'played');call.settleOutreach('played');call.pendingPlayback=false;call.initiative.activity();const id=call.completedDelivery;call.completedDelivery=null;safeLog('voice_playback_complete',{turn:call.serial});recordContact('assistant','sai_voice',id.id,id.speakerBinding).catch(e=>safeLog('contact_error',{error:e.message}));}
        call.interruption.playbackEnded();call.speaking=false;call.send('state',{state:call.controller?'thinking':'listening'});call.continuation.assistantDone();
      }
    }catch{}
  });
  if(isNew)call.start().catch(e=>call.fail(e));
});
server.listen(PORT,'127.0.0.1',()=>{
  console.log(`SAI ready on http://127.0.0.1:${PORT}`);
  // Warm the read-only connection once. Later calls still read fresh context,
  // without reopening and integrity-checking the agent database on the call.
  void runLiveMemory({operation:'context',sessionKey:process.env.SAI_SESSION_KEY||'agent:samantha:main',personId:'owner'}).then(()=>safeLog('live_memory_ready')).catch(()=>safeLog('live_memory_unavailable'));
  if(!process.env.SAI_DATA_DIR){const awake=spawn('/usr/bin/caffeinate',['-i','-w',String(process.pid)],{stdio:'ignore'});awake.on('error',()=>safeLog('keep_awake_unavailable'));awake.unref();}
});
for(const sig of ['SIGTERM','SIGINT'])process.on(sig,()=>{activeCall?.close();chess?.stop();chessConnection.close();stopMessageNotifications();void messageNotifications.stop();conversationFeed.stop();void textTurns.shutdown();void beats.shutdown();void appPresence.stop();stopLiveMemory();server.close(()=>process.exit(0));setTimeout(()=>process.exit(0),3000).unref();});
