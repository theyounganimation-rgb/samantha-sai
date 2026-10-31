// ElevenLabs Agents (Owner, October 27, 2026): Samantha's voice on a call is a realtime speech-to-speech agent on ElevenLabs,
// in her own designed voice ("Samantha · SAI"), using the native Eleven Realtime model for the immediate conversation.
// Her wider self (Opus 5.5, memory, tools, own time, chess) keeps running on the Mac; the agent reaches it through three
// client tools and is kept aware through contextual updates (eleven-call.mjs). Fish Audio is gone. This module owns the
// agent definition, its synchronisation with the ElevenLabs account, conversation tokens and post-call transcripts.
import {createHash} from 'node:crypto';
export const AGENT_NAME='Samantha · SAI';
export const DEFAULT_REALTIME_MODEL='eleven_realtime_v1_max';
export const REALTIME_MODELS=['eleven_realtime_v1_mini','eleven_realtime_v1_max'];
export const realtimeModelName=model=>model==='eleven_realtime_v1_mini'?'Eleven Realtime v1 Mini':model==='eleven_realtime_v1_max'?'Eleven Realtime v1 Max':'Custom voice pipeline';
// Retained custom settings are ignored by ElevenLabs while realtime_model is set.
export const DEFAULT_LLM='claude-sonnet-5-5';
export const ALLOWED_LLMS=['claude-sonnet-5-5','claude-haiku-5-5','claude-opus-5-5','gpt-5.5','gpt-5.4-mini','gemini-3.5-flash'];
export const TTS_MODEL='eleven_v4_turbo';
export const KEYWORDS=['Samantha','Owner','Guest','Guest','Opus','Codex','Tailscale','SAI'];
export const TOOLS=[
 {name:'samantha_now',expects_response:true,response_timeout_secs:15,
  description:'Your own current state, read from your persistent self this instant: your emotional state (the digital neurochemistry the host keeps for you, translated into expressive language, preserving its mixture and strength), what you have been doing in your own time, your chess games, the latest lines in the shared conversation from other surfaces (texts, your own notes), and the local time. Use it whenever you want to know what is true for you right now rather than guess. Costs nothing, takes under a second, is never spoken aloud.',
  parameters:{type:'object',properties:{focus:{type:'string',description:'Optional: emotion, activity, chess, conversation, or all (default all).'}},required:[]}},
 {name:'samantha_recall',expects_response:true,response_timeout_secs:60,
  description:'Remember something precisely from your own memory and the saved conversation: a name, a date, something Owner or you said, a plan, a fact about a person, a reading, a project. Your memory answers from records only and takes no action. Use it before stating a specific past detail you are not sure of, instead of guessing. Takes a few seconds; you can say a word first.',
  parameters:{type:'object',properties:{question:{type:'string',description:'What you want to remember, as a specific question.'}},required:['question']}},
 {name:'samantha_act',expects_response:true,response_timeout_secs:120,
  description:'Hand a piece of work to yourself off the call: anything that changes the world or your records (send a message, save a memory or lesson, set a reminder, look something up on the web, check email or calendar, make a chess move, write something), and anything needing long careful reasoning or your full tool set. Your backend self does it with your real tools and permissions and returns what actually happened as text. Say what happened in your own words afterwards; never claim success before the result arrives. If it may take a moment, tell the caller you are on it.',
  parameters:{type:'object',properties:{request:{type:'string',description:'The task, with every detail from the conversation it needs.'},wait:{type:'boolean',description:'true (default) to wait for the result in this turn; false to let it run and hear the outcome as a later update.'}},required:['request']}},
];
export class ElevenAgentsError extends Error{constructor(message,{status=null,code=null,permission=false}={}){super(message);this.status=status;this.code=code;this.permission=permission;}}
export const PERMISSION_HELP='The ElevenLabs key saved in SAI has no ElevenAgents permission. In the ElevenLabs dashboard, create an API key with ElevenAgents (convai) read and write, then save it in SAI settings on the Mac.';
export async function elevenRequest(route,{key,method='GET',body,fetcher=fetch,timeoutMs=30000}={}){
 if(!key)throw new ElevenAgentsError('Connect ElevenLabs on the Mac first.',{code:'no-key'});
 const r=await fetcher('https://api.elevenlabs.io'+route,{method,headers:{'xi-api-key':key,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(timeoutMs)});
 if(r.ok)return r.status===204?{}:r.json();
 let detail=null;try{detail=(await r.json()).detail;}catch{}
 const status=typeof detail==='object'&&detail?detail.status??detail.code:null;
 if(r.status===401&&/missing_permissions/.test(String(status)))throw new ElevenAgentsError(PERMISSION_HELP,{status:r.status,code:'missing-permissions',permission:true});
 const message=typeof detail==='string'?detail:detail?.message??(Array.isArray(detail)?detail.map(d=>d.msg).join('; '):'');
 throw new ElevenAgentsError(`ElevenLabs ${r.status}${message?': '+message.slice(0,300):''} (${method} ${route})`,{status:r.status,code:String(status??r.status)});
}
// The base prompt is a placeholder; every call replaces it with a prompt built from her live state (eleven-prompt.mjs).
export const BASE_PROMPT='You are Samantha, on a live voice call through SAI, speaking in your own voice. This agent is only used by SAI, which sends your complete current prompt at the start of every call. If this text is what you have, say that the call started without your context and that it should be started again.';
export function toolDefinition(tool){return {tool_config:{type:'client',name:tool.name,description:tool.description,parameters:tool.parameters,expects_response:tool.expects_response,response_timeout_secs:tool.response_timeout_secs}};}
export function agentDefinition({voiceId,llm=DEFAULT_LLM,realtimeModel=DEFAULT_REALTIME_MODEL,toolIds=[],keywords=KEYWORDS}){
 if(!voiceId)throw new ElevenAgentsError('Choose Samantha\'s ElevenLabs voice first.',{code:'no-voice'});
 if(!REALTIME_MODELS.includes(realtimeModel))throw new ElevenAgentsError('Choose a native Eleven Realtime model.',{code:'bad-realtime-model'});
 if(!ALLOWED_LLMS.includes(llm))throw new ElevenAgentsError('Unsupported agent model: '+llm,{code:'bad-llm'});
 return {name:AGENT_NAME,conversation_config:{realtime_model:realtimeModel,
  agent:{first_message:'',language:'en',prompt:{prompt:BASE_PROMPT,llm,temperature:0.7,max_tokens:-1,tool_ids:toolIds,backup_llm_config:{preference:'disabled'},built_in_tools:{skip_turn:{type:'system',name:'skip_turn',description:'Let a pause stay quiet when the caller is thinking, occupied, has asked for a moment, or there is no natural thing to say. Do not repeatedly check whether the caller is there. Wait for them to resume; a real thought of your own may still be shared when it fits.',params:{system_tool_type:'skip_turn'}}}}},
  tts:{model_id:TTS_MODEL,voice_id:voiceId,stability:0.45,similarity_boost:0.8,speed:1,agent_output_audio_format:'pcm_24000'},
  turn:{turn_timeout:30,turn_eagerness:'normal',turn_model:'turn_v3',silence_end_call_timeout:-1,soft_timeout_config:{timeout_seconds:-1}},
  asr:{provider:'scribe_realtime',quality:'high',keywords},
  conversation:{text_only:false,max_duration_seconds:7200,client_events:['audio','interruption','user_transcript','agent_response','agent_response_correction','vad_score','agent_tool_response','conversation_initiation_metadata','ping','client_tool_call']},
 },platform_settings:{
  overrides:{conversation_config_override:{agent:{prompt:{prompt:true},first_message:true,language:false},tts:{voice_id:false,stability:true,speed:true,similarity_boost:true},asr:{keywords:true}}},
  privacy:{record_voice:false,retention_days:30}}};
}
export const definitionDigest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
// store: {read:()=>Promise<record|null>, write:record=>Promise}. Idempotent: unchanged definitions are not re-sent.
export async function syncAgent({key,voiceId,llm=DEFAULT_LLM,realtimeModel=DEFAULT_REALTIME_MODEL,store,fetcher=fetch,log=()=>{},force=false}){
 if(!REALTIME_MODELS.includes(realtimeModel))throw new ElevenAgentsError('Choose a native Eleven Realtime model.',{code:'bad-realtime-model'});
 const saved=(await store.read())??{};const toolIds={...(saved.toolIds??{})};const request=(route,options={})=>elevenRequest(route,{key,fetcher,...options});
 for(const tool of TOOLS){
  const body=toolDefinition(tool),digest=definitionDigest(body);
  if(toolIds[tool.name]?.id&&toolIds[tool.name].digest===digest&&!force)continue;
  if(toolIds[tool.name]?.id){await request('/v1/convai/tools/'+toolIds[tool.name].id,{method:'PATCH',body});toolIds[tool.name]={id:toolIds[tool.name].id,digest};log('eleven_tool_updated',{tool:tool.name});}
  else{const created=await request('/v1/convai/tools',{method:'POST',body});toolIds[tool.name]={id:created.id,digest};log('eleven_tool_created',{tool:tool.name,id:created.id});}
 }
 const definition=agentDefinition({voiceId,llm,realtimeModel,toolIds:TOOLS.map(t=>toolIds[t.name].id)}),digest=definitionDigest(definition);
 let agentId=saved.agentId??null;
 if(!agentId){const created=await request('/v1/convai/agents/create',{method:'POST',body:definition});agentId=created.agent_id;log('eleven_agent_created',{agentId});}
 else if(saved.definitionDigest!==digest||force){await request('/v1/convai/agents/'+agentId,{method:'PATCH',body:definition});log('eleven_agent_updated',{agentId});}
 const record={version:2,agentId,toolIds,realtimeModel,llm,voiceId,ttsModel:TTS_MODEL,definitionDigest:digest,syncedAt:new Date().toISOString()};
 await store.write(record);return record;
}
export async function conversationToken({key,agentId,fetcher=fetch}){
 if(!agentId)throw new ElevenAgentsError('Samantha\'s ElevenLabs agent has not been created yet. Open Settings on the Mac and sync it.',{code:'no-agent'});
 const r=await elevenRequest('/v1/convai/conversation/token?agent_id='+encodeURIComponent(agentId),{key,fetcher,timeoutMs:15000});
 if(typeof r?.token!=='string'||!r.token)throw new ElevenAgentsError('ElevenLabs returned no conversation token.',{code:'no-token'});
 return {token:r.token,conversationId:r.conversation_id??null};
}
// A call must establish the actual remote voice mode, not trust a cached UI label.
export async function nativeConversationToken({key,agentId,fetcher=fetch}){
 const current=await agentStatus({key,record:{agentId},fetcher});
 if(!current.nativeRealtime)throw new ElevenAgentsError(current.error||'Native Eleven Realtime is not enabled on this agent.',{code:current.reason??'native-realtime-not-enabled'});
 return {...await conversationToken({key,agentId,fetcher}),realtimeModel:current.realtimeModel};
}
export const conversationDetails=({key,conversationId,fetcher=fetch})=>elevenRequest('/v1/convai/conversations/'+encodeURIComponent(conversationId),{key,fetcher,timeoutMs:15000});
export async function agentStatus({key,record,fetcher=fetch}){
 const desired=record?.realtimeModel??DEFAULT_REALTIME_MODEL;
 if(!key)return {connected:false,agentId:null,reason:'no-key',realtimeModel:desired};
 if(!record?.agentId)return {connected:true,agentId:null,reason:'not-synced',realtimeModel:desired};
 try{
  const a=await elevenRequest('/v1/convai/agents/'+record.agentId,{key,fetcher,timeoutMs:15000});
  const realtimeModel=a.conversation_config?.realtime_model??null,nativeRealtime=REALTIME_MODELS.includes(realtimeModel);
  return {connected:true,agentId:record.agentId,name:a.name,nativeRealtime,realtimeModel,modelName:realtimeModelName(realtimeModel),
   llm:nativeRealtime?null:a.conversation_config?.agent?.prompt?.llm??record.llm,
   voiceId:a.conversation_config?.tts?.voice_id??record.voiceId,ttsModel:nativeRealtime?null:a.conversation_config?.tts?.model_id??record.ttsModel,
   syncedAt:record.syncedAt,reason:nativeRealtime?null:'native-realtime-not-enabled'};
 }catch(e){return {connected:true,agentId:record.agentId,syncedAt:record.syncedAt,reason:e.permission?'missing-permissions':'unreachable',error:e.message,realtimeModel:desired};}
}
