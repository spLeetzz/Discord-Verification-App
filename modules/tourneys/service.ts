/**
 * The tournaments state machine.
 *
 * Quotient's tournaments were eleven view classes that each mutated
 * `self.record` and re-rendered the message. discord.js has no views, so
 * the state lives in the database and the message is re-rendered from it.
 * This module is that state machine: every transition a tournament can
 * make is a function here, and it is the only thing that writes the
 * `tourneys` and `tourney_slots` tables.
 *
 * **No Discord calls live here.** The views own the messages, the
 * reactions and the channel permissions; the service owns the state.
 */

import { findTeam, TEAM_NAME_MAX_LENGTH } from "../../core/team-name.js";
import { truncate } from "../../core/text.js";
import { dayName } from "../../core/time.js";
import { logger } from "../../utils/logger.js";
import {
  mediaPartnerChannelCache,
  tourneyChannelCache,
} from "./channel-cache.js";
import { groupSlots } from "./groups.js";
import type { Group } from "./groups.js";
import * as repo from "./repo.js";
import { nextOpenInstant, opensOnDay } from "./schedule.js";
import { canOpenTourney, canTransitionTourney } from "./state.js";
import type { RegistrationContext } from "./requirements.js";
import type {
  TourneyRecord,
  TourneySchedule,
  TourneySlotRecord,
  WizardDraft,
} from "./types.js";

/** A refusal the caller should show to a person. */
export class TourneyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TourneyError";
  }
}

/* ------------------------------------------------------------------ *
 * Opening, pausing and closing
 * ------------------------------------------------------------------ */

/** What happened when a tournament opened. */
export interface OpenResult {
  readonly tourney: TourneyRecord;
  /** How many slots were already taken. */
  readonly slotCount: number;
}

/**
 * Opens registration.
 *
 * The lifecycle is `draft | open | paused | closed` (D26).
 *
 * @throws TourneyError when the tournament may not open.
 */
export async function openTourney(tourneyId: string): Promise<OpenResult> {
  const tourney = await repo.getTourney(tourneyId);

  if (!tourney) throw new TourneyError("This tournament no longer exists.");

  const slotCount = await repo.countSlots(tourney.id);

  const refusal = canOpenTourney({
    status: tourney.status,
    slotCount,
    totalSlots: tourney.totalSlots,
  });

  if (refusal) throw new TourneyError(refusal);

  const now = new Date();

  const updated = await repo.updateTourney(tourney.id, {
    status: "open",
    startedAt: now,
    closedAt: null,
  });

  if (!updated) throw new TourneyError("This tournament no longer exists.");

  tourneyChannelCache.add(updated.registrationChannelId);

  return { tourney: updated, slotCount };
}

/**
 * Pauses registration.
 *
 * **Pausing is not closing.** The source set `closed_at` for both, so
 * the two were indistinguishable in the data (D26). A paused tournament
 * keeps its slots and can be resumed.
 *
 * @throws TourneyError when the tournament is not open.
 */
export async function pauseTourney(tourneyId: string): Promise<TourneyRecord> {
  const tourney = await repo.getTourney(tourneyId);

  if (!tourney) throw new TourneyError("This tournament no longer exists.");

  if (!canTransitionTourney(tourney.status, "paused")) {
    throw new TourneyError("This tournament is not open.");
  }

  const updated = await repo.updateTourney(tourney.id, {
    status: "paused",
    startedAt: null,
  });

  if (!updated) throw new TourneyError("This tournament no longer exists.");

  tourneyChannelCache.remove(updated.registrationChannelId);

  return updated;
}

/**
 * Closes the tournament.
 *
 * The tournament keeps its slots — that is the point of a tournament. It
 * just stops accepting registrations.
 *
 * @throws TourneyError when the tournament is already closed.
 */
