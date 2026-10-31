// A short application sound, sent through the same PCM route as call audio.
// It is never submitted to the speech model or stored as Samantha's dialogue.
export function readyCuePCM(sampleRate=24000){
  const count=Math.round(sampleRate*.24),pcm=Buffer.alloc(count*2);
  for(let i=0;i<count;i++){
    const t=i/sampleRate;
    const envelope=Math.min(1,t/.008,Math.max(0,(.24-t)/.025))*Math.exp(-t/0.085);
    const value=envelope*(.035*Math.sin(2*Math.PI*880*t)+.012*Math.sin(2*Math.PI*1320*t));
    pcm.writeInt16LE(Math.round(value*32767),i*2);
  }
  return pcm;
}
const readyAudio=readyCuePCM().toString('base64');
export function announceCallReady(send){
  send('call_ready');
  send('assistant_start',{turn:0,cue:'ready'});
  send('audio',{turn:0,cue:'ready',sampleRate:24000,audio:readyAudio});
  send('audio_done',{turn:0,cue:'ready'});
}
