import { isDeepStrictEqual } from 'node:util';

// OpenClaw separately verifies that the retained channel plugin and its channel
// config are unchanged. Preserve the same resolved iMessage account as well.
export function prepareIMessageRuntimeHandoff(currentCfg, admittedAccount, resolveAccount) {
  const currentAccount = resolveAccount({cfg: currentCfg, accountId: admittedAccount.accountId});
  if (!currentAccount.enabled || currentAccount.accountId !== admittedAccount.accountId ||
      !isDeepStrictEqual(currentAccount.config, admittedAccount.config)) {
    throw new Error('iMessage sender configuration changed; delivery was not started.');
  }
  return currentCfg;
}
