/**
 * Esports schema: scrims, their slots, and tournaments.
 *
 * The two redesigns that matter live here:
 *
 *  - D14: a slot is a row with a `state` column. There is no
 *    `available_slots` array and no M2M join table, so a claim is one
 *    conditional UPDATE and the database — not a process-global lock —
 *    guarantees that a slot has exactly one owner.
 *  - D25: a tourney slot is a row that belongs to exactly one tourney.
 *    `num` is a per-tourney position, so it is unique per tourney and not
 *    per row.
 */

import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  smallint,
  text,
  timestamp,
  unique,
} from "drizzle-orm/pg-core";
import {
  AUTOCLEAN_KINDS,
  SCRIM_STATUSES,
  SLOT_STATES,
  TOURNEY_STATUSES,
  WEEKDAYS,
  arrayContainedInCheck,
  createdAt,
  discordId,
  discordIdArray,
  foreignId,
  oneOfCheck,
  primaryId,
  updatedAt,
} from "./common.js";

/* ------------------------------------------------------------------ *
 * Scrims
 * ------------------------------------------------------------------ */

export const scrims = pgTable(
  "scrims",
  {
    id: primaryId(),
    guildId: discordId("guild_id").notNull(),
    name: text("name").notNull().default("Quotient-Scrims"),
    /**
     * D26: the lifecycle is a value, not a pair of nullable timestamps.
     * Quotient derived "open" and "closed" from `opened_at`/`closed_at` and
     * could not tell "paused" from "closed" at all.
     */
    status: text("status").notNull().default("draft"),
    registrationChannelId: discordId("registration_channel_id").notNull(),
    slotlistChannelId: discordId("slotlist_channel_id").notNull(),
    slotlistMessageId: discordId("slotlist_message_id"),
    roleId: discordId("role_id"),
    openRoleId: discordId("open_role_id"),
    pingRoleId: discordId("ping_role_id"),
    hostId: discordId("host_id").notNull(),
    requiredMentions: integer("required_mentions").notNull().default(4),
    requiredLines: smallint("required_lines").notNull().default(0),
    /** The first slot number; slots run from here to `total_slots`. */
    startFrom: integer("start_from").notNull().default(1),
    totalSlots: integer("total_slots").notNull(),
    openTime: timestamp("open_time", { withTimezone: true, mode: "date" }).notNull(),
    openedAt: timestamp("opened_at", { withTimezone: true, mode: "date" }),
    closedAt: timestamp("closed_at", { withTimezone: true, mode: "date" }),
    matchTime: timestamp("match_time", { withTimezone: true, mode: "date" }),
    /** What the autoclean pass removes when the match ends. */
    autoclean: text("autoclean")
      .array()
      .notNull()
      .default(sql.raw(`'{"${AUTOCLEAN_KINDS.join('","')}"}'::text[]`)),
    autocleanTime: timestamp("autoclean_time", {
      withTimezone: true,
      mode: "date",
    }),
    autoslotlist: boolean("autoslotlist").notNull().default(true),
    multiregister: boolean("multiregister").notNull().default(false),
    /**
     * S4: the source called this `stoggle`, a typo of "toggle" that
     * collided with `slot_managers.toggle`. Two different meanings, two
     * tables, two names.
     */
    enabled: boolean("enabled").notNull().default(true),
    autodeleteRejects: boolean("autodelete_rejects").notNull().default(false),
    autodeleteExtras: boolean("autodelete_extras").notNull().default(true),
    teamnameCompulsion: boolean("teamname_compulsion").notNull().default(false),
    noDuplicateName: boolean("no_duplicate_name").notNull().default(false),
    allowDuplicateTags: boolean("allow_duplicate_tags").notNull().default(true),
    /**
     * S4: the source stored a pre-formatted sentence ("2 hours 3 minutes").
     * Ours stores the duration in seconds and formats it at render time.
     */
    timeElapsedSeconds: integer("time_elapsed_seconds"),
    openDays: text("open_days")
      .array()
      .notNull()
      .default(sql.raw(`'{"${WEEKDAYS.join('","')}"}'::text[]`)),
    /** D32: embed templates are JSON, not Python literal strings. */
    slotlistFormat: jsonb("slotlist_format").notNull().default(sql`'{}'::jsonb`),
    openMessage: jsonb("open_message").notNull().default(sql`'{}'::jsonb`),
    closeMessage: jsonb("close_message").notNull().default(sql`'{}'::jsonb`),
    emojis: jsonb("emojis").notNull().default(sql`'{}'::jsonb`),
    cdn: jsonb("cdn")
      .notNull()
      .default(sql`'{"status": false, "countdown": 3, "msg": {}}'::jsonb`),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("scrims_guild_id_idx").on(t.guildId),
    // One scrim per registration channel. The source enforced this in
    // application code by reading then writing, which races.
    unique("scrims_registration_channel_id_unique").on(t.registrationChannelId),
    oneOfCheck("scrims_status_check", t.status, SCRIM_STATUSES),
    arrayContainedInCheck("scrims_autoclean_check", t.autoclean, AUTOCLEAN_KINDS),
    arrayContainedInCheck("scrims_open_days_check", t.openDays, WEEKDAYS),
  ],
);

