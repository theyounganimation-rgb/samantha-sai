import crypto from 'node:crypto';
import {conversationalText} from './visible-reply.mjs';
import {messageMedia,stripMediaDirectives} from './message-media.mjs';

// A spoken continuation can arrive before cancellation of the preceding reply
// has released the native session. Do not admit that continuation into a queue
// owned by a run which is still stopping.
const sessionTurns=new Map();
async function acquireTurn(sessionKey,signal){
  const previous=sessionTurns.get(sessionKey),settled=Promise.withResolvers();
  sessionTurns.set(sessionKey,settled.promise);
  let released=false;
  const release=(error)=>{if(released)return;released=true;settled.resolve(error);if(sessionTurns.get(sessionKey)===settled.promise)sessionTurns.delete(sessionKey);};
  try{
    if(previous){const error=await previous;if(error)throw error;}
    signal?.throwIfAborted();
    return release;
  }catch(e){release(signal?.aborted?undefined:e);throw e;}
}

// Use the gateway's conversation API, including its durable admission and native
// session binding. The OpenAI compatibility endpoint omits reply-policy facts.
// The gateway's wording for a CLI turn whose only output was the silent-reply token.
export const SILENT_CLI_FAILURE=/CLI backend returned an empty response/i;
export async function* gatewayChat({token,sessionKey,message,prepareMessage,workContext,signal,onReceipt=()=>{},onTiming=()=>{},responsePolicy,createClient,requestId,systemInputProvenance,attachments,replyTimeoutMs=180000,allowQuiet=false}) {
  const started=performance.now(),timing={};
  const mark=name=>{timing[name]=Math.round(performance.now()-started);};
  signal?.throwIfAborted();
  if(!createClient){
    const {GatewayClient}=await import('/opt/homebrew/lib/node_modules/openclaw/dist/plugin-sdk/gateway-runtime.js');
    createClient=options=>new GatewayClient(options);
  }
  const releaseTurn=await acquireTurn(sessionKey,signal);
  mark('slotReadyMs');
  const runId=requestId||crypto.randomUUID(),ready=Promise.withResolvers(),queue=[];
  let notify,closed=false,sent=false,terminal=false,rendered='',visible='',seq=-1;
  const push=value=>{queue.push(value);notify?.();notify=null;};
  const fail=error=>{ready.reject(error);push({error});};
  let client,reconnectTimer,reconcileTimer,recovering=false,reconciling=false,probeTimer,probing=false;
  // October 29 (Owner): a run she answers with NO_REPLY ends as a final with no message, indistinguishable from the admission final.
  // After an admission-like final, ask agent.wait whether the run already finished; a silent run is a quiet completion, not a wait.
  const probeSilent=async()=>{
    if(closed||terminal||rendered||probing)return;probing=true;
    try{
      const result=await client.request('agent.wait',{runId,timeoutMs:1000},{timeoutMs:5000});
      if(closed||terminal||rendered)return;
      if(result.status==='error')push({state:'error',errorMessage:result.error?.message||'The reply failed.'});
      else if(result.status==='ok'){
        const text=String(result.terminalReply?.text??'').trim();
        if(result.terminalReply?.disposition==='silent'||/^NO_REPLY$/.test(text)||!text)push({state:'final',silentRun:true});
        else{recovering=true;await recover();recovering=false;}
      }else probeTimer=setTimeout(()=>void probeSilent(),1500);
    }catch{if(!closed&&!terminal)probeTimer=setTimeout(()=>void probeSilent(),1500);}
    finally{probing=false;}
  };
  const recover=async()=>{
    if(closed||terminal||!recovering||reconciling)return;
    reconciling=true;
    try{
      const result=await client.request('agent.wait',{runId,timeoutMs:1000},{timeoutMs:5000});
      if(closed||terminal)return;
      if(result.status==='error')push({state:'error',errorMessage:result.error?.message||'The original reply failed during connection recovery.'});
      else if(result.status==='ok'){
        // agent.wait's text snapshot is capped at 4096 characters and omits
        // media. Recover the original canonical record, never that summary.
        const history=await client.request('chat.history',{sessionKey,limit:100},{timeoutMs:20000});
        if(closed||terminal)return;
        const message=history.messages?.findLast(m=>m.role==='assistant'&&m.model!=='delivery-mirror'&&
          (m.idempotencyKey===`cli-assistant:${runId}`||m.__openclaw?.idempotencyKey===`cli-assistant:${runId}`||m.__openclaw?.runId===runId));
        if(message?.__openclaw?.truncated)fail(new Error('The saved reply is incomplete in the recovery view. Your message was not sent again.'));
        else if(message)push({state:'final',message});
        else if(result.terminalReply?.disposition==='silent')fail(new Error('The original reply ended without a conversational answer. Your message was not sent again.'));
        else reconcileTimer=setTimeout(()=>void recover(),1000);
      }else reconcileTimer=setTimeout(()=>void recover(),1000);
    }catch{if(!closed&&!terminal)reconcileTimer=setTimeout(()=>void recover(),1000);}
    finally{reconciling=false;}
  };
  const makeClient=()=>createClient({url:'ws://127.0.0.1:18789',token,clientName:'gateway-client',clientDisplayName:'SAI',
    clientVersion:'1.0',platform:'darwin',mode:'backend',deviceIdentity:null,scopes:['operator.admin'],
    caps:['chat-only-assistant-text'],onHelloOk:()=>{ready.resolve();clearTimeout(reconnectTimer);if(recovering)void recover();},onConnectError:error=>{if(!sent)fail(error);},
    onClose:()=>{
      if(closed||terminal)return;
      if(!sent){fail(new Error('Samantha’s connection closed before the request was submitted.'));return;}
      if(!recovering){recovering=true;onReceipt({event:'reconnecting',sessionKey,runId});}
      clearTimeout(reconnectTimer);reconnectTimer=setTimeout(()=>fail(new Error('The connection did not recover. Your message was not sent again.')),30000);
    },
    onEvent:event=>{
      const p=event.payload;
      if(recovering||event.event!=='chat'||p?.runId!==runId||p.sessionKey!==sessionKey||p.seq<=seq)return;
      seq=p.seq;push(p);
      // OpenClaw emits a bare final when admission moves into its follow-up
      // queue, then restarts sequence numbers for the eventual reply. That
      // frame does not mean the queued model turn produced an empty answer.
      if(isAdmissionFinal(p))seq=-1;
    }});
  // Never cancel another channel's turn, and never automatically resend a turn
  // after a lost connection: acceptance may already have been committed.
  const cancel=async()=>{
    if(!sent||terminal)return;
    const stopped=await client.request('chat.abort',{sessionKey,runId,preserveSideRuns:true},{timeoutMs:10000});
    onReceipt({event:'cancel-ack',sessionKey,runId,aborted:stopped.aborted});
    // Terminal run events precede native cleanup. Await the actual reply slot,
    // without re-aborting a successor or replaying any accepted speech.
    // A negative settlement read is pending cleanup, not a failed connection.
    // Hooks can outlive the first 15-second observation window after abort.
    // Keep the admission lock and unsubmitted speech while checking again;
    // never repeat chat.abort or chat.send to recover this condition.
    for(let attempt=1;attempt<=4;attempt++){
      const result=await client.request('sai.reply.settle',{sessionKey},{timeoutMs:17000});
      onReceipt({event:'cancel-settled',sessionKey,runId,attempt,...result});
      if(result.settled===true)return;
    }
    throw Object.assign(new Error('The previous reply is still stopping. Please try again shortly.'),{code:'reply_cleanup_pending'});
  };
  const abort=()=>{const e=signal.reason??new DOMException('Aborted','AbortError');ready.reject(e);push({error:e});};
  const timeout=setTimeout(()=>fail(new Error('Samantha’s reply timed out. Your message is saved in SAI and was not sent again.')),replyTimeoutMs);
  signal?.addEventListener('abort',abort,{once:true});
  try{
    client=makeClient();client.start();await ready.promise;signal?.throwIfAborted();mark('connectedMs');
    if(prepareMessage)message=prepareMessage();
    // Decide after any interrupted fragments have been combined. Never mutate
    // the session's saved reasoning default or classify only the last fragment.
    const policy=responsePolicy?.(message)??{};
    timing.mode=policy.mode??'default';
    if(policy.thinking!==undefined&&!['low','high'].includes(policy.thinking))throw Error('Unsupported conversational effort.');
    sent=true;
    const accepted=await client.request('chat.send',{sessionKey,message,deliver:false,idempotencyKey:runId,
      ...(policy.thinking?{thinking:policy.thinking}:{}),
      timeoutMs:Math.max(1000,replyTimeoutMs-10000),...(workContext?{workContext}:{}),...(systemInputProvenance?{systemInputProvenance}:{}),...(attachments?.length?{attachments}:{}),queueMode:'followup'},{timeoutMs:20000});
    if(accepted.runId&&accepted.runId!==runId)throw new Error('Unexpected conversation run identity.');
    mark('acceptedMs');
    onReceipt({event:'accepted',sessionKey,runId});
    while(true){
      signal?.throwIfAborted();
      if(!queue.length)await new Promise(resolve=>notify=resolve);
      while(queue.length){
        const p=queue.shift();if(p.error)throw p.error;
        // October 26: the gateway's CLI backend reports a deliberate NO_REPLY to a human message as 'CLI backend returned an
        // empty response' instead of a final event. In text, with nothing streamed, that is her choosing not to answer.
        if(p.state==='error'&&allowQuiet&&!rendered.trim()&&SILENT_CLI_FAILURE.test(p.errorMessage??'')){terminal=true;await onReceipt({event:'completed',sessionKey,runId,quiet:true,silentFailure:p.errorMessage});return;}
        if(p.state==='error'||p.state==='aborted')throw new Error(p.errorMessage||'Samantha’s reply was interrupted.');
        if(p.state==='final'&&p.silentRun){terminal=true;if(allowQuiet){await onReceipt({event:'completed',sessionKey,runId,quiet:true,silentRun:true});return;}throw new Error('The reply ended without a conversational answer. Your message was not sent again.');}
        let next;
        if(p.state==='delta')next=p.replace?messageText(p.message)||p.deltaText:rendered+p.deltaText;
        if(p.state==='final')next=messageText(p.message)||rendered;
        if(next!==undefined){
          if(!next.startsWith(rendered)&&!(p.state==='final'&&messageMedia(p.message).length&&/^MEDIA:\s*\S/m.test(rendered)&&stripMediaDirectives(next).startsWith(stripMediaDirectives(rendered))))throw new Error('Samantha revised text that was already streamed.');
          rendered=next;
          if(p.message?.model==='<synthetic>'||p.state==='final'&&/^(?:No response requested\.|NO_REPLY|HEARTBEAT_OK)$/.test(rendered.trim())){
            // October 21: in text, a deliberate NO_REPLY is her choosing not to answer, not a failure. Voice keeps the error path.
            if(allowQuiet&&p.state==='final'&&p.message?.model!=='<synthetic>'&&rendered.trim()==='NO_REPLY'){terminal=true;await onReceipt({event:'completed',sessionKey,runId,quiet:true});return;}
            terminal=true;throw new Error('The reply ended without a conversational answer. Your message was not sent again.');}
          const clean=conversationalText(rendered,{final:p.state==='final'});
          if(!clean.startsWith(visible))throw new Error('Conversational reply changed after delivery.');
          const delta=clean.slice(visible.length);visible=clean;if(delta){if(timing.firstTextMs===undefined)mark('firstTextMs');yield delta;}
        }
        if(p.state==='final'){
          if(!rendered.trim()&&isAdmissionFinal(p)){
            onReceipt({event:'queued',sessionKey,runId});
            clearTimeout(probeTimer);probeTimer=setTimeout(()=>void probeSilent(),1500);
            continue;
          }
          terminal=true;
          const media=messageMedia(p.message);
          if(!visible.trim()&&!media.length)throw new Error('Samantha completed the turn without a visible reply.');
          await onReceipt({event:'completed',sessionKey,runId,...(media.length?{media}:{})});return;
        }
      }
    }
  }finally{
    mark('streamEndedMs');
    try{onTiming({runId,...timing,terminal,aborted:signal?.aborted===true});}catch{}
    clearTimeout(timeout);clearTimeout(reconnectTimer);clearTimeout(reconcileTimer);clearTimeout(probeTimer);signal?.removeEventListener('abort',abort);
    closed=true;let cancellationError;
    try{await cancel();}catch(e){cancellationError=e;throw e;}finally{client?.stop();releaseTurn(cancellationError);}
  }
}

function isAdmissionFinal(p){return p.state==='final'&&p.message==null&&!p.stopReason;}

function messageText(message){
  if(typeof message?.content==='string')return message.content;
  if(Array.isArray(message?.content))return message.content.filter(c=>c.type==='text').map(c=>c.text).join('\n');
  return typeof message?.text==='string'?message.text:'';
}
