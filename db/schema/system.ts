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
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import {
  BLOCK_ID_TYPES,
  JOB_EVENTS,
  LOCKDOWN_TYPES,
  createdAt,
  discordId,
  discordIdArray,
  foreignId,
  oneOfCheck,
  primaryId,
  serialId,
  updatedAt,
} from "./common.js";

/**
 * Per-guild settings.
 *
 * This is the runtime state a guild owns: how its embeds look, which
 * prefix-equivalent it uses, whether it is locked down, and how long its
 * premium subscription runs. It is deliberately *not* `config/events.ts` —
 * that file is deploy-time configuration for the frozen verification flow.
 */
export const guildSettings = pgTable(
  "guild_settings",
  {
    id: primaryId(),
    guildId: discordId("guild_id").notNull(),
    /**
     * S12: the prefix keeps a length check. The source's `max_length` was a
     * Tortoise-side validator, but the prefix length *is* a domain rule —
     * the source checked it explicitly — so it becomes a real constraint.
     */
    prefix: text("prefix").notNull().default("q"),
    /** Embed accent colour, as a decimal integer. Null means "use the default". */
    embedColor: integer("embed_color").default(2267063),
    embedFooter: text("embed_footer").notNull().default(""),
    /** A private channel the bot may use to talk to the owner. */
    privateChannelId: discordId("private_channel_id"),
    /** Which dashboard surfaces the guild may open. */
    dashboardAccess: jsonb("dashboard_access")
      .notNull()
      .default(
        sql`'{"embed": [], "scrims": [], "tourney": [], "slotm": []}'::jsonb`,
      ),
    /**
     * When the guild's premium subscription runs out.
     *
     * This is the *tier* level gate (how many scrims, how many tourneys it
     * may have). The per-feature gates live in `guild_entitlements`.
     */
    premiumExpiresAt: timestamp("premium_expires_at", {
      withTimezone: true,
      mode: "date",
    }),
    /** The user who paid for the subscription. */
    madePremiumBy: discordId("made_premium_by"),
    /**
     * The global kill switch (D39). While it is on, the dispatcher refuses
     * every command. Per-channel and per-guild lockdowns live in
     * `lockdowns`.
     */
    lockdown: boolean("lockdown").notNull().default(false),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique("guild_settings_guild_id_unique").on(t.guildId),
    check(
      "guild_settings_prefix_length_check",
      sql`char_length(${t.prefix}) <= 5`,
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
export const userSettings = pgTable(
  "user_settings",
  {
    id: primaryId(),
    userId: discordId("user_id").notNull(),
    isPremium: boolean("is_premium").notNull().default(false),
    premiumExpireTime: timestamp("premium_expire_time", {
      withTimezone: true,
      mode: "date",
    }),
    /** How many subscriptions the user currently holds. */
    premiums: integer("premiums").notNull().default(0),
    /**
     * D40: the Quo Coin balance. Nothing may spend it to grant entitlement
     * — the economy does not ship — but the column may exist.
     */
    money: integer("money").notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
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
export const jobs = pgTable(
  "jobs",
  {
    id: primaryId(),
    expiresAt: timestamp("expires_at", { withTimezone: true, mode: "date" }).notNull(),
    /** The scheduler event name, e.g. `scrim_match` or `guild_premium`. */
    event: text("event").notNull(),
    payload: jsonb("payload").notNull().default(sql`'{}'::jsonb`),
    /** The user the job is about, when it is about one. */
    userId: discordId("user_id"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
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
export const blocklist = pgTable(
  "blocklist",
  {
    id: primaryId(),
    blockId: discordId("block_id").notNull(),
    blockIdType: text("block_id_type").notNull(),
    /** The moderator who issued the block. */
    blockedBy: discordId("blocked_by"),
    reason: text("reason"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
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
export const lockdowns = pgTable(
  "lockdowns",
  {
    id: primaryId(),
    guildId: discordId("guild_id").notNull(),
    type: text("type").notNull(),
    roleId: discordId("role_id"),
    channelId: discordId("channel_id"),
    channelIds: discordIdArray("channel_ids")
      .notNull()
      .default(sql`'{}'::text[]`),
    expireTime: timestamp("expire_time", { withTimezone: true, mode: "date" }),
    /**
     * What each channel's permission looked like before the lock.
     *
     * This lives on the lockdown rather than in the scheduled job's payload
     * because it is a property of the lockdown, not of the timer. A lockdown
     * with no duration has no job at all, and its prior state still has to
     * survive a restart.
     */
    priorState: jsonb("prior_state").$type<LockdownPriorState | null>(),
    /**
     * The maintenance channels the bot created for this lockdown.
     *
     * A maintenance lockdown has no duration, so it has no job row, and the
     * ids of the channels the bot created used to travel in the job
     * payload. Recording them here means `maintenance off` deletes exactly
     * the channels it created, rather than every channel named
     * `maintenance-chat` — which would take a moderator's own channel with
     * it.
     */
    maintenanceChannelIds: discordIdArray("maintenance_channel_ids")
      .notNull()
      .default(sql`'{}'::text[]`),
    authorId: discordId("author_id").notNull(),
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
    lockKey: text("lock_key").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("lockdowns_guild_id_type_idx").on(t.guildId, t.type),
    index("lockdowns_channel_id_type_idx").on(t.channelId, t.type),
    unique("lockdowns_lock_key_unique").on(t.lockKey),
    oneOfCheck("lockdowns_type_check", t.type, LOCKDOWN_TYPES),
  ],
);

/** A channel whose messages are deleted automatically. */
export const autopurgeConfigs = pgTable(
  "autopurge_configs",
  {
    id: primaryId(),
    guildId: discordId("guild_id").notNull(),
    channelId: discordId("channel_id").notNull(),
    /** Minutes after which a message is purged. */
    deleteAfter: integer("delete_after").notNull().default(10),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [unique("autopurge_configs_channel_id_unique").on(t.channelId)],
);

/** The roles automatically given to new members. */
export const autoroleConfigs = pgTable(
  "autorole_configs",
  {
    id: primaryId(),
    guildId: discordId("guild_id").notNull(),
    humans: discordIdArray("humans")
      .notNull()
      .default(sql`'{}'::text[]`),
    bots: discordIdArray("bots").notNull().default(sql`'{}'::text[]`),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [unique("autorole_configs_guild_id_unique").on(t.guildId)],
);

/** A canned message a guild can post with a short command. */
export const tags = pgTable(
  "tags",
  {
    id: primaryId(),
    guildId: discordId("guild_id").notNull(),
    name: text("name").notNull(),
    content: text("content").notNull(),
    isEmbed: boolean("is_embed").notNull().default(false),
    isNsfw: boolean("is_nsfw").notNull().default(false),
    ownerId: discordId("owner_id").notNull(),
    /** How many times the tag was used. */
    usage: integer("usage").notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [unique("tags_guild_id_name_unique").on(t.guildId, t.name)],
);

/**
 * An announcement the bot shows to every user until it is read.
 *
 * S11: `conditions` is dropped — the source never read or wrote it.
 */
export const alerts = pgTable(
  "alerts",
  {
    id: primaryId(),
    authorId: discordId("author_id").notNull(),
    active: boolean("active").notNull().default(true),
    /** D32: the embed is JSON, not a Python literal string. */
    message: jsonb("message").notNull().default(sql`'{}'::jsonb`),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    // Only one alert is live at a time.
    uniqueIndex("alerts_active_unique")
      .on(t.active)
      .where(sql`${t.active}`),
  ],
);

/** A time a user was prompted to read an alert. */
export const alertPrompts = pgTable(
  "alert_prompts",
  {
    id: primaryId(),
    alertId: foreignId("alert_id")
      .notNull()
      .references(() => alerts.id, { onDelete: "cascade" }),
    userId: discordId("user_id").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("alert_prompts_alert_id_user_id_idx").on(t.alertId, t.userId)],
);

/** A record that a user read an alert. */
export const alertReads = pgTable(
  "alert_reads",
  {
    id: primaryId(),
    alertId: foreignId("alert_id")
      .notNull()
      .references(() => alerts.id, { onDelete: "cascade" }),
    userId: discordId("user_id").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique("alert_reads_alert_id_user_id_unique").on(t.alertId, t.userId),
    index("alert_reads_alert_id_idx").on(t.alertId),
  ],
);

/**
 * One row per command invocation, for the usage statistics.
 *
 * S1: the one table in the schema with a `bigserial` primary key. It is the
 * only high-write table and nothing references its id.
 *
 * S4: the source's `used_at` becomes `created_at`.
 *
 * S10: rows older than 30 days are pruned daily — see `db/retention.ts`.
 */
export const commandUsage = pgTable(
  "command_usage",
  {
    id: serialId(),
    guildId: discordId("guild_id").notNull(),
    channelId: discordId("channel_id").notNull(),
    userId: discordId("user_id").notNull(),
    cmd: text("cmd").notNull(),
    /** The prefix that was used, for the prefix-command statistics. */
    prefix: text("prefix").notNull().default(""),
    failed: boolean("failed").notNull().default(false),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    // The two tag-stats queries that ship filter on exactly these.
    index("command_usage_guild_id_cmd_idx").on(t.guildId, t.cmd),
    index("command_usage_user_id_cmd_idx").on(t.userId, t.cmd),
  ],
);

/** The last deleted message of a channel, for the `snipe` command. */
export const snipes = pgTable(
  "snipes",
  {
    id: primaryId(),
    channelId: discordId("channel_id").notNull(),
    authorId: discordId("author_id").notNull(),
    content: text("content").notNull(),
    nsfw: boolean("nsfw").notNull().default(false),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [unique("snipes_channel_id_unique").on(t.channelId)],
);

/** A user's vote profile. */
export const votes = pgTable(
  "votes",
  {
    id: primaryId(),
    userId: discordId("user_id").notNull(),
    isVoter: boolean("is_voter").notNull().default(false),
    expireTime: timestamp("expire_time", { withTimezone: true, mode: "date" }),
    reminder: boolean("reminder").notNull().default(false),
    notified: boolean("notified").notNull().default(false),
    totalVotes: integer("total_votes").notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [unique("votes_user_id_unique").on(t.userId)],
);
