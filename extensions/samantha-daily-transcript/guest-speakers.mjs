import {bindingFromInput,isGuestId,guestName,rowPeople} from './speaker-context.mjs';

export async function identifyGuest({binding,args,rows,now=Date.now(),save}){
 const p=binding?.speaker;
 if(!isGuestId(p?.personId))throw Error('Only the guest selected for this turn can be identified.');
 const name=guestName(args.name),source=rows.find(r=>r.id===args.sourceMessageId),quote=args.quote;
 const at=Date.parse(source?.timestamp);
 if(!source||source.role!=='user'||rowPeople(source).speaker.personId!==p.personId||!Number.isFinite(at)||now-at>600000||at>now+60000)throw Error('Use this guest’s recent saved introduction.');
 if(typeof quote!=='string'||!quote.trim()||quote.length>500||!source.text.includes(quote)||!quote.toLocaleLowerCase().includes(name.toLocaleLowerCase()))throw Error('Quote their own introduction exactly, including the name.');
 return save({personId:p.personId,name,sourceMessageId:source.id,quote});
}
export async function saveGuest(args,{fetcher=fetch}={}){
 const response=await fetcher('http://127.0.0.1:18506/api/speaker/identify',{method:'POST',headers:{'content-type':'application/json',origin:'http://127.0.0.1:18506'},body:JSON.stringify(args),signal:AbortSignal.timeout(10000)});
 const result=await response.json();if(!response.ok||!result.ok)throw Error(result.error??'Guest profile was not saved.');return result;
}
export function registerGuestSpeakers(api,{readRows,now=Date.now,save=saveGuest}={}){
 const bindings=new Map(),key=ctx=>ctx.runId??ctx.sessionKey;
 api.registerTool(ctx=>ctx.agentId!=='samantha'?null:{name:'samantha_speaker',label:'Name the current guest profile',
  description:'After an anonymous guest directly introduces themself, save their preferred name on the same stable speaker profile. Ask who is speaking if they have not introduced themself; respect anonymity. Read samantha_conversation to obtain the exact saved human message id. name and quote must come from their own self-identification, never a third-party mention or inferred voice identity. A short name reply to your identity question is valid. This does not merge names, change the account owner, create a phone contact or send a message. Returning visitors can choose their saved profile in the app. Do not claim success before a confirmed result.',
  parameters:{type:'object',properties:{name:{type:'string',minLength:1,maxLength:60},sourceMessageId:{type:'string',minLength:1,maxLength:180},quote:{type:'string',minLength:1,maxLength:500}},required:['name','sourceMessageId','quote'],additionalProperties:false},
  async execute(_id,args){let result;try{ctx.assertInvocationCurrent?.();const binding=bindings.get(key(ctx));result=await identifyGuest({binding,args,rows:await readRows(ctx),now:now(),save:value=>{ctx.assertInvocationCurrent?.();return save(value);}});}catch(e){result={ok:false,error:e.message};}return {content:[{type:'text',text:JSON.stringify(result)}],details:result};}
 },{names:['samantha_speaker']});
 return {remember(ctx,binding){for(const k of [key(ctx),ctx.sessionKey])if(k)bindings.set(k,binding);while(bindings.size>128)bindings.delete(bindings.keys().next().value);}};
}
