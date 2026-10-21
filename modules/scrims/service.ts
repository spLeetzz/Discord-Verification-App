/**
 * The scrims state machine.
 *
 * Quotient's scrims were seventeen view classes that each mutated
 * `self.record` and re-rendered the message. discord.js has no views, so
 * the state lives in the database and the message is re-rendered from it.
 * This module is that state machine: every transition a scrim can make
 * is a function here, and it is the only thing that writes the `scrims`
 * and `slots` tables.
 *
 * **No Discord calls live here.** The views own the messages, the
 * reactions and the channel permissions; the service owns the state.
 */

import { findTeam, TEAM_NAME_MAX_LENGTH } from "../../core/team-name.js";
import { truncate } from "../../core/text.js";
import { planBan } from "./bans.js";
import { scrimChannelCache } from "./channel-cache.js";
import * as repo from "./repo.js";
import { classifyClaim, slotNumbers } from "./slots.js";
import { nextDailySchedule, nextMatchTime } from "./schedule.js";
import { canTransitionScrim } from "./state.js";
import type { RegistrationContext } from "./requirements.js";
import type { BanMode } from "./types.js";
import type {
  BannedTeamRecord,
  ReservedSlotRecord,
  ScrimRecord,
  SlotRecord,
} from "./types.js";

/** A refusal the caller should show to a person. */
export class ScrimError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScrimError";
  }
}

/* ------------------------------------------------------------------ *
 * Opening and closing
 * ------------------------------------------------------------------ */

/** What happened when registration opened. */
export interface OpenResult {
  readonly scrim: ScrimRecord;
  /** How many slots were reserved before the scrim opened. */
  readonly reservedCount: number;
  /** How many slots are free now. */
  readonly freeSlots: number;
}

/**
 * Opens registration.
 *
 * The lifecycle is `draft | open | closed` (D26), and opening resets the
 * slots: every slot row is replaced with a fresh free one, and the
 * reserved slots become ordinary claimed slots.
 *
 * @throws ScrimError when the scrim is already open.
 */
export async function openRegistration(scrimId: string): Promise<OpenResult> {
  const scrim = await repo.getScrim(scrimId);

  if (!scrim) throw new ScrimError("This scrim no longer exists.");

  if (!canTransitionScrim(scrim.status, "open")) {
    throw new ScrimError("Registration is already open.");
  }

  const numbers = slotNumbers(scrim.startFrom, scrim.totalSlots);

  await repo.deleteSlots(scrim.id);
  await repo.createFreeSlots(scrim.id, numbers);

  const reserved = await repo.listReservedSlots(scrim.id);

  for (const reservation of reserved) {
    await repo.claimSlot(scrim.id, reservation.num, {
      teamName: reservation.teamName ?? `Team ${reservation.num}`,
      ownerUserId: reservation.userId ?? "",
      members: reservation.members.length > 0 ? reservation.members : [],
      messageId: null,
      jumpUrl: null,
    });
  }

  const now = new Date();

  const updated = await repo.updateScrim(scrim.id, {
    status: "open",
    openedAt: now,
    closedAt: null,
    slotlistMessageId: null,
  });

  if (!updated) throw new ScrimError("This scrim no longer exists.");

  await armDailyJobs(updated);
  scrimChannelCache.add(updated.registrationChannelId);

  return {
    scrim: updated,
    reservedCount: reserved.length,
    freeSlots: await repo.countFreeSlots(updated.id),
  };
}

/** What happened when registration closed. */
export interface CloseResult {
  readonly scrim: ScrimRecord;
  /** How long the registration was open, in seconds. */
  readonly elapsedSeconds: number;
  /** How many slots were filled. */
  readonly filled: number;
  /** The teams that registered, in slot order. */
  readonly registered: readonly SlotRecord[];
}

/**
 * Closes registration.
 *
 * The channel is locked and the close message is posted by the caller —
 * that is Discord work and it lives in the views.
 *
 * @throws ScrimError when the scrim is not open.
 */
