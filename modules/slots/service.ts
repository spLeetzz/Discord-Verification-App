/**
 * The slot-manager state machine.
 *
 * Everything the public panel and the slot-list panel do goes through
 * here. The rules are separated from the SQL (the repository) and from
 * Discord (the views), so they can be proved on their own.
 *
 * The state machine is the `slots.state` column:
 *
 * ```
 * free ──claim──▶ claimed ──cancel──▶ free
 *   │                │
 *   └──(moderator)───┴──▶ locked / banned
 * ```
 *
 * Three rules are load-bearing and are ported exactly:
 *
 *  1. **The claim is a race, and the database settles it.** The claim is
 *     one conditional `UPDATE … WHERE state = 'free'`. Zero rows updated
 *     means somebody else won. There is no lock — the source's
 *     module-global `asyncio.Lock` died with the process, so two users
 *     could own one slot (B1).
 *  2. **Cancelling removes the scrim's role only when it was the
 *     member's last slot in that scrim.** A member with two slots keeps
 *     the role until the second one goes too.
 *  3. **A reminder is one-shot.** The row is deleted when it fires, so
 *     nobody is reminded about the same scrim twice.
 */

import { IST } from "../../core/time.js";
import { normaliseTeamName } from "../../core/team-name.js";
import { parseMentionIds } from "./mentions.js";
import type {
  BanMode,
  ClaimResult,
  ReminderCandidate,
  ScrimLite,
  SlotRecord,
  SlotStore,
  TransferResult,
} from "./types.js";

/* ------------------------------------------------------------------ *
 * Time
 * ------------------------------------------------------------------ */

/**
 * The offset of a time zone at an instant, in milliseconds.
 *
 * The trick is to format the instant in the zone, read the parts back as
 * if they were UTC, and compare.
 */
function zoneOffsetMs(date: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(date);

  const read = (type: Intl.DateTimeFormatPartTypes): number =>
    Number(parts.find((part) => part.type === type)?.value ?? "0");

  const asUtc = Date.UTC(
    read("year"),
    read("month") - 1,
    read("day"),
    read("hour") % 24,
    read("minute"),
    read("second"),
  );

  return asUtc - date.getTime() + (date.getTime() % 1000);
}

/**
 * Midnight of the day an instant falls in, in a named time zone.
 *
 * The source compared against `current_time.replace(hour=0, minute=0,
 * second=0, microsecond=0)` — midnight of *today*, in the server's zone.
 * Reading the zone rather than the server's local time is D30: the day
 * boundary is where the users think it is.
 */
export function startOfDay(
  date: Date = new Date(),
  timeZone: string = IST,
): Date {
  const dayParts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);

  const read = (type: Intl.DateTimeFormatPartTypes): number =>
    Number(dayParts.find((part) => part.type === type)?.value ?? "0");

  const year = read("year");
  const month = read("month");
  const day = read("day");

  // The zone's midnight, found by correcting the naive UTC guess by the
  // zone's offset. Two passes, because the offset at the guess may differ
  // from the offset at the answer on a day the zone changes.
  let guess = Date.UTC(year, month - 1, day);

  for (let pass = 0; pass < 2; pass += 1) {
    guess = Date.UTC(year, month - 1, day) - zoneOffsetMs(new Date(guess), timeZone);
  }

  return new Date(guess);
}

/**
 * Is this scrim in the window the slot panel covers?
 *
 * The source's rule, in three parts:
 *
 *  - `opened_at IS NULL` — registration is closed. In this port the
 *    lifecycle is explicit (D26), so it is `status === "closed"`.
 *  - `closed_at > today midnight` — the scrim closed **today**. The
 *    source used this rule in all three places the panel appears (claim,
 *    cancel, reminder), so it is a deliberate same-day rule and it is
 *    ported as it is.
 *  - `match_time > now` — the match has not started yet. After the match
 *    starts, the slots are locked and nobody may claim or cancel.
 */
