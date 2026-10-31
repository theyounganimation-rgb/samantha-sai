import crypto from 'node:crypto';

export class CallInitiative {
  constructor({now=Date.now,quietMs=12000}={}){
    this.now=now;this.quietMs=quietMs;this.callId=crypto.randomUUID();this.started=now();
    this.lastActivity=now();this.lastSound=0;this.lastInput=0;this.activityRevision=0;this.ready=false;
  }
  activity(){this.lastActivity=this.now();this.activityRevision++;}
  input(bytes){
    this.lastInput=this.now();let power=0,count=0;
    for(let i=0;i+1<bytes.length;i+=8){const v=bytes.readInt16LE(i)/32768;power+=v*v;count++;}
    // Reserve the turn before transcription when audible microphone input starts.
    if(count&&Math.sqrt(power/count)>.035)this.lastSound=this.now();
  }
  status({closed=false,busy=false,speaking=false,capable=false,quietMs=this.quietMs}={}){
    const now=this.now(),idleMs=now-this.lastActivity;
    const reason=closed?'call-ended':!this.ready?'connecting':!capable?'client-update-required':busy?'reply-in-progress':speaking?'playback-in-progress':now-this.lastInput>10000?'microphone-stream-stale':now-this.lastSound<2500?'microphone-active':idleMs<quietMs?'recent-conversation':null;
    return {active:!closed,callId:this.callId,activityRevision:this.activityRevision,startedAt:this.started,idleSeconds:Math.max(0,Math.floor(idleMs/1000)),canSpeak:!reason,reason};
  }
}

export class OutreachReceipts {
  constructor({now=Date.now,persist=async()=>{}}={}){this.now=now;this.persist=persist;this.entries=new Map();this.queue=Promise.resolve();}
  get(id){return this.entries.get(id);}
  async update(id,patch){
    const value={...this.entries.get(id),...patch,requestId:id,updatedAt:this.now()};this.entries.set(id,value);
    // Full text is already in the canonical conversation, not the health receipt.
    while(this.entries.size>200)this.entries.delete(this.entries.keys().next().value);
    const snapshot=[...this.entries.values()];const write=this.queue.then(()=>this.persist(snapshot));this.queue=write.catch(()=>{});await write;return value;
  }
  async accept(request,status){
    if(typeof request.requestId!=='string'||!/^[a-zA-Z0-9_-]{8,100}$/.test(request.requestId))throw Error('Use a stable requestId of 8-100 letters, numbers, hyphens or underscores.');
    if(typeof request.text!=='string'||!request.text.trim()||request.text.length>2500)throw Error('Provide 1-2500 characters to speak.');
    const digest=crypto.createHash('sha256').update(request.text).digest('hex');
    const previous=this.get(request.requestId);
    if(previous){
      if(previous.textSha256!==digest||previous.callId!==request.callId)throw Error('Request ID already belongs to another utterance.');
      return {...previous,duplicate:true};
    }
    if(!status.active||request.callId!==status.callId)return {accepted:false,status:'not-admitted',reason:'call-ended-or-changed'};
    if(request.activityRevision!==status.activityRevision)return {accepted:false,status:'not-admitted',reason:'conversation-changed'};
    if(!status.canSpeak)return {accepted:false,status:'not-admitted',reason:status.reason};
    return this.update(request.requestId,{accepted:true,status:'accepted',callId:status.callId,textSha256:digest,createdAt:this.now()});
  }
}
