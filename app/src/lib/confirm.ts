import { confirmMessage, type ConfirmProof } from '@protocol';
import type { NicodeClient } from './client';
import { signFresh } from './deviceKey';

/**
 * Proof for a destructive server action: a one-time nonce from the server, signed with this
 * phone's key after a fresh fingerprint/face check. Bound to exactly `action` + `fields`.
 */
export async function confirmAction(client: NicodeClient, action: string, fields: string[], reason: string): Promise<ConfirmProof> {
  const { nonce } = await client.call('auth.confirmChallenge', {});
  return { nonce, sig: await signFresh(confirmMessage(nonce, action, fields), reason) };
}
