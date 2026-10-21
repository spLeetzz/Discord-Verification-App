/**
 * The refusal hierarchy.
 *
 * A refusal is not a crash: it is an answer the caller should show to a
 * person. The base class is the `DenialError` that already exists in
 * `utils/errors.ts` — this module adds the *kinds* of refusal on top of it
 * rather than starting a parallel hierarchy, so `instanceof DenialError`
 * keeps working for everything.
 *
 * Every message is built with a template literal at construction time.
 * There is deliberately no "format later" placeholder: a refusal that
 * still holds `{ctx.bot.prime_link}` when it reaches the user is worse
 * than no message at all, and a placeholder that is filled in later is
 * exactly how that happens.
 */

import { DenialError } from "../utils/errors.js";

export { DenialError } from "../utils/errors.js";

/**
 * The kinds of refusal the guards and the domain code raise.
 *
 * A string rather than an enum, because the value is compared, logged and
 * put in front of a user — it is data, not a type.
 */
export type DenialKind =
  | "permission"
  | "role_hierarchy"
  | "premium"
  | "limit"
  | "ownership"
  | "staff"
  | "input";

/**
 * A refusal with a machine-readable kind.
 *
 * The kind lets a caller branch without a chain of `instanceof` checks —
 * useful when the refusal crosses a module boundary.
 */
export class TypedDenialError extends DenialError {
  /** The kind of refusal this is. */
  readonly kind: DenialKind;

  constructor(kind: DenialKind, message: string) {
    super(message);
    this.name = "TypedDenialError";
    this.kind = kind;
  }
}

/** The caller does not hold the permission the action needs. */
export class PermissionDeniedError extends TypedDenialError {
  constructor(message: string) {
    super("permission", message);
    this.name = "PermissionDeniedError";
  }
}

/**
 * The role is above the bot, above the caller, or carries permissions the
 * caller does not have.
 */
export class RoleHierarchyError extends TypedDenialError {
  constructor(message: string) {
    super("role_hierarchy", message);
    this.name = "RoleHierarchyError";
  }
}

/** The guild does not hold the entitlement the feature needs (D15). */
export class PremiumRequiredError extends TypedDenialError {
  /** The feature the guild is missing. */
  readonly feature: string;

  constructor(feature: string, message: string) {
    super("premium", message);
    this.name = "PremiumRequiredError";
    this.feature = feature;
  }
}

/** The guild already has as many of something as it is allowed. */
export class LimitExceededError extends TypedDenialError {
  /** How many exist. */
  readonly current: number;
  /** How many are allowed. */
  readonly limit: number;

  constructor(current: number, limit: number, message: string) {
    super("limit", message);
    this.name = "LimitExceededError";
    this.current = current;
    this.limit = limit;
  }
}

/** Only the person who started the flow may act on it. */
export class OwnershipError extends TypedDenialError {
  constructor(message: string) {
    super("ownership", message);
    this.name = "OwnershipError";
  }
}

/** The caller is not staff. */
export class NotStaffError extends TypedDenialError {
  constructor(message: string) {
    super("staff", message);
    this.name = "NotStaffError";
  }
}

/**
 * The input was not usable.
 *
 * The port of Quotient's `InputError`, which was raised by the
 * `wait_for("message")` collectors this codebase no longer has (D17).
 */
export class InputError extends TypedDenialError {
  constructor(message: string) {
    super("input", message);
    this.name = "InputError";
  }
}

/**
 * The refusal message of any error, or `null` when the error is not a
 * refusal.
 *
 * The dispatcher uses this to tell "the user cannot do that" apart from
 * "something broke", without importing every subclass.
 */
export function denialMessage(error: unknown): string | null {
  return error instanceof DenialError ? error.message : null;
}
