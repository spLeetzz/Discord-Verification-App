/**
 * The tournament lifecycle.
 *
 * D26: the lifecycle is an explicit value — `draft | open | paused |
 * closed` — not a pair of nullable timestamps. Quotient derived "open"
 * and "paused" from `started_at`/`closed_at`, and **both pause and close
 * set `closed_at`**, so the two states were indistinguishable in the
 * data: the only way to tell them apart was to read `started_at` in the
 * view and guess.
 *
 * ```
 *            ┌──────────────────────────────┐
 *            ▼                              │
 *   draft ──open──▶ open ──pause──▶ paused ─┘
 *     │                │  ▲         │
 *     │                │  └─open────┘
 *     │                └──close──▶ closed ──open──▶ open
 *     └──────────────────────────────┘
 * ```
 *
 * The rules the source had, kept:
 *
 *  - a tournament that is already full cannot be opened ("Slots are
 *    already full, Increase slots to start again.");
 *  - a tournament in `closed` can be opened again by a moderator, because
 *    the source's `toggle_registrations` started whenever `started_at`
 *    was null — and `end_process` cleared it.
 *
 * The one thing the source could not express — *paused* and *closed* being
 * different — is what this enum is for.
 */

/** The states a tournament can be in. */
export type TourneyLifecycle = "draft" | "open" | "paused" | "closed";

/** The transitions the lifecycle allows. */
const TRANSITIONS: Readonly<
  Record<TourneyLifecycle, readonly TourneyLifecycle[]>
> = {
  draft: ["open", "closed"],
  open: ["paused", "closed"],
  paused: ["open", "closed"],
  closed: ["open"],
};

/** May the tournament move from one state to another? */
export function canTransitionTourney(
  from: TourneyLifecycle,
  to: TourneyLifecycle,
): boolean {
  return TRANSITIONS[from].includes(to);
}

/** The states a tournament may move to from here. */
export function nextTourneyStates(
  from: TourneyLifecycle,
): readonly TourneyLifecycle[] {
  return TRANSITIONS[from];
}

/** Is registration currently accepting registrations? */
export function isRegistrationOpen(status: TourneyLifecycle): boolean {
  return status === "open";
}

/**
 * Is the tournament paused?
 *
 * A paused tournament keeps its slots: the registrations are suspended,
 * not ended. Only `closed` ends a tournament.
 */
export function isPaused(status: TourneyLifecycle): boolean {
  return status === "paused";
}

/**
 * Is the tournament finished?
 *
 * A finished tournament keeps its slots too — that is the point of a
 * tournament. It just does not accept new ones.
 */
export function isClosed(status: TourneyLifecycle): boolean {
  return status === "closed";
}

/**
 * May the tournament open?
 *
 * The source checked one thing before opening: that it was not already
 * full. Everything else it checked was about the *environment* — the
 * channel exists, the bot can manage permissions there, the open role
 * exists — and those are checked in the view, where the guild is
 * available.
 *
 * @param status   the tournament's current status;
 * @param slotCount how many slots are taken;
 * @param totalSlots how many slots there are.
 * @returns the reason it may not open, or `null` when it may.
 */
export function canOpenTourney(options: {
  readonly status: TourneyLifecycle;
  readonly slotCount: number;
  readonly totalSlots: number;
}): string | null {
  if (!canTransitionTourney(options.status, "open")) {
    return "This tournament is already open.";
  }

  if (options.slotCount >= options.totalSlots) {
    return "Slots are already full. Increase the number of slots to start again.";
  }

  return null;
}

/**
 * What the "start / pause" button does from here.
 *
 * The source's button was a toggle: "Start/Pause Reg". With an explicit
 * status the button can say what it is about to do, which is the whole
 * point of D26 — a moderator can no longer close a tournament by
 * pressing a button that says "pause".
 */
export function toggleTarget(
  status: TourneyLifecycle,
): "open" | "paused" {
  return status === "open" ? "paused" : "open";
}
