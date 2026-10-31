class Microphone extends AudioWorkletProcessor {
  constructor(){super();this.samples=[];this.position=0;this.pending=[];}
  process(inputs){
    const data=inputs[0]?.[0];if(!data)return true;
    this.samples.push(...data);const step=sampleRate/16000;
    while(this.position+1<this.samples.length){const a=Math.floor(this.position),f=this.position-a,v=this.samples[a]*(1-f)+this.samples[a+1]*f;this.pending.push(Math.max(-32768,Math.min(32767,Math.round(v*32767))));this.position+=step;}
    const used=Math.min(Math.floor(this.position),this.samples.length);this.samples.splice(0,used);this.position-=used;
    if(this.pending.length>=1600){const packet=new Int16Array(this.pending.splice(0,1600));this.port.postMessage(packet.buffer,[packet.buffer]);}
    return true;
  }
}
registerProcessor('sai-microphone',Microphone);
