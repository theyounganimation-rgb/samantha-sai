import {conversationalText} from './visible-reply.mjs';
import {messageMedia,mediaBlocks,stripMediaDirectives,cliTransportPlaceholder} from './message-media.mjs';
import {messageAttribution} from './integrations/activity-recall/speaker-context.mjs';
import {isInternalNativeRecord} from './native-record-visibility.mjs';
// October 27 (Owner), evening: Fish Audio restored as the call voice; the ElevenLabs realtime agent remains available as an engine.
export function publicSettings(settings,fish={}) {
  return {connected:!!settings.apiKey,voiceId:settings.voiceId||'',voiceName:settings.voiceName||'',model:settings.model||'eleven_v4_turbo',provider:settings.provider==='fish'?'fish':'elevenlabs',fishConnected:!!fish.apiKey};
}
const contentText=m=>typeof m.content==='string'?m.content:Array.isArray(m.content)?m.content.filter(c=>c.type==='text'&&typeof c.text==='string').map(c=>c.text).join('\n'):'';
const idempotency=m=>m.idempotencyKey??m.__openclaw?.idempotencyKey??'';
function withoutCliMirrors(messages) {
  const omitted=new Set();let imported=[],inputRun=null;
  for(let i=0;i<messages.length;i++){
    const m=messages[i],meta=m.__openclaw;
    if(cliTransportPlaceholder(m))continue;
    if(m.role==='user'||m.role==='system'){
      imported=[];inputRun=m.role==='user'?idempotency(m).match(/^(.+):user$/)?.[1]??null:null;continue;
    }
    if(m.role!=='assistant')continue;
    // chat.history overlays native Claude events on the canonical transcript.
    // Its per-tool-step text and terminal reply can also be represented by one
    // canonical cli-assistant aggregate. Match that representation, not merely
    // similar text, nearby timestamps or consecutive assistant messages.
    if(m.provider==='claude-cli'&&m.api==='anthropic-messages'&&meta?.importedFrom==='claude-cli'&&meta.externalId&&!meta.transcriptPosition){
      if(contentText(m).trim())imported.push(i);
      continue;
    }
    const run=idempotency(m).match(/^cli-assistant:(.+)$/)?.[1];
    if(m.provider==='claude-cli'&&m.api==='cli'&&m.stopReason==='stop'&&run&&meta?.transcriptPosition){
      const combined=imported.map(j=>contentText(messages[j]).trim()).join('\n\n');
      // Canonical conversion also produces audio/video/file blocks, even if a
      // particular attachment type has no SAI renderer. Match managed artifact
      // provenance here, independently of the UI's supported media types.
      const convertedMedia=mediaBlocks(m).some(b=>/^\/api\/chat\/media\/outgoing\/[^/]+\/[a-f0-9-]{36}\/full$/.test(b.url));
      const mediaMirror=convertedMedia&&imported.some(j=>/^MEDIA:\s*\S/m.test(contentText(messages[j])))&&stripMediaDirectives(combined).trim()===stripMediaDirectives(contentText(m)).trim();
      if(imported.length&&(!inputRun||inputRun===run)&&(combined===contentText(m).trim()||mediaMirror)){
        for(const j of imported)omitted.add(j);
      }
    }
    imported=[];
  }
  return messages.filter((_,i)=>!omitted.has(i));
}
// Background generated prose is operational output. Only its confirmed
// delivery mirror belongs in the shared conversation.
function withoutBackgroundNarration(messages) {
  const internalRuns=new Set(messages.filter(m=>m.role==='user'&&m.provenance?.kind==='internal_system').map(m=>idempotency(m).replace(/:user$/,'')));
  let internal=false;
  return messages.filter(m=>{
    if(m.role==='user')internal=m.provenance?.kind==='internal_system';
    if(m.role!=='assistant'||m.model==='delivery-mirror')return true;
    const run=m.__openclaw?.runId||idempotency(m).match(/^cli-assistant:(.+)$/)?.[1];
    if(run)return !internalRuns.has(run);
    return !(internal&&m.__openclaw?.importedFrom==='claude-cli');
  });
}
export function visibleHistory(messages) {
  const turns=new Map(),surfaces=new Map();
  for(const m of messages){const run=idempotency(m).match(/^(.+):user$/)?.[1]??m.__openclaw?.runId;const ctx=m.__openclaw?.workContext;const page=(ctx?.snapshot??ctx)?.page;if(run&&page)surfaces.set(run,page==='SAI voice'?'voice':'text');}
  // A native terminal row can be saved just before its canonical run is
  // cancelled. Retain the bound input's turn identity through that overlay.
  // Ordinary background/delivery rows never inherit a foreground turn.
  const turnIds=new Map();let boundInput=null;
  for(const m of messages){
    const explicit=m.__openclaw?.runId??idempotency(m).match(/^(?:cli-assistant:)(.+)$/)?.[1];
    if(m.role==='user'){boundInput=m.provenance?.kind&&m.provenance.kind!=='external_user'?null:idempotency(m).match(/^(.+):user$/)?.[1]??null;if(boundInput)turnIds.set(m,boundInput);}
    else if(m.role==='system')boundInput=null;
    else if(m.role==='assistant'){
      if(m.model==='delivery-mirror'){boundInput=null;continue;}
      if(explicit){turnIds.set(m,explicit);if(explicit!==boundInput)boundInput=null;}
      else if(boundInput&&m.provider==='claude-cli'&&m.api==='anthropic-messages'&&m.__openclaw?.importedFrom==='claude-cli'&&m.stopReason==='end_turn')turnIds.set(m,boundInput);
      else if(m.model==='delivery-mirror'||m.provider!=='claude-cli')boundInput=null;
    }
  }
  return withoutCliMirrors(withoutBackgroundNarration(messages.filter(m=>!isInternalNativeRecord(m)))).filter(m=>['user','assistant'].includes(m.role)&&!cliTransportPlaceholder(m)&&!(m.role==='assistant'&&String(m.__openclaw?.runId??idempotency(m)).replace(/^cli-assistant:/,'').startsWith('sai-live-delegate-'))&&!['tool_use','toolUse','error','aborted'].includes(m.stopReason)&&!(m.role==='user'&&m.provenance?.kind&&m.provenance.kind!=='external_user')).map(m=>{
    let text=typeof m.__openclaw?.workContext?.text==='string'?m.__openclaw.workContext.text:typeof m.content==='string'?m.content:(m.content||[]).filter(c=>c.type==='text').map(c=>c.text).join('\n');
    // Hide the technical playback qualifier only in SAI's presentation; the
    // canonical transcript and its delivery metadata keep the uncertainty.
    if(m.role==='assistant'&&m.__openclaw?.saiLive)text=text.replace(/^\[Voice generated; playback not fully confirmed\] /,'');
    const media=messageMedia(m);
    const turnId=turnIds.get(m),attributed=turnId&&m.role==='assistant'?{...m,__openclaw:{...m.__openclaw,runId:turnId}}:m;
    return {role:m.role,text:m.role==='assistant'?conversationalText(text):text,timestamp:m.timestamp,id:m.id||m.messageId||String(m.timestamp),turnId:turnId??null,...((m.__openclaw?.saiLive||(m.__openclaw?.workContext?.snapshot??m.__openclaw?.workContext)?.page==='SAI voice'||surfaces.get(turnId)==='voice')?{surface:'voice'}:{}),...messageAttribution(attributed,turns),...(media.length?{media}:{})};
  }).filter(m=>(m.text.trim()||m.media?.length)&&!(m.role==='assistant'&&m.text.startsWith('[Live handoff, not spoken]'))&&!/^(HEARTBEAT_OK|NO_REPLY|No response requested\.)$/.test(m.text.trim())&&!/^(\[System Message\]|OpenClaw resumed this CLI session|Samantha, this is new sensory input|Samantha, your delegated Codex task has finished|System: \[)/.test(m.text)).slice(-60);
}
export async function* sseEvents(body) {
  const decoder=new TextDecoder();let pending='';
  for await(const chunk of body){
    pending+=decoder.decode(chunk,{stream:true});
    let cut;
    let boundary;
    while((boundary=/\r?\n\r?\n/.exec(pending))){
      cut=boundary.index;const block=pending.slice(0,cut);pending=pending.slice(cut+boundary[0].length);
      const data=block.replace(/\r\n/g,'\n').split('\n').filter(l=>l.startsWith('data:')).map(l=>l.slice(5).trimStart()).join('\n');
      if(!data)continue;if(data==='[DONE]')return;
      const value=JSON.parse(data);if(value.error)throw new Error(value.error.message||'Samantha’s response failed.');yield value;
    }
    if(pending.length>1048576)throw new Error('Response stream exceeded its buffer.');
  }
}
export function originAllowed(origin,host,allowed) {
  if(!allowed.has(host))return false;
  try{const u=new URL(origin);return u.host===host&&['http:','https:'].includes(u.protocol);}catch{return false;}
}
