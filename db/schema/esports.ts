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
 *
 * **Every list of ids is a join table.** Postgres has arrays and SQLite
 * does not, so a column that holds a list cannot be written in a dialect
 * both engines understand. The lists are therefore normalised: `slots`
 * has `slot_members`, `tourney_slots` has `tourney_slot_members`, and so
 * on. The overlap checks that used to be the array operator `&&` become a
 * join, which is faster than the operator was.
 */

import { sql } from "drizzle-orm";
import {
  AUTOCLEAN_KINDS,
  SCRIM_STATUSES,
  SLOT_STATES,
  TOURNEY_STATUSES,
  WEEKDAYS,
  oneOfCheck,
} from "./common.js";
import {
  boolCol,
  check,
  createdAtCol,
  defineTable,
  foreignIdCol,
  idCol,
  index,
  intCol,
  jsonCol,
  smallIntCol,
  textCol,
  tsCol,
  unique,
  updatedAtCol,
} from "../dialect.js";

/* ------------------------------------------------------------------ *
 * Scrims
 * ------------------------------------------------------------------ */

export const scrims = defineTable(
  "scrims",
  {
    id: idCol(),
    guildId: textCol("guild_id").notNull(),
    name: textCol("name").notNull().default("Quotient-Scrims"),
    /**
     * D26: the lifecycle is a value, not a pair of nullable timestamps.
     * Quotient derived "open" and "closed" from `opened_at`/`closed_at` and
     * could not tell "paused" from "closed" at all.
     */
    status: textCol("status").notNull().default("draft"),
    registrationChannelId: textCol("registration_channel_id").notNull(),
    slotlistChannelId: textCol("slotlist_channel_id").notNull(),
    slotlistMessageId: textCol("slotlist_message_id"),
    roleId: textCol("role_id"),
    openRoleId: textCol("open_role_id"),
    pingRoleId: textCol("ping_role_id"),
    hostId: textCol("host_id").notNull(),
    requiredMentions: intCol("required_mentions").notNull().default(4),
    requiredLines: smallIntCol("required_lines").notNull().default(0),
    /** The first slot number; slots run from here to `total_slots`. */
    startFrom: intCol("start_from").notNull().default(1),
    totalSlots: intCol("total_slots").notNull(),
    openTime: tsCol("open_time").notNull(),
    openedAt: tsCol("opened_at"),
    closedAt: tsCol("closed_at"),
    matchTime: tsCol("match_time"),
    /**
     * When the autoclean pass runs. *What* it removes is in
     * `scrim_autoclean` — one row per kind.
     */
    autocleanTime: tsCol("autoclean_time"),
    autoslotlist: boolCol("autoslotlist").notNull().default(true),
    multiregister: boolCol("multiregister").notNull().default(false),
    /**
     * S4: the source called this `stoggle`, a typo of "toggle" that
     * collided with `slot_managers.toggle`. Two different meanings, two
     * tables, two names.
     */
    enabled: boolCol("enabled").notNull().default(true),
    autodeleteRejects: boolCol("autodelete_rejects").notNull().default(false),
    autodeleteExtras: boolCol("autodelete_extras").notNull().default(true),
    teamnameCompulsion: boolCol("teamname_compulsion").notNull().default(false),
    noDuplicateName: boolCol("no_duplicate_name").notNull().default(false),
    allowDuplicateTags: boolCol("allow_duplicate_tags").notNull().default(true),
    /**
     * S4: the source stored a pre-formatted sentence ("2 hours 3 minutes").
     * Ours stores the duration in seconds and formats it at render time.
     */
    timeElapsedSeconds: intCol("time_elapsed_seconds"),
    /** D32: embed templates are JSON, not Python literal strings. */
    slotlistFormat: jsonCol<Record<string, unknown>>("slotlist_format", {}),
    openMessage: jsonCol<Record<string, unknown>>("open_message", {}),
    closeMessage: jsonCol<Record<string, unknown>>("close_message", {}),
    emojis: jsonCol<Record<string, unknown>>("emojis", {}),
    cdn: jsonCol<Record<string, unknown>>("cdn", {
      status: false,
      countdown: 3,
      msg: {},
    }),
    createdAt: createdAtCol(),
    updatedAt: updatedAtCol(),
  },
  (t) => [
    index("scrims_guild_id_idx").on(t.guildId),
    // One scrim per registration channel. The source enforced this in
    // application code by reading then writing, which races.
    unique("scrims_registration_channel_id_unique").on(t.registrationChannelId),
    oneOfCheck("scrims_status_check", t.status, SCRIM_STATUSES),
  ],
);

