// Keep the logical call alive across a short loss of its iPhone socket.
// Sequence receipts acknowledge queued playback, not audible delivery; that
// remains the separate playback_done message from the native output callback.
export class CallTransport {
  constructor({id,owner,graceMs=90000,maxBytes=8*1024*1024,onExpire=()=>{},log=()=>{}}={}) {
    Object.assign(this,{id,owner,graceMs,maxBytes,onExpire,log});
    this.sequence=0;this.acked=0;this.frames=[];this.bytes=0;this.controls=new Set();this.client=null;this.closed=false;
  }
  get connected(){return this.client?.readyState===1;}
  matches(id,owner){return !!id&&this.id===id&&this.owner===owner&&!this.closed;}
  acknowledge(seq){
    if(!Number.isSafeInteger(seq)||seq<this.acked||seq>this.sequence)return false;
    this.acked=seq;
    while(this.frames.length&&this.frames[0].seq<=seq)this.bytes-=this.frames.shift().bytes;
    return true;
  }
  attach(client,after=0){
    if(this.closed||!this.acknowledge(after))return false;
    clearTimeout(this.timer);this.timer=null;
    const previous=this.client;this.client=client;
    this.sending=false;this.sentSequence=after;
    if(previous&&previous!==client)previous.terminate();
    client.send(JSON.stringify({type:'transport_ready',resumed:this.attached===true}));
    this.flush();
    this.attached=true;return true;
  }
  detach(client){
    if(this.closed||client!==this.client)return;
    this.client=null;this.log('call_transport_reconnecting');
    clearTimeout(this.timer);this.timer=setTimeout(()=>{this.timer=null;this.onExpire('Call connection could not recover. Please start a new call.');},this.graceMs);
    this.timer.unref?.();
  }
  send(type,data={}){
    if(this.closed||this.exhausted)return;
    const seq=++this.sequence,raw=JSON.stringify({type,...data,transportSeq:seq}),bytes=Buffer.byteLength(raw);
    if(this.bytes+bytes>this.maxBytes){this.exhausted=true;this.onExpire('The connection was interrupted too long to recover this call. Please reconnect.');return;}
    this.frames.push({seq,raw,bytes});this.bytes+=bytes;
    this.flush();
  }
  flush(){
    if(!this.connected||this.sending||this.closed)return;
    const frame=this.frames.find(f=>f.seq>Math.max(this.sentSequence,this.acked));
    if(!frame)return;
    const client=this.client;this.sending=true;
    client.send(frame.raw,error=>{
      if(this.client!==client||this.closed)return;
      this.sending=false;
      if(error){this.detach(client);client.terminate();return;}
      this.sentSequence=frame.seq;this.flush();
    });
  }
  acceptControl(id){
    if(typeof id!=='string'||!/^[a-zA-Z0-9-]{16,100}$/.test(id)||this.controls.has(id))return false;
    this.controls.add(id);while(this.controls.size>512)this.controls.delete(this.controls.values().next().value);return true;
  }
  async finish({timeoutMs=750}={}){
    // Give queued error/ended events a chance to reach the device before close
    // clears the frame queue. This is transmission, not a playback receipt.
    const target=this.sequence,deadline=Date.now()+timeoutMs;
    while(this.connected&&!this.closed&&this.sentSequence<target&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,10));
    this.close();
  }
  close(){this.closed=true;clearTimeout(this.timer);this.frames=[];this.bytes=0;this.controls.clear();this.client?.close();this.client=null;}
}