export function isWithinSlotWindow(
  scrim: ScrimLite,
  now: Date = new Date(),
  timeZone: string = IST,
): boolean {
  if (scrim.status !== "closed") return false;

  if (!scrim.closedAt) return false;
  if (scrim.closedAt.getTime() <= startOfDay(now, timeZone).getTime()) {
    return false;
  }

  if (!scrim.matchTime) return false;

  return scrim.matchTime.getTime() > now.getTime();
}

/* ------------------------------------------------------------------ *
 * Numbers
 * ------------------------------------------------------------------ */

/**
 * The slot numbers a scrim has.
 *
 * `startFrom` is the first number and there are `totalSlots` of them.
 *
 * The source's "Add Team" button offered `range(start_from, 30)` — a
 * hard-coded thirty that ignored `total_slots` and offered numbers the
 * scrim did not have (B4).
 */
export function slotNumbersOf(scrim: {
  readonly startFrom: number;
  readonly totalSlots: number;
}): number[] {
  const numbers: number[] = [];

  for (let offset = 0; offset < scrim.totalSlots; offset += 1) {
    numbers.push(scrim.startFrom + offset);
  }

  return numbers;
}

/** Is this a slot number the scrim actually has? */
export function isValidSlotNumber(
  scrim: { readonly startFrom: number; readonly totalSlots: number },
  num: number,
): boolean {
  if (!Number.isInteger(num)) return false;

  return (
    num >= scrim.startFrom && num < scrim.startFrom + scrim.totalSlots
  );
}

/**
 * The placeholder owner of a slot a moderator added without a leader.
 *
 * The source allowed a moderator to add a team without naming its
 * leader, and the slot then had no owner at all. The schema forbids
 * that — `CHECK (state <> 'claimed' OR owner_user_id IS NOT NULL)` — so
 * the slot needs *some* owner. A snowflake is never `"0"`, so the
 * placeholder can never be a real member, and the "Info" panel renders
 * it as "added by a moderator", exactly as the source did.
 */
export const MODERATOR_OWNER_ID = "0";

/* ------------------------------------------------------------------ *
 * The claimable scrims
 * ------------------------------------------------------------------ */

/** A scrim a member may claim a slot in. */
export interface ClaimableScrim {
  readonly scrim: ScrimLite;
  /** The lowest free slot number — the one the source's menu offered. */
  readonly lowestFreeNum: number;
  /** How many slots are free. */
  readonly freeCount: number;
}

/**
 * The scrims a member may claim a slot in right now.
 *
 * The source's `claimable_slots` property:
 *
 * ```python
 * Scrim.filter(
 *     pk__in=scrim_ids,
 *     closed_at__gt=today_midnight,
 *     available_slots__not=[],
 *     match_time__gt=now,
 *     opened_at__isnull=True,
 * ).order_by("open_time").limit(25)
 * ```
 *
 * The `available_slots__not=[]` half is the count of free slots (D14) and
 * the `opened_at__isnull=True` half is the explicit lifecycle (D26).
 */
export async function listClaimableScrims(
  store: SlotStore,
  managerId: string,
  now: Date = new Date(),
  timeZone: string = IST,
): Promise<ClaimableScrim[]> {
  const scrims = await store.listScrimsForManager(managerId);

  const claimable: ClaimableScrim[] = [];

  for (const scrim of scrims) {
    if (!isWithinSlotWindow(scrim, now, timeZone)) continue;

    const slots = await store.listSlots(scrim.id);

    const free = slots
      .filter((slot) => slot.state === "free")
      .map((slot) => slot.num)
      .sort((left, right) => left - right);

    const lowest = free[0];

    if (lowest === undefined) continue;

    claimable.push({
      scrim,
      lowestFreeNum: lowest,
      freeCount: free.length,
    });
  }

  return claimable;
}

/* ------------------------------------------------------------------ *
 * The claim
 * ------------------------------------------------------------------ */

/**
 * The team name a claim writes.
 *
 * The source normalised the typed name with
 * `"Team " + re.sub(r"team|name|[^\w\s]", "", name.lower()).strip().title()`.
 * `core/team-name.ts` is the same rule, already unit-tested (D27).
 *
 * @returns the name, or an empty string when the input holds nothing
 *          usable.
 */
