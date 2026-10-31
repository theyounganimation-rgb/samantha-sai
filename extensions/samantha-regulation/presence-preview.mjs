// Keep the same total budget regulation occupied before this package. The
// following plugin still needs room for speaker, facts and conversational flow.
import {renderNativeStance,interpersonalUndertone} from './relational-client.js';
import {relationshipLine} from './relationship-client.js';
export function presencePreview(view,{matter='',share='',followup='',own='',habit='',relationship,between}={}){
 // Something between the two of them comes first: it is the thing she would be carrying into this exchange.
 const line=relationshipLine(between);
 // Strong current affect gets its complete native cue before optional tangents.
 // Own matters remain available in full context; no extra reply is scheduled.
 if(view?.affectExpression||view?.relationshipRecovery||view?.frictionNow){const stance=renderNativeStance(view,{relationship});let l=line;while(l&&Buffer.byteLength(stance+l+'\n')>950&&l.length>90)l=l.slice(0,-1);return stance+(l&&Buffer.byteLength(stance+l+'\n')<=950?l+'\n':'');}
 if(line&&!share){const stance=renderNativeStance(view,{relationship});let l=line;while(Buffer.byteLength(stance+l+'\n')>950&&l.length>90)l=l.slice(0,-1);return stance+l+'\n';}
 if(matter){
  const unfinished=interpersonalUndertone(relationship);
  const data={tone:view?.tone?.slice(0,1),pacing:view?.pacing,
   ...(view?.named?{feeling:view.named.current?.slice(0,1)}:{}),
   ...(view?.guarded?{guarded:true}:{}),...(unfinished?{unfinished:unfinished.fact}:{})};
  const render=()=> 'Current stance; no automatic cheerfulness or agreement. Current input can revise it.\n'+JSON.stringify(data)+'\n'+matter;
  for(const key of ['pacing','feeling']){if(Buffer.byteLength(render())<=650)break;delete data[key];}
  if(Buffer.byteLength(render())>650&&unfinished)data.unfinished={source:unfinished.source,status:unfinished.status};
  if(Buffer.byteLength(render())<=650)return render();
  // Never half-quote a concern or suppress the actual stance to fit it.
 }
 if(interpersonalUndertone(relationship)&&!share)return renderNativeStance(view,{relationship});
 const option=share||followup||own||habit;
 if(!option)return renderNativeStance(view);
 const data={tone:view?.tone?.slice(0,1),pacing:view?.pacing,initiative:view?.initiative,
  ...(interpersonalUndertone(relationship)?{unfinished:{source:interpersonalUndertone(relationship).source,status:interpersonalUndertone(relationship).status}}:{}),
  ...(view?.initiativeFrom?.length?{initiativeFrom:view.initiativeFrom.slice(0,2)}:{}),
  ...(view?.named?{feeling:view.named.current?.slice(0,1),wellbeing:view.named.wellbeing}:{}),
  ...(view?.guarded?{guarded:true}:{}),...(view?.reconnect?{reconnect:true}:{})};
 const render=()=> 'Current stance; no automatic cheerfulness or agreement. Current input wins.\n'+JSON.stringify(data)+'\n'+option;
 for(const key of ['pacing','wellbeing','initiative','feeling']){if(Buffer.byteLength(render())<=650)break;delete data[key];}
 return Buffer.byteLength(render())<=650?render():renderNativeStance(view);
}
