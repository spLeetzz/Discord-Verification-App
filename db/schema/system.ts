/**
 * System schema: per-guild settings, the durable scheduler, and the small
 * utility tables (tags, alerts, snipes, votes, block list, lockdowns).
 *
 * `jobs` replaces Quotient's `timer` table (D12): "timer" already means
 * three different things in this codebase, and `jobs` is unambiguous. It is
 * the durable scheduler — a row is a scheduled event, and the scheduler
 * fires the rows whose `expires_at` has passed.
 */

import { sql } from "drizzle-orm";
import {
  AUTOROLE_KINDS,
  BLOCK_ID_TYPES,
  JOB_EVENTS,
  LOCKDOWN_TYPES,
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
  serialIdCol,
  textCol,
  tsCol,
  unique,
  uniqueIndex,
  updatedAtCol,
} from "../dialect.js";

/**
 * Per-guild settings.
 *
 * This is the runtime state a guild owns: how its embeds look, which
 * prefix-equivalent it uses, whether it is locked down, and how long its
 * premium subscription runs. It is deliberately *not* `config/events.ts` —
 * that file is deploy-time configuration for the frozen verification flow.
 */
export const guildSettings = defineTable(
  "guild_settings",
  {
    id: idCol(),
    guildId: textCol("guild_id").notNull(),
    /**
     * S12: the prefix keeps a length check. The source's `max_length` was a
     * Tortoise-side validator, but the prefix length *is* a domain rule —
     * the source checked it explicitly — so it becomes a real constraint.
     */
    prefix: textCol("prefix").notNull().default("q"),
    /** Embed accent colour, as a decimal integer. Null means "use the default". */
    embedColor: intCol("embed_color").default(2267063),
    embedFooter: textCol("embed_footer").notNull().default(""),
    /** A private channel the bot may use to talk to the owner. */
    privateChannelId: textCol("private_channel_id"),
    /** Which dashboard surfaces the guild may open. */
    dashboardAccess: jsonCol<Record<string, unknown>>("dashboard_access", {
      embed: [],
      scrims: [],
      tourney: [],
      slotm: [],
    }),
    /**
     * When the guild's premium subscription runs out.
     *
     * This is the *tier* level gate (how many scrims, how many tourneys it
     * may have). The per-feature gates live in `guild_entitlements`.
     */
    premiumExpiresAt: tsCol("premium_expires_at"),
    /** The user who paid for the subscription. */
    madePremiumBy: textCol("made_premium_by"),
    /**
     * The global kill switch (D39). While it is on, the dispatcher refuses
     * every command. Per-channel and per-guild lockdowns live in
     * `lockdowns`.
     */
    lockdown: boolCol("lockdown").notNull().default(false),
    createdAt: createdAtCol(),
    updatedAt: updatedAtCol(),
  },
  (t) => [
    unique("guild_settings_guild_id_unique").on(t.guildId),
    // `length()`, not `char_length()`: SQLite has no `char_length`, and
    // `length()` counts characters on both engines.
    check(
      "guild_settings_prefix_length_check",
      sql`length(${t.prefix}) <= 5`,
    ),
  ],
);

/**
 * A user's own settings: their premium subscription and their balance.
 *
 * S4/S11: `made_premium` is dropped — the source appended the *user id* to
 * it by mistake and never read it back, and the monetisation cluster that
 * would populate it does not ship (D40). `premium_notified` and
 * `public_profile` are dropped as never-read columns.
 */
export const userSettings = defineTable(
  "user_settings",
  {
    id: idCol(),
    userId: textCol("user_id").notNull(),
    isPremium: boolCol("is_premium").notNull().default(false),
    premiumExpireTime: tsCol("premium_expire_time"),
    /** How many subscriptions the user currently holds. */
    premiums: intCol("premiums").notNull().default(0),
    /**
     * D40: the Quo Coin balance. Nothing may spend it to grant entitlement
     * — the economy does not ship — but the column may exist.
     */
    money: intCol("money").notNull().default(0),
    createdAt: createdAtCol(),
    updatedAt: updatedAtCol(),
  },
  (t) => [unique("user_settings_user_id_unique").on(t.userId)],
);

