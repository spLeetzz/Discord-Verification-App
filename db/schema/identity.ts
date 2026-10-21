/**
 * Identity and community verification: screenshot verification, tag checks
 * and easy tags.
 *
 * D13 is the important one here: a screenshot submission belongs to exactly
 * one configuration, so `ss_submissions.ss_config_id` is a plain foreign key
 * with `ON DELETE CASCADE`. Quotient used a many-to-many join table for a
 * strictly one-to-many relation.
 */

import { SCREENSHOT_TYPES, oneOfCheck } from "./common.js";
import {
  boolCol,
  createdAtCol,
  defineTable,
  foreignIdCol,
  idCol,
  index,
  intCol,
  textCol,
  unique,
  updatedAtCol,
} from "../dialect.js";

/**
 * A screenshot-verification configuration: one channel, one flavour of
 * screenshot, one role to grant.
 */
export const ssConfigs = defineTable(
  "ss_configs",
  {
    id: idCol(),
    guildId: textCol("guild_id").notNull(),
    channelId: textCol("channel_id").notNull(),
    roleId: textCol("role_id").notNull(),
    /** How many screenshots a user has to submit. */
    requiredSs: intCol("required_ss").notNull().default(4),
    /** The channel or page the screenshot has to belong to. */
    channelName: textCol("channel_name").notNull(),
    channelLink: textCol("channel_link").notNull(),
    /** Allow the same screenshot to be submitted twice. */
    allowSame: boolCol("allow_same").notNull().default(false),
    /**
     * The Hamming distance at which two screenshots count as duplicates.
     *
     * The default of 7 is calibrated against Python's `imagehash` 4.3.2, and
     * this port's hashing is bit-exact with it — so the number means the
     * same thing it did there. It is a column rather than a constant because
     * the threshold has to move with the hash implementation, and because a
     * guild whose screenshots rescale differently may need a different one.
     */
    duplicateThreshold: intCol("duplicate_threshold").notNull().default(7),
    ssType: textCol("ss_type").notNull(),
    successMessage: textCol("success_message"),
    createdAt: createdAtCol(),
    updatedAt: updatedAtCol(),
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
 * The words a custom screenshot must contain.
 *
 * One row per (configuration, keyword). The source kept them in a `text[]`
 * column and rewrote the whole array on every edit; a join table makes the
 * edit an insert or a delete.
 */
export const ssConfigKeywords = defineTable(
  "ss_config_keywords",
  {
    id: idCol(),
    ssConfigId: foreignIdCol("ss_config_id")
      .notNull()
      .references(() => ssConfigs.id, { onDelete: "cascade" }),
    keyword: textCol("keyword").notNull(),
    createdAt: createdAtCol(),
    updatedAt: updatedAtCol(),
  },
  (t) => [
    unique("ss_config_keywords_ss_config_id_keyword_unique").on(
      t.ssConfigId,
      t.keyword,
    ),
    index("ss_config_keywords_ss_config_id_idx").on(t.ssConfigId),
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
export const ssSubmissions = defineTable(
  "ss_submissions",
  {
    id: idCol(),
    ssConfigId: foreignIdCol("ss_config_id")
      .notNull()
      .references(() => ssConfigs.id, { onDelete: "cascade" }),
    authorId: textCol("author_id").notNull(),
    channelId: textCol("channel_id").notNull(),
    messageId: textCol("message_id").notNull(),
    /** 16 hex characters of dHash; compared with a Hamming distance. */
    dhash: textCol("dhash"),
    phash: textCol("phash"),
    createdAt: createdAtCol(),
    updatedAt: updatedAtCol(),
  },
  (t) => [
    index("ss_submissions_ss_config_id_idx").on(t.ssConfigId),
    index("ss_submissions_author_id_idx").on(t.authorId),
    // The duplicate check looks a submission up by its two hashes.
    index("ss_submissions_dhash_phash_idx").on(t.dhash, t.phash),
  ],
);

/** A channel where a clan tag is checked on every message. */
export const tagcheckChannels = defineTable(
  "tagcheck_channels",
  {
    id: idCol(),
    guildId: textCol("guild_id").notNull(),
    channelId: textCol("channel_id").notNull(),
    requiredMentions: intCol("required_mentions").notNull().default(0),
    deleteAfter: boolCol("delete_after").notNull().default(false),
    createdAt: createdAtCol(),
    updatedAt: updatedAtCol(),
  },
  (t) => [
    index("tagcheck_channels_guild_id_idx").on(t.guildId),
    unique("tagcheck_channels_channel_id_unique").on(t.channelId),
  ],
);

/** A channel where members are asked to tag their clan. */
export const easytagChannels = defineTable(
  "easytag_channels",
  {
    id: idCol(),
    guildId: textCol("guild_id").notNull(),
    channelId: textCol("channel_id").notNull(),
    deleteAfter: boolCol("delete_after").notNull().default(false),
    createdAt: createdAtCol(),
    updatedAt: updatedAtCol(),
  },
  (t) => [
    index("easytag_channels_guild_id_idx").on(t.guildId),
    unique("easytag_channels_channel_id_unique").on(t.channelId),
  ],
);
