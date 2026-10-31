// A native control command is operational history, not a human chat turn.
// Match its import origin and entire record shape. Never discard a user's
// question or quoted XML merely because it contains one of these tags.
const textOf=m=>typeof m.content==='string'?m.content:Array.isArray(m.content)?m.content.filter(c=>c.type==='text'&&typeof c.text==='string').map(c=>c.text).join('\n'):'';
const command=/^\s*<command-name>\/[A-Za-z][\w-]*<\/command-name>\s*<command-message>[\s\S]*?<\/command-message>\s*<command-args>[\s\S]*?<\/command-args>\s*$/;
const localOutput=/^\s*<local-command-(stdout|stderr)>[\s\S]*?<\/local-command-\1>\s*$/;
export function isInternalNativeRecord(message) {
  if(message?.role!=='user'||message.__openclaw?.importedFrom!=='claude-cli')return false;
  // Explicit captured chat text outranks the native transport representation.
  if(typeof message.__openclaw?.workContext?.text==='string')return false;
  if(message.idempotencyKey||message.__openclaw?.idempotencyKey)return false;
  if(Array.isArray(message.content)&&message.content.some(c=>c?.type!=='text'))return false;
  const text=textOf(message);
  return command.test(text)||localOutput.test(text);
}