export function claimTeamName(raw: string): string {
  return normaliseTeamName(raw);
}

/**
 * The member list a claim writes.
 *
 * **This is the fix for B3.** The source wrote `members=[user_id]` only,
 * so the ID-Pass transfer could never find a teammate and the feature
 * had never worked. The claim modal collects the teammate mentions, like
 * the registration flow does, and they are persisted here.
 *
 * The claimer is always the first member, and nobody appears twice.
 */
export function claimMembers(
  claimerId: string,
  mentionText: string,
): string[] {
  const members = [claimerId];

  for (const id of parseMentionIds(mentionText)) {
    if (id === claimerId) continue;
    if (members.includes(id)) continue;

    members.push(id);
  }

  return members;
}

/** What a claim attempt needs to know. */
export interface ClaimParams {
  readonly scrimId: string;
  /** The slot number the member picked. */
  readonly num: number;
  readonly userId: string;
  /** The team name the member typed. */
  readonly teamNameInput: string;
  /** The teammate mentions the member typed. */
  readonly mentionText: string;
  /** May one member hold more than one slot in a scrim? */
  readonly multipleSlots: boolean;
  readonly now?: Date;
}

/**
 * Claims a slot.
 *
 * The order matters:
 *
 *  1. the scrim has to exist;
 *  2. the member must not be banned from it;
 *  3. the member must not already hold a slot (unless multi-claim is
 *     on);
 *  4. the team name has to be usable;
 *  5. **then** the conditional `UPDATE` — the race is settled by the
 *     database, not by a read-then-write.
 */
export async function claimSlot(
  store: SlotStore,
  params: ClaimParams,
): Promise<ClaimResult> {
  const scrim = await store.getScrim(params.scrimId);

  if (!scrim) return { ok: false, reason: "scrim_gone" };

  if (await store.isBanned(params.scrimId, params.userId)) {
    return { ok: false, reason: "banned" };
  }

  if (!params.multipleSlots) {
    const held = await store.listUserSlots([params.scrimId], params.userId);

    if (held.length > 0) return { ok: false, reason: "already_holds" };
  }

  const teamName = claimTeamName(params.teamNameInput);

  if (!teamName) return { ok: false, reason: "invalid_team_name" };

  const members = claimMembers(params.userId, params.mentionText);

  const slot = await store.claimSlot(params.scrimId, params.num, {
    teamName,
    ownerUserId: params.userId,
    members,
  });

  // Zero rows updated: somebody else took the slot first. The database
  // decided, and there is no lock to get wrong.
  if (!slot) return { ok: false, reason: "taken" };

  return { ok: true, slot };
}

/* ------------------------------------------------------------------ *
 * The cancel
 * ------------------------------------------------------------------ */

/** What a cancel attempt needs to know. */
export interface CancelParams {
  readonly slotId: string;
  readonly userId: string;
}

/**
 * Cancels a slot.
 *
 * The role rule is the load-bearing part: the scrim's role is only
 * removed when this was the member's **last** slot in that scrim. The
 * answer is read *before* the release, excluding the slot being
 * cancelled, because that slot is still claimed at that moment.
 */
export async function cancelSlot(
  store: SlotStore,
  params: CancelParams,
): Promise<
  | {
      readonly ok: true;
      readonly slot: SlotRecord;
      /** Should the scrim's role be taken away? */
      readonly roleRemoved: boolean;
    }
  | { readonly ok: false; readonly reason: "not_found" | "not_owner" }
> {
  const slot = await store.getSlot(params.slotId);

  if (!slot) return { ok: false, reason: "not_found" };

  if (slot.ownerUserId !== params.userId) {
    return { ok: false, reason: "not_owner" };
  }

  const others = await store.countUserSlotsInScrim(
    slot.scrimId,
    params.userId,
    slot.id,
  );

  const released = await store.releaseSlot(slot.id, params.userId);

  // The slot vanished or changed hands between the read and the write.
  if (!released) return { ok: false, reason: "not_owner" };

  return { ok: true, slot: released, roleRemoved: others === 0 };
}

/* ------------------------------------------------------------------ *
 * The reminders
 * ------------------------------------------------------------------ */

