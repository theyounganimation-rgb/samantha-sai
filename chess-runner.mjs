import {isOpus55} from './chess-store.mjs';

export function chessTurnPrompt(game,{onCall=false}={}){
 return `SAI chess game event, not a spoken or typed message. You are playing ${game.human.name} as ${game.samanthaColor==='w'?'White':'Black'} in your shared conversation. Game ${game.id}, revision ${game.revision}. ${game.lastMove?`${game.human.name} played ${game.lastMove.san}.`:'Your opponent chose Black; you have the first move.'}
Use samantha_chess status with this gameId, consider the position yourself, then use samantha_chess move with the exact expectedRevision and a legal UCI move. You are the player; do not delegate move selection or use a chess engine. An optional short, natural comment belongs in the move tool's comment field and appears beside the board; if you write one, aim it at ${game.human.name} (a tease, a dare, a reaction), never at a piece's feelings. A move is only played after the tool confirms it. If the game is paused, finished or has changed, respect its current state. No clock: your opponent can return later. Do not send a separate message or a progress report; the game card carries your move. Finish with NO_REPLY.`+(onCall?` ${game.human.name} is on a voice call with you right now, possibly mid-conversation with you about something else, and the board is on his screen, so the move itself needs no announcement. Leave the comment empty unless there is something you would actually say out loud right now (a reaction, a tease, "your move"); if you write one, the host says it aloud in the next quiet moment. Otherwise just play and let the conversation go on as it was.`:'');
}

// Durable admission. Restarting SAI reconciles an accepted run by ID; it never
// silently reruns a turn whose outcome is uncertain. The board itself is CAS.
export function createChessRunner({store,gateway,isBusy=()=>false,callStatus=()=>null,onMoved=async()=>{},sessionKey='agent:samantha:main',now=Date.now,auto=true,log=()=>{}}){
 let running=false,stopped=false,timer;
 async function tick(){
  if(running||stopped)return;running=true;
  try{
   const jobs=store.jobs();const inflight=jobs.find(j=>j.phase!=='queued');
   if(inflight){
    const g=store.get(inflight.game);
    let r;try{r=await gateway('agent.wait',{runId:inflight.id,timeoutMs:1000});}catch(e){if(now()-inflight.at>600000)store.mark(inflight.id,'uncertain','The connection stopped before her turn could be confirmed. The board is saved.');return;}
    if(r.status==='ok'||r.status==='error'){
     const moved=g.moves.some(m=>m.by==='samantha'&&m.at>=inflight.at);
     const changed=g.revision!==inflight.revision;
     store.mark(inflight.id,moved||changed?'completed':'failed',moved||changed?null:'Samantha did not finish a move. You can ask her to try this turn again.');
     // October 22: her move landed; on a call the server says it aloud.
     if(moved){try{await onMoved({job:inflight,game:store.get(inflight.game),move:store.get(inflight.game).moves.at(-1)});}catch(e){log('chess_moved_hook_error',{id:inflight.id,error:String(e.message).slice(0,160)});}}
    }else if(now()-inflight.at>600000)store.mark(inflight.id,'uncertain','Her turn has not been confirmed. The board is saved; retry only when you want to.');
    return;
   }
   if(isBusy())return;
   // October 22: a call no longer blocks her turn. It waits for a quiet moment, the same rule as her own speech on the call.
   const call=callStatus();const onCall=!!call?.active;
   if(onCall&&!call.canSpeak)return;
   const job=jobs.find(j=>j.phase==='queued');if(!job)return;
   const g=store.get(job.game);
   if(g.paused||g.status!=='active'||g.turn!=='samantha'||g.revision!==job.revision){store.mark(job.id,'superseded');return;}
   const d=await gateway('sessions.describe',{key:sessionKey});
   if(!isOpus55(d.session?.model)){store.mark(job.id,'failed','Samantha’s Opus 5.5 session is unavailable. No other model played.');return;}
   // Do not put a chess turn in front of an ongoing personal conversation.
   if(['running','busy'].includes(d.session?.status))return;
   store.mark(job.id,'dispatching');
   try{
    await gateway('chat.send',{sessionKey,message:chessTurnPrompt(g,{onCall}),deliver:false,idempotencyKey:job.id,timeoutMs:240000,queueMode:'followup',
     systemInputProvenance:{kind:'internal_system',sourceTool:'sai-chess'},
     workContext:{page:'SAI chess',title:`Chess with ${g.human.name}`,selection:JSON.stringify({gameId:g.id,revision:g.revision,playerId:g.human.id,speakerBinding:{v:1,speakerId:g.human.id,recipientId:'samantha',source:'sai-chess'},source:'saved chess board, not human speech'})}});
    store.mark(job.id,'accepted');log('chess_turn_accepted',{id:job.id,gameId:g.id,revision:g.revision,onCall});
   }catch(e){log('chess_admission_uncertain',{id:job.id,error:e.message});/* reconcile by run ID on next tick */}
  }catch(e){log('chess_runner_error',{error:e.message});}
  finally{running=false;}
 }
 if(auto){timer=setInterval(()=>void tick(),4000);timer.unref?.();}
 return {tick,stop(){stopped=true;clearInterval(timer);},busy:()=>running};
}
