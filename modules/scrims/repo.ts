/**
 * All the SQL for the scrims area.
 *
 * The rule that matters: **no SQL outside this file.** The service layer
 * talks to these functions; the views talk to the service.
 *
 * The schema is in `db/schema/esports.ts` and it is already migrated and
 * verified, so the column names here are the real ones — `slots.state`,
 * `scrims.status`, `scrims.start_from`, `scrims.total_slots` and so on.
 *
 * The one statement that matters most is {@link claimSlot}: the
 * conditional `UPDATE` from S7. It is the whole reason D14 exists.
 */

import { and, asc, count, eq, inArray, sql } from "drizzle-orm";
import { db } from "../../db/client.js";
import {
  banLogs,
  bannedTeams,
  jobs,
  reservedSlots,
  scrims,
  slots,
} from "../../db/schema.js";
import type {
  AutocleanKind,
  JobEvent,
  ScrimStatus,
  SlotState,
  Weekday,
} from "../../db/schema/common.js";
import { parseTemplate } from "./template.js";
import type { EmbedTemplate } from "./template.js";
import type {
  BannedTeamRecord,
  ReservedSlotRecord,
  ScrimCountdown,
  ScrimEmojis,
  ScrimRecord,
  SlotRecord,
} from "./types.js";

/* ------------------------------------------------------------------ *
 * Row mapping
 * ------------------------------------------------------------------ */

/**
 * The `emojis` column, with the defaults the source had.
 *
 * The column's default is `{}`, not `{"tick": "✅"}`, so a scrim that was
 * never edited has no emoji of its own and falls back to the Unicode
 * ones (D36).
 */
function readEmojis(value: unknown): ScrimEmojis {
  const source = (typeof value === "object" && value !== null
    ? value
    : {}) as Record<string, unknown>;

  return {
    tick: typeof source.tick === "string" ? source.tick : "✅",
    cross: typeof source.cross === "string" ? source.cross : "❌",
  };
}

/** The countdown column, with the defaults the source had. */
function readCountdown(value: unknown): ScrimCountdown {
  const source = (typeof value === "object" && value !== null
    ? value
    : {}) as Record<string, unknown>;

  return {
    status: source.status === true,
    countdown: typeof source.countdown === "number" ? source.countdown : 3,
    msg: parseTemplate(source.msg),
  };
}