export async function closeRegistration(scrimId: string): Promise<CloseResult> {
  const scrim = await repo.getScrim(scrimId);

  if (!scrim) throw new ScrimError("This scrim no longer exists.");

  if (!canTransitionScrim(scrim.status, "closed")) {
    throw new ScrimError("Registration is already closed.");
  }

  const now = new Date();
  const openedAt = scrim.openedAt ?? scrim.openTime;
  const elapsedSeconds = Math.max(
    0,
    Math.round((now.getTime() - openedAt.getTime()) / 1000),
  );

  const updated = await repo.updateScrim(scrim.id, {
    status: "closed",
    closedAt: now,
    timeElapsedSeconds: elapsedSeconds,
  });

  if (!updated) throw new ScrimError("This scrim no longer exists.");

  const registered = (await repo.listSlots(scrim.id)).filter(
    (slot) => slot.state === "claimed",
  );

  scrimChannelCache.remove(updated.registrationChannelId);

  return {
    scrim: updated,
    elapsedSeconds,
    filled: registered.length,
    registered,
  };
}

/**
 * Arms the daily jobs of a scrim.
 *
 * Both are rows in the durable `jobs` table, never a `setTimeout`. The
 * `scrim_open` job advances `open_time` by 24 hours and re-arms itself;
 * the `autoclean` job does the same for `autoclean_time`.
 */
export async function armDailyJobs(scrim: ScrimRecord): Promise<void> {
  await repo.replaceScrimJob("scrim_open", scrim.id, scrim.openTime, {
    scrimId: scrim.id,
  });

  if (scrim.autocleanTime) {
    await repo.replaceScrimJob("autoclean", scrim.id, scrim.autocleanTime, {
      scrimId: scrim.id,
    });
  }

  if (scrim.matchTime) {
    await repo.replaceScrimJob("scrim_match", scrim.id, scrim.matchTime, {
      scrimId: scrim.id,
    });
  }
}

/**
 * Re-arms the daily jobs after one of them fired.
 *
 * The advance is exactly 24 hours, and the next job is armed for the new
 * time — not "tomorrow at the same wall-clock time".
 */
export async function rearmDailyJob(
  scrim: ScrimRecord,
  kind: "open" | "autoclean",
): Promise<ScrimRecord> {
  const current = kind === "open" ? scrim.openTime : scrim.autocleanTime;

  if (!current) return scrim;

  const { nextTime } = nextDailySchedule(current);

  const updated = await repo.updateScrim(
    scrim.id,
    kind === "open" ? { openTime: nextTime } : { autocleanTime: nextTime },
  );

  if (!updated) return scrim;

  await repo.replaceScrimJob(
    kind === "open" ? "scrim_open" : "autoclean",
    scrim.id,
    nextTime,
    { scrimId: scrim.id },
  );

  return updated;
}

/** Rolls the match time forward and arms the `scrim_match` job. */
export async function armMatchTimer(
  scrim: ScrimRecord,
  now: Date,
): Promise<ScrimRecord> {
  const current = scrim.matchTime ?? now;
  const next = nextMatchTime(current, now);

  const updated = await repo.updateScrim(scrim.id, { matchTime: next });

  if (!updated) return scrim;

  await repo.replaceScrimJob("scrim_match", scrim.id, next, {
    scrimId: scrim.id,
  });

  return updated;
}

/* ------------------------------------------------------------------ *
 * Creating a scrim
 * ------------------------------------------------------------------ */

/**
 * Creates a scrim from a finished wizard.
 *
 * The scrim starts as a `draft` (D26): it exists, but registration has
 * not opened. Opening it is a separate, explicit step.
 */
export async function createScrimFromWizard(
  state: WizardState,
): Promise<string> {
  if (!state.registrationChannelId || !state.slotlistChannelId) {
    throw new ScrimError("The scrim needs a registration channel.");
  }

  if (!state.roleId) {
    throw new ScrimError("The scrim needs a success role.");
  }

  if (!state.totalSlots || state.totalSlots < 1) {
    throw new ScrimError("The scrim needs at least one slot.");
  }

  if (!state.openTime) {
    throw new ScrimError("The scrim needs an open time.");
  }

  const scrimId = await repo.createScrim({
    guildId: state.guildId,
    hostId: state.hostId,
    name: state.name,
    registrationChannelId: state.registrationChannelId,
    slotlistChannelId: state.slotlistChannelId,
    roleId: state.roleId,
    requiredMentions: state.requiredMentions,
    totalSlots: state.totalSlots,
    openTime: state.openTime,
    startFrom: state.startFrom,
    openDays: state.openDays,
    autoclean: state.autoclean,
    autocleanTime: state.autocleanTime,
    emojis: state.emojis,
    openMessage: {},
    closeMessage: {},
    slotlistFormat: {},
  });

  const scrim = await repo.getScrim(scrimId);

  if (!scrim) throw new ScrimError("The scrim could not be created.");

  await armDailyJobs(scrim);

  return scrimId;
}

