// Only transport receipts count as sends. Guard prose can quote old receipts;
// never scan arbitrary text or historical context for a message identifier.
const GUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const failed = value => value && typeof value === 'object' && (
  value.isError === true || !!value.error || value.ok === false || value.success === false ||
  value.block === true || !!value.deniedReason ||
  ['blocked','denied','refused','failed','error','pending','unknown','queued'].includes(value.status) ||
  (value.deliveryStatus !== undefined && value.deliveryStatus !== 'sent')
);
export function messageSendReceipt(event) {
  if (event.error || event.toolName?.split('__').at(-1) !== 'message' || event.params?.action !== 'send') return null;
  const result = event.result;
  if (!result || failed(result) || failed(result.details) || failed(result.structuredContent)) return null;
  const candidates = [result.details, result.structuredContent, result];
  for (const block of result.content ?? []) {
    if (block.type !== 'text' || typeof block.text !== 'string') continue;
    try { candidates.push(JSON.parse(block.text)); } catch { /* Guard prose is not a receipt. */ }
  }
  if (candidates.some(value => failed(value) || failed(value?.result))) return null;
  for (const value of candidates) {
    if (!value || typeof value !== 'object') continue;
    const payload = value.result ?? value;
    const channel = value.channel ?? payload.channel ?? event.params.channel;
    if (channel && channel !== 'imessage') continue;
    const recipient = value.to ?? payload.to;
    if (recipient && String(recipient).replace(/\D/g,'') !== String(event.params.target ?? event.params.to).replace(/\D/g,'')) continue;
    const guid = payload.meta?.imessageMessageGuid ?? payload.receipt?.primaryPlatformMessageId ?? payload.messageId;
    if (typeof guid === 'string' && GUID.test(guid)) return {guid, status:'sent'};
  }
  return null;
}