export async function closeTourney(tourneyId: string): Promise<TourneyRecord> {
  const tourney = await repo.getTourney(tourneyId);

  if (!tourney) throw new TourneyError("This tournament no longer exists.");

  if (!canTransitionTourney(tourney.status, "closed")) {
    throw new TourneyError("This tournament is already closed.");
  }

  const now = new Date();

  const updated = await repo.updateTourney(tourney.id, {
    status: "closed",
    startedAt: null,
    closedAt: now,
  });

  if (!updated) throw new TourneyError("This tournament no longer exists.");

  tourneyChannelCache.remove(updated.registrationChannelId);

  // A closed tournament is finished; its schedule is not armed any more.
  await repo.deleteTourneyJobs(repo.TOURNEY_JOB_EVENT, updated.id);

  return updated;
}

/**
 * Moves a tournament to a status, if the lifecycle allows it.
 *
 * @throws TourneyError when the transition is not allowed.
 */
export async function setTourneyStatus(
  tourneyId: string,
  status: TourneyRecord["status"],
): Promise<TourneyRecord> {
  switch (status) {
    case "open":
      return (await openTourney(tourneyId)).tourney;
    case "paused":
      return pauseTourney(tourneyId);
    case "closed":
      return closeTourney(tourneyId);
    case "draft": {
      const tourney = await repo.getTourney(tourneyId);

      if (!tourney) throw new TourneyError("This tournament no longer exists.");

      if (!canTransitionTourney(tourney.status, "draft")) {
        throw new TourneyError("This tournament cannot go back to a draft.");
      }

      const updated = await repo.updateTourney(tourneyId, {
        status: "draft",
        startedAt: null,
      });

      if (!updated) {
        throw new TourneyError("This tournament no longer exists.");
      }

      return updated;
    }
  }
}

/* ------------------------------------------------------------------ *
 * Creating a tournament
 * ------------------------------------------------------------------ */

/** The default wizard draft for a guild. */
export function newDraft(guildId: string, hostId: string): WizardDraft {
  return {
    guildId,
    hostId,
    name: "Tournament",
    registrationChannelId: null,
    confirmChannelId: null,
    roleId: null,
    requiredMentions: 4,
    totalSlots: null,
    groupSize: null,
    emojis: { tick: "✅", cross: "❌" },
    openDays: [],
    openTime: "18:00",
  };
}

/** The state the setup wizard collects. */
export type { WizardDraft };

/**
 * Creates a tournament from a finished wizard.
 *
 * The tournament starts as a `draft` (D26): it exists, but registration
 * has not opened. Opening it is a separate, explicit step.
 */
