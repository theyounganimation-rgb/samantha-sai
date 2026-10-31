// chat.abort/agent.wait report terminal cancellation before the native reply
// operation releases its slot. Read and await that operation, without cancelling
// any other channel's work or resubmitting the owner's speech.
import {h as registry,b as waitForOwner,S as waitForAdmission} from '/opt/homebrew/lib/node_modules/openclaw/dist/reply-run-registry.registry-BB8ktna9.mjs';

export function registerReplySettlement(api){
  api.registerGatewayMethod('sai.reply.settle',async({params,respond})=>{
    const key=params?.sessionKey;
    if(typeof key!=='string'||!/^agent:samantha:[a-zA-Z0-9:_-]+$/.test(key)){
      respond(false,undefined,{code:'INVALID_REQUEST',message:'A Samantha session key is required.'});return;
    }
    const operation=registry.get(key),phase=operation?.phase,started=Date.now();
    const settled=!operation||await waitForOwner(operation,15000);
    const admitted=settled&&await waitForAdmission(key,Math.max(100,15000-(Date.now()-started)));
    respond(true,{settled:settled&&admitted.settled===true,phase:phase??'idle',elapsedMs:Date.now()-started});
  },{scope:'operator.admin'});
}
