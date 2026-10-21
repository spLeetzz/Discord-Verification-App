/**
 * The scrim lifecycle.
 *
 * D26: the lifecycle is an explicit value — `draft | open | closed` — not
 * a pair of nullable timestamps. Quotient derived "open" and "closed"
 * from `opened_at`/`closed_at`, which could not tell a pause from a close
 * and made "is it open?" a question with three answers.
 *
 * ```
 *   draft ──open──▶ open ──close──▶ closed
 *     ▲                              │
 *     └─────────────open─────────────┘
 * ```
 *
 * A scrim is created as a `draft` (the wizard has not finished yet), and
 * registration opens it. Closing locks the channel and posts the close
 * message. Re-opening resets the slots.
 */

/** The states a scrim can be in. */
export type ScrimLifecycle = "draft" | "open" | "closed";

/** The transitions the lifecycle allows. */
const TRANSITIONS: Readonly<Record<ScrimLifecycle, readonly ScrimLifecycle[]>> = {
  draft: ["open", "closed"],
  open: ["closed"],
  closed: ["open"],
};

/** May the scrim move from one state to another? */
export function canTransitionScrim(
  from: ScrimLifecycle,
  to: ScrimLifecycle,
): boolean {
  return TRANSITIONS[from].includes(to);
}

/** The states a scrim may move to from here. */
export function nextScrimStates(from: ScrimLifecycle): readonly ScrimLifecycle[] {
  return TRANSITIONS[from];
}

/** Is registration currently accepting registrations? */
export function isRegistrationOpen(status: ScrimLifecycle): boolean {
  return status === "open";
}

/**
 * Is the scrim enabled?
 *
 * A disabled scrim is not opened by the daily job and does not open when
 * a moderator presses Start. It is a *separate* switch from the
 * lifecycle: the source called it `stoggle` (S4 renamed it `enabled`).
 */
export function shouldAutoOpen(options: {
  readonly enabled: boolean;
  readonly status: ScrimLifecycle;
  /** The weekday the daily job is checking, in the server's zone. */
  readonly today: string;
  /** The weekdays the scrim opens on. */
  readonly openDays: readonly string[];
}): boolean {
  if (!options.enabled) return false;
  if (options.status === "open") return false;

  return options.openDays.includes(options.today);
}