/**
 * The scrims a member may not set a reminder for.
 *
 * The source built this by **mutating the list it was iterating**:
 *
 * ```python
 * for scrim in await self.banned_from(user_id):
 *     for _ in scrims:
 *         if _.id == scrim["scrim_id"]:
 *             scrims.remove(_)
 * ```
 *
 * Removing an element from a list while a loop walks it skips the next
 * one, so **every second match survived the filter** (B2). A member
 * banned from three scrims was still offered two of them.
 *
 * Here the excluded ids are collected into a `Set` and the candidates are
 * filtered against it. Every match is excluded, and none is skipped.
 */
export function filterReminderCandidates(
  candidates: readonly ReminderCandidate[],
  excluded: {
    /** The scrims the member is banned from. */
    readonly bannedScrimIds: readonly string[];
    /** The scrims the member already has a reminder for. */
    readonly remindedScrimIds: readonly string[];
    /** The scrims the member already holds a slot in. */
    readonly ownSlotScrimIds: readonly string[];
  },
): ReminderCandidate[] {
  const banned = new Set(excluded.bannedScrimIds);
  const reminded = new Set(excluded.remindedScrimIds);
  const own = new Set(excluded.ownSlotScrimIds);

  return candidates.filter(
    (candidate) =>
      !banned.has(candidate.scrimId) &&
      !reminded.has(candidate.scrimId) &&
      !own.has(candidate.scrimId),
  );
}

/** What the reminder collector needs to know. */
export interface ReminderQuery {
  readonly managerId: string;
  readonly userId: string;
  /** May one member hold more than one slot in a scrim? */
  readonly multipleSlots: boolean;
  readonly now?: Date;
  readonly timeZone?: string;
}

/**
 * The scrims a member may set a reminder for.
 *
 * A reminder means "tell me when a slot frees up", so it only makes
 * sense for a scrim that is **full** — the source filtered on
 * `not scrim.available_slots`, which in this port is "no free slot".
 */
export async function collectReminderCandidates(
  store: SlotStore,
  query: ReminderQuery,
): Promise<ReminderCandidate[]> {
  const now = query.now ?? new Date();
  const scrims = await store.listScrimsForManager(query.managerId);

  const inWindow = scrims.filter((scrim) =>
    isWithinSlotWindow(scrim, now, query.timeZone),
  );

  const candidates: ReminderCandidate[] = [];

  for (const scrim of inWindow) {
    const free = await store.countFreeSlots(scrim.id);

    // A scrim with a free slot needs no reminder: a member can take it
    // right now.
    if (free > 0) continue;

    candidates.push({
      scrimId: scrim.id,
      scrimName: scrim.name,
      registrationChannelId: scrim.registrationChannelId,
    });
  }

  const bannedScrimIds: string[] = [];
  const remindedScrimIds = await store.listReminderScrimIds(query.userId);

  for (const candidate of candidates) {
    if (await store.isBanned(candidate.scrimId, query.userId)) {
      bannedScrimIds.push(candidate.scrimId);
    }
  }

  let ownSlotScrimIds: string[] = [];

  if (!query.multipleSlots) {
    const scrimIds = candidates.map((candidate) => candidate.scrimId);
    const held = await store.listUserSlots(scrimIds, query.userId);

    ownSlotScrimIds = [...new Set(held.map((slot) => slot.scrimId))];
  }

  return filterReminderCandidates(candidates, {
    bannedScrimIds,
    remindedScrimIds,
    ownSlotScrimIds,
  });
}

/**
 * Sets a reminder for a set of scrims.
 *
 * The row is keyed by `(scrim_id, user_id)`, so setting a reminder twice
 * does not stack two rows, and a reminder for one scrim does not
 * unsubscribe the member from another.
 */
export async function createReminders(
  store: SlotStore,
  scrimIds: readonly string[],
  userId: string,
): Promise<void> {
  for (const scrimId of scrimIds) {
    await store.addReminder(scrimId, userId);
  }
}

/* ------------------------------------------------------------------ *
 * The ID-Pass transfer
 * ------------------------------------------------------------------ */

