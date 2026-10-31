// The existing owner-only iMessage destination, never inferred from message text.
export const OWNER_MESSAGE_TARGET = process.env.SAI_OWNER_MESSAGE_TARGET || '';
export const OWNER_ROUTE_REVISION = 'owner-imessage-20261016-v1';
export const isOwnerBackground = ctx => ctx?.agentId === 'samantha' && /^agent:samantha:cron:[^:]+(?::run:[^:]+)?$/.test(ctx.sessionKey ?? '');
export const messageToolName = name => String(name ?? '').split('__').at(-1).replace(/^openclaw(?=message$)/, '');
const nonempty = value => typeof value === 'string' && value.trim().length > 0;

export function ownerMessageEvent(event, ctx) {
  const p = event?.params;
  if (!isOwnerBackground(ctx) || messageToolName(event?.toolName) !== 'message' || p?.action !== 'send') return event;
  if (!OWNER_MESSAGE_TARGET) throw new Error('Owner message target is not configured');
  // Explicit destinations, accounts, channels and multi-target requests remain
  // subject to their normal routing/authorization. Never redirect someone else.
  if ([p.target,p.to,p.channelId].some(nonempty) || Object.hasOwn(p,'targets') ||
      (nonempty(p.channel) && p.channel !== 'imessage') ||
      (nonempty(p.accountId) && p.accountId !== 'default')) return event;
  return {...event,params:{...p,target:OWNER_MESSAGE_TARGET,channel:'imessage',accountId:'default'}};
}
