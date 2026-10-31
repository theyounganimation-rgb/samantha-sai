import {EventEmitter} from 'node:events';
import WebSocket from 'ws';
import {encode,decode} from '@msgpack/msgpack';

export const FISH_VOICE='YOUR_FISH_VOICE_ID';
export const FISH_NAME='Samantha · Fish Audio';
export async function fishRequest(route,{apiKey,fetcher=fetch}={}){
 if(!apiKey)throw new Error('Connect Fish Audio on the Mac first.');
 const r=await fetcher('https://api.fish.audio'+route,{headers:{Authorization:'Bearer '+apiKey},signal:AbortSignal.timeout(15000)});
 if(!r.ok)throw new Error(r.status===401?'The Fish Audio key needs attention.':`Fish Audio is unavailable (${r.status}).`);
 return r.json();
}
export async function fishCredit(config,options={}){
 const data=await fishRequest('/wallet/self/api-credit?check_free_credit=true',{apiKey:config.apiKey,...options});
 const credit=Number(data.credit);
 if(!Number.isFinite(credit)||credit<0)throw new Error('Fish Audio returned an unknown credit balance.');
 return {credit,hasFreeCredit:data.has_free_credit===true};
}
export function requireFishCredit(balance){
 if(!(balance.credit>0))throw new Error('Fish Audio has no API credit. Add API credit on Fish, then try again. Your saved ElevenLabs voice is still available.');
}
export async function fishStatus(config,options={}){
 if(!config.apiKey)return {connected:false,voiceName:FISH_NAME};
 const [balance,voice]=await Promise.all([
  fishCredit(config,options),fishRequest('/model/'+(config.voiceId||FISH_VOICE),{apiKey:config.apiKey,...options})
 ]);
 return {connected:true,...balance,voiceName:FISH_NAME,model:config.model||'s2.1-pro',samples:(voice.samples??[]).filter(s=>{
  try{const u=new URL(s.audio);return u.protocol==='https:'&&(u.hostname.endsWith('.fish.audio')||u.hostname.endsWith('.r2.cloudflarestorage.com'));}catch{return false;}
 }).map(s=>({name:String(s.title||'Sample').trim(),url:s.audio}))};
}

// Adapt Fish's MessagePack stream to SAI's existing audio/completion contract.
// This leaves turn IDs, interruption, transcript and playback receipts unchanged.
function firstSentenceEnd(text){
 let inTag=false;
 for(let i=0;i<text.length;i++){
  const c=text[i];if(c==='['){inTag=true;continue;}if(c===']'){inTag=false;continue;}if(inTag||!/[.!?]/u.test(c))continue;
  // Do not turn a delivery cue, decimal or common title into a spoken phrase.
  if(c==='.'&&(/[\d.]/u.test(text[i-1]||'')||text[i+1]==='.'||/\b(?:Mr|Mrs|Ms|Dr|Prof|St|vs|etc)$/iu.test(text.slice(0,i))))continue;
  let end=i+1;while(/[!?"'”’)]/u.test(text[end]||'')&&end<text.length)end++;
  if(end<text.length&&!/\s/u.test(text[end]))continue;
  if(text.slice(0,i).replace(/\[[^\]]*\]/gu,'').trim())return end;
 }
 return -1;
}
export class FishSpeechSocket extends EventEmitter{
 constructor({apiKey,voiceId=FISH_VOICE,model='s2.1-pro',WebSocketImpl=WebSocket}={}){
  super();this.started=false;this.ending=false;this.finished=false;this.stopped=false;this.tail=Buffer.alloc(0);
  this.openingText='';
  this.socket=new WebSocketImpl('wss://api.fish.audio/v1/tts/live',{headers:{Authorization:'Bearer '+apiKey,model},handshakeTimeout:12000,maxPayload:5*1048576});
  this.voiceId=voiceId;
  this.socket.on('open',()=>this.emit('open'));
  this.socket.on('error',()=>this.emit('error',new Error('Fish Audio speech connection failed.')));
  this.socket.on('close',code=>this.emit('close',code));
  this.socket.on('message',(raw,binary)=>{
   if(this.stopped||this.finished)return;
   try{
    const m=binary===false?JSON.parse(String(raw)):decode(raw);
    if(m.event==='audio'){
     if(!(m.audio instanceof Uint8Array))throw new Error('Fish Audio returned invalid audio.');
     if(m.audio.length)this.openingText=null;
     const bytes=Buffer.concat([this.tail,Buffer.from(m.audio)]),length=bytes.length-(bytes.length%2);
     this.tail=Buffer.from(bytes.subarray(length));
     if(length)this.emit('message',JSON.stringify({audio:bytes.subarray(0,length).toString('base64')}));
    }else if(m.event==='finish'){
     if(m.reason!=='stop'||!this.ending||this.tail.length)throw new Error('Fish Audio ended before the complete voice reply arrived.');
     this.finished=true;this.emit('message',JSON.stringify({is_final:true}));this.socket.close();
    }else if(m.error||m.event==='error')throw new Error('Fish Audio could not synthesize this reply.');
   }catch(e){this.emit('error',e);}
  });
 }
 get readyState(){return this.socket.readyState;}
 send(raw){
  if(this.stopped||this.finished)return;
  const m=JSON.parse(raw),send=value=>this.socket.send(encode(value));
  if(m.voices){
   if(this.started)throw new Error('Fish Audio session already started.');
   this.started=true;send({event:'start',request:{text:'',reference_id:this.voiceId,format:'pcm',sample_rate:24000,latency:'normal',chunk_length:150}});
  }else if(m.inputs){
   if(!this.started||this.ending)throw new Error('Fish Audio session is not accepting text.');
   for(const input of m.inputs){
    if(typeof input.text!=='string')throw new Error('Invalid speech text.');if(!input.text)continue;
    if(this.openingText===null){send({event:'text',text:input.text});continue;}
    const previousLength=this.openingText.length;this.openingText+=input.text;
    const end=firstSentenceEnd(this.openingText);
    if(end<0){send({event:'text',text:input.text});continue;}
    // Flush only the completed opening sentence, before any unfinished tail.
    // Later phrases retain Fish's normal buffering and audio context.
    const cut=Math.max(0,end-previousLength);
    if(cut)send({event:'text',text:input.text.slice(0,cut)});
    send({event:'flush'});this.openingText=null;
    if(cut<input.text.length)send({event:'text',text:input.text.slice(cut)});
   }
  }else if(m.close_socket){
   if(!this.started)throw new Error('Fish Audio session was not started.');
   if(!this.ending){this.ending=true;send({event:'close'});}
  }else if(m.keep_alive&&this.socket.readyState===WebSocket.OPEN)this.socket.ping();
 }
 terminate(){this.stopped=true;this.tail=Buffer.alloc(0);this.socket.terminate();}
}