/** Turns a database row into the domain type. */
function toScrim(row: typeof scrims.$inferSelect): ScrimRecord {
  return {
    id: row.id,
    guildId: row.guildId,
    name: row.name,
    status: row.status as ScrimStatus,
    registrationChannelId: row.registrationChannelId,
    slotlistChannelId: row.slotlistChannelId,
    slotlistMessageId: row.slotlistMessageId,
    roleId: row.roleId,
    openRoleId: row.openRoleId,
    pingRoleId: row.pingRoleId,
    hostId: row.hostId,
    requiredMentions: row.requiredMentions,
    requiredLines: row.requiredLines,
    startFrom: row.startFrom,
    totalSlots: row.totalSlots,
    openTime: row.openTime,
    openedAt: row.openedAt,
    closedAt: row.closedAt,
    matchTime: row.matchTime,
    autoclean: row.autoclean as AutocleanKind[],
    autocleanTime: row.autocleanTime,
    autoslotlist: row.autoslotlist,
    multiregister: row.multiregister,
    enabled: row.enabled,
    autodeleteRejects: row.autodeleteRejects,
    autodeleteExtras: row.autodeleteExtras,
    teamnameCompulsion: row.teamnameCompulsion,
    noDuplicateName: row.noDuplicateName,
    allowDuplicateTags: row.allowDuplicateTags,
    timeElapsedSeconds: row.timeElapsedSeconds,
    openDays: row.openDays as Weekday[],
    slotlistFormat: parseTemplate(row.slotlistFormat),
    openMessage: parseTemplate(row.openMessage),
    closeMessage: parseTemplate(row.closeMessage),
    emojis: readEmojis(row.emojis),
    cdn: readCountdown(row.cdn),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** Turns a database row into the domain type. */
function toSlot(row: typeof slots.$inferSelect): SlotRecord {
  return {
    id: row.id,
    scrimId: row.scrimId,
    num: row.num,
    state: row.state as SlotState,
    teamName: row.teamName,
    ownerUserId: row.ownerUserId,
    members: row.members,
    messageId: row.messageId,
    jumpUrl: row.jumpUrl,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** Turns a database row into the domain type. */
function toReservedSlot(
  row: typeof reservedSlots.$inferSelect,
): ReservedSlotRecord {
  return {
    id: row.id,
    scrimId: row.scrimId,
    num: row.num,
    userId: row.userId,
    teamName: row.teamName,
    members: row.members,
    expires: row.expires,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** Turns a database row into the domain type. */
function toBannedTeam(row: typeof bannedTeams.$inferSelect): BannedTeamRecord {
  return {
    id: row.id,
    scrimId: row.scrimId,
    num: row.num,
    userId: row.userId,
    teamName: row.teamName,
    members: row.members,
    reason: row.reason,
    expires: row.expires,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/* ------------------------------------------------------------------ *
 * Scrims
 * ------------------------------------------------------------------ */

/** One scrim, by id. */
export async function getScrim(id: string): Promise<ScrimRecord | null> {
  const rows = await db.select().from(scrims).where(eq(scrims.id, id)).limit(1);

  const row = rows[0];

  return row ? toScrim(row) : null;
}

/** Every scrim in a guild, oldest open time first. */
export async function listScrims(guildId: string): Promise<ScrimRecord[]> {
  const rows = await db
    .select()
    .from(scrims)
    .where(eq(scrims.guildId, guildId))
    .orderBy(asc(scrims.openTime));

  return rows.map(toScrim);
}

/** The scrim that lives in a registration channel. */
export async function getScrimByRegistrationChannel(
  channelId: string,
): Promise<ScrimRecord | null> {
  const rows = await db
    .select()
    .from(scrims)
    .where(eq(scrims.registrationChannelId, channelId))
    .limit(1);

  const row = rows[0];

  return row ? toScrim(row) : null;
}

/** Every scrim whose registration is open, across every guild. */
export async function listOpenScrims(): Promise<ScrimRecord[]> {
  const rows = await db
    .select()
    .from(scrims)
    .where(eq(scrims.status, "open"))
    .orderBy(asc(scrims.openTime));

  return rows.map(toScrim);
}

/** How many scrims a guild has. */
export async function countScrims(guildId: string): Promise<number> {
  const rows = await db
    .select({ value: count() })
    .from(scrims)
    .where(eq(scrims.guildId, guildId));

  return rows[0]?.value ?? 0;
}

/** The values a new scrim is created with. */
export interface CreateScrimValues {
  readonly guildId: string;
  readonly hostId: string;
  readonly name: string;
  readonly registrationChannelId: string;
  readonly slotlistChannelId: string;
  readonly roleId: string | null;
  readonly requiredMentions: number;
  readonly totalSlots: number;
  readonly openTime: Date;
  readonly startFrom: number;
  readonly openDays: Weekday[];
  readonly autoclean: AutocleanKind[];
  readonly autocleanTime: Date | null;
  readonly emojis: ScrimEmojis;
  readonly openMessage: EmbedTemplate;
  readonly closeMessage: EmbedTemplate;
  readonly slotlistFormat: EmbedTemplate;
}

/** Creates a scrim. It starts as a `draft` (D26). */
export async function createScrim(values: CreateScrimValues): Promise<string> {
  const rows = await db
    .insert(scrims)
    .values({
      guildId: values.guildId,
      hostId: values.hostId,
      name: values.name,
      status: "draft",
      registrationChannelId: values.registrationChannelId,
      slotlistChannelId: values.slotlistChannelId,
      roleId: values.roleId,
      requiredMentions: values.requiredMentions,
      totalSlots: values.totalSlots,
      openTime: values.openTime,
      startFrom: values.startFrom,
      openDays: values.openDays,
      autoclean: values.autoclean,
      autocleanTime: values.autocleanTime,
      emojis: values.emojis,
      openMessage: values.openMessage,
      closeMessage: values.closeMessage,
      slotlistFormat: values.slotlistFormat,
    })
    .returning({ id: scrims.id });

  const id = rows[0]?.id;

  if (!id) throw new Error("the scrim insert returned no id");

  return id;
}

/**
 * The fields the editor may write.
 *
 * `slotlistMessageId` is **not** in the list: the slot area owns the
 * published slot list, and it is the only writer of the column that
 * remembers the message. Two writers means whichever re-renders last
 * wins.
 */
export type ScrimUpdate = Partial<
  Pick<
    typeof scrims.$inferInsert,
    | "name"
    | "registrationChannelId"
    | "slotlistChannelId"
    | "roleId"
    | "openRoleId"
    | "pingRoleId"
    | "requiredMentions"
    | "requiredLines"
    | "startFrom"
    | "totalSlots"
    | "openTime"
    | "openedAt"
    | "closedAt"
    | "matchTime"
    | "status"
    | "autoclean"
    | "autocleanTime"
    | "autoslotlist"
    | "multiregister"
    | "enabled"
    | "autodeleteRejects"
    | "autodeleteExtras"
    | "teamnameCompulsion"
    | "noDuplicateName"
    | "allowDuplicateTags"
    | "timeElapsedSeconds"
    | "openDays"
    | "slotlistFormat"
    | "openMessage"
    | "closeMessage"
    | "emojis"
    | "cdn"
  >
>;

/**
 * Writes **one** field of a scrim.
 *
 * The source's editor rebuilt the whole model from `dict(self.record)` on
 * every interaction, which wrote columns another writer may have changed
 * in the meantime. The port writes only what the button touched.
 */
export async function updateScrim(
  id: string,
  values: ScrimUpdate,
): Promise<ScrimRecord | null> {
  const rows = await db
    .update(scrims)
    .set({ ...values, updatedAt: new Date() })
    .where(eq(scrims.id, id))
    .returning();

  const row = rows[0];

  return row ? toScrim(row) : null;
}

/**
 * Writes one field on **every** scrim of a guild.
 *
 * This is the "apply to all scrims" prompt. It is a separate function on
 * purpose: the source ran it *after* the panel had already re-rendered,
 * so the user saw the new value on the edited scrim and then had to
 * confirm a change to every other scrim. The port asks first.
 */
export async function updateAllScrims(
  guildId: string,
  values: ScrimUpdate,
): Promise<number> {
  const rows = await db
    .update(scrims)
    .set({ ...values, updatedAt: new Date() })
    .where(eq(scrims.guildId, guildId))
    .returning({ id: scrims.id });

  return rows.length;
}

/** Deletes a scrim. The slots cascade. */
export async function deleteScrim(id: string): Promise<void> {
  await db.delete(scrims).where(eq(scrims.id, id));
}

/* ------------------------------------------------------------------ *
 * Slots
 * ------------------------------------------------------------------ */

/** Every slot of a scrim, in slot-number order. */
export async function listSlots(scrimId: string): Promise<SlotRecord[]> {
  const rows = await db
    .select()
    .from(slots)
    .where(eq(slots.scrimId, scrimId))
    .orderBy(asc(slots.num));

  return rows.map(toSlot);
}

/** One slot of a scrim, by its number. */
export async function getSlotByNum(
  scrimId: string,
  num: number,
): Promise<SlotRecord | null> {
  const rows = await db
    .select()
    .from(slots)
    .where(and(eq(slots.scrimId, scrimId), eq(slots.num, num)))
    .limit(1);

  const row = rows[0];

  return row ? toSlot(row) : null;
}

/** One slot, by its row id. */
export async function getSlot(slotId: string): Promise<SlotRecord | null> {
  const rows = await db.select().from(slots).where(eq(slots.id, slotId)).limit(1);

  const row = rows[0];

  return row ? toSlot(row) : null;
}

/** How many slots are free. A count, not a read-modify-write (D14). */
export async function countFreeSlots(scrimId: string): Promise<number> {
  const rows = await db
    .select({ value: count() })
    .from(slots)
    .where(and(eq(slots.scrimId, scrimId), eq(slots.state, "free")));

  return rows[0]?.value ?? 0;
}

/** What a claim writes. */
export interface ClaimValues {
  readonly teamName: string;
  readonly ownerUserId: string;
  readonly members: readonly string[];
  readonly messageId: string | null;
  readonly jumpUrl: string | null;
}

/**
 * Claims a slot.
 *
 * ```sql
 * UPDATE slots
 *    SET state = 'claimed', team_name = $3, owner_user_id = $4, members = $5
 *  WHERE scrim_id = $1 AND num = $2 AND state = 'free'
 * RETURNING id;
 * ```
 *
 * Zero rows returned means somebody else got it. **There is no lock** —
 * the source protected this with a module-global `asyncio.Lock` that
 * died with the process, so two users could own one slot.
 *
 * @returns the claimed slot, or `null` when somebody else won.
 */
export async function claimSlot(
  scrimId: string,
  num: number,
  values: ClaimValues,
): Promise<SlotRecord | null> {
  const rows = await db
    .update(slots)
    .set({
      state: "claimed",
      teamName: values.teamName,
      ownerUserId: values.ownerUserId,
      members: [...values.members],
      messageId: values.messageId,
      jumpUrl: values.jumpUrl,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(slots.scrimId, scrimId),
        eq(slots.num, num),
        eq(slots.state, "free"),
      ),
    )
    .returning();

  const row = rows[0];

  return row ? toSlot(row) : null;
}

/**
 * Releases a slot.
 *
 * Only the owner may release their own slot; a moderator releasing
 * somebody else's slot goes through {@link setSlotState} instead.
 */
export async function releaseSlot(
  slotId: string,
  ownerUserId: string,
): Promise<SlotRecord | null> {
  const rows = await db
    .update(slots)
    .set({
      state: "free",
      teamName: null,
      ownerUserId: null,
      members: [],
      messageId: null,
      jumpUrl: null,
      updatedAt: new Date(),
    })
    .where(and(eq(slots.id, slotId), eq(slots.ownerUserId, ownerUserId)))
    .returning();

  const row = rows[0];

  return row ? toSlot(row) : null;
}

/**
 * Moves a slot to a state.
 *
 * The moderator path: "Add Team", "Remove Team", "Change Team". The
 * source did this with array surgery on `available_slots` plus a row
 * insert or delete; here it is a state change on one row.
 */
export async function setSlotState(
  slotId: string,
  state: SlotState,
  values: {
    readonly teamName?: string | null;
    readonly ownerUserId?: string | null;
    readonly members?: readonly string[];
  } = {},
): Promise<SlotRecord | null> {
  const patch: Partial<typeof slots.$inferInsert> = {
    state,
    updatedAt: new Date(),
  };

  if (values.teamName !== undefined) patch.teamName = values.teamName;
  if (values.ownerUserId !== undefined) patch.ownerUserId = values.ownerUserId;
  if (values.members !== undefined) patch.members = [...values.members];

  const rows = await db
    .update(slots)
    .set(patch)
    .where(eq(slots.id, slotId))
    .returning();

  const row = rows[0];

  return row ? toSlot(row) : null;
}

/**
 * Replaces a slot's team, in one statement.
 *
 * The "Change Team" button. The source wrote the team name and the
 * owner in two separate statements, which could leave a half-changed
 * slot behind.
 */
export async function changeSlotTeam(
  slotId: string,
  values: {
    readonly teamName: string;
    readonly ownerUserId: string | null;
    readonly members: readonly string[];
  },
): Promise<SlotRecord | null> {
  const rows = await db
    .update(slots)
    .set({
      state: "claimed",
      teamName: values.teamName,
      ownerUserId: values.ownerUserId,
      members: [...values.members],
      updatedAt: new Date(),
    })
    .where(eq(slots.id, slotId))
    .returning();

  const row = rows[0];

  return row ? toSlot(row) : null;
}

/**
 * Creates the free slots of a scrim.
 *
 * Called when registration opens. A free slot is a **row**, so the
 * whole range is materialised up front rather than being discovered one
 * at a time.
 */
export async function createFreeSlots(
  scrimId: string,
  numbers: readonly number[],
): Promise<void> {
  if (numbers.length === 0) return;

  await db
    .insert(slots)
    .values(
      numbers.map((num) => ({
        scrimId,
        num,
        state: "free" as const,
      })),
    )
    .onConflictDoNothing();
}

/**
 * Deletes every slot of a scrim.
 *
 * Opening a scrim resets its slots, so this runs first.
 */
export async function deleteSlots(scrimId: string): Promise<void> {
  await db.delete(slots).where(eq(slots.scrimId, scrimId));
}

/** The owners of the claimed slots of a scrim. */
export async function listClaimedOwnerIds(scrimId: string): Promise<string[]> {
  const rows = await db
    .select({ ownerUserId: slots.ownerUserId })
    .from(slots)
    .where(and(eq(slots.scrimId, scrimId), eq(slots.state, "claimed")));

  return rows
    .map((row) => row.ownerUserId)
    .filter((id): id is string => id !== null);
}

/** The team names of the claimed slots of a scrim. */
export async function listClaimedTeamNames(
  scrimId: string,
): Promise<string[]> {
  const rows = await db
    .select({ teamName: slots.teamName })
    .from(slots)
    .where(and(eq(slots.scrimId, scrimId), eq(slots.state, "claimed")));

  return rows
    .map((row) => row.teamName)
    .filter((name): name is string => name !== null);
}

/**
 * The claimed slots of a scrim that already hold one of these members.
 *
 * The source ran this as raw SQL with an array-overlap operator
 * (`$2 && SLOTS.MEMBERS`) against a schema-qualified join table. Ours is
 * a typed query over one table (S6, row 12).
 *
 * The overlap is written as `members && ARRAY[$1, $2]::text[]` rather
 * than `members && $1::text[]`: the latter makes Postgres read the
 * parameter as text and then cast it, and the array literal it receives
 * is not one it can parse. Every id is still a bind parameter.
 */
export async function findFakeTagMatches(
  scrimId: string,
  memberIds: readonly string[],
): Promise<SlotRecord[]> {
  if (memberIds.length === 0) return [];

  const array = sql.join(
    memberIds.map((id) => sql`${id}`),
    sql`, `,
  );

  const rows = await db
    .select()
    .from(slots)
    .where(
      and(
        eq(slots.scrimId, scrimId),
        eq(slots.state, "claimed"),
        sql`${slots.members} && ARRAY[${array}]::text[]`,
      ),
    );

  return rows.map(toSlot);
}

/* ------------------------------------------------------------------ *
 * Reserved slots
 * ------------------------------------------------------------------ */

/** Every reserved slot of a scrim, in slot-number order. */
export async function listReservedSlots(
  scrimId: string,
): Promise<ReservedSlotRecord[]> {
  const rows = await db
    .select()
    .from(reservedSlots)
    .where(eq(reservedSlots.scrimId, scrimId))
    .orderBy(asc(reservedSlots.num));

  return rows.map(toReservedSlot);
}

/**
 * Reserves a slot.
 *
 * The reservation replaces any earlier one for the same number, which is
 * what the source did by deleting the old row first.
 */
export async function reserveSlot(
  values: {
    readonly scrimId: string;
    readonly num: number;
    readonly userId: string | null;
    readonly teamName: string;
    readonly members: readonly string[];
    readonly expires: Date | null;
  },
): Promise<ReservedSlotRecord | null> {
  await db
    .delete(reservedSlots)
    .where(
      and(
        eq(reservedSlots.scrimId, values.scrimId),
        eq(reservedSlots.num, values.num),
      ),
    );

  const rows = await db
    .insert(reservedSlots)
    .values({
      scrimId: values.scrimId,
      num: values.num,
      userId: values.userId,
      teamName: values.teamName,
      members: [...values.members],
      expires: values.expires,
    })
    .returning();

  const row = rows[0];

  return row ? toReservedSlot(row) : null;
}

/** Removes a reservation. */
export async function deleteReservedSlot(slotId: string): Promise<void> {
  await db.delete(reservedSlots).where(eq(reservedSlots.id, slotId));
}

/** Removes every reservation of a scrim. */
export async function deleteReservedSlots(scrimId: string): Promise<void> {
  await db.delete(reservedSlots).where(eq(reservedSlots.scrimId, scrimId));
}

/* ------------------------------------------------------------------ *
 * Bans
 * ------------------------------------------------------------------ */

/** Every ban of a scrim. */
export async function listBans(scrimId: string): Promise<BannedTeamRecord[]> {
  const rows = await db
    .select()
    .from(bannedTeams)
    .where(eq(bannedTeams.scrimId, scrimId))
    .orderBy(asc(bannedTeams.createdAt));

  return rows.map(toBannedTeam);
}

/** The users banned from a scrim. */
export async function listBannedUserIds(scrimId: string): Promise<string[]> {
  const rows = await db
    .select({ userId: bannedTeams.userId })
    .from(bannedTeams)
    .where(eq(bannedTeams.scrimId, scrimId));

  return rows.map((row) => row.userId);
}

/** Is this user banned from this scrim? */
export async function isBanned(
  scrimId: string,
  userId: string,
): Promise<boolean> {
  const rows = await db
    .select({ id: bannedTeams.id })
    .from(bannedTeams)
    .where(and(eq(bannedTeams.scrimId, scrimId), eq(bannedTeams.userId, userId)))
    .limit(1);

  return rows.length > 0;
}

/**
 * Bans a user from a scrim.
 *
 * The unique constraint on `(scrim_id, user_id)` makes this idempotent:
 * banning twice updates the row instead of stacking a second one.
 */
export async function banUser(
  values: {
    readonly scrimId: string;
    readonly userId: string;
    readonly teamName: string | null;
    readonly members: readonly string[];
    readonly reason: string | null;
    readonly expires: Date | null;
  },
): Promise<BannedTeamRecord | null> {
  const rows = await db
    .insert(bannedTeams)
    .values({
      scrimId: values.scrimId,
      userId: values.userId,
      teamName: values.teamName,
      members: [...values.members],
      reason: values.reason,
      expires: values.expires,
    })
    .onConflictDoUpdate({
      target: [bannedTeams.scrimId, bannedTeams.userId],
      set: {
        teamName: values.teamName,
        members: [...values.members],
        reason: values.reason,
        expires: values.expires,
        updatedAt: new Date(),
      },
    })
    .returning();

  const row = rows[0];

  return row ? toBannedTeam(row) : null;
}

/** Lifts a ban. */
export async function unbanUser(scrimId: string, userId: string): Promise<void> {
  await db
    .delete(bannedTeams)
    .where(and(eq(bannedTeams.scrimId, scrimId), eq(bannedTeams.userId, userId)));
}

/** The scrims a user is banned from, in one guild. */
export async function listScrimsBanning(
  guildId: string,
  userId: string,
): Promise<string[]> {
  const rows = await db
    .select({ scrimId: bannedTeams.scrimId })
    .from(bannedTeams)
    .innerJoin(scrims, eq(bannedTeams.scrimId, scrims.id))
    .where(and(eq(scrims.guildId, guildId), eq(bannedTeams.userId, userId)));

  return rows.map((row) => row.scrimId);
}

/** The channel a guild writes its ban log to. */
export async function getBanLogChannel(
  guildId: string,
): Promise<string | null> {
  const rows = await db
    .select({ channelId: banLogs.channelId })
    .from(banLogs)
    .where(eq(banLogs.guildId, guildId))
    .limit(1);

  return rows[0]?.channelId ?? null;
}

/** Sets the channel a guild writes its ban log to. */
export async function setBanLogChannel(
  guildId: string,
  channelId: string,
): Promise<void> {
  await db
    .insert(banLogs)
    .values({ guildId, channelId })
    .onConflictDoUpdate({
      target: banLogs.guildId,
      set: { channelId, updatedAt: new Date() },
    });
}

/* ------------------------------------------------------------------ *
 * Jobs
 * ------------------------------------------------------------------ */

/** The payload of a scrim job. */
export interface ScrimJobPayload {
  readonly scrimId: string;
  readonly [key: string]: unknown;
}

/**
 * Arms a job for a scrim.
 *
 * The scheduler is the durable `jobs` table, never a `setTimeout`: a
 * timer that dies with the process means the scrim never opens again.
 */
export async function scheduleJob(
  event: JobEvent,
  expiresAt: Date,
  payload: ScrimJobPayload,
  userId: string | null = null,
): Promise<string> {
  const rows = await db
    .insert(jobs)
    .values({ event, expiresAt, payload, userId })
    .returning({ id: jobs.id });

  const id = rows[0]?.id;

  if (!id) throw new Error("the job insert returned no id");

  return id;
}

/**
 * Replaces the job of one kind for one scrim.
 *
 * The source deleted the old timer and created a new one whenever the
 * schedule changed. Same here, so there is never two timers for one
 * scrim.
 */
export async function replaceScrimJob(
  event: JobEvent,
  scrimId: string,
  expiresAt: Date,
  payload: ScrimJobPayload = { scrimId },
  userId: string | null = null,
): Promise<string> {
  await deleteScrimJobs(event, scrimId);

  return scheduleJob(event, expiresAt, payload, userId);
}

/** Deletes every job of one kind for one scrim. */
export async function deleteScrimJobs(
  event: JobEvent,
  scrimId: string,
): Promise<void> {
  await db
    .delete(jobs)
    .where(
      and(
        eq(jobs.event, event),
        sql`${jobs.payload} ->> 'scrimId' = ${scrimId}`,
      ),
    );
}

/** The jobs of one kind for one scrim. */
export async function listScrimJobs(
  event: JobEvent,
  scrimId: string,
): Promise<{ id: string; expiresAt: Date }[]> {
  const rows = await db
    .select({ id: jobs.id, expiresAt: jobs.expiresAt })
    .from(jobs)
    .where(
      and(
        eq(jobs.event, event),
        sql`${jobs.payload} ->> 'scrimId' = ${scrimId}`,
      ),
    );

  return rows;
}

/** The jobs of one kind that are due at a given instant. */
export async function listDueJobs(
  event: JobEvent,
  now: Date,
): Promise<{ id: string; payload: unknown; expiresAt: Date }[]> {
  const rows = await db
    .select({ id: jobs.id, payload: jobs.payload, expiresAt: jobs.expiresAt })
    .from(jobs)
    .where(and(eq(jobs.event, event), sql`${jobs.expiresAt} <= ${now}`));

  return rows;
}

/** Deletes a job by id. The dispatcher deletes before it dispatches. */
export async function deleteJob(id: string): Promise<void> {
  await db.delete(jobs).where(eq(jobs.id, id));
}

/** The scrim ids a job is about. */
export function scrimIdOf(payload: unknown): string | null {
  if (typeof payload !== "object" || payload === null) return null;

  const scrimId = (payload as Record<string, unknown>).scrimId;

  return typeof scrimId === "string" ? scrimId : null;
}

/** The user ids a job is about. */
export function userIdsOf(payload: unknown): string[] {
  if (typeof payload !== "object" || payload === null) return [];

  const raw = (payload as Record<string, unknown>).userIds;

  if (!Array.isArray(raw)) return [];

  return raw.filter((id): id is string => typeof id === "string");
}

/** The scrim ids a job is about, as a list. */
export function scrimIdsOf(payload: unknown): string[] {
  if (typeof payload !== "object" || payload === null) return [];

  const raw = (payload as Record<string, unknown>).scrimIds;

  if (!Array.isArray(raw)) return [];

  return raw.filter((id): id is string => typeof id === "string");
}

/** Every scrim id a job is about, whichever key it used. */
export function allScrimIdsOf(payload: unknown): string[] {
  const single = scrimIdOf(payload);
  const many = scrimIdsOf(payload);

  if (single) return [single, ...many];

  return many;
}

/** The ids of the slots a job is about. */
export function slotIdsOf(payload: unknown): string[] {
  if (typeof payload !== "object" || payload === null) return [];

  const raw = (payload as Record<string, unknown>).slotIds;

  if (!Array.isArray(raw)) return [];

  return raw.filter((id): id is string => typeof id === "string");
}

/** The ids of the scrims a set of slots belong to. */
export async function listScrimIdsForSlots(
  slotIds: readonly string[],
): Promise<string[]> {
  if (slotIds.length === 0) return [];

  const rows = await db
    .selectDistinct({ scrimId: slots.scrimId })
    .from(slots)
    .where(inArray(slots.id, [...slotIds]));

  return rows.map((row) => row.scrimId);
}
