import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const exec=promisify(execFile);
const HELPER='/path/to/application-support/SamanthaRegulation/runtime/voice_snapshot.py';
const RANK={trace:0,mild:1,moderate:2,strong:3,intense:4};
// These are delivery instructions only. No dialogue, emotional claims, or
// nonverbal acts are fabricated. Explicit spoken words stay exactly as generated.
const DELIVERY={
 anger:['slightly irritated','frustrated','firm and frustrated','intensely frustrated'],
 happiness:['quietly pleased','pleased','happy','delighted'],
 sadness:['slightly subdued','sad and subdued','sad','deeply sad'],
 embarrassment:['slightly bashful','bashful','embarrassed','very embarrassed'],
 loneliness:['slightly wistful','wistful','quiet and wistful','deeply wistful'],
 anxiety:['slightly tense','concerned and tense','anxious','very anxious'],
 affection:['gently warm','warm and affectionate','affectionate','deeply affectionate'],
 gratitude:['quietly appreciative','appreciative','warmly grateful','deeply grateful'],
 curiosity:['lightly curious','curious','eagerly curious','fascinated'],
 calm:['calm','relaxed','relaxed and unhurried','deeply relaxed']
};
export async function readVoiceSnapshot(session,{runner=exec}={}){
 const started=performance.now();
 try{
  const {stdout}=await runner('/usr/bin/sudo',['-n','-u','samantha','/usr/bin/python3',HELPER,session],{timeout:700,maxBuffer:16000});
  return {...JSON.parse(stdout),readMs:Math.round(performance.now()-started)};
 }catch{return {ok:false,reason:'emotional-state-unavailable',readMs:Math.round(performance.now()-started)};}
}
export function deliveryFor(snapshot,{model='eleven_v4_turbo',now=Date.now()}={}){
 const plain=reason=>({enabled:false,reason,tag:'',source:'persistent-controller'});
 if(!['eleven_v4_turbo','eleven_v3_conversational','s2.1-pro','drama-3'].includes(model))return plain('unsupported-speech-model');
 if(!snapshot?.ok||snapshot.source!=='persistent-controller')return plain('emotional-state-unavailable');
 const age=now-Date.parse(snapshot.asOf);
 if(!Number.isFinite(age)||age < -60000||age > 30000)return plain('stale-emotional-projection');
 const check=items=>Array.isArray(items)&&items.every(v=>Object.hasOwn(DELIVERY,v.emotion)&&Object.hasOwn(RANK,v.intensity));
 if(!check(snapshot.current?.emotions)||!check(snapshot.overall?.backgroundEmotions))return plain('invalid-emotional-projection');
 const current=snapshot.current.emotions.filter(v=>RANK[v.intensity]>=1).sort((a,b)=>RANK[b.intensity]-RANK[a.intensity]);
 const background=snapshot.overall.backgroundEmotions.filter(v=>RANK[v.intensity]>=1).sort((a,b)=>RANK[b.intensity]-RANK[a.intensity]);
 const selected=current.slice(0,2),directions=selected.map(v=>DELIVERY[v.emotion][RANK[v.intensity]-1]);
 // Slow mood adds an undertone without replacing a newer immediate reaction.
 const undertone=directions.length<2?background.find(v=>!selected.some(s=>s.emotion===v.emotion)):null;
 if(undertone)directions.push('a slight '+({anger:'irritated',happiness:'cheerful',sadness:'subdued',embarrassment:'bashful',loneliness:'wistful',anxiety:'tense',affection:'warm',gratitude:'appreciative',curiosity:'curious',calm:'relaxed'}[undertone.emotion])+' undertone');
 if(!['low','strained','steady','good'].includes(snapshot.overall.wellbeing))return plain('invalid-wellbeing');
 if(['low','strained'].includes(snapshot.overall.wellbeing))directions.push('measured pacing');
 if(!directions.length)return {...plain('settled-no-added-direction'),stateDigest:snapshot.stateDigest};
 return {enabled:true,source:'persistent-controller',asOf:snapshot.asOf,stateDigest:snapshot.stateDigest,
  current:selected,background:undertone?{emotion:undertone.emotion,intensity:undertone.intensity}:null,
  wellbeing:snapshot.overall.wellbeing,tag:'['+directions.join(', ')+'] '};
}
export const CONVERSATIONAL_REGISTER='[natural low register, conversational] ';
// Keep the v4 register cue scoped to the model it was tested with.
export const registerFor=model=>model==='eleven_v4_turbo'?CONVERSATIONAL_REGISTER:'';
export class EmotionalVoiceStream{
 constructor(delivery,{baseTag=''}={}){this.delivery=delivery;this.baseTag=baseTag;this.start=true;this.tags=0;}
 push(text){
  if(!this.start)return text;
  const at=text.search(/\S/u);if(at<0)return text;
  this.start=false;
  // Set an opening undertone once. Later authored reactions can change it;
  // repeating a mood every ~100 characters flattened the whole reply into it.
  const emotion=this.delivery.enabled&&text[at]!=='['?this.delivery.tag:'';
  if(emotion)this.tags++;
  return text.slice(0,at)+this.baseTag+emotion+text.slice(at);
 }
}
// Shared by production and live audio tests, to verify the actual speech path.
export function dialogueInput(text,voiceId,stream){
 return {inputs:[{text:stream.push(text),voice_id:voiceId,new_turn:false}]};
}