/**
 * The durable scheduler.
 *
 * A row is a job that is due at `expires_at`. `event` names the handler and
 * `payload` carries its arguments, so the scheduler stays a plain loop over
 * one table instead of a set of in-process timers that die with the bot.
 *
 * `user_id` is a real column, not a JSON path: Quotient listed a user's
 * reminders with `extra #>> '{args,0}'`, which is a full scan of the table
 * for every "remind me" button press.
 */
export const jobs = defineTable(
  "jobs",
  {
    id: idCol(),
    expiresAt: tsCol("expires_at").notNull(),
    /** The scheduler event name, e.g. `scrim_match` or `guild_premium`. */
    event: textCol("event").notNull(),
    payload: jsonCol<Record<string, unknown>>("payload", {}),
    /** The user the job is about, when it is about one. */
    userId: textCol("user_id"),
    createdAt: createdAtCol(),
    updatedAt: updatedAtCol(),
  },
  (t) => [
    index("jobs_expires_at_idx").on(t.expiresAt),
    index("jobs_user_id_idx").on(t.userId),
    oneOfCheck("jobs_event_check", t.event, JOB_EVENTS),
  ],
);

/**
 * The block list.
 *
 * Global, not per-guild: Quotient can block a user from every server at
 * once, so the entries are keyed by (id, kind) rather than by guild.
 *
 * `block_id_type` is `"1"` for a user and `"2"` for a guild. Quotient
 * looked records up by `block_id` alone, so a user and a guild that share
 * an id collided.
 */
export const blocklist = defineTable(
  "blocklist",
  {
    id: idCol(),
    blockId: textCol("block_id").notNull(),
    blockIdType: textCol("block_id_type").notNull(),
    /** The moderator who issued the block. */
    blockedBy: textCol("blocked_by"),
    reason: textCol("reason"),
    createdAt: createdAtCol(),
    updatedAt: updatedAtCol(),
  },
  (t) => [
    unique("blocklist_block_id_block_id_type_unique").on(
      t.blockId,
      t.blockIdType,
    ),
    oneOfCheck("blocklist_block_id_type_check", t.blockIdType, BLOCK_ID_TYPES),
  ],
);

/**
 * The permission state a channel had *before* a lockdown locked it.
 *
 * Quotient's unlock path forced `send_messages = True` on every channel it
 * had locked, which opened channels that a moderator had deliberately
 * write-locked beforehand. Restoring the exact prior state needs the prior
 * state.
 */
export interface LockdownChannelState {
  /**
   * Whether the channel had an explicit `@everyone` overwrite before the
   * lock. When it did not, unlocking must **remove** the overwrite the lock
   * created rather than set it to a value.
   */
  existed: boolean;
  /**
   * The permission value before the lock: `true`, `false`, or `null` for
   * "inherit from the category".
   */
  value: boolean | null;
}

/** Prior permission state, keyed by channel id. */
export type LockdownPriorState = Record<string, LockdownChannelState>;

/**
 * A lockdown record: channels or a whole guild that are locked until a
 * moderator lifts them or the timer expires.
 */
export const lockdowns = defineTable(
  "lockdowns",
  {
    id: idCol(),
    guildId: textCol("guild_id").notNull(),
    type: textCol("type").notNull(),
    roleId: textCol("role_id"),
    channelId: textCol("channel_id"),
    expireTime: tsCol("expire_time"),
    /**
     * What each channel's permission looked like before the lock.
     *
     * This lives on the lockdown rather than in the scheduled job's payload
     * because it is a property of the lockdown, not of the timer. A lockdown
     * with no duration has no job at all, and its prior state still has to
     * survive a restart.
     */
    priorState: jsonCol<LockdownPriorState | null>("prior_state"),
    authorId: textCol("author_id").notNull(),
    /**
     * The logical key of the lockdown: what it locks, in one string.
     *
     * The subject differs by type — a channel lockdown is keyed by its
     * channel, a maintenance one by its role, a server one by the guild.
     * Without a single key the table cannot express "one lockdown per
     * subject", and two moderators can both create a server lockdown, one
     * of which then dangles and re-locks the server on the next unlock.
     *
     * The repository writes it in the same statement as the row, and the
     * unique index is what actually enforces it.
     */
    lockKey: textCol("lock_key").notNull(),
    createdAt: createdAtCol(),
    updatedAt: updatedAtCol(),
  },
  (t) => [
    index("lockdowns_guild_id_type_idx").on(t.guildId, t.type),
    index("lockdowns_channel_id_type_idx").on(t.channelId, t.type),
    unique("lockdowns_lock_key_unique").on(t.lockKey),
    oneOfCheck("lockdowns_type_check", t.type, LOCKDOWN_TYPES),
  ],
);