/**
 * The days a scrim may be opened on.
 *
 * One row per (scrim, weekday). An empty set means "no restriction" — the
 * same meaning the source's `open_days` array had.
 */
export const scrimOpenDays = defineTable(
  "scrim_open_days",
  {
    id: idCol(),
    scrimId: foreignIdCol("scrim_id")
      .notNull()
      .references(() => scrims.id, { onDelete: "cascade" }),
    day: textCol("day").notNull(),
    createdAt: createdAtCol(),
    updatedAt: updatedAtCol(),
  },
  (t) => [
    unique("scrim_open_days_scrim_id_day_unique").on(t.scrimId, t.day),
    index("scrim_open_days_scrim_id_idx").on(t.scrimId),
    oneOfCheck("scrim_open_days_day_check", t.day, WEEKDAYS),
  ],
);

/**
 * What a scrim's autoclean pass removes when the match ends.
 *
 * One row per (scrim, kind). `kind` is `channel` or `role`.
 */
export const scrimAutoclean = defineTable(
  "scrim_autoclean",
  {
    id: idCol(),
    scrimId: foreignIdCol("scrim_id")
      .notNull()
      .references(() => scrims.id, { onDelete: "cascade" }),
    kind: textCol("kind").notNull(),
    createdAt: createdAtCol(),
    updatedAt: updatedAtCol(),
  },
  (t) => [
    unique("scrim_autoclean_scrim_id_kind_unique").on(t.scrimId, t.kind),
    index("scrim_autoclean_scrim_id_idx").on(t.scrimId),
    oneOfCheck("scrim_autoclean_kind_check", t.kind, AUTOCLEAN_KINDS),
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
 *    SET state = 'claimed', team_name = $3, owner_user_id = $4
 *  WHERE scrim_id = $1 AND num = $2 AND state = 'free'
 *  RETURNING id;
 * ```
 *
 * Zero rows updated means somebody else won the race. The database enforces
 * the invariant; there is no lock and no read-modify-write anywhere. The
 * team members go into `slot_members` in the same transaction.
 */
export const slots = defineTable(
  "slots",
  {
    id: idCol(),
    scrimId: foreignIdCol("scrim_id")
      .notNull()
      .references(() => scrims.id, { onDelete: "cascade" }),
    num: intCol("num").notNull(),
    state: textCol("state").notNull().default("free"),
    teamName: textCol("team_name"),
    ownerUserId: textCol("owner_user_id"),
    messageId: textCol("message_id"),
    jumpUrl: textCol("jump_url"),
    createdAt: createdAtCol(),
    updatedAt: updatedAtCol(),
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
 * The team that holds a slot.
 *
 * One row per (slot, member). The fake-tag check — "does any other
 * claimed slot in this scrim already hold one of these players?" — is a
 * join against this table.
 */
export const slotMembers = defineTable(
  "slot_members",
  {
    id: idCol(),
    slotId: foreignIdCol("slot_id")
      .notNull()
      .references(() => slots.id, { onDelete: "cascade" }),
    userId: textCol("user_id").notNull(),
    createdAt: createdAtCol(),
    updatedAt: updatedAtCol(),
  },
  (t) => [
    unique("slot_members_slot_id_user_id_unique").on(t.slotId, t.userId),
    index("slot_members_user_id_idx").on(t.userId),
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
export const reservedSlots = defineTable(
  "reserved_slots",
  {
    id: idCol(),
    scrimId: foreignIdCol("scrim_id")
      .notNull()
      .references(() => scrims.id, { onDelete: "cascade" }),
    num: intCol("num").notNull(),
    userId: textCol("user_id"),
    teamName: textCol("team_name"),
    expires: tsCol("expires"),
    createdAt: createdAtCol(),
    updatedAt: updatedAtCol(),
  },
  (t) => [
    unique("reserved_slots_scrim_id_num_unique").on(t.scrimId, t.num),
    index("reserved_slots_scrim_id_idx").on(t.scrimId),
  ],
);

/** The members a reserved slot was reserved for. */
export const reservedSlotMembers = defineTable(
  "reserved_slot_members",
  {
    id: idCol(),
    reservedSlotId: foreignIdCol("reserved_slot_id")
      .notNull()
      .references(() => reservedSlots.id, { onDelete: "cascade" }),
    userId: textCol("user_id").notNull(),
    createdAt: createdAtCol(),
    updatedAt: updatedAtCol(),
  },
  (t) => [
    unique("reserved_slot_members_reserved_slot_id_user_id_unique").on(
      t.reservedSlotId,
      t.userId,
    ),
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
export const bannedTeams = defineTable(
  "banned_teams",
  {
    id: idCol(),
    scrimId: foreignIdCol("scrim_id")
      .notNull()
      .references(() => scrims.id, { onDelete: "cascade" }),
    num: intCol("num").notNull().default(0),
    userId: textCol("user_id").notNull(),
    teamName: textCol("team_name"),
    reason: textCol("reason"),
    expires: tsCol("expires"),
    createdAt: createdAtCol(),
    updatedAt: updatedAtCol(),
  },
  (t) => [
    unique("banned_teams_scrim_id_user_id_unique").on(t.scrimId, t.userId),
    index("banned_teams_scrim_id_idx").on(t.scrimId),
  ],
);

/**
 * The members of a banned team.
 *
 * The ban survives a rename because the ids are stored, not the names.
 */
export const bannedTeamMembers = defineTable(
  "banned_team_members",
  {
    id: idCol(),
    bannedTeamId: foreignIdCol("banned_team_id")
      .notNull()
      .references(() => bannedTeams.id, { onDelete: "cascade" }),
    userId: textCol("user_id").notNull(),
    createdAt: createdAtCol(),
    updatedAt: updatedAtCol(),
  },
  (t) => [
    unique("banned_team_members_banned_team_id_user_id_unique").on(
      t.bannedTeamId,
      t.userId,
    ),
  ],
);

/** The channel a guild's ban log is written to. One per guild. */
export const banLogs = defineTable(
  "ban_logs",
  {
    id: idCol(),
    guildId: textCol("guild_id").notNull(),
    channelId: textCol("channel_id").notNull(),
    createdAt: createdAtCol(),
    updatedAt: updatedAtCol(),
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
export const slotReminders = defineTable(
  "slot_reminders",
  {
    id: idCol(),
    scrimId: foreignIdCol("scrim_id")
      .notNull()
      .references(() => scrims.id, { onDelete: "cascade" }),
    userId: textCol("user_id").notNull(),
    createdAt: createdAtCol(),
    updatedAt: updatedAtCol(),
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
export const slotManagers = defineTable(
  "slot_managers",
  {
    id: idCol(),
    guildId: textCol("guild_id").notNull(),
    mainChannelId: textCol("main_channel_id").notNull(),
    messageId: textCol("message_id").notNull(),
    toggle: boolCol("toggle").notNull().default(true),
    allowReminders: boolCol("allow_reminders").notNull().default(true),
    multipleSlots: boolCol("multiple_slots").notNull().default(false),
    createdAt: createdAtCol(),
    updatedAt: updatedAtCol(),
  },
  (t) => [
    index("slot_managers_guild_id_idx").on(t.guildId),
    unique("slot_managers_main_channel_id_unique").on(t.mainChannelId),
  ],
);

export const slotManagerScrims = defineTable(
  "slot_manager_scrims",
  {
    id: idCol(),
    slotManagerId: foreignIdCol("slot_manager_id")
      .notNull()
      .references(() => slotManagers.id, { onDelete: "cascade" }),
    scrimId: foreignIdCol("scrim_id")
      .notNull()
      .references(() => scrims.id, { onDelete: "cascade" }),
    createdAt: createdAtCol(),
    updatedAt: updatedAtCol(),
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

export const tourneys = defineTable(
  "tourneys",
  {
    id: idCol(),
    guildId: textCol("guild_id").notNull(),
    name: textCol("name").notNull().default("Quotient-Tourney"),
    /** D26: same explicit lifecycle as scrims, plus `paused`. */
    status: textCol("status").notNull().default("draft"),
    registrationChannelId: textCol("registration_channel_id").notNull(),
    confirmChannelId: textCol("confirm_channel_id").notNull(),
    roleId: textCol("role_id").notNull(),
    openRoleId: textCol("open_role_id"),
    pingRoleId: textCol("ping_role_id"),
    hostId: textCol("host_id").notNull(),
    requiredMentions: smallIntCol("required_mentions").notNull().default(4),
    requiredLines: smallIntCol("required_lines").notNull().default(0),
    totalSlots: smallIntCol("total_slots").notNull(),
    startedAt: tsCol("started_at"),
    closedAt: tsCol("closed_at"),
    multiregister: boolCol("multiregister").notNull().default(false),
    teamnameCompulsion: boolCol("teamname_compulsion")
      .notNull()
      .default(false),
    noDuplicateName: boolCol("no_duplicate_name").notNull().default(true),
    autodeleteRejects: boolCol("autodelete_rejects").notNull().default(false),
    allowDuplicateTags: boolCol("allow_duplicate_tags").notNull().default(true),
    /**
     * S4: the source called this `slotlist_start` and the decision log
     * says *both* names are wrong. It is `start_from`, same as the scrim's.
     */
    startFrom: smallIntCol("start_from").notNull().default(2),
    /** How many teams share a group. Null until the groups are drawn. */
    groupSize: smallIntCol("group_size"),
    successMessage: textCol("success_message"),
    emojis: jsonCol<Record<string, unknown>>("emojis", {
      tick: "✅",
      cross: "❌",
    }),
    slotmChannelId: textCol("slotm_channel_id"),
    slotmMessageId: textCol("slotm_message_id"),
    createdAt: createdAtCol(),
    updatedAt: updatedAtCol(),
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
export const tourneySlots = defineTable(
  "tourney_slots",
  {
    id: idCol(),
    tourneyId: foreignIdCol("tourney_id")
      .notNull()
      .references(() => tourneys.id, { onDelete: "cascade" }),
    num: intCol("num").notNull(),
    teamName: textCol("team_name").notNull(),
    leaderId: textCol("leader_id").notNull(),
    messageId: textCol("message_id"),
    jumpUrl: textCol("jump_url"),
    confirmJumpUrl: textCol("confirm_jump_url"),
    createdAt: createdAtCol(),
    updatedAt: updatedAtCol(),
  },
  (t) => [
    unique("tourney_slots_tourney_id_num_unique").on(t.tourneyId, t.num),
    index("tourney_slots_tourney_id_idx").on(t.tourneyId),
  ],
);

/**
 * The members of a registered tournament team.
 *
 * The fake-tag check — "does any other slot in this tournament already
 * hold one of these players?" — is a join against this table.
 */
export const tourneySlotMembers = defineTable(
  "tourney_slot_members",
  {
    id: idCol(),
    tourneySlotId: foreignIdCol("tourney_slot_id")
      .notNull()
      .references(() => tourneySlots.id, { onDelete: "cascade" }),
    userId: textCol("user_id").notNull(),
    createdAt: createdAtCol(),
    updatedAt: updatedAtCol(),
  },
  (t) => [
    unique("tourney_slot_members_tourney_slot_id_user_id_unique").on(
      t.tourneySlotId,
      t.userId,
    ),
    index("tourney_slot_members_user_id_idx").on(t.userId),
  ],
);

/**
 * Users banned from a tournament (D25).
 *
 * Quotient kept this in a `bigint[]` and mutated it with ARRAY_APPEND /
 * ARRAY_REMOVE — a read-modify-write that races under concurrent bans. A
 * join table with a unique key is idempotent: banning twice is a no-op.
 */
export const tourneyBannedUsers = defineTable(
  "tourney_banned_users",
  {
    id: idCol(),
    tourneyId: foreignIdCol("tourney_id")
      .notNull()
      .references(() => tourneys.id, { onDelete: "cascade" }),
    userId: textCol("user_id").notNull(),
    createdAt: createdAtCol(),
    updatedAt: updatedAtCol(),
  },
  (t) => [
    unique("tourney_banned_users_tourney_id_user_id_unique").on(
      t.tourneyId,
      t.userId,
    ),
  ],
);

/** A media-partner channel attached to a tournament. */
export const mediaPartners = defineTable(
  "media_partners",
  {
    id: idCol(),
    tourneyId: foreignIdCol("tourney_id")
      .notNull()
      .references(() => tourneys.id, { onDelete: "cascade" }),
    channelId: textCol("channel_id").notNull(),
    createdAt: createdAtCol(),
    updatedAt: updatedAtCol(),
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
export const mediaPartnerSlots = defineTable(
  "media_partner_slots",
  {
    id: idCol(),
    mediaPartnerId: foreignIdCol("media_partner_id")
      .notNull()
      .references(() => mediaPartners.id, { onDelete: "cascade" }),
    userId: textCol("user_id").notNull(),
    messageId: textCol("message_id").notNull(),
    jumpUrl: textCol("jump_url"),
    createdAt: createdAtCol(),
    updatedAt: updatedAtCol(),
  },
  (t) => [
    index("media_partner_slots_media_partner_id_idx").on(t.mediaPartnerId),
  ],
);

/** The members of a media-partner registration. */
export const mediaPartnerSlotMembers = defineTable(
  "media_partner_slot_members",
  {
    id: idCol(),
    mediaPartnerSlotId: foreignIdCol("media_partner_slot_id")
      .notNull()
      .references(() => mediaPartnerSlots.id, { onDelete: "cascade" }),
    userId: textCol("user_id").notNull(),
    createdAt: createdAtCol(),
    updatedAt: updatedAtCol(),
  },
  (t) => [
    unique(
      "media_partner_slot_members_media_partner_slot_id_user_id_unique",
    ).on(t.mediaPartnerSlotId, t.userId),
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
export const tourneyGroupLists = defineTable(
  "tourney_group_lists",
  {
    id: idCol(),
    tourneyId: foreignIdCol("tourney_id")
      .notNull()
      .references(() => tourneys.id, { onDelete: "cascade" }),
    messageId: textCol("message_id").notNull(),
    channelId: textCol("channel_id").notNull(),
    groupNumber: smallIntCol("group_number").notNull(),
    createdAt: createdAtCol(),
    updatedAt: updatedAtCol(),
  },
  (t) => [
    unique("tourney_group_lists_message_id_unique").on(t.messageId),
    unique("tourney_group_lists_tourney_id_group_number_unique").on(
      t.tourneyId,
      t.groupNumber,
    ),
  ],
);
