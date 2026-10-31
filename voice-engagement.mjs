const normalize=text=>String(text??'').replace(/\[[^\]]*\]/g,'').toLowerCase().replace(/[’']/g,'').replace(/[^a-z0-9]+/g,' ').trim();
const stop=text=>/^(stop|wait|pause|quiet|hold on|hang on)( please)?$/.test(text);
const addressed=text=>/\bsamantha\b/.test(text)||/^(hey |hello )?are you (there|listening)\b/.test(text)||/^(im|i am) (awake|up now)\b/.test(text);
const resting=text=>/^(good ?night(?: samantha)?|im going (back )?to sleep|i am going (back )?to sleep|let me sleep|im falling asleep)$/.test(text);
// ASR hypotheses are fallible, not speaker identification. This tracks evidence
// within one call, never a diagnosis of sleep. A quiet gap raises the admission
// bar; it does not itself assert that the participant is asleep.
export class VoiceEngagement {
 constructor({now=Date.now,quietMs=300000}={}){this.now=now;this.quietMs=quietMs;this.lastEngaged=now();this.resting=false;this.hypothesis=null;}
 partial(text){
  const value=normalize(text),now=this.now();if(!value)return;
  const old=this.hypothesis;
  if(old&&now-old.at<5000&&value.startsWith(old.text)&&value!==old.text){old.updates++;old.text=value;old.at=now;}
  else if(!old||old.text!==value||now-old.at>=5000)this.hypothesis={text:value,at:now,start:now,updates:1};
 }
 committed(text){
  const value=normalize(text),h=this.hypothesis;this.hypothesis=null;
  const quiet=this.now()-this.lastEngaged>=this.quietMs;
  const sustained=h&&this.now()-h.at<=5000&&h.updates>=3&&h.at-h.start>=400&&h.text.split(' ').length>=3&&value.startsWith(h.text);
  // A committed utterance of three
  // words or more is speech, whatever the ASR partial count; only one- or two-word fragments still need address or sustain.
  const clear=value.split(' ').filter(Boolean).length>=3;
  if(stop(value))return {accept:true,contact:false,reason:'control-command',resting:this.resting};
  if(this.resting&&!addressed(value)&&!sustained)return {accept:false,reason:'resting-unaddressed-speech'};
  if(quiet&&!addressed(value)&&!sustained&&!clear)return {accept:false,reason:'uncorroborated-after-quiet'};
  if(!value)return {accept:false,reason:'empty'};
  if(addressed(value)||sustained||(clear&&!this.resting))this.resting=false;
  if(resting(value))this.resting=true;
  this.lastEngaged=this.now();
  return {accept:true,contact:true,reason:quiet?'speech-after-quiet':'ongoing-conversation',resting:this.resting};
 }
 assistant(text){
  const value=normalize(text);
  if(/^(?:okay )?(?:go back to sleep|good ?night)(?: |$)/.test(value)||/\bgo back to sleep\b/.test(value))this.resting=true;
 }
 status(){return {availability:this.resting?'resting':this.now()-this.lastEngaged>=this.quietMs?'unconfirmed':'engaged',speakerVerified:false};}
}