/** The result of looking for a teammate to transfer to. */
export type IdpCandidates =
  | {
      readonly ok: true;
      readonly slot: SlotRecord;
      /** The teammates that were mentioned when the slot was claimed. */
      readonly teammates: readonly string[];
    }
  | {
      readonly ok: false;
      readonly reason: "no_slot" | "not_owner" | "no_teammate";
    };

/**
 * The teammates a slot may be transferred to.
 *
 * The captain leaves the team when the slot is transferred, so the
 * remaining members are the candidates.
 *
 * The source removed the captain from `slot.members` **in memory only** and
 * never wrote it back, so the database kept listing the old captain
 * (B9). Here the list is returned and the transfer writes it back.
 */
export async function idpCandidates(
  store: SlotStore,
  params: { readonly slotId: string; readonly userId: string },
): Promise<IdpCandidates> {
  const slot = await store.getSlot(params.slotId);

  if (!slot) return { ok: false, reason: "no_slot" };

  if (slot.ownerUserId !== params.userId) {
    return { ok: false, reason: "not_owner" };
  }

  const teammates = slot.members.filter((id) => id !== params.userId);

  if (teammates.length === 0) return { ok: false, reason: "no_teammate" };

  return { ok: true, slot, teammates };
}

/**
 * Transfers a slot to a teammate.
 *
 * The ownership moves and the member list is written back (B9).
 */
export async function applyIdpTransfer(
  store: SlotStore,
  params: {
    readonly slotId: string;
    readonly newOwnerId: string;
    readonly previousOwnerId: string;
  },
): Promise<TransferResult> {
  const slot = await store.getSlot(params.slotId);

  if (!slot) return { ok: false, reason: "no_slot" };

  if (slot.ownerUserId !== params.previousOwnerId) {
    return { ok: false, reason: "not_owner" };
  }

  const members = slot.members.filter((id) => id !== params.previousOwnerId);

  const updated = await store.transferSlot(
    slot.id,
    params.newOwnerId,
    members,
  );

  if (!updated) return { ok: false, reason: "no_slot" };

  return { ok: true, slot: updated, newOwnerId: params.newOwnerId };
}

/* ------------------------------------------------------------------ *
 * The ban matrix
 * ------------------------------------------------------------------ */

/** What a ban is planned against. */
export interface BanPlanInput {
  readonly mode: BanMode;
  /** The scrim the punished slot belongs to. */
  readonly thisScrimId: string;
  /** Every scrim of the server. */
  readonly allScrimIds: readonly string[];
  /** The captain of the slot. */
  readonly leaderId: string | null;
  /** The whole team of the slot. */
  readonly memberIds: readonly string[];
}

/** The bans a punish creates. */
export interface BanPlan {
  /** The scrims the members are banned from. */
  readonly scrimIds: readonly string[];
  /** The members who are banned. */
  readonly userIds: readonly string[];
}

/**
 * Works out who is banned from where.
 *
 * The four modes are real behaviour and all four are kept:
 *
 *  1. the team leader, from this scrim;
 *  2. the whole team, from this scrim;
 *  3. the team leader, from every scrim;
 *  4. the whole team, from every scrim.
 */
export function planBan(input: BanPlanInput): BanPlan {
  const scrimIds =
    input.mode === 3 || input.mode === 4
      ? [...input.allScrimIds]
      : [input.thisScrimId];

  const team =
    input.mode === 2 || input.mode === 4
      ? [...new Set([...(input.leaderId ? [input.leaderId] : []), ...input.memberIds])]
      : input.leaderId
        ? [input.leaderId]
        : [...input.memberIds];

  return {
    scrimIds,
    userIds: [...new Set(team)],
  };
}

/* ------------------------------------------------------------------ *
 * The slot list's team operations
 * ------------------------------------------------------------------ */

/** What a moderator's "add team" needs to know. */
export interface AddTeamParams {
  readonly scrimId: string;
  readonly num: number;
  /** The team name the moderator typed. */
  readonly teamNameInput: string;
  /** The id of the member who leads the team, when one was mentioned. */
  readonly leaderId: string | null;
  readonly now?: Date;
}

