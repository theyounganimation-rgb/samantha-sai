// Scene captions are not OCR. Keep a guessed display time from becoming a fact
// in the foreground, background, or a direct vision-tool result.
export const VISUAL_PRECISION='Small text and clock digits in scene captions are unverified. Use systemTime for the current time; it is the Mac clock, not a reading of the room clock. Never infer that a physical clock is wrong, slow or fast from a caption. If its displayed time matters, say the digits are unclear and ask for a closer view or direct confirmation. Do not substitute the Mac time for what a physical clock displays.';

// Only visual prose is filtered. Capture/source timestamps and questions retain
// their exact provenance. Decimal values require clock context, unlike HH:MM.
export function visualDescription(text) {
  let value=String(text??'').slice(0,1600);
  value=value.replace(/\b(?:[01]?\d|2[0-3]):[0-5]\d(?::[0-5]\d)?(?:\s*[ap]\.?m\.?)?\b/gi,'[unverified display time]');
  if(/\b(?:clock|watch|time|alarm)\b/i.test(value)) {
    value=value.replace(/\b(?:[01]?\d|2[0-3])[.h][0-5]\d(?:\s*[ap]\.?m\.?)?\b/gi,'[unverified display time]');
    value=value.replace(/\b(?:[1-9]|1[0-2])\s*(?:[ap]\.?m\.?|o['’]?clock)\b/gi,'[unverified display time]');
  }
  return value;
}

export function systemTime(now=Date.now()) {
  const date=new Date(now),timeZone=Intl.DateTimeFormat().resolvedOptions().timeZone;
  return {source:'Mac system clock, not visual evidence',at:date.toISOString(),timeZone,
    local:date.toLocaleString('en-US',{timeZone,timeZoneName:'short'})};
}

export function visionEvidence(value,now=Date.now()) {
  if(!value||typeof value!=='object')return value;
  if(Array.isArray(value))return value.map(item=>visionEvidence(item,now));
  const out={...value};let hasDescription=false;
  for(const key of ['description','observation'])if(typeof out[key]==='string') {
    out[key]=visualDescription(out[key]);hasDescription=true;
  }
  for(const key of ['latest','recent','observation'])if(out[key]&&typeof out[key]==='object')out[key]=visionEvidence(out[key],now);
  if(hasDescription)out.visualPrecision={clockDigits:'unverified',smallText:'unverified',guidance:VISUAL_PRECISION};
  return {...out,systemTime:systemTime(now)};
}
