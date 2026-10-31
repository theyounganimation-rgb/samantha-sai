// +7.6 dB for ordinary speech (Owner, October 29, 2026: too quiet at the phone's maximum; was +4.1 dB), with a smooth peak knee
// below full scale. Applied once, before transport, so browser, iPhone and Watch hear the same level.
export function voiceSample(x) {
  const y=x*2.4, a=Math.abs(y), knee=.78, ceiling=.975;
  return a<=knee?y:Math.sign(y)*(knee+(ceiling-knee)*Math.tanh((a-knee)/(ceiling-knee)));
}
export function boostVoicePCM(base64) {
  const source=Buffer.from(base64,'base64');
  if(source.length%2)throw new Error('Voice PCM must contain complete 16-bit samples.');
  const out=Buffer.allocUnsafe(source.length);
  for(let i=0;i<source.length;i+=2)out.writeInt16LE(Math.round(voiceSample(source.readInt16LE(i)/32768)*32768),i);
  return out.toString('base64');
}
