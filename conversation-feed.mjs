import crypto from 'node:crypto';
import {visibleHistory} from './core.mjs';

// One read-only gateway subscription serves all SAI screens. It never starts a
// model turn, sends a message, or treats generated speech as heard speech.
export function createConversationFeed({getToken,sessionKey='agent:samantha:main',createClient,preferSavedHistory=false,projectMessages=messages=>messages,prepareMessages=async messages=>messages,isBusy=()=>false,now=Date.now,log=()=>{}}) {
  let client,opening,connected=false,ready=Promise.withResolvers(),version=0,loaded=-1,snapshot=null,inflight=null,timer,stopped=false;
  const listeners=new Set(),epoch=crypto.randomUUID();let sequence=0;
  // Saved canonical messages include confirmed iMessage delivery mirrors. The
  // display-history RPC additionally imports the entire native provider log.
  // Keep that expensive import out of ordinary foreground synchronization.
  const recovered=new Map(),attempted=new Map();let recovery=null,failedRuns=new Map();
  const runOf=m=>m.__openclaw?.runId??(m.idempotencyKey??m.__openclaw?.idempotencyKey??'').match(/^cli-assistant:(.+)$/)?.[1];
  const failures=rows=>new Map(rows.filter(m=>m.role==='assistant'&&m.provider==='claude-cli'&&['error','aborted'].includes(m.stopReason)&&runOf(m)).map(m=>[runOf(m),JSON.stringify([m.__openclaw?.id,m.timestamp,m.stopReason,m.content])]));
  function withRecoveries(rows){
    const present=new Set(rows.filter(m=>m.role==='assistant'&&m.turnId).map(m=>m.turnId));
    return [...rows,...[...recovered].filter(([run,r])=>failedRuns.get(run)===r.failure&&!present.has(run)).map(([,r])=>r.message)]
      .sort((a,b)=>Number(new Date(a.timestamp))-Number(new Date(b.timestamp))).slice(-60);
  }
  function recoverNative(){
    if(stopped||recovery||isBusy())return;
    const missing=[...failedRuns].filter(([run,key])=>{
      const prior=attempted.get(key);
      return recovered.get(run)?.failure!==key&&(!prior||prior.count<3&&now()-prior.at>=15000);
    });
    if(!missing.length)return;
    // A native final can land just after cancellation. Later real refreshes
    // may retry its read, bounded to three attempts and no new timer or send.
    for(const [,key] of missing)attempted.set(key,{at:now(),count:(attempted.get(key)?.count??0)+1});
    while(attempted.size>80)attempted.delete(attempted.keys().next().value);
    recovery=(async()=>{
      const started=performance.now(),result=await client.request('chat.history',{sessionKey,limit:100},{timeoutMs:20000});
      if(stopped)return;
      let changed=false;
      for(const message of visibleHistory(projectMessages(result.messages??[]))){
        const match=missing.find(([run,key])=>message.role==='assistant'&&message.turnId===run&&failedRuns.get(run)===key);
        if(match){recovered.set(match[0],{failure:match[1],message});changed=true;}
      }
      while(recovered.size>80)recovered.delete(recovered.keys().next().value);
      log('history_native_recovery',{durationMs:Math.round(performance.now()-started),recovered:changed});
      if(changed)invalidate();
    })().catch(e=>log('history_recovery_error',{error:e.message})).finally(()=>{recovery=null;});
  }
  async function open(){
    if(!client&&!opening)opening=(async()=>{
      const token=await getToken();
      if(!createClient){const {GatewayClient}=await import('/opt/homebrew/lib/node_modules/openclaw/dist/plugin-sdk/gateway-runtime.js');createClient=o=>new GatewayClient(o);}
      client=createClient({url:'ws://127.0.0.1:18789',token,clientName:'gateway-client',clientDisplayName:'SAI conversation sync',clientVersion:'1.0',platform:'darwin',mode:'backend',deviceIdentity:null,scopes:['operator.admin'],
        onHelloOk:()=>{void client.request('sessions.messages.subscribe',{key:sessionKey,agentId:'samantha',subscriptionId:'sai-history'},{timeoutMs:10000}).then(()=>{connected=true;ready.resolve();invalidate();log('history_subscribed');}).catch(e=>log('history_subscription_error',{error:e.message}));},
        onClose:()=>{if(connected){connected=false;ready=Promise.withResolvers();}version++;},
        onConnectError:e=>log('history_connection_error',{error:e.message}),
        onEvent:e=>{if(e.payload?.sessionKey===sessionKey&&(e.event==='session.message'||e.event==='chat'&&['final','error','aborted'].includes(e.payload.state)))invalidate();}
      });client.start();
    })().finally(()=>opening=null);
    if(opening)await opening;
    let deadline;
    try{await Promise.race([ready.promise,new Promise((_,reject)=>{deadline=setTimeout(()=>reject(Error('Conversation connection is recovering.')),10000);})]);}
    finally{clearTimeout(deadline);}
  }
  function schedule(){
    if(!listeners.size||stopped)return;
    clearTimeout(timer);timer=setTimeout(()=>{
      if(isBusy()){schedule();return;}
      void read().catch(e=>log('history_refresh_error',{error:e.message}));
    },250);timer.unref?.();
  }
  function invalidate(){version++;schedule();}
  async function read({fresh=false}={}){
    if(inflight)return inflight;
    if(fresh)version++;
    if(snapshot&&loaded===version)return snapshot;
    inflight=(async()=>{
      await open();
      let passes=0;
      do{
        const target=version;
        const started=performance.now();
        let result,rows;
        if(preferSavedHistory){
          // A tool-heavy tail may contain fewer visible messages. Expand only
          // within a fixed bound; never scan a provider's lifetime transcript.
          for(const limit of [240,480,960]){
            result=await client.request('sessions.get',{key:sessionKey,agentId:'samantha',limit},{timeoutMs:10000});
            rows=visibleHistory(projectMessages(result.messages??[]));
            if(rows.length>=60||(result.messages?.length??0)<limit)break;
          }
          failedRuns=failures(result.messages??[]);rows=withRecoveries(rows);
        }else{
          result=await client.request('chat.history',{sessionKey,limit:100},{timeoutMs:20000});
          rows=visibleHistory(projectMessages(result.messages??[]));
        }
        log('history_read',{durationMs:Math.round(performance.now()-started),source:preferSavedHistory?'saved_messages':'display_history'});
        const messages=await prepareMessages(rows);
        const revision=crypto.createHash('sha256').update(JSON.stringify(messages)).digest('hex');
        const changed=snapshot?.revision!==revision;
        snapshot={messages,revision,epoch,sequence:changed?++sequence:sequence};loaded=target;
        if(changed){for(const fn of listeners)fn(snapshot);log('history_updated',{revision,count:messages.length});}
        passes++;
      }while(loaded!==version&&!stopped&&!isBusy()&&passes<2);
      if(preferSavedHistory)recoverNative();
      return snapshot;
    })().finally(()=>{
      inflight=null;
      // Continuous transcript activity must not hold an HTTP history request
      // open forever. Publish the consistent snapshot, then catch up separately.
      if(loaded!==version)schedule();
    });
    return inflight;
  }
  return {
    read,invalidate,
    subscribe(fn){listeners.add(fn);if(snapshot)fn(snapshot);if(isBusy())invalidate();else void read({fresh:true}).then(v=>{if(listeners.has(fn))fn(v);}).catch(e=>log('history_refresh_error',{error:e.message}));return()=>listeners.delete(fn);},
    stop(){stopped=true;clearTimeout(timer);listeners.clear();client?.stop();}
  };
}

export function streamConversation(feed,res){
  res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-store','X-Accel-Buffering':'no'});res.flushHeaders();
  let closed=false,lastRevision;
  const send=v=>{if(closed||res.destroyed||v.revision===lastRevision)return;lastRevision=v.revision;res.write('data: '+JSON.stringify(v)+'\n\n');};
  const unsubscribe=feed.subscribe(send);
  const timer=setInterval(()=>{if(!closed&&!res.destroyed)res.write(': keepalive\n\n');},10000);timer.unref?.();
  res.on('close',()=>{closed=true;clearInterval(timer);unsubscribe();});
}