/* ------------------------------------------------------------------ *
 * The registration intake
 * ------------------------------------------------------------------ */

/** The bits of a message the requirements matrix needs. */
export interface RegistrationMessageFacts {
  readonly content: string;
  readonly authorId: string;
  readonly mentions: readonly { readonly id: string; readonly isBot: boolean }[];
}

/**
 * Gathers everything the requirements matrix reads.
 *
 * The team name comes from `core/team-name.ts` — the same derivation the
 * slotlist shows, so the duplicate check compares like with like.
 */
export async function buildRegistrationContext(
  scrim: ScrimRecord,
  facts: RegistrationMessageFacts,
): Promise<RegistrationContext> {
  const teamName = truncate(
    findTeam({ content: facts.content, author: { toString: () => `<@${facts.authorId}>` } }),
    TEAM_NAME_MAX_LENGTH,
  );

  const [bannedUserIds, claimedOwnerIds, claimedTeamNames] = await Promise.all([
    repo.listBannedUserIds(scrim.id),
    repo.listClaimedOwnerIds(scrim.id),
    repo.listClaimedTeamNames(scrim.id),
  ]);

  const memberIds = [
    facts.authorId,
    ...facts.mentions.filter((mention) => !mention.isBot).map((m) => m.id),
  ];

  const fakeTagMatches = await repo.findFakeTagMatches(scrim.id, [
    ...new Set(memberIds),
  ]);

  return {
    settings: {
      requiredMentions: scrim.requiredMentions,
      requiredLines: scrim.requiredLines,
      teamnameCompulsion: scrim.teamnameCompulsion,
      multiregister: scrim.multiregister,
      noDuplicateName: scrim.noDuplicateName,
      allowDuplicateTags: scrim.allowDuplicateTags,
    },
    rawContent: facts.content,
    mentions: facts.mentions,
    authorId: facts.authorId,
    bannedUserIds: new Set(bannedUserIds),
    claimedOwnerIds: new Set(claimedOwnerIds),
    claimedTeamNames: new Set(claimedTeamNames),
    fakeTagMatches: fakeTagMatches.length,
    teamName,
  };
}

/** What a registration attempt writes. */
export interface RegistrationClaim {
  readonly teamName: string;
  readonly ownerUserId: string;
  readonly members: readonly string[];
  readonly messageId: string | null;
  readonly jumpUrl: string | null;
}

/**
 * Claims a slot for a registration.
 *
 * The claim is one conditional `UPDATE` (D14). When it matches no row,
 * somebody else got the slot first, and the next free slot is tried. The
 * database guarantees that a slot has exactly one owner — there is no
 * lock, and there never needs to be one.
 *
 * @returns the claimed slot, or `null` when every free slot was taken
 *          while we were trying.
 */
export async function claimSlotForRegistration(
  scrim: ScrimRecord,
  claim: RegistrationClaim,
): Promise<SlotRecord | null> {
  const slots = await repo.listSlots(scrim.id);

  const candidates = slots
    .filter((slot) => slot.state === "free")
    .sort((left, right) => left.num - right.num);

  for (const candidate of candidates) {
    const claimed = await repo.claimSlot(scrim.id, candidate.num, claim);

    if (claimed) return claimed;

    const after = await repo.getSlotByNum(scrim.id, candidate.num);

    if (classifyClaim(after?.state ?? null) === "unavailable") {
      // The slot is banned or locked. Skip it and try the next one.
      continue;
    }

    // Somebody else took it. Try the next free number.
  }

  return null;
}

/* ------------------------------------------------------------------ *
 * Reserved slots
 * ------------------------------------------------------------------ */