/**
 * The channels a lockdown covers.
 *
 * One row per (lockdown, channel). The source kept them in a `text[]`
 * column and rewrote the whole array on every lock and unlock.
 */
export const lockdownChannels = defineTable(
  "lockdown_channels",
  {
    id: idCol(),
    lockdownId: foreignIdCol("lockdown_id")
      .notNull()
      .references(() => lockdowns.id, { onDelete: "cascade" }),
    channelId: textCol("channel_id").notNull(),
    createdAt: createdAtCol(),
    updatedAt: updatedAtCol(),
  },
  (t) => [
    unique("lockdown_channels_lockdown_id_channel_id_unique").on(
      t.lockdownId,
      t.channelId,
    ),
    index("lockdown_channels_channel_id_idx").on(t.channelId),
  ],
);

/**
 * The maintenance channels the bot created for a lockdown.
 *
 * A maintenance lockdown has no duration, so it has no job row, and the
 * ids of the channels the bot created used to travel in the job payload.
 * Recording them here means `maintenance off` deletes exactly the channels
 * it created, rather than every channel named `maintenance-chat` — which
 * would take a moderator's own channel with it.
 */
export const lockdownMaintenanceChannels = defineTable(
  "lockdown_maintenance_channels",
  {
    id: idCol(),
    lockdownId: foreignIdCol("lockdown_id")
      .notNull()
      .references(() => lockdowns.id, { onDelete: "cascade" }),
    channelId: textCol("channel_id").notNull(),
    createdAt: createdAtCol(),
    updatedAt: updatedAtCol(),
  },
  (t) => [
    unique("lockdown_maintenance_channels_lockdown_id_channel_id_unique").on(
      t.lockdownId,
      t.channelId,
    ),
  ],
);

/** A channel whose messages are deleted automatically. */
export const autopurgeConfigs = defineTable(
  "autopurge_configs",
  {
    id: idCol(),
    guildId: textCol("guild_id").notNull(),
    channelId: textCol("channel_id").notNull(),
    /** Minutes after which a message is purged. */
    deleteAfter: intCol("delete_after").notNull().default(10),
    createdAt: createdAtCol(),
    updatedAt: updatedAtCol(),
  },
  (t) => [unique("autopurge_configs_channel_id_unique").on(t.channelId)],
);

/** The roles automatically given to new members. */
export const autoroleConfigs = defineTable(
  "autorole_configs",
  {
    id: idCol(),
    guildId: textCol("guild_id").notNull(),
    createdAt: createdAtCol(),
    updatedAt: updatedAtCol(),
  },
  (t) => [unique("autorole_configs_guild_id_unique").on(t.guildId)],
);

/**
 * The roles an auto-role config gives out.
 *
 * One row per (guild, kind, role). `kind` is `human` or `bot` — the source
 * kept two arrays, `humans` and `bots`, and rewrote the whole array on
 * every toggle.
 */
export const autoroleRoles = defineTable(
  "autorole_roles",
  {
    id: idCol(),
    guildId: textCol("guild_id")
      .notNull()
      .references(() => autoroleConfigs.guildId, { onDelete: "cascade" }),
    kind: textCol("kind").notNull(),
    roleId: textCol("role_id").notNull(),
    createdAt: createdAtCol(),
    updatedAt: updatedAtCol(),
  },
  (t) => [
    unique("autorole_roles_guild_id_kind_role_id_unique").on(
      t.guildId,
      t.kind,
      t.roleId,
    ),
    index("autorole_roles_guild_id_idx").on(t.guildId),
    oneOfCheck("autorole_roles_kind_check", t.kind, AUTOROLE_KINDS),
  ],
);

/** A canned message a guild can post with a short command. */
export const tags = defineTable(
  "tags",
  {
    id: idCol(),
    guildId: textCol("guild_id").notNull(),
    name: textCol("name").notNull(),
    content: textCol("content").notNull(),
    isEmbed: boolCol("is_embed").notNull().default(false),
    isNsfw: boolCol("is_nsfw").notNull().default(false),
    ownerId: textCol("owner_id").notNull(),
    /** How many times the tag was used. */
    usage: intCol("usage").notNull().default(0),
    createdAt: createdAtCol(),
    updatedAt: updatedAtCol(),
  },
  (t) => [
    unique("tags_guild_id_name_unique").on(t.guildId, t.name),
    // The per-member tag count runs on every /tag create, and without this
    // it is a sequential scan.
    index("tags_guild_id_owner_id_idx").on(t.guildId, t.ownerId),
  ],
);

