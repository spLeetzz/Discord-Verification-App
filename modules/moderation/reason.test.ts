/**
 * The audit-log reason.
 *
 * The cap is on the *whole* reason, not on the moderator's text, and
 * Quotient refused the action rather than truncating it. A moderator who
 * typed a long reason and found a different one in the audit log would
 * have a very bad time explaining it.
 */

import { describe, expect, it } from "vitest";
import { InputError } from "../../core/errors.js";
import {
  MAX_ACTION_REASON_LENGTH,
  actionReasonPrefix,
  defaultActionReason,
  formatActionReason,
  maxReasonLength,
} from "./reason.js";

const AUTHOR = "Moderator";
const AUTHOR_ID = "123456789012345678";

describe("formatActionReason", () => {
  it("uses the default wording when there is no reason", () => {
    expect(formatActionReason(AUTHOR, AUTHOR_ID)).toBe(
      "Action done by Moderator (ID: 123456789012345678)",
    );
  });

  it("uses the default wording for an empty reason", () => {
    expect(formatActionReason(AUTHOR, AUTHOR_ID, "")).toBe(
      defaultActionReason(AUTHOR, AUTHOR_ID),
    );
    expect(formatActionReason(AUTHOR, AUTHOR_ID, "   ")).toBe(
      defaultActionReason(AUTHOR, AUTHOR_ID),
    );
  });

  it("puts the moderator's text after the author", () => {
    expect(formatActionReason(AUTHOR, AUTHOR_ID, "being rude")).toBe(
      "Moderator (ID: 123456789012345678): being rude",
    );
  });

  it("counts the whole reason against the cap", () => {
    const budget = maxReasonLength(AUTHOR, AUTHOR_ID);
    const reason = "x".repeat(budget);

    const built = formatActionReason(AUTHOR, AUTHOR_ID, reason);

    expect(built).toHaveLength(MAX_ACTION_REASON_LENGTH);
  });

  it("refuses a reason one character too long", () => {
    const budget = maxReasonLength(AUTHOR, AUTHOR_ID);
    const reason = "x".repeat(budget + 1);

    expect(() => formatActionReason(AUTHOR, AUTHOR_ID, reason)).toThrow(
      InputError,
    );
    expect(() => formatActionReason(AUTHOR, AUTHOR_ID, reason)).toThrow(
      `Reason is too long (${budget + 1}/${budget})`,
    );
  });

  it("gives a longer author a shorter budget", () => {
    const short = maxReasonLength("A", AUTHOR_ID);
    const long = maxReasonLength("A very long display name indeed", AUTHOR_ID);

    expect(long).toBeLessThan(short);
  });

  it("counts the prefix in the cap", () => {
    expect(actionReasonPrefix(AUTHOR, AUTHOR_ID)).toBe(
      "Moderator (ID: 123456789012345678): ",
    );
    expect(
      maxReasonLength(AUTHOR, AUTHOR_ID) +
        actionReasonPrefix(AUTHOR, AUTHOR_ID).length,
    ).toBe(MAX_ACTION_REASON_LENGTH);
  });
});
