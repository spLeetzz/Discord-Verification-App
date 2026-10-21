/**
 * Identity and community verification: screenshot verification, tag checks
 * and easy tags.
 *
 * D13 is the important one here: a screenshot submission belongs to exactly
 * one configuration, so `ss_submissions.ss_config_id` is a plain foreign key
 * with `ON DELETE CASCADE`. Quotient used a many-to-many join table for a
 * strictly one-to-many relation.
 */

import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  pgTable,
  text,
  unique,
} from "drizzle-orm/pg-core";
import {
  SCREENSHOT_TYPES,
  createdAt,
  discordId,
  foreignId,
  oneOfCheck,
  primaryId,
  updatedAt,
} from "./common.js";

/**
 * A screenshot-verification configuration: one channel, one flavour of
 * screenshot, one role to grant.
 */
export const ssConfigs = pgTable(
  "ss_configs",
  {
    id: primaryId(),
    guildId: discordId("guild_id").notNull(),
    channelId: discordId("channel_id").notNull(),
    roleId: discordId("role_id").notNull(),
    /** How many screenshots a user has to submit. */
    requiredSs: integer("required_ss").notNull().default(4),
    /** The channel or page the screenshot has to belong to. */
    channelName: text("channel_name").notNull(),
    channelLink: text("channel_link").notNull(),
    /** The words a custom screenshot must contain. */
    keywords: text("keywords")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    /** Allow the same screenshot to be submitted twice. */
    allowSame: boolean("allow_same").notNull().default(false),
    /**
     * The Hamming distance at which two screenshots count as duplicates.
     *
     * The default of 7 is calibrated against Python's `imagehash` 4.3.2, and
     * this port's hashing is bit-exact with it — so the number means the
     * same thing it did there. It is a column rather than a constant because
     * the threshold has to move with the hash implementation, and because a
     * guild whose screenshots rescale differently may need a different one.
     */
    duplicateThreshold: integer("duplicate_threshold").notNull().default(7),
    ssType: text("ss_type").notNull(),
    successMessage: text("success_message"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    // One configuration per channel — the source enforced this by reading
    // then writing, which races.
    unique("ss_configs_channel_id_unique").on(t.channelId),
    index("ss_configs_guild_id_idx").on(t.guildId),
    oneOfCheck("ss_configs_ss_type_check", t.ssType, SCREENSHOT_TYPES),
  ],
);

/**
 * One submitted screenshot.
 *
 * `ss_config_id` is a plain foreign key with `ON DELETE CASCADE` (D13):
 * deleting a configuration deletes its submissions, which is what Quotient's
 * `SSVerify.full_delete()` had to do by hand.
 *
 * S4: the source's `submitted_at` becomes `created_at`.
 */
export const ssSubmissions = pgTable(
  "ss_submissions",
  {
    id: primaryId(),
    ssConfigId: foreignId("ss_config_id")
      .notNull()
      .references(() => ssConfigs.id, { onDelete: "cascade" }),
    authorId: discordId("author_id").notNull(),
    channelId: discordId("channel_id").notNull(),
    messageId: discordId("message_id").notNull(),
    /** 16 hex characters of dHash; compared with a Hamming distance. */
    dhash: text("dhash"),
    phash: text("phash"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("ss_submissions_ss_config_id_idx").on(t.ssConfigId),
    index("ss_submissions_author_id_idx").on(t.authorId),
    // The duplicate check looks a submission up by its two hashes.
    index("ss_submissions_dhash_phash_idx").on(t.dhash, t.phash),
  ],
);

/** A channel where a clan tag is checked on every message. */
export const tagcheckChannels = pgTable(
  "tagcheck_channels",
  {
    id: primaryId(),
    guildId: discordId("guild_id").notNull(),
    channelId: discordId("channel_id").notNull(),
    requiredMentions: integer("required_mentions").notNull().default(0),
    deleteAfter: boolean("delete_after").notNull().default(false),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("tagcheck_channels_guild_id_idx").on(t.guildId),
    unique("tagcheck_channels_channel_id_unique").on(t.channelId),
  ],
);

/** A channel where members are asked to tag their clan. */
export const easytagChannels = pgTable(
  "easytag_channels",
  {
    id: primaryId(),
    guildId: discordId("guild_id").notNull(),
    channelId: discordId("channel_id").notNull(),
    deleteAfter: boolean("delete_after").notNull().default(false),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("easytag_channels_guild_id_idx").on(t.guildId),
    unique("easytag_channels_channel_id_unique").on(t.channelId),
  ],
);
