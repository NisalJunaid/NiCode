/**
 * Step-up confirmation for destructive actions: the phone asks for a nonce, unlocks its key
 * with a fresh fingerprint/face check, and signs confirmMessage(nonce, action, fields). The
 * proof is single use, expires after 60 s, and only works for that exact action and fields.
 */
import { confirmMessage, type ConfirmProof } from '../../../protocol/types.js';
import { ChallengeStore, isKeyDevice, verifyDeviceSignature } from '../auth.js';
import { RpcError, type RpcContext } from '../rpc.js';

const nonces = new ChallengeStore(60_000, 1000);

export function issueConfirmNonce(): { nonce: string; expiresAt: string } {
  return nonces.issue();
}

export function requireConfirmation(ctx: RpcContext, action: string, fields: string[], proof: ConfirmProof | undefined): void {
  if (!isKeyDevice(ctx.device)) throw new RpcError('forbidden', 'Only a paired phone can confirm this');
  if (!proof || !nonces.consume(proof.nonce)) throw new RpcError('forbidden', 'The confirmation expired. Try again.');
  if (!verifyDeviceSignature(ctx.device, confirmMessage(proof.nonce, action, fields), proof.sig)) {
    throw new RpcError('forbidden', "Couldn't verify the confirmation from this phone");
  }
}
