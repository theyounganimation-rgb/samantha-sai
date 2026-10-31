// Older native SAI builds encode every non-Eleven call as "classic". When a
// user has selected Phonic, recover that intent for identified native calls.
export function resolveVoiceMode({requested,selected,callId,incoming=false}) {
  if(incoming)return 'eleven';
  if(requested==='classic' && selected==='phonic' && callId)return 'phonic';
  return requested ?? selected ?? 'classic';
}
