/**
 * The audit-log reason format.
 *
 * Discord caps an audit-log reason at 512 characters. Quotient's
 * `ActionReason` converter built `"<author> (ID: <id>): <reason>"` and
 * refused the whole action when the result was too long — the *total* was
 * capped, not the reason on its own. A moderator who typed a 600 character
 * reason and had it silently truncated would have found a different reason
 * in the audit log than the one they wrote, so the port refuses instead.
 */

import { InputError } from "../../core/errors.js";

/** Discord's audit-log reason limit. */
export const MAX_ACTION_REASON_LENGTH = 512;

/**
 * The part of the reason that is not the moderator's own text.
 *
 * Every reason starts with this, so the moderator's text only gets what is
 * left of the 512 characters.
 */
export function actionReasonPrefix(authorLabel: string, authorId: string): string {
  return `${authorLabel} (ID: ${authorId}): `;
}

/**
 * How long a reason may be, given who is writing it.
 *
 * The name of the author is part of the reason, so a longer display name
 * means a shorter reason.
 */
export function maxReasonLength(authorLabel: string, authorId: string): number {
  return MAX_ACTION_REASON_LENGTH - actionReasonPrefix(authorLabel, authorId).length;
}

/**
 * The reason used when the moderator did not give one.
 *
 * Quotient's wording, kept: `"Action done by <author> (ID: <id>)"`.
 */
export function defaultActionReason(authorLabel: string, authorId: string): string {
  return `Action done by ${authorLabel} (ID: ${authorId})`;
}

/**
 * Builds the audit-log reason.
 *
 * @param reason the moderator's own text, or nothing.
 * @throws InputError when the reason is longer than the remaining budget.
 */
export function formatActionReason(
  authorLabel: string,
  authorId: string,
  reason?: string | null,
): string {
  if (reason === undefined || reason === null || reason.trim() === "") {
    return defaultActionReason(authorLabel, authorId);
  }

  const prefix = actionReasonPrefix(authorLabel, authorId);
  const max = MAX_ACTION_REASON_LENGTH - prefix.length;

  if (reason.length > max) {
    throw new InputError(`Reason is too long (${reason.length}/${max})`);
  }

  return `${prefix}${reason}`;
}