/**
 * An announcement the bot shows to every user until it is read.
 *
 * S11: `conditions` is dropped — the source never read or wrote it.
 */
export const alerts = defineTable(
  "alerts",
  {
    id: idCol(),
    authorId: textCol("author_id").notNull(),
    active: boolCol("active").notNull().default(true),
    /** D32: the embed is JSON, not a Python literal string. */
    message: jsonCol<Record<string, unknown>>("message", {}),
    createdAt: createdAtCol(),
    updatedAt: updatedAtCol(),
  },
  (t) => [
    // Only one alert is live at a time.
    uniqueIndex("alerts_active_unique")
      .on(t.active)
      .where(sql`${t.active}`),
  ],
);

/** A time a user was prompted to read an alert. */
export const alertPrompts = defineTable(
  "alert_prompts",
  {
    id: idCol(),
    alertId: foreignIdCol("alert_id")
      .notNull()
      .references(() => alerts.id, { onDelete: "cascade" }),
    userId: textCol("user_id").notNull(),
    createdAt: createdAtCol(),
    updatedAt: updatedAtCol(),
  },
  (t) => [index("alert_prompts_alert_id_user_id_idx").on(t.alertId, t.userId)],
);

/** A record that a user read an alert. */
export const alertReads = defineTable(
  "alert_reads",
  {
    id: idCol(),
    alertId: foreignIdCol("alert_id")
      .notNull()
      .references(() => alerts.id, { onDelete: "cascade" }),
    userId: textCol("user_id").notNull(),
    createdAt: createdAtCol(),
    updatedAt: updatedAtCol(),
  },
  (t) => [
    unique("alert_reads_alert_id_user_id_unique").on(t.alertId, t.userId),
    index("alert_reads_alert_id_idx").on(t.alertId),
  ],
);

/**
 * One row per command invocation, for the usage statistics.
 *
 * S1: the one table in the schema with a serial primary key. It is the
 * only high-write table and nothing references its id.
 *
 * S4: the source's `used_at` becomes `created_at`.
 *
 * S10: rows older than 30 days are pruned daily — see `db/retention.ts`.
 */
export const commandUsage = defineTable(
  "command_usage",
  {
    id: serialIdCol(),
    guildId: textCol("guild_id").notNull(),
    channelId: textCol("channel_id").notNull(),
    userId: textCol("user_id").notNull(),
    cmd: textCol("cmd").notNull(),
    /** The prefix that was used, for the prefix-command statistics. */
    prefix: textCol("prefix").notNull().default(""),
    failed: boolCol("failed").notNull().default(false),
    createdAt: createdAtCol(),
    updatedAt: updatedAtCol(),
  },
  (t) => [
    // The two tag-stats queries that ship filter on exactly these.
    index("command_usage_guild_id_cmd_idx").on(t.guildId, t.cmd),
    index("command_usage_user_id_cmd_idx").on(t.userId, t.cmd),
  ],
);

/** The last deleted message of a channel, for the `snipe` command. */
export const snipes = defineTable(
  "snipes",
  {
    id: idCol(),
    channelId: textCol("channel_id").notNull(),
    authorId: textCol("author_id").notNull(),
    content: textCol("content").notNull(),
    nsfw: boolCol("nsfw").notNull().default(false),
    createdAt: createdAtCol(),
    updatedAt: updatedAtCol(),
  },
  (t) => [unique("snipes_channel_id_unique").on(t.channelId)],
);

/** A user's vote profile. */
export const votes = defineTable(
  "votes",
  {
    id: idCol(),
    userId: textCol("user_id").notNull(),
    isVoter: boolCol("is_voter").notNull().default(false),
    expireTime: tsCol("expire_time"),
    reminder: boolCol("reminder").notNull().default(false),
    notified: boolCol("notified").notNull().default(false),
    totalVotes: intCol("total_votes").notNull().default(0),
    createdAt: createdAtCol(),
    updatedAt: updatedAtCol(),
  },
  (t) => [unique("votes_user_id_unique").on(t.userId)],
);