/** Reserves a slot for a team. */
export async function reserveSlot(values: {
  readonly scrimId: string;
  readonly num: number;
  readonly teamName: string;
  readonly ownerUserId: string | null;
  readonly members: readonly string[];
  readonly expires: Date | null;
}): Promise<ReservedSlotRecord> {
  const scrim = await repo.getScrim(values.scrimId);

  if (!scrim) throw new ScrimError("This scrim no longer exists.");

  const numbers = slotNumbers(scrim.startFrom, scrim.totalSlots);

  if (!numbers.includes(values.num)) {
    throw new ScrimError(
      `Slot ${values.num} is not a slot of this scrim. The slot numbers run from ${numbers[0] ?? 0} to ${numbers[numbers.length - 1] ?? 0}.`,
    );
  }

  const reserved = await repo.reserveSlot({
    scrimId: values.scrimId,
    num: values.num,
    userId: values.ownerUserId,
    teamName: values.teamName,
    members: values.members,
    expires: values.expires,
  });

  if (!reserved) throw new ScrimError("The slot could not be reserved.");

  if (reserved.expires && reserved.userId) {
    await repo.replaceScrimJob(
      "scrim_reserve",
      scrim.id,
      reserved.expires,
      {
        scrimId: scrim.id,
        num: reserved.num,
        userId: reserved.userId,
        teamName: reserved.teamName,
      },
      reserved.userId,
    );
  }

  return reserved;
}

/** Removes a reservation. */
export async function removeReservation(
  scrimId: string,
  slotId: string,
): Promise<void> {
  await repo.deleteReservedSlot(slotId);
  await repo.deleteScrimJobs("scrim_reserve", scrimId);
}

/* ------------------------------------------------------------------ *
 * Bans
 * ------------------------------------------------------------------ */

/** The outcome of a ban. */
export interface BanResult {
  /** How many (scrim, user) pairs were written. */
  readonly written: number;
  /** How many were skipped because the user was already banned. */
  readonly skipped: number;
}

/**
 * Bans a user, or a whole team, from one scrim or from every scrim.
 *
 * The four modes are the source's, and the plan is computed by
 * `bans.ts`; this function writes it.
 */
export async function banUsers(
  options: {
    readonly scrimId: string;
    readonly mode: BanMode;
    readonly leaderId: string;
    readonly memberIds: readonly string[];
    readonly teamName: string | null;
    readonly reason: string | null;
    readonly expires: Date | null;
  },
): Promise<BanResult> {
  const scrim = await repo.getScrim(options.scrimId);

  if (!scrim) throw new ScrimError("This scrim no longer exists.");

  const allScrims = await repo.listScrims(scrim.guildId);
  const allScrimIds = allScrims.map((entry) => entry.id);

  const bannedSets = new Map<string, Set<string>>();

  for (const scrimId of allScrimIds) {
    bannedSets.set(
      scrimId,
      new Set(await repo.listBannedUserIds(scrimId)),
    );
  }

  const plan = planBan({
    mode: options.mode,
    target: { leaderId: options.leaderId, memberIds: options.memberIds },
    thisScrimId: scrim.id,
    allScrimIds,
    isBanned: (scrimId, userId) =>
      bannedSets.get(scrimId)?.has(userId) ?? false,
  });

  for (const entry of plan.entries) {
    await repo.banUser({
      scrimId: entry.scrimId,
      userId: entry.userId,
      teamName: options.teamName,
      members:
        entry.userId === options.leaderId
          ? [options.leaderId, ...options.memberIds]
          : options.memberIds,
      reason: options.reason,
      expires: options.expires,
    });
  }

  if (options.expires && plan.entries.length > 0) {
    await repo.replaceScrimJob("scrim_ban", scrim.id, options.expires, {
      scrimId: scrim.id,
      scrimIds: plan.entries.map((entry) => entry.scrimId),
      userIds: plan.entries.map((entry) => entry.userId),
      reason: options.reason,
    });
  }

  return { written: plan.entries.length, skipped: plan.skipped };
}

/** Lifts a ban. */
export async function unbanUser(
  scrimId: string,
  userId: string,
): Promise<void> {
  await repo.unbanUser(scrimId, userId);
}

/** The bans of a scrim. */
export async function listBans(scrimId: string): Promise<BannedTeamRecord[]> {
  return repo.listBans(scrimId);
}

/* ------------------------------------------------------------------ *
 * Applying a change to every scrim
 * ------------------------------------------------------------------ */

/**
 * Applies one field to every scrim of a guild.
 *
 * The source asked this question **after** the panel had already
 * re-rendered, so the user saw the new value on the scrim they were
 * editing and then had to confirm a change to every other scrim. The
 * port asks first and writes second.
 */
export async function applyToAllScrims(
  guildId: string,
  values: repo.ScrimUpdate,
): Promise<number> {
  return repo.updateAllScrims(guildId, values);
}

/** How many scrims a guild has. */
export async function countScrims(guildId: string): Promise<number> {
  return repo.countScrims(guildId);
}