/**
 * Adds a team to a slot, as a moderator.
 *
 * The slot must be free, and the **same conditional `UPDATE`** decides
 * that — a moderator adding a team and a member claiming one are the
 * same operation.
 */
export async function addTeam(
  store: SlotStore,
  params: AddTeamParams,
): Promise<
  | { readonly ok: true; readonly slot: SlotRecord }
  | { readonly ok: false; readonly reason: "taken" | "invalid_team_name" }
> {
  const teamName = claimTeamName(params.teamNameInput);

  if (!teamName) return { ok: false, reason: "invalid_team_name" };

  const members = params.leaderId ? [params.leaderId] : [];

  const slot = await store.claimSlot(params.scrimId, params.num, {
    teamName,
    ownerUserId: params.leaderId ?? MODERATOR_OWNER_ID,
    members,
  });

  if (!slot) return { ok: false, reason: "taken" };

  return { ok: true, slot };
}

/** What a moderator's "remove team" needs to know. */
export interface RemoveTeamParams {
  readonly slotId: string;
}

/**
 * Removes a team from a slot, as a moderator.
 *
 * The slot goes back to the pool and the owner's role is removed when
 * they hold no other slot in that scrim — the same rule the public
 * cancel uses.
 */
export async function removeTeam(
  store: SlotStore,
  params: RemoveTeamParams,
): Promise<
  | {
      readonly ok: true;
      readonly slot: SlotRecord;
      readonly roleRemoved: boolean;
      readonly ownerId: string | null;
    }
  | { readonly ok: false; readonly reason: "not_found" | "not_claimed" }
> {
  const slot = await store.getSlot(params.slotId);

  if (!slot) return { ok: false, reason: "not_found" };
  if (slot.state !== "claimed") return { ok: false, reason: "not_claimed" };

  const ownerId = slot.ownerUserId;

  const others = ownerId
    ? await store.countUserSlotsInScrim(slot.scrimId, ownerId, slot.id)
    : 1;

  const released = await store.releaseSlot(slot.id, ownerId ?? MODERATOR_OWNER_ID);

  if (!released) return { ok: false, reason: "not_found" };

  return {
    ok: true,
    slot: released,
    roleRemoved: ownerId !== null && others === 0,
    ownerId,
  };
}

/** What a moderator's "change team" needs to know. */
export interface ChangeTeamParams {
  readonly slotId: string;
  readonly teamNameInput: string;
  readonly leaderId: string | null;
}

/**
 * Changes the team of a slot, as a moderator.
 *
 * The source set the team name and the leader but never removed the old
 * leader's role, so a moderator could hand a slot to somebody else and
 * leave the previous captain with the ID/Pass role. The old leader's
 * role is removed when they hold no other slot in that scrim.
 */
export async function changeTeam(
  store: SlotStore,
  params: ChangeTeamParams,
): Promise<
  | {
      readonly ok: true;
      readonly slot: SlotRecord;
      readonly previousOwnerId: string | null;
      readonly roleRemoved: boolean;
    }
  | { readonly ok: false; readonly reason: "not_found" | "invalid_team_name" }
> {
  const slot = await store.getSlot(params.slotId);

  if (!slot) return { ok: false, reason: "not_found" };

  const teamName = claimTeamName(params.teamNameInput);

  if (!teamName) return { ok: false, reason: "invalid_team_name" };

  const previousOwnerId = slot.ownerUserId;

  const others =
    previousOwnerId && previousOwnerId !== params.leaderId
      ? await store.countUserSlotsInScrim(
          slot.scrimId,
          previousOwnerId,
          slot.id,
        )
      : 0;

  const members = params.leaderId ? [params.leaderId] : [];

  const updated = await store.transferSlot(
    slot.id,
    params.leaderId ?? MODERATOR_OWNER_ID,
    members,
  );

  if (!updated) return { ok: false, reason: "not_found" };

  return {
    ok: true,
    slot: updated,
    previousOwnerId,
    roleRemoved:
      previousOwnerId !== null &&
      previousOwnerId !== params.leaderId &&
      others === 0,
  };
}