export async function createTourneyFromWizard(
  state: WizardDraft,
): Promise<string> {
  if (!state.registrationChannelId) {
    throw new TourneyError("The tournament needs a registration channel.");
  }

  if (!state.confirmChannelId) {
    throw new TourneyError("The tournament needs a confirm channel.");
  }

  if (!state.roleId) {
    throw new TourneyError("The tournament needs a success role.");
  }

  if (!state.totalSlots || state.totalSlots < 1) {
    throw new TourneyError("The tournament needs at least one slot.");
  }

  if (await repo.isRegistrationChannelTaken(state.registrationChannelId)) {
    throw new TourneyError(
      "Another tournament is already running in that registration channel.",
    );
  }

  const id = await repo.createTourney({
    guildId: state.guildId,
    hostId: state.hostId,
    name: state.name,
    registrationChannelId: state.registrationChannelId,
    confirmChannelId: state.confirmChannelId,
    roleId: state.roleId,
    requiredMentions: state.requiredMentions,
    totalSlots: state.totalSlots,
    groupSize: state.groupSize,
    emojis: state.emojis,
  });

  const tourney = await repo.getTourney(id);

  if (!tourney) throw new TourneyError("The tournament could not be created.");

  tourneyChannelCache.add(tourney.registrationChannelId);

  return tourney.id;
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
 * group list shows, so the duplicate check compares like with like.
 */
export async function buildRegistrationContext(
  tourney: TourneyRecord,
  facts: RegistrationMessageFacts,
): Promise<RegistrationContext> {
  const teamName = truncate(
    findTeam({
      content: facts.content,
      author: { toString: () => `<@${facts.authorId}>` },
    }),
    TEAM_NAME_MAX_LENGTH,
  );

  const [bannedUserIds, claimedOwnerIds, claimedTeamNames] = await Promise.all([
    repo.listBannedUserIds(tourney.id),
    repo.listLeaderIds(tourney.id),
    repo.listTeamNames(tourney.id),
  ]);

  const memberIds = [
    facts.authorId,
    ...facts.mentions.filter((mention) => !mention.isBot).map((m) => m.id),
  ];

  const fakeTagMatches = await repo.findFakeTagMatches(
    tourney.id,
    [...new Set(memberIds)],
  );

  return {
    settings: {
      requiredMentions: tourney.requiredMentions,
      requiredLines: tourney.requiredLines,
      teamnameCompulsion: tourney.teamnameCompulsion,
      multiregister: tourney.multiregister,
      noDuplicateName: tourney.noDuplicateName,
      allowDuplicateTags: tourney.allowDuplicateTags,
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
  readonly leaderId: string;
  readonly members: readonly string[];
  readonly messageId: string | null;
  readonly jumpUrl: string | null;
}

/**
 * Registers a team.
 *
 * The slot number comes from the **per-tourney sequence** (D25), so two
 * registrations can never be handed the same number — the source's
 * `max(num) + 1` under a process-global lock could.
 *
 * @returns the slot, or `null` when the tournament is full.
 */
export async function registerTeam(
  tourney: TourneyRecord,
  claim: RegistrationClaim,
): Promise<TourneySlotRecord | null> {
  const slotCount = await repo.countSlots(tourney.id);

  if (slotCount >= tourney.totalSlots) return null;

  return repo.insertSlot({
    tourneyId: tourney.id,
    teamName: claim.teamName,
    leaderId: claim.leaderId,
    members: claim.members,
    messageId: claim.messageId,
    jumpUrl: claim.jumpUrl,
    confirmJumpUrl: null,
  });
}

/**
 * Removes a slot.
 *
 * @returns the slot that was removed, or `null` when it had already
 *          gone.
 */
export async function removeSlot(
  tourneyId: string,
  slotId: string,
): Promise<TourneySlotRecord | null> {
  const slot = await repo.getSlot(slotId);

  if (!slot) return null;
  if (slot.tourneyId !== tourneyId) return null;

  await repo.deleteSlot(slot.id);

  return slot;
}

/**
 * Does the user still hold a slot in the tournament?
 *
 * The rule the source had, twice: *"only remove the role if this was
 * their last slot"*.
 */
export async function hasOtherSlot(
  tourneyId: string,
  userId: string,
  exceptSlotId?: string,
): Promise<boolean> {
  const slots = await repo.listSlotsOfUser(tourneyId, userId);

  return slots.some((slot) => slot.id !== exceptSlotId);
}

/**
 * Swaps the numbers of two slots.
 *
 * One transaction (D25) — see {@link repo.swapSlotNumbers}.
 */
export async function swapGroups(
  tourneyId: string,
  firstSlotId: string,
  secondSlotId: string,
): Promise<boolean> {
  return repo.swapSlotNumbers(tourneyId, firstSlotId, secondSlotId);
}

/* ------------------------------------------------------------------ *
 * Groups
 * ------------------------------------------------------------------ */

/**
 * The groups of a tournament.
 *
 * A flat chunk of the ordered slot list by `group_size` — see
 * `groups.ts`. There is no standings and no progression.
 */
export async function listGroups(
  tourneyId: string,
): Promise<Group<TourneySlotRecord>[]> {
  const tourney = await repo.getTourney(tourneyId);

  if (!tourney) return [];
  if (!tourney.groupSize) return [];

  const slots = await repo.listSlots(tourneyId);

  return groupSlots(slots, tourney.groupSize);
}

/* ------------------------------------------------------------------ *
 * The open schedule
 * ------------------------------------------------------------------ */

/**
 * The open schedule of a tournament.
 *
 * The schedule lives in the payload of the `tourney_open` job row, and
 * the job row is the only copy of it — so this reads `null` in the one
 * moment there is no row: while the job is firing, because the
 * dispatcher deletes the row before it dispatches it. The handler reads
 * the schedule out of the payload it was handed instead; this is for
 * the views, which ask "what is this tournament's schedule?" while the
 * bot is up.
 */
export async function getSchedule(
  tourneyId: string,
): Promise<TourneySchedule | null> {
  const jobs = await repo.listTourneyJobs(repo.TOURNEY_JOB_EVENT, tourneyId);

  const job = jobs[0];

  if (!job) return null;

  return repo.scheduleOf(job.payload);
}

/**
 * Arms the daily open job of a tournament.
 *
 * The job is a row in the durable `jobs` table, never a `setTimeout`: a
 * timer that dies with the process means the tournament never opens
 * again.
 *
 * **The next open is the next occurrence of the schedule**, not "now plus
 * 24 hours" and not "now plus the length of the last outage". The
 * schedule is the weekdays and the wall-clock time, and the instant is
 * computed from those — so a tournament that opens at 6pm opens at 6pm,
 * whatever time the job happened to fire at.
 *
 * @param tourneyId the tournament;
 * @param schedule  the weekdays and the time of day;
 * @param now       the reference instant.
 * @returns the instant the job is armed for, or `null` when the
 *          schedule is unusable or the row could not be written.
 */
export async function armOpenJob(
  tourneyId: string,
  schedule: TourneySchedule,
  now: Date = new Date(),
): Promise<Date | null> {
  const next = nextOpenInstant(schedule, now);

  if (!next) return null;

  try {
    await repo.replaceTourneyJob(
      repo.TOURNEY_JOB_EVENT,
      tourneyId,
      next,
      {
        tourneyId,
        openDays: [...schedule.openDays],
        openTime: schedule.openTime,
      },
    );
  } catch (error) {
    logger.error(
      `[Tourneys] Could not arm the "${repo.TOURNEY_JOB_EVENT}" job for the tournament ${tourneyId}: ${
        error instanceof Error ? error.message : String(error)
      }.`,
    );

    return null;
  }

  return next;
}

/**
 * May the daily job open the tournament today?
 *
 * A closed tournament is finished: the job does not reopen it.
 */
export function shouldAutoOpen(options: {
  readonly status: TourneyRecord["status"];
  readonly schedule: TourneySchedule | null;
  readonly now: Date;
}): boolean {
  if (options.status === "closed") return false;
  if (options.status === "open") return false;
  if (!options.schedule) return false;

  return opensOnDay(options.schedule, dayName(options.now));
}

/* ------------------------------------------------------------------ *
 * Media partners
 * ------------------------------------------------------------------ */

/** Records a media partner and puts its channel in the cache. */
export async function addMediaPartner(
  tourneyId: string,
  channelId: string,
): Promise<void> {
  const partner = await repo.createMediaPartner(tourneyId, channelId);

  if (!partner) {
    throw new TourneyError("That channel is already a media partner channel.");
  }

  mediaPartnerChannelCache.add(channelId);
}

/** Removes a media partner. */
export async function removeMediaPartner(
  tourneyId: string,
  channelId: string,
): Promise<void> {
  await repo.deleteMediaPartner(tourneyId, channelId);

  mediaPartnerChannelCache.remove(channelId);
}

/** How many media partners a guild has. */
export async function countMediaPartners(guildId: string): Promise<number> {
  return repo.countMediaPartners(guildId);
}