/**
 * One row per scrim slot, always — a free slot is a row with
 * `state = 'free'`, not a missing row (D14).
 *
 * The claim is a single statement:
 *
 * ```sql
 * UPDATE slots
 *    SET state = 'claimed', team_name = $3, owner_user_id = $4, members = $5
 *  WHERE scrim_id = $1 AND num = $2 AND state = 'free'
 *  RETURNING id;
 * ```
 *
 * Zero rows updated means somebody else won the race. The database enforces
 * the invariant; there is no lock and no read-modify-write anywhere.
 */
export const slots = pgTable(
  "slots",
  {
    id: primaryId(),
    scrimId: foreignId("scrim_id")
      .notNull()
      .references(() => scrims.id, { onDelete: "cascade" }),
    num: integer("num").notNull(),
    state: text("state").notNull().default("free"),
    teamName: text("team_name"),
    ownerUserId: discordId("owner_user_id"),
    /** The whole team, not just the captain — the IDP transfer needs it (B3). */
    members: discordIdArray("members")
      .notNull()
      .default(sql`'{}'::text[]`),
    messageId: discordId("message_id"),
    jumpUrl: text("jump_url"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique("slots_scrim_id_num_unique").on(t.scrimId, t.num),
    index("slots_scrim_id_state_idx").on(t.scrimId, t.state),
    oneOfCheck("slots_state_check", t.state, SLOT_STATES),
    // A claimed slot without an owner could never be cancelled or transferred.
    check(
      "slots_claimed_has_owner_check",
      sql`${t.state} <> 'claimed' or ${t.ownerUserId} is not null`,
    ),
  ],
);

/**
 * Slots a host set aside for somebody before registration opened.
 *
 * Quotient modelled these as a many-to-many relation, but every reserved
 * slot belongs to exactly one scrim — the host reserves it *for that
 * scrim*. The relation columns are inlined here instead of being split
 * across a join table, and `UNIQUE (scrim_id, num)` keeps one reservation
 * per slot number.
 */
export const reservedSlots = pgTable(
  "reserved_slots",
  {
    id: primaryId(),
    scrimId: foreignId("scrim_id")
      .notNull()
      .references(() => scrims.id, { onDelete: "cascade" }),
    num: integer("num").notNull(),
    userId: discordId("user_id"),
    teamName: text("team_name"),
    members: discordIdArray("members")
      .notNull()
      .default(sql`'{}'::text[]`),
    expires: timestamp("expires", { withTimezone: true, mode: "date" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique("reserved_slots_scrim_id_num_unique").on(t.scrimId, t.num),
    index("reserved_slots_scrim_id_idx").on(t.scrimId),
  ],
);

/**
 * A team banned from a scrim.
 *
 * `UNIQUE (scrim_id, user_id)` makes a ban idempotent: re-banning the same
 * user in the same scrim updates the existing row instead of stacking
 * duplicates, which is what the read-then-write in Quotient's `ban_slot`
 * could not guarantee.
 */
export const bannedTeams = pgTable(
  "banned_teams",
  {
    id: primaryId(),
    scrimId: foreignId("scrim_id")
      .notNull()
      .references(() => scrims.id, { onDelete: "cascade" }),
    num: integer("num").notNull().default(0),
    userId: discordId("user_id").notNull(),
    teamName: text("team_name"),
    members: discordIdArray("members")
      .notNull()
      .default(sql`'{}'::text[]`),
    reason: text("reason"),
    expires: timestamp("expires", { withTimezone: true, mode: "date" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique("banned_teams_scrim_id_user_id_unique").on(t.scrimId, t.userId),
    index("banned_teams_scrim_id_idx").on(t.scrimId),
  ],
);

/** The channel a guild's ban log is written to. One per guild. */
export const banLogs = pgTable(
  "ban_logs",
  {
    id: primaryId(),
    guildId: discordId("guild_id").notNull(),
    channelId: discordId("channel_id").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [unique("ban_logs_guild_id_unique").on(t.guildId)],
);

/**
 * "Tell me when a slot frees up" — one row per (scrim, user).
 *
 * Quotient shared one reminder row between every scrim it was attached to
 * and deleted the whole row when the first of them fired, silently
 * unsubscribing the user from the rest. Keying the row by (scrim, user)
 * makes the dispatch independent per scrim.
 */
export const slotReminders = pgTable(
  "slot_reminders",
  {
    id: primaryId(),
    scrimId: foreignId("scrim_id")
      .notNull()
      .references(() => scrims.id, { onDelete: "cascade" }),
    userId: discordId("user_id").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique("slot_reminders_scrim_id_user_id_unique").on(t.scrimId, t.userId),
    index("slot_reminders_user_id_idx").on(t.userId),
  ],
);

/**
 * The public "cancel / claim a slot" panel.
 *
 * Which scrims it shows is a many-to-many relation, so it gets a real join
 * table. A scrim may sit in at most one panel, which is why the join table
 * also carries a unique constraint on `scrim_id` alone.
 */
export const slotManagers = pgTable(
  "slot_managers",
  {
    id: primaryId(),
    guildId: discordId("guild_id").notNull(),
    mainChannelId: discordId("main_channel_id").notNull(),
    messageId: discordId("message_id").notNull(),
    toggle: boolean("toggle").notNull().default(true),
    allowReminders: boolean("allow_reminders").notNull().default(true),
    multipleSlots: boolean("multiple_slots").notNull().default(false),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("slot_managers_guild_id_idx").on(t.guildId),
    unique("slot_managers_main_channel_id_unique").on(t.mainChannelId),
  ],
);

export const slotManagerScrims = pgTable(
  "slot_manager_scrims",
  {
    id: primaryId(),
    slotManagerId: foreignId("slot_manager_id")
      .notNull()
      .references(() => slotManagers.id, { onDelete: "cascade" }),
    scrimId: foreignId("scrim_id")
      .notNull()
      .references(() => scrims.id, { onDelete: "cascade" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique("slot_manager_scrims_slot_manager_id_scrim_id_unique").on(
      t.slotManagerId,
      t.scrimId,
    ),
    unique("slot_manager_scrims_scrim_id_unique").on(t.scrimId),
  ],
);

/* ------------------------------------------------------------------ *
 * Tournaments
 * ------------------------------------------------------------------ */

export const tourneys = pgTable(
  "tourneys",
  {
    id: primaryId(),
    guildId: discordId("guild_id").notNull(),
    name: text("name").notNull().default("Quotient-Tourney"),
    /** D26: same explicit lifecycle as scrims, plus `paused`. */
    status: text("status").notNull().default("draft"),
    registrationChannelId: discordId("registration_channel_id").notNull(),
    confirmChannelId: discordId("confirm_channel_id").notNull(),
    roleId: discordId("role_id").notNull(),
    openRoleId: discordId("open_role_id"),
    pingRoleId: discordId("ping_role_id"),
    hostId: discordId("host_id").notNull(),
    requiredMentions: smallint("required_mentions").notNull().default(4),
    requiredLines: smallint("required_lines").notNull().default(0),
    totalSlots: smallint("total_slots").notNull(),
    startedAt: timestamp("started_at", { withTimezone: true, mode: "date" }),
    closedAt: timestamp("closed_at", { withTimezone: true, mode: "date" }),
    multiregister: boolean("multiregister").notNull().default(false),
    teamnameCompulsion: boolean("teamname_compulsion")
      .notNull()
      .default(false),
    noDuplicateName: boolean("no_duplicate_name").notNull().default(true),
    autodeleteRejects: boolean("autodelete_rejects").notNull().default(false),
    allowDuplicateTags: boolean("allow_duplicate_tags").notNull().default(true),
    /**
     * S4: the source called this `slotlist_start` and the decision log
     * says *both* names are wrong. It is `start_from`, same as the scrim's.
     */
    startFrom: smallint("start_from").notNull().default(2),
    /** How many teams share a group. Null until the groups are drawn. */
    groupSize: smallint("group_size"),
    successMessage: text("success_message"),
    emojis: jsonb("emojis")
      .notNull()
      .default(sql`'{"tick": "✅", "cross": "❌"}'::jsonb`),
    slotmChannelId: discordId("slotm_channel_id"),
    slotmMessageId: discordId("slotm_message_id"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("tourneys_guild_id_idx").on(t.guildId),
    unique("tourneys_registration_channel_id_unique").on(t.registrationChannelId),
    oneOfCheck("tourneys_status_check", t.status, TOURNEY_STATUSES),
  ],
);

/**
 * A registered team in a tournament (D25).
 *
 * `num` is a position *within the tourney*, so it is unique per tourney and
 * not per row. "Swap Groups" rewrites two `num` values, which collides with
 * the unique constraint mid-update — do it as a two-step swap through a
 * temporary number inside one transaction, not as a single statement.
 */
export const tourneySlots = pgTable(
  "tourney_slots",
  {
    id: primaryId(),
    tourneyId: foreignId("tourney_id")
      .notNull()
      .references(() => tourneys.id, { onDelete: "cascade" }),
    num: integer("num").notNull(),
    teamName: text("team_name").notNull(),
    leaderId: discordId("leader_id").notNull(),
    /**
     * The team members. Kept as an array because the fake-tag check is an
     * array overlap (`$2 && members`) and the members have no natural key
     * of their own.
     */
    members: discordIdArray("members")
      .notNull()
      .default(sql`'{}'::text[]`),
    messageId: discordId("message_id"),
    jumpUrl: text("jump_url"),
    confirmJumpUrl: text("confirm_jump_url"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique("tourney_slots_tourney_id_num_unique").on(t.tourneyId, t.num),
    index("tourney_slots_tourney_id_idx").on(t.tourneyId),
  ],
);

/**
 * Users banned from a tournament (D25).
 *
 * Quotient kept this in a `bigint[]` and mutated it with ARRAY_APPEND /
 * ARRAY_REMOVE — a read-modify-write that races under concurrent bans. A
 * join table with a unique key is idempotent: banning twice is a no-op.
 */
export const tourneyBannedUsers = pgTable(
  "tourney_banned_users",
  {
    id: primaryId(),
    tourneyId: foreignId("tourney_id")
      .notNull()
      .references(() => tourneys.id, { onDelete: "cascade" }),
    userId: discordId("user_id").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique("tourney_banned_users_tourney_id_user_id_unique").on(
      t.tourneyId,
      t.userId,
    ),
  ],
);

/** A media-partner channel attached to a tournament. */
export const mediaPartners = pgTable(
  "media_partners",
  {
    id: primaryId(),
    tourneyId: foreignId("tourney_id")
      .notNull()
      .references(() => tourneys.id, { onDelete: "cascade" }),
    channelId: discordId("channel_id").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique("media_partners_channel_id_unique").on(t.channelId),
    index("media_partners_tourney_id_idx").on(t.tourneyId),
  ],
);

/**
 * A team that registered through a media-partner channel.
 *
 * The source's table was `tm.media_partner_users` plus a join table; ours
 * is one table with `media_partner_id` as a plain column.
 */
export const mediaPartnerSlots = pgTable(
  "media_partner_slots",
  {
    id: primaryId(),
    mediaPartnerId: foreignId("media_partner_id")
      .notNull()
      .references(() => mediaPartners.id, { onDelete: "cascade" }),
    userId: discordId("user_id").notNull(),
    messageId: discordId("message_id").notNull(),
    jumpUrl: text("jump_url"),
    members: discordIdArray("members")
      .notNull()
      .default(sql`'{}'::text[]`),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("media_partner_slots_media_partner_id_idx").on(t.mediaPartnerId),
  ],
);

/**
 * A published group list (the standings board for one group).
 *
 * The channel id is stored on the row (D16 / B15): Quotient re-discovered it
 * by substring match, so "Group 1" could pick up "Group 10"'s channel.
 *
 * S4 folds the source's `refresh_at` into `updated_at`: a group list row is
 * created once and then only ever written by the refresh path, so its
 * modification time *is* the last refresh time. The two-minute cooldown
 * reads `updated_at`.
 */
export const tourneyGroupLists = pgTable(
  "tourney_group_lists",
  {
    id: primaryId(),
    tourneyId: foreignId("tourney_id")
      .notNull()
      .references(() => tourneys.id, { onDelete: "cascade" }),
    messageId: discordId("message_id").notNull(),
    channelId: discordId("channel_id").notNull(),
    groupNumber: smallint("group_number").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique("tourney_group_lists_message_id_unique").on(t.messageId),
    unique("tourney_group_lists_tourney_id_group_number_unique").on(
      t.tourneyId,
      t.groupNumber,
    ),
  ],
);
