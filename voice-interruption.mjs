const words=text=>String(text||'').toLowerCase().replace(/[’']/g,'').replace(/\bkinda\b/g,'kind of').match(/[\p{L}\p{N}]+/gu)||[];
const protectedWords=new Set(['no','not','never','dont','cant','wont','isnt','didnt','arent','wasnt','cannot','why','what','where','when','how']);
const directInterruption=tokens=>/^(stop|wait|pause|quiet|hold on|hang on|no)(\s|$)/.test(tokens.join(' '));
// A listener can acknowledge a sentence without taking the conversational
// floor. Match the entire utterance only; "okay, but why?" is not a backchannel.
const listeningAcknowledgment=tokens=>/^(?:(?:all right|alright|okay|ok|yeah|yep|yup|right|mhm|mmhmm|mm hmm|mm|uh huh|got it|oh okay|oh ok)(?:\s|$)){1,3}$/.test(tokens.join(' '));
function nearWord(a,b){
 if(a===b)return 0;
 if(a.length<4||b.length<4||Math.abs(a.length-b.length)>1)return 1;
 let i=0,j=0,edits=0;
 while(i<a.length&&j<b.length){if(a[i]===b[j]){i++;j++;continue;}if(++edits>1)return 1;if(a.length>=b.length)i++;if(b.length>=a.length)j++;}
 return edits+(a.length-i)+(b.length-j)<=1?.3:1;
}
function echoMatch(tokens,spoken){
 if(tokens.length<2||!spoken.length)return null;
 if(spoken.some((_,i)=>tokens.every((token,j)=>token===spoken[i+j])))return {score:1,kind:'exact'};
 if(tokens.length<4)return null;
 // Subsequence edit alignment tolerates an ASR substitution (ears -> years)
 // or an extra word. It cannot ignore a new negation or question word.
 let previous=Array(spoken.length+1).fill(0),starts=spoken.map((_,i)=>i);starts.push(spoken.length);
 for(let i=1;i<=tokens.length;i++){
  const row=[i],nextStarts=[0];
  for(let j=1;j<=spoken.length;j++){
   const choices=[{cost:previous[j-1]+nearWord(tokens[i-1],spoken[j-1]),start:starts[j-1]},
    {cost:previous[j]+1,start:starts[j]},{cost:row[j-1]+1,start:nextStarts[j-1]}];
   const best=choices.reduce((a,b)=>a.cost<=b.cost?a:b);row[j]=best.cost;nextStarts[j]=best.start;
  }
  previous=row;starts=nextStarts;
 }
 let end=1;for(let j=2;j<previous.length;j++)if(previous[j]<previous[end])end=j;
 const score=1-previous[end]/tokens.length,segment=spoken.slice(starts[end],end);
 const changedMeaning=tokens.some(t=>protectedWords.has(t)&&!segment.includes(t));
 const matches=tokens.filter(t=>segment.some(s=>nearWord(t,s)<1)).length;
 return score>=.72&&matches>=3&&!changedMeaning?{score,kind:'approximate'}:null;
}
// Interim ASR is revisable. Require a continuing speech hypothesis before
// discarding queued audio; explicit stop commands and committed speech act now.
export class VoiceInterruption{
 constructor(){this.reset();this.playback=[];this.echoSegment=null;this.partialEvidence=null;this.acceptedInput=null;}
 reset(){this.candidate=[];this.since=0;this.updates=0;}
 rememberPlayback(text,now=Date.now()){
  this.playback=[{tokens:words(text),expires:Infinity}];
 }
 playbackEnded(now=Date.now()){
  for(const source of this.playback)if(source.expires===Infinity)source.expires=now+2500;
 }
 matchEcho(tokens,{speaking=false,assistant='',now=Date.now()}={}){
  if(speaking)this.rememberPlayback(assistant,now);
  this.playback=this.playback.filter(source=>source.expires>=now);
  for(const source of this.playback){const match=echoMatch(tokens,source.tokens);if(match)return match;}
  // Keep recognition of a segment across ASR revisions and its delayed final.
  // A different utterance does not inherit this decision.
  const segment=this.echoSegment;
  if(segment&&now-segment.at<=5000&&segment.tokens.length>=4&&tokens.length>=segment.tokens.length&&segment.tokens.every((t,i)=>t===tokens[i]))return {score:segment.score,kind:'echo-segment-continuation'};
  return null;
 }
 partial(text,{busy=false,speaking=false,assistant='',now=Date.now()}={}){
  const tokens=words(text);
  if(!tokens.length){this.reset();this.partialEvidence=null;return {interrupt:false,reason:'no-active-speech'};}
  const echo=this.matchEcho(tokens,{speaking,assistant,now});
  if(echo){this.reset();this.partialEvidence=null;if(echo.kind!=='echo-segment-continuation')this.echoSegment={tokens,at:now,score:echo.score};return {interrupt:false,reason:'playback-echo',echoKind:echo.kind,echoScore:echo.score};}
  // A final may be followed by a delayed hypothesis of those same words.
  // It is not a new utterance and cannot cancel the answer to that final.
  const accepted=this.acceptedInput;
  if(accepted&&now>=accepted.at&&now-accepted.at<=1500&&tokens.length<=accepted.tokens.length&&tokens.every((t,i)=>t===accepted.tokens[i])){
   this.reset();this.partialEvidence=null;return {interrupt:false,reason:'committed-input-tail'};
  }
  this.partialEvidence={tokens,at:now,duringPlayback:speaking};
  if(!busy){this.reset();return {interrupt:false,reason:'no-active-speech'};}
  if(speaking&&listeningAcknowledgment(tokens)){this.reset();return {interrupt:false,reason:'listening-acknowledgment'};}
  if(/^(stop|wait|pause|quiet|hold on|hang on)$/.test(tokens.join(' '))){this.reset();return {interrupt:true,reason:'explicit-stop'};}
  // Before audio as well as during it, one revisable hypothesis is not enough
  // to throw away a registered turn. A growing utterance can still interrupt
  // before its final; explicit stop and accepted final speech remain immediate.
  const common=Math.min(tokens.length,this.candidate.length);
  if(common&&tokens.slice(0,common).every((word,i)=>word===this.candidate[i])){if(tokens.length>this.candidate.length)this.updates++;}
  else{this.since=now;this.updates=1;}
  this.candidate=tokens;
  const interrupt=tokens.length>=2&&this.updates>=2&&now-this.since>=200;
  return {interrupt,reason:interrupt?(speaking?'sustained-user-speech':'continued-user-speech'):'unconfirmed-partial'};
 }
 committed(text,{speaking=false,assistant='',now=Date.now()}={}){
  this.reset();
  const tokens=words(text),evidence=this.partialEvidence;this.partialEvidence=null;
  const echo=this.matchEcho(tokens,{speaking,assistant,now});this.echoSegment=null;
  if(echo)return {accept:false,reason:'playback-echo',echoKind:echo.kind,echoScore:echo.score};
  // This applies even when a matching partial preceded the final. That pair
  // confirms recognized wording, not an intention to cancel queued speech.
  // After playback, the same short answers are ordinary user turns.
  if(speaking&&listeningAcknowledgment(tokens))return {accept:false,reason:'listening-acknowledgment'};
  // A short final can appear out of nowhere while the other voice is playing.
  // Do not let that lone ASR result cut off audio and create a phantom user turn.
  // A matching recent partial corroborates it; direct stop/correction commands
  // and substantive longer speech still act immediately. This adds no timer.
  const overlap=evidence?.tokens.filter(t=>tokens.includes(t)).length??0;
  const corroborated=evidence?.duringPlayback&&now-evidence.at<=5000&&overlap>=Math.min(2,tokens.length)&&overlap/evidence.tokens.length>=.6;
  if(speaking&&tokens.length<=5&&!directInterruption(tokens)&&!corroborated)return {accept:false,reason:'uncorroborated-playback-final'};
  this.acceptedInput={tokens,at:now};
  return {accept:true,reason:'committed-user-speech'};
 }
}
