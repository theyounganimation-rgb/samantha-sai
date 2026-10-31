import path from 'node:path';
import crypto from 'node:crypto';
import {createChessStore,mergeGameCards} from './chess-store.mjs';
import {createChessRunner} from './chess-runner.mjs';

export function createChessService({directory,gateway,isBusy,callStatus,onMoved,onChange=()=>{},sessionKey='agent:samantha:main',auto=true,log=()=>{}}){
 const listeners=new Set(),proofs=new Map();
 const changed=()=>{onChange();for(const send of listeners)send();};
 const store=createChessStore({file:path.join(directory,'chess.sqlite'),onChange:changed});
 const runner=createChessRunner({store,gateway,isBusy,callStatus,onMoved,sessionKey,auto,log});
 function scoped(key){
  if(key==='agent:samantha:main')return store;
  if(!/^agent:samantha:regulation-proof-chess-[a-z0-9-]{1,100}$/.test(key??''))throw Object.assign(Error('This session cannot change a chess game.'),{status:403});
  if(!proofs.has(key)){
   if(proofs.size>=8){const first=proofs.keys().next().value;proofs.get(first).close();proofs.delete(first);}
   proofs.set(key,createChessStore({file:path.join(directory,'proof',crypto.createHash('sha256').update(key).digest('hex')+'.sqlite')}));
  }
  return proofs.get(key);
 }
 return {store,runner,
  list:()=>({games:store.list()}),get:id=>({game:store.get(id)}),
  act:(args,human)=>store.act(args,{actor:human.id,human}),
  merge:messages=>mergeGameCards(messages,store.cards()),
  control(b){
   const proof=b.sessionKey?.startsWith('agent:samantha:regulation-proof-');
   if(proof&&!/^agent:samantha:regulation-proof-chess-/.test(b.sessionKey))return {ok:true,games:[]};
   const read=['list','status'].includes(b.action);
   const target=proof?scoped(b.sessionKey):read?store:scoped(b.sessionKey);
   if(read)return b.gameId?{ok:true,game:target.get(b.gameId)}:{ok:true,games:target.list()};
   return target.act(b,{actor:'samantha',model:b.model,sessionKey:b.sessionKey});
  },
  // Only local verification can create fixture games, and only in an isolated DB.
  proofAct(b){if(!b.sessionKey?.startsWith('agent:samantha:regulation-proof-chess-'))throw Error('A chess proof session is required');return scoped(b.sessionKey).act(b.args,{actor:'owner',human:{id:'owner',name:'Owner'}});},
  events(res){
   res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-store','X-Accel-Buffering':'no'});res.flushHeaders();
   const send=()=>{if(!res.destroyed)res.write('data: '+JSON.stringify({games:store.list()})+'\n\n');};listeners.add(send);send();
   const timer=setInterval(()=>{if(!res.destroyed)res.write(': keepalive\n\n');},15000);timer.unref();
   res.on('close',()=>{clearInterval(timer);listeners.delete(send);});
  },
  stop(){runner.stop();store.close();for(const s of proofs.values())s.close();listeners.clear();}
 };
}
