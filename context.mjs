// Per-turn UI metadata. Shared history and routine come from the gateway hook.
export function phoneViewForTurn(outing,now=Date.now()) {
  if(!outing?.active)return null;
  const p=outing.perception??{},age=(now-Date.parse(p.capturedAt))/1000;
  const current=outing.cameraStatus==='on'&&Number.isFinite(age)&&age>=-5&&age<=40&&p.description?.trim();
  const unclear=Boolean(current&&p.unclear),fresh=Boolean(current&&!p.unclear);
  // October 26 (Owner): with no caption model the frame is attached to the turn directly.
  const direct=outing.cameraStatus==='on'&&Number.isFinite(age)&&age>=-5&&age<=40&&p.direct===true;
  return {sourceKind:'phone-camera',status:fresh?'fresh':unclear?'unclear':direct?'direct':outing.cameraStatus==='on'?'interpreting':outing.cameraStatus,
    sharingEnabled:true,capturedAt:p.capturedAt??null,lastFrameAt:outing.lastFrameAt??null,
    ...(fresh?{source:p.source??p.id,description:p.description}:{}),
    guidance:direct?'The live phone frame is attached to this turn; what you see in the image is your view of where the phone is pointing, not the home desk. There is no caption. One frame loses to what the conversation has established about where he is and what he is doing.':fresh?'This is the explicitly shared phone view for this call, not the home desk. Use the dated description as fallible visual evidence; one captioned frame loses to what the conversation has established about where he is and what he is doing.':unclear?'The phone view is currently unclear (dark, blurred or covered); you cannot see through it right now. Do not describe his surroundings from it or from memory.':
      'Phone sharing is enabled for this call, but no fresh interpreted image is available yet. Do not claim you see it or say you only have the home camera. Use samantha_outing status/look when a visual question needs current evidence.'};
}
export function conversationWorkContext({voice=false,interrupted=false,continued=false,voiceEvidence,speakerBinding,outing,cameraFrame=null}={}) {
  const phoneView=phoneViewForTurn(outing);
  const metadata={surface:voice?'voice':'text',previousSpeechInterrupted:interrupted,
      ...(speakerBinding?{speakerBinding:{v:1,speakerId:speakerBinding.speaker.personId,...(speakerBinding.speaker.personId.startsWith('guest-')&&speakerBinding.recipient.personId===speakerBinding.speaker.personId?{}:{recipientId:speakerBinding.recipient.personId}),source:speakerBinding.source,...(speakerBinding.speaker.personId.startsWith('guest-')?{name:speakerBinding.speaker.name,anonymous:speakerBinding.speaker.anonymous}:{}),...(speakerBinding.recipient.personId!==speakerBinding.speaker.personId&&speakerBinding.recipient.personId.startsWith('guest-')?{recipientName:speakerBinding.recipient.name,recipientAnonymous:speakerBinding.recipient.anonymous}:{})}}:{}),
      ...(voice&&continued?{continuedBeforeReply:true,turnTaking:'Continuation before audio: answer consecutive user messages as one thought; no apology for talking over them.'}:{}),
      ...(voice?{delivery:'Natural low, warm register; relaxed endings and emotion suited to the moment, without a constant smile. Brief [chuckles], [laughs], [sighs] or [dryly] only when fitting; most lines need no tag. Never explain or force delivery.'}:{})};
  if(voice&&voiceEvidence){
    metadata.audioInput={source:'ASR',speakerVerified:false,availability:voiceEvidence.resting?'resting':'unconfirmed',guidance:'ASR can err. Preserve rest; time is not waking.'};
    metadata.delivery='Low, warm, natural. Sparse delivery tags.';
  }
  // Kept short on purpose: the whole metadata object must stay under 640 characters (checked below).
  if(cameraFrame)metadata.cameraFrame=cameraFrame.sourceKind==='phone-camera'
    ?{src:'phone',live:true,note:'Attached image: his live phone camera view (bring me along) right now, not a photo he sent.'}
    :{src:'home',live:true,note:'Attached image: the live home camera right now, not a photo he sent.'};
  if(phoneView){
    // This gateway reference is capped at 640 characters. Preserve complete
    // descriptions only when they fit; otherwise point to the existing full
    // status read, never half-quote a visual qualifier or truncate JSON.
    metadata.phoneView={sourceKind:'phone-camera',status:phoneView.status,capturedAt:phoneView.capturedAt,full:'samantha_outing status'};
    if(!interrupted)delete metadata.previousSpeechInterrupted;
    if(voice&&!voiceEvidence)metadata.delivery='Low, warm; relaxed endings; mood suited, no constant smile. Sparse [chuckles]/[laughs]/[sighs]/[dryly], never forced or explained.';
    if(metadata.turnTaking)metadata.turnTaking='Combine speech resumed before audio; no interruption apology.';
    if(phoneView.description){
      metadata.phoneView.description=phoneView.description;
      if(JSON.stringify(metadata).length>640){delete metadata.phoneView.description;metadata.phoneView.descriptionOmitted=true;}
    }
  }
  if(JSON.stringify(metadata).length>640&&metadata.turnTaking)metadata.turnTaking='Combine speech continued before audio; no interruption apology.';
  if(JSON.stringify(metadata).length>640&&metadata.cameraFrame?.note)delete metadata.cameraFrame.note;
  if(voiceEvidence&&JSON.stringify(metadata).length>640){delete metadata.delivery;if(metadata.phoneView)delete metadata.phoneView.descriptionOmitted;}
  if(JSON.stringify(metadata).length>640&&metadata.delivery)metadata.delivery='Low, warm, natural. Sparse delivery tags.';
  if(JSON.stringify(metadata).length>640&&metadata.phoneView){delete metadata.phoneView.description;delete metadata.phoneView.descriptionOmitted;}
  if(JSON.stringify(metadata).length>640){delete metadata.delivery;if(metadata.turnTaking)metadata.turnTaking='Combine continued speech.';if(metadata.audioInput)metadata.audioInput.guidance='ASR can err; preserve rest.';}
  if(JSON.stringify(metadata).length>640)throw Error('Voice turn metadata exceeds the gateway limit; inspect rather than truncate it.');
  return {page:voice?'SAI voice':'SAI text',title:'Samantha: shared conversation',selection:JSON.stringify(metadata)};
}
