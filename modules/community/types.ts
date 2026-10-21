/**
 * The community area's domain types.
 *
 * These are the shapes the rest of the area speaks in. They are **not**
 * the database rows: `repo.ts` maps a row onto one of these, so a column
 * change never reaches the command handlers.
 *
 * Every id is a string. A Discord snowflake does not fit in a `number`,
 * and the schema stores them as `text` (S2).
 */

/**
 * A canned message a guild can post with a short command.
 *
 * `name` is the **canonical** name: trimmed and lower-cased. See
 * `service.ts` for why the canonical form is the only form that is stored.
 */
export interface TagRecord {
  readonly id: string;
  readonly guildId: string;
  /** The canonical (lower-cased, trimmed) name. */
  readonly name: string;
  /** The body. For an embed tag, a JSON template (D32). */
  readonly content: string;
  readonly isEmbed: boolean;
  readonly isNsfw: boolean;
  readonly ownerId: string;
  readonly usage: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** The last deleted message of a channel. */
export interface SnipeRecord {
  readonly id: string;
  readonly channelId: string;
  readonly authorId: string;
  readonly content: string;
  /** Whether the channel the message was deleted in was NSFW. */
  readonly nsfw: boolean;
  readonly createdAt: Date;
}

/** A channel whose messages are deleted automatically. */
export interface AutoPurgeConfig {
  readonly id: string;
  readonly guildId: string;
  readonly channelId: string;
  /** Seconds after which a message is purged. */
  readonly deleteAfter: number;
  readonly createdAt: Date;
}

/** The roles automatically given to new members. */
export interface AutoroleConfig {
  readonly id: string;
  readonly guildId: string;
  /** Role ids given to human members. */
  readonly humans: readonly string[];
  /** Role ids given to bot members. */
  readonly bots: readonly string[];
}

/** Which list of an auto-role config a role belongs to. */
export type AutoroleKind = "humans" | "bots";

/** A running reminder, as the `/reminder list` command shows it. */
export interface ReminderRecord {
  readonly id: string;
  readonly expiresAt: Date;
  /** The message the user asked to be reminded of. */
  readonly message: string;
  readonly channelId: string;
  readonly userId: string;
  readonly createdAt: Date;
}

/** The payload of a `reminder` job. */
export interface ReminderJobPayload {
  /** The channel the reminder is posted in. */
  readonly channelId: string;
  /** The member the reminder is for. */
  readonly userId: string;
  /** What to remind them of. */
  readonly message: string;
  /** The message the reminder was created from, for the jump link. */
  readonly sourceMessageId?: string;
  /**
   * The job's own id.
   *
   * The dispatcher hands the handler the payload and nothing else, so the
   * id travels with it: the embed says "Reminder #<id>" and the id is the
   * one `/reminder list` shows.
   */
  readonly reminderId?: string;
}

/** The payload of an `autopurge` job. */
export interface AutoPurgeJobPayload {
  /** The channel the message is in. */
  readonly channelId: string;
  /** The message to delete when the job comes due. */
  readonly messageId: string;
}

/** How many times one member has used the tag command in a guild. */
export interface TagUserUseCount {
  readonly userId: string;
  readonly uses: number;
}

/** How many tags one member owns in a guild. */
export interface TagOwnerCount {
  readonly ownerId: string;
  readonly count: number;
}

/** One row of the "top tags of a member" statistics. */
export interface MemberTagStat {
  readonly name: string;
  readonly usage: number;
  /** How many tags the member owns in total. */
  readonly totalTags: number;
  /** How many uses the member's tags have in total. */
  readonly totalUses: number;
}

/** The guild-wide tag statistics. */
export interface GuildTagStats {
  /** How many tags the guild has. */
  readonly totalTags: number;
  /** How many times the tag command has been used in the guild. */
  readonly totalUses: number;
  /** The most used tags. */
  readonly topTags: readonly { readonly name: string; readonly usage: number }[];
  /** The members who used the tag command most. */
  readonly topUsers: readonly TagUserUseCount[];
  /** The members who own the most tags. */
  readonly topCreators: readonly TagOwnerCount[];
}

/** One row of the command-usage log. */
export interface CommandUsageEntry {
  readonly guildId: string;
  readonly channelId: string;
  readonly userId: string;
  /** The command name, e.g. `tag`. */
  readonly cmd: string;
  /** The prefix that was used, for the prefix-command statistics. */
  readonly prefix: string;
  /** Whether the command failed. */
  readonly failed: boolean;
}
