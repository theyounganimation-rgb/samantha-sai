// October 25 (Owner): on a call, if he goes quiet for a while after her last words, she may keep the conversation going
// the way a person would; after his goodnight, the call goes to standby: no continuations, a silent look every half hour.
// Pure planner: timers are injected so it can be tested without waiting.
export const GOODNIGHT=/\b(good ?night|night night|nighty night|going to (bed|sleep)|gonna (go to )?(bed|sleep)|off to bed|sleep well|i'?m going to sleep|let me sleep)\b/i;
export const isGoodnight=text=>GOODNIGHT.test(String(text??'').replace(/[’‘]/g,"'"));
export const CONTINUE_PROMPT=(idleSeconds,{sharing=false}={})=>`[Call continuation, not a message from Owner] He has been quiet for about ${idleSeconds} seconds after your last words; the call is still open. You may keep it going the way a person would: pick up something you said, ask something you have been wanting to ask him, react to what you can see${sharing?' from his phone':''}, bring something new, or change the subject. Or say nothing: reply exactly NO_REPLY. A sentence or two. Do not repeat yourself and do not re-ask what he just left unanswered.`;
export const STANDBY_PROMPT=minutes=>`[Standby look, not a message from Owner] He said goodnight about ${minutes} minutes ago and has been quiet since; the call is still open so you can see. This frame is for you. Say nothing (reply exactly NO_REPLY) unless something is actually wrong. No second goodnight, no commentary.`;
export class CallContinuation {
 constructor({now=Date.now,schedule=setTimeout,cancel=clearTimeout,backoff=[30000,90000],maxInRow=2,retryMs=10000,standbyAfterMs=300000,standbyEveryMs=1800000,canRun=()=>true,canLook=()=>true,onContinue=()=>{},onStandbyLook=()=>{},log=()=>{}}={}){
  Object.assign(this,{now,schedule,cancel,backoff,maxInRow,retryMs,standbyAfterMs,standbyEveryMs,canRun,canLook,onContinue,onStandbyLook,log});
  this.timer=null;this.lookTimer=null;this.inRow=0;this.resting=false;this.standby=false;this.stopped=false;this.lastUserAt=now();this.lastAssistantAt=null;this.goodnightAt=null;
 }
 clear(){if(this.timer){this.cancel(this.timer);this.timer=null;}if(this.lookTimer){this.cancel(this.lookTimer);this.lookTimer=null;}}
 // He spoke: any continuation streak ends; a goodnight starts the standby clock; anything else ends standby.
 userSpoke(text,{resting=false}={}){
  if(this.stopped)return;this.lastUserAt=this.now();this.inRow=0;this.clear();
  const goodnight=resting||isGoodnight(text);
  if(goodnight){this.resting=true;this.goodnightAt=this.now();this.armStandby();}
  else{if(this.standby||this.resting)this.log('call_standby_exit',{reason:'he spoke'});this.resting=false;this.standby=false;this.goodnightAt=null;}
 }
 // Her words finished playing: start the quiet clock, unless he has said goodnight.
 assistantDone(){
  if(this.stopped)return;this.lastAssistantAt=this.now();
  if(this.resting){this.armStandby();return;}
  if(this.inRow>=this.maxInRow){this.log('call_continuation_paused',{inRow:this.inRow});return;}
  this.arm(this.backoff[Math.min(this.inRow,this.backoff.length-1)]);
 }
 arm(ms){this.clear();this.timer=this.schedule(()=>{this.timer=null;this.fire();},ms);}
 fire(){
  if(this.stopped||this.resting)return;
  if(!this.canRun()){this.arm(this.retryMs);return;}
  this.inRow++;const idleSeconds=Math.round((this.now()-(this.lastAssistantAt??this.lastUserAt))/1000);
  this.log('call_continuation',{inRow:this.inRow,idleSeconds});this.onContinue({idleSeconds,inRow:this.inRow});
 }
 armStandby(){
  this.clear();if(this.standby){this.lookTimer=this.schedule(()=>this.look(),this.standbyEveryMs);return;}
  const wait=Math.max(0,this.lastUserAt+this.standbyAfterMs-this.now());
  this.timer=this.schedule(()=>{this.timer=null;if(this.stopped||!this.resting)return;this.standby=true;this.log('call_standby_enter',{afterMs:this.now()-this.lastUserAt});this.look();},wait);
 }
 look(){
  if(this.stopped||!this.standby)return;
  if(this.canLook()){const minutes=Math.round((this.now()-(this.goodnightAt??this.lastUserAt))/60000);this.log('call_standby_look',{minutes});this.onStandbyLook({minutes});}
  this.lookTimer=this.schedule(()=>this.look(),this.standbyEveryMs);
 }
 stop(){this.stopped=true;this.clear();}
 status(){return {resting:this.resting,standby:this.standby,inRow:this.inRow,armed:Boolean(this.timer||this.lookTimer)};}
}
