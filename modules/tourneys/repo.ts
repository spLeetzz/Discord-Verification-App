/**
 * All the SQL for the tournaments area.
 *
 * The rule that matters: **no SQL outside this file.** The service layer
 * talks to these functions; the views talk to the service.
 *
 * The schema is in `db/schema/esports.ts` and it is already migrated and
 * verified, so the column names here are the real ones — `tourneys.status`,
 * `tourney_slots.num`, `tourney_group_lists.channel_id` and so on.
 *
 * **The engine is SQLite.** The schema is dialect neutral (see
 * `db/dialect.ts`), so nothing here spells out an engine's dialect: a
 * list of ids is a join table, a timestamp is a `Date`, a boolean is a
 * `boolean` and a JSON column is a parsed object, on both.
 *
 * Three statements matter more than the rest:
 *
 *  - {@link insertSlot}, which takes the next number from a **per-tourney
 *    sequence** rather than `max(num) + 1` (D25);
 *  - {@link swapSlotNumbers}, which is one transaction (D25);
 *  - {@link findFakeTagMatches}, which is a **join** against the member
 *    table (S6, row 14).
 */

import { and, asc, count, eq, exists, inArray, ne, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { db, withTransaction } from "../../db/client.js";
import type { DbExecutor } from "../../db/client.js";
import {
  jobs,
  mediaPartnerSlotMembers,
  mediaPartnerSlots,
  mediaPartners,
  tourneyBannedUsers,
  tourneyGroupLists,
  tourneySlotMembers,
  tourneySlots,
  tourneys,
} from "../../db/schema.js";
import type { TourneyStatus } from "../../db/schema/common.js";
import type {
  MediaPartnerRecord,
  MediaPartnerSlotRecord,
  TourneyEmojis,
  TourneyGroupListRecord,
  TourneyRecord,
  TourneySchedule,
  TourneySlotRecord,
} from "./types.js";

/* ------------------------------------------------------------------ *
 * Row mapping
 * ------------------------------------------------------------------ */

/**
 * The `emojis` column, with the defaults the source had.
 *
 * The column's default is `{"tick": "✅", "cross": "❌"}`, but a row
 * written before the column existed can hold anything, so the reader is
 * defensive.
 */
function readEmojis(value: unknown): TourneyEmojis {
  const source = (typeof value === "object" && value !== null
    ? value
    : {}) as Record<string, unknown>;

  return {
    tick: typeof source.tick === "string" ? source.tick : "✅",
    cross: typeof source.cross === "string" ? source.cross : "❌",
  };
}

/** Turns a database row into the domain type. */
function toTourney(row: typeof tourneys.$inferSelect): TourneyRecord {
  return {
    id: row.id,
    guildId: row.guildId,
    name: row.name,
    status: row.status as TourneyStatus,
    registrationChannelId: row.registrationChannelId,
    confirmChannelId: row.confirmChannelId,
    roleId: row.roleId,
    openRoleId: row.openRoleId,
    pingRoleId: row.pingRoleId,
    hostId: row.hostId,
    requiredMentions: row.requiredMentions,
    requiredLines: row.requiredLines,
    totalSlots: row.totalSlots,
    startedAt: row.startedAt,
    closedAt: row.closedAt,
    multiregister: row.multiregister,
    teamnameCompulsion: row.teamnameCompulsion,
    noDuplicateName: row.noDuplicateName,
    autodeleteRejects: row.autodeleteRejects,
    allowDuplicateTags: row.allowDuplicateTags,
    startFrom: row.startFrom,
    groupSize: row.groupSize,
    successMessage: row.successMessage,
    emojis: readEmojis(row.emojis),
    slotmChannelId: row.slotmChannelId,
    slotmMessageId: row.slotmMessageId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * Turns a database row into the domain type.
 *
 * **The members are not on the row.** `tourney_slots.members` used to be
 * a `text[]`; it is a join table now (`tourney_slot_members`), so the
 * list is read separately and handed in. The domain type is unchanged —
 * a slot still has a `members` array.
 */
function toSlot(
  row: typeof tourneySlots.$inferSelect,
  members: readonly string[],
): TourneySlotRecord {
  return {
    id: row.id,
    tourneyId: row.tourneyId,
    num: row.num,
    teamName: row.teamName,
    leaderId: row.leaderId,
    members,
    messageId: row.messageId,
    jumpUrl: row.jumpUrl,
    confirmJumpUrl: row.confirmJumpUrl,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** Turns a database row into the domain type. */
function toMediaPartner(
  row: typeof mediaPartners.$inferSelect,
): MediaPartnerRecord {
  return {
    id: row.id,
    tourneyId: row.tourneyId,
    channelId: row.channelId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * Turns a database row into the domain type.
 *
 * The members come from `media_partner_slot_members`, for the same
 * reason the tourney slot's do.
 */
function toMediaPartnerSlot(
  row: typeof mediaPartnerSlots.$inferSelect,
  members: readonly string[],
): MediaPartnerSlotRecord {
  return {
    id: row.id,
    mediaPartnerId: row.mediaPartnerId,
    userId: row.userId,
    messageId: row.messageId,
    jumpUrl: row.jumpUrl,
    members,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** Turns a database row into the domain type. */
function toGroupList(
  row: typeof tourneyGroupLists.$inferSelect,
): TourneyGroupListRecord {
  return {
    id: row.id,
    tourneyId: row.tourneyId,
    messageId: row.messageId,
    channelId: row.channelId,
    groupNumber: row.groupNumber,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/* ------------------------------------------------------------------ *
 * Slot members
 *
 * `tourney_slots.members` was a `text[]`. It is a join table now
 * (`tourney_slot_members`), so the list is read from there and written
 * there. The domain type did not change: a slot still has a `members`
 * array, and the code above this file never learned about the join.
 * ------------------------------------------------------------------ */

/**
 * The members of a set of tourney slots, keyed by the slot's row id.
 *
 * **One query for the whole set.** The slots of a tournament are read
 * together, and a query per slot would be a round-trip per row.
 */
async function loadSlotMembers(
  slotIds: readonly string[],
): Promise<Map<string, string[]>> {
  const members = new Map<string, string[]>();

  if (slotIds.length === 0) return members;

  const rows = await db
    .select({
      slotId: tourneySlotMembers.tourneySlotId,
      userId: tourneySlotMembers.userId,
    })
    .from(tourneySlotMembers)
    .where(inArray(tourneySlotMembers.tourneySlotId, [...slotIds]))
    .orderBy(asc(tourneySlotMembers.createdAt), asc(tourneySlotMembers.userId));

  for (const row of rows) {
    const list = members.get(row.slotId);

    if (list) list.push(row.userId);
    else members.set(row.slotId, [row.userId]);
  }

  return members;
}

/**
 * Turns slot rows into domain records, with their members.
 *
 * The member list is read in one query for the whole set and handed to
 * each row, so the join table never turns into a query per row.
 */
async function toSlots(
  rows: readonly (typeof tourneySlots.$inferSelect)[],
): Promise<TourneySlotRecord[]> {
  const members = await loadSlotMembers(rows.map((row) => row.id));

  return rows.map((row) => toSlot(row, members.get(row.id) ?? []));
}

/**
 * Writes the members of a slot.
 *
 * One row per member, in one statement. The unique key on
 * `(tourney_slot_id, user_id)` makes a repeated member a no-op instead
 * of a second row.
 *
 * **The leader is always one of them.** The leader is a member of their
 * own team, and the fake-tag check reads the member table — so a slot
 * whose leader is missing from it would let the same person register
 * twice.
 *
 * @returns the members that were written, in order.
 */
async function writeSlotMembers(
  executor: DbExecutor,
  slotId: string,
  leaderId: string,
  memberIds: readonly string[],
): Promise<string[]> {
  const members = [...new Set([leaderId, ...memberIds])];

  if (members.length === 0) return [];

  await executor
    .insert(tourneySlotMembers)
    .values(members.map((userId) => ({ tourneySlotId: slotId, userId })))
    .onConflictDoNothing();

  return members;
}

/* ------------------------------------------------------------------ *
 * Tournaments
 * ------------------------------------------------------------------ */

/** One tournament, by id. */
export async function getTourney(id: string): Promise<TourneyRecord | null> {
  const rows = await db.select().from(tourneys).where(eq(tourneys.id, id)).limit(1);

  const row = rows[0];

  return row ? toTourney(row) : null;
}

/** The tournament that lives in a registration channel. */
export async function getTourneyByRegistrationChannel(
  channelId: string,
): Promise<TourneyRecord | null> {
  const rows = await db
    .select()
    .from(tourneys)
    .where(eq(tourneys.registrationChannelId, channelId))
    .limit(1);

  const row = rows[0];

  return row ? toTourney(row) : null;
}

/** Every tournament in a guild, oldest first. */
export async function listTourneys(
  guildId: string,
): Promise<TourneyRecord[]> {
  const rows = await db
    .select()
    .from(tourneys)
    .where(eq(tourneys.guildId, guildId))
    .orderBy(asc(tourneys.createdAt));

  return rows.map(toTourney);
}

/** How many tournaments a guild has. */
export async function countTourneys(guildId: string): Promise<number> {
  const rows = await db
    .select({ value: count() })
    .from(tourneys)
    .where(eq(tourneys.guildId, guildId));

  return rows[0]?.value ?? 0;
}

/** Every tournament whose registration is open, across every guild. */
export async function listOpenTourneys(): Promise<TourneyRecord[]> {
  const rows = await db
    .select()
    .from(tourneys)
    .where(eq(tourneys.status, "open"))
    .orderBy(asc(tourneys.createdAt));

  return rows.map(toTourney);
}

/**
 * Is a registration channel already taken?
 *
 * The source checked this in the wizard's "set registration channel"
 * button and then wrote the channel id anyway, so two tournaments could
 * end up fighting over one channel. The database has a unique constraint
 * on `registration_channel_id` (S5) and this is the friendly check that
 * runs before it.
 */
export async function isRegistrationChannelTaken(
  channelId: string,
  exceptTourneyId?: string,
): Promise<boolean> {
  const rows = await db
    .select({ id: tourneys.id })
    .from(tourneys)
    .where(eq(tourneys.registrationChannelId, channelId))
    .limit(1);

  const row = rows[0];

  if (!row) return false;

  return exceptTourneyId === undefined ? true : row.id !== exceptTourneyId;
}

/** The values a new tournament is created with. */
export interface CreateTourneyValues {
  readonly guildId: string;
  readonly hostId: string;
  readonly name: string;
  readonly registrationChannelId: string;
  readonly confirmChannelId: string;
  readonly roleId: string;
  readonly requiredMentions: number;
  readonly totalSlots: number;
  readonly groupSize: number | null;
  readonly emojis: TourneyEmojis;
}

/** Creates a tournament. It starts as a `draft` (D26). */
export async function createTourney(values: CreateTourneyValues): Promise<string> {
  const rows = await db
    .insert(tourneys)
    .values({
      guildId: values.guildId,
      hostId: values.hostId,
      name: values.name,
      status: "draft",
      registrationChannelId: values.registrationChannelId,
      confirmChannelId: values.confirmChannelId,
      roleId: values.roleId,
      requiredMentions: values.requiredMentions,
      totalSlots: values.totalSlots,
      groupSize: values.groupSize,
      emojis: values.emojis,
    })
    .returning({ id: tourneys.id });

  const id = rows[0]?.id;

  if (!id) throw new Error("the tourney insert returned no id");

  return id;
}

/** The fields the editor may write. */
export type TourneyUpdate = Partial<
  Pick<
    typeof tourneys.$inferInsert,
    | "name"
    | "status"
    | "registrationChannelId"
    | "confirmChannelId"
    | "roleId"
    | "openRoleId"
    | "pingRoleId"
    | "requiredMentions"
    | "requiredLines"
    | "totalSlots"
    | "startedAt"
    | "closedAt"
    | "multiregister"
    | "teamnameCompulsion"
    | "noDuplicateName"
    | "autodeleteRejects"
    | "allowDuplicateTags"
    | "startFrom"
    | "groupSize"
    | "successMessage"
    | "emojis"
    | "slotmChannelId"
    | "slotmMessageId"
  >
>;

/**
 * Writes **one** field of a tournament.
 *
 * The source's editor rebuilt the whole model from `dict(self.record)` on
 * every interaction, which relied on Tortoise internals and wrote
 * columns another writer may have changed in the meantime. The port
 * writes only what the button touched.
 */
export async function updateTourney(
  id: string,
  values: TourneyUpdate,
): Promise<TourneyRecord | null> {
  const rows = await db
    .update(tourneys)
    .set({ ...values, updatedAt: new Date() })
    .where(eq(tourneys.id, id))
    .returning();

  const row = rows[0];

  return row ? toTourney(row) : null;
}

/** Deletes a tournament. The slots, the bans and the group lists cascade. */
export async function deleteTourney(id: string): Promise<void> {
  await db.delete(tourneys).where(eq(tourneys.id, id));
}

/* ------------------------------------------------------------------ *
 * Slots
 * ------------------------------------------------------------------ */

/** Every slot of a tournament, in slot-number order. */
export async function listSlots(tourneyId: string): Promise<TourneySlotRecord[]> {
  const rows = await db
    .select()
    .from(tourneySlots)
    .where(eq(tourneySlots.tourneyId, tourneyId))
    .orderBy(asc(tourneySlots.num));

  return toSlots(rows);
}

/** One slot, by its row id. */
export async function getSlot(slotId: string): Promise<TourneySlotRecord | null> {
  const rows = await db
    .select()
    .from(tourneySlots)
    .where(eq(tourneySlots.id, slotId))
    .limit(1);

  const slots = await toSlots(rows);

  return slots[0] ?? null;
}

/** How many slots a tournament has. */
export async function countSlots(tourneyId: string): Promise<number> {
  const rows = await db
    .select({ value: count() })
    .from(tourneySlots)
    .where(eq(tourneySlots.tourneyId, tourneyId));

  return rows[0]?.value ?? 0;
}

/**
 * The slot a registration message produced.
 *
 * The source looked the slot up by `message_id` alone, across every
 * tournament. Ours scopes it to the tournament, because the reaction
 * path has to know *which* tournament's message it is looking at.
 */
export async function getSlotByMessage(
  tourneyId: string,
  messageId: string,
): Promise<TourneySlotRecord | null> {
  const rows = await db
    .select()
    .from(tourneySlots)
    .where(and(eq(tourneySlots.tourneyId, tourneyId), eq(tourneySlots.messageId, messageId)))
    .limit(1);

  const slots = await toSlots(rows);

  return slots[0] ?? null;
}

/**
 * The slot a user leads, or is a member of, in a tournament.
 *
 * The membership half is an `EXISTS` against the member table: the
 * source's `members && ARRAY[$1]::text[]` was a Postgres array overlap,
 * and SQLite has no arrays. The subquery is the same question — "is
 * this user on that slot?" — and the index on `user_id` answers it.
 */
export async function listSlotsOfUser(
  tourneyId: string,
  userId: string,
): Promise<TourneySlotRecord[]> {
  const rows = await db
    .select()
    .from(tourneySlots)
    .where(
      and(
        eq(tourneySlots.tourneyId, tourneyId),
        sql`(${tourneySlots.leaderId} = ${userId} or ${userIsOnSlot(userId)})`,
      ),
    )
    .orderBy(asc(tourneySlots.num));

  return toSlots(rows);
}

/**
 * The "is this user on that slot?" subquery.
 *
 * It is a correlated `EXISTS` against the member table: the slot the
 * outer query is looking at is named by `tourney_slots.id`, and the
 * subquery asks whether the member table holds a row for that slot and
 * that user. The index on `user_id` answers it.
 */
function userIsOnSlot(userId: string): SQL {
  return exists(
    db
      .select({ one: sql`1` })
      .from(tourneySlotMembers)
      .where(
        and(
          eq(tourneySlotMembers.tourneySlotId, tourneySlots.id),
          eq(tourneySlotMembers.userId, userId),
        ),
      ),
  );
}

/** The users who lead a registered slot in a tournament. */
export async function listLeaderIds(tourneyId: string): Promise<string[]> {
  const rows = await db
    .select({ leaderId: tourneySlots.leaderId })
    .from(tourneySlots)
    .where(eq(tourneySlots.tourneyId, tourneyId));

  return rows.map((row) => row.leaderId);
}

/** The team names already taken in a tournament. */
export async function listTeamNames(tourneyId: string): Promise<string[]> {
  const rows = await db
    .select({ teamName: tourneySlots.teamName })
    .from(tourneySlots)
    .where(eq(tourneySlots.tourneyId, tourneyId));

  return rows.map((row) => row.teamName);
}

/**
 * The registered slots that already hold one of these members.
 *
 * The source ran this as raw SQL with an array-overlap operator
 * (`$2 && SLOTS.MEMBERS`) against a schema-qualified join table, and
 * quoted the qualified names as single identifiers — so it would raise
 * `relation does not exist` at runtime and the fake-tag check had never
 * worked.
 *
 * **Ours is a join.** The member list is a table
 * (`tourney_slot_members`), so the question "which slots of this
 * tournament hold one of these users?" is a join between the two, and
 * the answer is a set of slots — which is what the source's `&&`
 * operator meant. A join is faster than the operator was, and it is the
 * same query on both engines.
 *
 * `DISTINCT` matters: a slot that holds *two* of the mentioned users
 * matches twice, and the answer is a set of slots, not a set of
 * matches.
 *
 * @param exceptSlotId a slot to leave out of the answer — the slot
 *                     being checked, when there is one.
 */
export async function findFakeTagMatches(
  tourneyId: string,
  memberIds: readonly string[],
  exceptSlotId?: string,
): Promise<TourneySlotRecord[]> {
  if (memberIds.length === 0) return [];

  const rows = await db
    .selectDistinct({ slot: tourneySlots })
    .from(tourneySlots)
    .innerJoin(
      tourneySlotMembers,
      eq(tourneySlotMembers.tourneySlotId, tourneySlots.id),
    )
    .where(
      and(
        eq(tourneySlots.tourneyId, tourneyId),
        inArray(tourneySlotMembers.userId, [...memberIds]),
        exceptSlotId === undefined
          ? undefined
          : ne(tourneySlots.id, exceptSlotId),
      ),
    )
    .orderBy(asc(tourneySlots.num));

  return toSlots(rows.map((row) => row.slot));
}

/** What a slot insert writes. */
export interface InsertSlotValues {
  readonly tourneyId: string;
  readonly teamName: string;
  readonly leaderId: string;
  readonly members: readonly string[];
  readonly messageId: string | null;
  readonly jumpUrl: string | null;
  readonly confirmJumpUrl: string | null;
}

/**
 * The next slot number of a tournament.
 *
 * **A per-tourney sequence, not `max(num) + 1`.** The source took
 * `max(num) + 1` under a module-global lock that died with the process,
 * so two registrations could be handed the same number. Ours takes the
 * number inside a transaction that holds the tournament row, and the
 * transaction is behind a per-tourney mutex — so two registrations for
 * the same tournament queue up, and two registrations for different
 * tournaments do not.
 *
 * The number is always positive, which is what lets the swap use `-1` as
 * a temporary.
 *
 * The mutex is taken here and nowhere else: a caller that already holds
 * it must use {@link insertSlot}, which allocates and writes in one go.
 */
export async function nextSlotNumber(tourneyId: string): Promise<number> {
  return withTourneyLock(tourneyId, () =>
    withTransaction((handle) => nextSlotNumberIn(handle, tourneyId)),
  );
}

/**
 * The next slot number, inside an existing transaction.
 *
 * **SQLite has no `SELECT … FOR UPDATE`.** The equivalent is a *write*:
 * a conditional `UPDATE` on the tournament row takes the write lock for
 * the rest of the transaction, and it is conditional on the row still
 * being there — zero rows updated means the tournament was deleted
 * underneath us, and the number would be meaningless.
 */
async function nextSlotNumberIn(
  tx: Parameters<Parameters<typeof withTransaction>[0]>[0],
  tourneyId: string,
): Promise<number> {
  const locked = await tx
    .update(tourneys)
    .set({ updatedAt: new Date() })
    .where(eq(tourneys.id, tourneyId))
    .returning({ id: tourneys.id });

  if (locked.length === 0) {
    throw new Error("the tournament no longer exists");
  }

  const rows = await tx
    .select({ value: sql<number>`coalesce(max(${tourneySlots.num}), 0)` })
    .from(tourneySlots)
    .where(eq(tourneySlots.tourneyId, tourneyId));

  return (rows[0]?.value ?? 0) + 1;
}

/* ------------------------------------------------------------------ *
 * The per-tourney mutex
 *
 * SQLite has no `SELECT … FOR UPDATE`, so the lock that used to
 * serialise the number allocation is a write (see
 * {@link nextSlotNumberIn}) — and a write only holds the lock for the
 * length of its own transaction. Two transactions in the *same* process
 * would still race for the number, so the transaction is behind a
 * mutex: one registration per tournament at a time.
 *
 * The mutex is per tournament, not global: two registrations for
 * different tournaments do not wait for each other.
 * ------------------------------------------------------------------ */

/** The tail of each tournament's lock chain. */
const tourneyLocks = new Map<string, Promise<unknown>>();

/**
 * Runs `fn` with the tournament's lock held.
 *
 * The lock is a chain of promises: every caller appends itself to the
 * tournament's chain and waits for the one before it. A caller that
 * throws does not break the chain for the next one.
 */
async function withTourneyLock<T>(
  tourneyId: string,
  fn: () => Promise<T>,
): Promise<T> {
  const previous = tourneyLocks.get(tourneyId) ?? Promise.resolve();

  const result = previous.then(fn, fn);

  const settled = result.then(
    () => undefined,
    () => undefined,
  );

  tourneyLocks.set(tourneyId, settled);

  void settled.then(() => {
    if (tourneyLocks.get(tourneyId) === settled) {
      tourneyLocks.delete(tourneyId);
    }
  });

  return result;
}

/**
 * Inserts a slot with the next number of its tournament.
 *
 * The allocation, the insert and the member rows share one transaction,
 * so the number cannot be handed out twice and a slot never exists
 * without its team.
 */
export async function insertSlot(
  values: InsertSlotValues,
): Promise<TourneySlotRecord> {
  return withTourneyLock(values.tourneyId, () =>
    withTransaction(async (tx) => {
      const num = await nextSlotNumberIn(tx, values.tourneyId);

      const rows = await tx
        .insert(tourneySlots)
        .values({
          tourneyId: values.tourneyId,
          num,
          teamName: values.teamName,
          leaderId: values.leaderId,
          messageId: values.messageId,
          jumpUrl: values.jumpUrl,
          confirmJumpUrl: values.confirmJumpUrl,
        })
        .returning();

      const row = rows[0];

      if (!row) throw new Error("the tourney slot insert returned no row");

      const members = await writeSlotMembers(
        tx,
        row.id,
        values.leaderId,
        values.members,
      );

      return toSlot(row, members);
    }),
  );
}

/**
 * Swaps the numbers of two slots.
 *
 * **One transaction, three statements.** The source did two independent
 * `UPDATE`s (`TMSlot.get(pk=first.id).update(num=second.num)` and then
 * the reverse), which means the intermediate state has *both* rows on the
 * same number — a violation of `UNIQUE (tourney_id, num)`, and a
 * violation of the source's own M2M uniqueness. It only "worked" because
 * the source's `num` lived on a globally-unique row with no per-tourney
 * constraint.
 *
 * Ours has the constraint, so the swap goes through a temporary number:
 *
 * ```sql
 * UPDATE tourney_slots SET num = -1       WHERE id = $first;   -- park
 * UPDATE tourney_slots SET num = $firstNum WHERE id = $second;
 * UPDATE tourney_slots SET num = $secondNum WHERE id = $first;
 * ```
 *
 * The order matters: the constraint is checked immediately, so the
 * second slot has to take the first one's number **before** the first
 * slot takes the second one's.
 *
 * `-1` cannot collide with a real number: every number comes from the
 * per-tourney sequence and is positive.
 *
 * @returns whether the swap happened.
 */
export async function swapSlotNumbers(
  tourneyId: string,
  firstSlotId: string,
  secondSlotId: string,
): Promise<boolean> {
  if (firstSlotId === secondSlotId) return false;

  return withTransaction(async (tx) => {
    const rows = await tx
      .select()
      .from(tourneySlots)
      .where(
        and(
          eq(tourneySlots.tourneyId, tourneyId),
          inArray(tourneySlots.id, [firstSlotId, secondSlotId]),
        ),
      );

    const first = rows.find((row) => row.id === firstSlotId);
    const second = rows.find((row) => row.id === secondSlotId);

    if (!first || !second) return false;
    if (first.num === second.num) return false;

    const firstNum = first.num;
    const secondNum = second.num;

    await tx
      .update(tourneySlots)
      .set({ num: -1, updatedAt: new Date() })
      .where(eq(tourneySlots.id, firstSlotId));

    // The second slot takes the first one's number, which the parking
    // step has just freed.
    await tx
      .update(tourneySlots)
      .set({ num: firstNum, updatedAt: new Date() })
      .where(eq(tourneySlots.id, secondSlotId));

    // And the first slot takes the second one's number, which the step
    // above has just freed.
    await tx
      .update(tourneySlots)
      .set({ num: secondNum, updatedAt: new Date() })
      .where(eq(tourneySlots.id, firstSlotId));

    return true;
  });
}

/** Writes a slot's team name. */
export async function updateSlotTeamName(
  slotId: string,
  teamName: string,
): Promise<TourneySlotRecord | null> {
  const rows = await db
    .update(tourneySlots)
    .set({ teamName, updatedAt: new Date() })
    .where(eq(tourneySlots.id, slotId))
    .returning();

  const slots = await toSlots(rows);

  return slots[0] ?? null;
}

/** Writes a slot's confirmation message link. */
export async function updateSlotConfirmUrl(
  slotId: string,
  confirmJumpUrl: string,
): Promise<TourneySlotRecord | null> {
  const rows = await db
    .update(tourneySlots)
    .set({ confirmJumpUrl, updatedAt: new Date() })
    .where(eq(tourneySlots.id, slotId))
    .returning();

  const slots = await toSlots(rows);

  return slots[0] ?? null;
}

/** Deletes a slot. */
export async function deleteSlot(slotId: string): Promise<void> {
  await db.delete(tourneySlots).where(eq(tourneySlots.id, slotId));
}

/* ------------------------------------------------------------------ *
 * Bans
 * ------------------------------------------------------------------ */

/** The users banned from a tournament. */
export async function listBannedUserIds(tourneyId: string): Promise<string[]> {
  const rows = await db
    .select({ userId: tourneyBannedUsers.userId })
    .from(tourneyBannedUsers)
    .where(eq(tourneyBannedUsers.tourneyId, tourneyId));

  return rows.map((row) => row.userId);
}

/** Is this user banned from this tournament? */
export async function isBanned(
  tourneyId: string,
  userId: string,
): Promise<boolean> {
  const rows = await db
    .select({ id: tourneyBannedUsers.id })
    .from(tourneyBannedUsers)
    .where(
      and(
        eq(tourneyBannedUsers.tourneyId, tourneyId),
        eq(tourneyBannedUsers.userId, userId),
      ),
    )
    .limit(1);

  return rows.length > 0;
}

/**
 * Bans a user from a tournament.
 *
 * The unique constraint on `(tourney_id, user_id)` makes this
 * idempotent: banning twice updates the row instead of stacking a second
 * one. The source's `ArrayAppend` was a read-modify-write that raced.
 */
export async function banUser(
  tourneyId: string,
  userId: string,
): Promise<void> {
  await db
    .insert(tourneyBannedUsers)
    .values({ tourneyId, userId })
    .onConflictDoNothing();
}

/** Lifts a ban. */
export async function unbanUser(tourneyId: string, userId: string): Promise<void> {
  await db
    .delete(tourneyBannedUsers)
    .where(
      and(
        eq(tourneyBannedUsers.tourneyId, tourneyId),
        eq(tourneyBannedUsers.userId, userId),
      ),
    );
}

/* ------------------------------------------------------------------ *
 * Media partners
 * ------------------------------------------------------------------ */

/** Every media partner of a tournament. */
export async function listMediaPartners(
  tourneyId: string,
): Promise<MediaPartnerRecord[]> {
  const rows = await db
    .select()
    .from(mediaPartners)
    .where(eq(mediaPartners.tourneyId, tourneyId))
    .orderBy(asc(mediaPartners.createdAt));

  return rows.map(toMediaPartner);
}

/** The media partner a channel belongs to. */
export async function getMediaPartnerByChannel(
  channelId: string,
): Promise<MediaPartnerRecord | null> {
  const rows = await db
    .select()
    .from(mediaPartners)
    .where(eq(mediaPartners.channelId, channelId))
    .limit(1);

  const row = rows[0];

  return row ? toMediaPartner(row) : null;
}

/** Every media partner, across every guild. */
export async function listAllMediaPartners(): Promise<MediaPartnerRecord[]> {
  const rows = await db.select().from(mediaPartners);

  return rows.map(toMediaPartner);
}

/** How many media partners a guild has. */
export async function countMediaPartners(guildId: string): Promise<number> {
  const rows = await db
    .select({ value: count() })
    .from(mediaPartners)
    .innerJoin(tourneys, eq(mediaPartners.tourneyId, tourneys.id))
    .where(eq(tourneys.guildId, guildId));

  return rows[0]?.value ?? 0;
}

/**
 * Creates a media partner.
 *
 * The `channel_id` unique constraint makes this idempotent: a channel
 * can be a partner of one tournament only, which is one of the source's
 * own checks.
 */
export async function createMediaPartner(
  tourneyId: string,
  channelId: string,
): Promise<MediaPartnerRecord | null> {
  const rows = await db
    .insert(mediaPartners)
    .values({ tourneyId, channelId })
    .onConflictDoNothing()
    .returning();

  const row = rows[0];

  return row ? toMediaPartner(row) : null;
}

/** Removes a media partner. */
export async function deleteMediaPartner(
  tourneyId: string,
  channelId: string,
): Promise<void> {
  await db
    .delete(mediaPartners)
    .where(
      and(
        eq(mediaPartners.tourneyId, tourneyId),
        eq(mediaPartners.channelId, channelId),
      ),
    );
}

/** Records a registration that came in through a partner channel. */
export async function insertMediaPartnerSlot(
  values: {
    readonly mediaPartnerId: string;
    readonly userId: string;
    readonly messageId: string;
    readonly jumpUrl: string | null;
    readonly members: readonly string[];
  },
): Promise<void> {
  await withTransaction(async (tx) => {
    const rows = await tx
      .insert(mediaPartnerSlots)
      .values({
        mediaPartnerId: values.mediaPartnerId,
        userId: values.userId,
        messageId: values.messageId,
        jumpUrl: values.jumpUrl,
      })
      .returning({ id: mediaPartnerSlots.id });

    const row = rows[0];

    if (!row) throw new Error("the media partner slot insert returned no row");

    // The members are a join table too, so they are written as rows.
    const members = [...new Set([values.userId, ...values.members])];

    if (members.length > 0) {
      await tx
        .insert(mediaPartnerSlotMembers)
        .values(
          members.map((userId) => ({
            mediaPartnerSlotId: row.id,
            userId,
          })),
        )
        .onConflictDoNothing();
    }
  });
}

/** The registrations that came in through a partner channel. */
export async function countMediaPartnerSlots(
  mediaPartnerId: string,
): Promise<number> {
  const rows = await db
    .select({ value: count() })
    .from(mediaPartnerSlots)
    .where(eq(mediaPartnerSlots.mediaPartnerId, mediaPartnerId));

  return rows[0]?.value ?? 0;
}

/** The registrations that came in through a partner channel. */
export async function listMediaPartnerSlots(
  mediaPartnerId: string,
): Promise<MediaPartnerSlotRecord[]> {
  const rows = await db
    .select()
    .from(mediaPartnerSlots)
    .where(eq(mediaPartnerSlots.mediaPartnerId, mediaPartnerId))
    .orderBy(asc(mediaPartnerSlots.createdAt));

  if (rows.length === 0) return [];

  const memberRows = await db
    .select({
      slotId: mediaPartnerSlotMembers.mediaPartnerSlotId,
      userId: mediaPartnerSlotMembers.userId,
    })
    .from(mediaPartnerSlotMembers)
    .where(
      inArray(
        mediaPartnerSlotMembers.mediaPartnerSlotId,
        rows.map((row) => row.id),
      ),
    )
    .orderBy(
      asc(mediaPartnerSlotMembers.createdAt),
      asc(mediaPartnerSlotMembers.userId),
    );

  const members = new Map<string, string[]>();

  for (const row of memberRows) {
    const list = members.get(row.slotId);

    if (list) list.push(row.userId);
    else members.set(row.slotId, [row.userId]);
  }

  return rows.map((row) => toMediaPartnerSlot(row, members.get(row.id) ?? []));
}

/* ------------------------------------------------------------------ *
 * Published group lists
 * ------------------------------------------------------------------ */

/** Every published group list of a tournament. */
export async function listGroupLists(
  tourneyId: string,
): Promise<TourneyGroupListRecord[]> {
  const rows = await db
    .select()
    .from(tourneyGroupLists)
    .where(eq(tourneyGroupLists.tourneyId, tourneyId))
    .orderBy(asc(tourneyGroupLists.groupNumber));

  return rows.map(toGroupList);
}

/**
 * The published group list a message is.
 *
 * The source looked this up by the message id, which is the same thing.
 */
export async function getGroupListByMessage(
  messageId: string,
): Promise<TourneyGroupListRecord | null> {
  const rows = await db
    .select()
    .from(tourneyGroupLists)
    .where(eq(tourneyGroupLists.messageId, messageId))
    .limit(1);

  const row = rows[0];

  return row ? toGroupList(row) : null;
}

/** The published group list of one group. */
export async function getGroupList(
  tourneyId: string,
  groupNumber: number,
): Promise<TourneyGroupListRecord | null> {
  const rows = await db
    .select()
    .from(tourneyGroupLists)
    .where(
      and(
        eq(tourneyGroupLists.tourneyId, tourneyId),
        eq(tourneyGroupLists.groupNumber, groupNumber),
      ),
    )
    .limit(1);

  const row = rows[0];

  return row ? toGroupList(row) : null;
}

/**
 * Records a published group list.
 *
 * The source deleted the old row and created a new one, because the
 * `(tourney, group)` pair had to be unique. Ours upserts, so republishing
 * a group replaces the row and the old message id stops resolving.
 */
export async function upsertGroupList(
  values: {
    readonly tourneyId: string;
    readonly messageId: string;
    readonly channelId: string;
    readonly groupNumber: number;
  },
): Promise<TourneyGroupListRecord> {
  const rows = await db
    .insert(tourneyGroupLists)
    .values(values)
    .onConflictDoUpdate({
      target: [tourneyGroupLists.tourneyId, tourneyGroupLists.groupNumber],
      set: {
        messageId: values.messageId,
        channelId: values.channelId,
        updatedAt: new Date(),
      },
    })
    .returning();

  const row = rows[0];

  if (!row) throw new Error("the group list insert returned no row");

  return toGroupList(row);
}

/**
 * Writes the refresh timestamp of a published group list.
 *
 * **This is the only function that updates a `tourney_group_lists` row.**
 * The source's `refresh_at` was an `auto_now` column, so the two-minute
 * cooldown depended on the last write of *any* kind (B16). Here the
 * timestamp is a plain one, and only the refresh path writes it.
 *
 * S4 folds the source's `refresh_at` into `updated_at`, so that is the
 * column the cooldown reads.
 */
export async function touchGroupList(
  id: string,
  when: Date = new Date(),
): Promise<void> {
  await db
    .update(tourneyGroupLists)
    .set({ updatedAt: when })
    .where(eq(tourneyGroupLists.id, id));
}

/** Deletes a published group list. */
export async function deleteGroupList(id: string): Promise<void> {
  await db.delete(tourneyGroupLists).where(eq(tourneyGroupLists.id, id));
}

/* ------------------------------------------------------------------ *
 * Jobs
 * ------------------------------------------------------------------ */

/**
 * The job event that opens a tournament on schedule.
 *
 * The name is in the `jobs_event_check` constraint: the constraint is
 * generated from `JOB_EVENTS` in `db/schema/common.ts`, and the
 * migration that added it has been applied. The row the dispatcher
 * deletes before it dispatches it is the only copy of the schedule —
 * see `service.getSchedule`.
 */
export const TOURNEY_JOB_EVENT = "tourney_open";

/** The payload of a tournament job. */
export interface TourneyJobPayload {
  readonly tourneyId: string;
  readonly [key: string]: unknown;
}

/**
 * Arms a job for a tournament.
 *
 * The scheduler is the durable `jobs` table, never a `setTimeout`: a
 * timer that dies with the process means the tournament never opens
 * again.
 */
export async function scheduleTourneyJob(
  event: string,
  expiresAt: Date,
  payload: TourneyJobPayload,
): Promise<string> {
  const rows = await db
    .insert(jobs)
    .values({ event, expiresAt, payload })
    .returning({ id: jobs.id });

  const id = rows[0]?.id;

  if (!id) throw new Error("the job insert returned no id");

  return id;
}

/**
 * Replaces the job of one kind for one tournament.
 *
 * The source deleted the old timer and created a new one whenever the
 * schedule changed. Same here, so there is never two timers for one
 * tournament.
 */
export async function replaceTourneyJob(
  event: string,
  tourneyId: string,
  expiresAt: Date,
  payload: TourneyJobPayload = { tourneyId },
): Promise<string> {
  await deleteTourneyJobs(event, tourneyId);

  return scheduleTourneyJob(event, expiresAt, payload);
}

/** Deletes every job of one kind for one tournament. */
export async function deleteTourneyJobs(
  event: string,
  tourneyId: string,
): Promise<void> {
  await db
    .delete(jobs)
    .where(
      and(
        eq(jobs.event, event),
        sql`${jobs.payload} ->> 'tourneyId' = ${tourneyId}`,
      ),
    );
}

/** The jobs of one kind for one tournament. */
export async function listTourneyJobs(
  event: string,
  tourneyId: string,
): Promise<{ id: string; expiresAt: Date; payload: unknown }[]> {
  const rows = await db
    .select({ id: jobs.id, expiresAt: jobs.expiresAt, payload: jobs.payload })
    .from(jobs)
    .where(
      and(
        eq(jobs.event, event),
        sql`${jobs.payload} ->> 'tourneyId' = ${tourneyId}`,
      ),
    );

  return rows;
}

/** The tournament id a job is about. */
export function tourneyIdOf(payload: unknown): string | null {
  if (typeof payload !== "object" || payload === null) return null;

  const tourneyId = (payload as Record<string, unknown>).tourneyId;

  return typeof tourneyId === "string" ? tourneyId : null;
}

/* ------------------------------------------------------------------ *
 * The message-delete job
 * ------------------------------------------------------------------ */

/**
 * The job event that deletes a message.
 *
 * The name is in the `jobs_event_check` constraint — see `JOB_EVENTS` in
 * `db/schema/common.ts`. This area both **produces** the row (the
 * room-credential post arms one for itself) and **handles** it
 * (`modules/tourneys/jobs.ts`).
 */
export const MSG_DELETE_JOB_EVENT = "msg_delete";

/**
 * The payload of a message-delete job.
 *
 * **It carries no secret.** The deletion only has to know *which*
 * message to delete, so the payload carries the channel id and the
 * message id — never the text of the message, and never a password. A
 * job row is a row in a table that is read, logged and copied around; it
 * is not a place a credential can go.
 *
 * It is a type alias rather than an interface because the column it is
 * written to is a JSON column, and a JSON column takes a
 * `Record<string, unknown>`: an interface has no implicit index
 * signature, a type alias of an object literal type has one.
 */
export type MessageDeleteJobPayload = {
  /** The channel the message is in. */
  readonly channelId: string;
  /** The message to delete. */
  readonly messageId: string;
};

/**
 * Arms the deletion of a message.
 *
 * The scheduler is the durable `jobs` table, never a `setTimeout`: a
 * timer that dies with the process means the message stays in the
 * channel — and a room password that stays in a channel is the problem
 * this job exists to solve (D39).
 */
export async function scheduleMessageDelete(
  payload: MessageDeleteJobPayload,
  expiresAt: Date,
): Promise<string> {
  const rows = await db
    .insert(jobs)
    .values({ event: MSG_DELETE_JOB_EVENT, expiresAt, payload })
    .returning({ id: jobs.id });

  const id = rows[0]?.id;

  if (!id) throw new Error("the job insert returned no id");

  return id;
}

/**
 * The message-delete jobs that are armed.
 *
 * Every one of them carries a channel id and a message id, and nothing
 * else — see {@link MessageDeleteJobPayload}.
 */
export async function listMessageDeleteJobs(): Promise<
  { id: string; expiresAt: Date; payload: unknown }[]
> {
  const rows = await db
    .select({ id: jobs.id, expiresAt: jobs.expiresAt, payload: jobs.payload })
    .from(jobs)
    .where(eq(jobs.event, MSG_DELETE_JOB_EVENT));

  return rows;
}

/**
 * The schedule a job payload carries.
 *
 * The `tourneys` table has no schedule column, so the schedule lives in
 * the payload of the job row that opens the tournament.
 */
export function scheduleOf(payload: unknown): TourneySchedule | null {
  if (typeof payload !== "object" || payload === null) return null;

  const record = payload as Record<string, unknown>;

  const openDays = Array.isArray(record.openDays)
    ? record.openDays.filter((day): day is string => typeof day === "string")
    : [];

  const openTime = typeof record.openTime === "string" ? record.openTime : "18:00";

  return { openDays, openTime };
}
