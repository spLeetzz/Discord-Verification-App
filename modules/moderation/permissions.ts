/**
 * Recording and restoring a channel's permissions.
 *
 * The bug this file exists to prevent: Quotient unlocked a channel by
 * setting `send_messages = True` on the `@everyone` overwrite, whatever
 * the channel looked like before. A channel that was write-locked before
 * the lockdown was silently opened by the unlock. The same applied to
 * maintenance mode's `read_messages`.
 *
 * The fix is to *record* what the permission was and put it back exactly:
 *
 *  - `null` means the permission was inherited, not set;
 *  - `existed` says whether the channel had an explicit overwrite for that
 *    target at all. If it did not, the unlock removes the overwrite the
 *    lock created rather than leaving a flat `true` behind.
 */

import type { PriorPermissionState } from "./types.js";

/**
 * Reads the state of a permission from an overwrite.
 *
 * @param input.exists  was there an explicit overwrite for the target?
 * @param input.allowed is the permission in the overwrite's allow set?
 * @param input.denied  is the permission in the overwrite's deny set?
 */
export function readOverwriteState(input: {
  exists: boolean;
  allowed: boolean;
  denied: boolean;
}): PriorPermissionState {
  if (!input.exists) return { existed: false, value: null };
  if (input.allowed) return { existed: true, value: true };
  if (input.denied) return { existed: true, value: false };

  return { existed: true, value: null };
}

/** What an unlock has to do to put a permission back. */
export type RestorePlan =
  /** Set the permission back to the value it had. */
  | { readonly kind: "restore"; readonly value: boolean | null }
  /** Take the overwrite away again — there was not one before. */
  | { readonly kind: "remove" };

/**
 * Works out how to undo a permission change.
 *
 * The distinction that matters: if the channel had no explicit overwrite
 * for the target before the lock, the lock *created* one, and the unlock
 * has to remove it. Writing `true` into it instead would leave the
 * channel with an explicit allow where it used to inherit — which is a
 * different channel, not the same one.
 */
export function planRestore(prior: PriorPermissionState): RestorePlan {
  if (!prior.existed) return { kind: "remove" };

  return { kind: "restore", value: prior.value };
}
