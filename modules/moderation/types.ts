/**
 * The domain types of the moderation area.
 *
 * Everything here is a closed union or a plain data shape. There is no
 * `string` standing in for a state, and no Discord id that has been parsed
 * into a number (D18 / S2).
 *
 * The types that come from the database are re-exported from `db/schema.ts`
 * so that the union in TypeScript and the `CHECK` constraint in Postgres are
 * the same list, written down once.
 */

import type { GuildMember } from "discord.js";
import type { BlockIdType, LockdownType } from "../../db/schema.js";
import type { Guard } from "../../core/guards.js";
import type { Command } from "../../types/command.js";

export type { BlockIdType, LockdownType };

/**
 * A command with the D28 guard list.
 *
 * `types/command.ts` has not gained the `guards` field yet — that is a
 * central change, and it is listed in the area report. Until it does, the
 * moderation commands carry their guards here, and the dispatcher runs
 * them as soon as it knows about the field. The permission checks are also
 * made inside the module, so the commands behave correctly today.
 */
export interface ModerationCommand extends Command {
  /** The guards, run in order. A string is the refusal. */
  guards?: Guard[];
  /** Defaults to true. Set false only for a command that works in a DM. */
  guildOnly?: boolean;
}

/* ------------------------------------------------------------------ *
 * Purge
 * ------------------------------------------------------------------ */

/**
 * What a purge selects.
 *
 * A discriminated union rather than a `kind` string plus optional fields:
 * a `"contains"` filter without its text is not a state the compiler can
 * rule out, and a filter that selects the wrong messages is a data loss.
 */
export type PurgeFilter =
  /** Everything that is not pinned. */
  | { readonly kind: "all" }
  /** Messages that carry an embed. */
  | { readonly kind: "embeds" }
  /** Messages that carry an attachment. */
  | { readonly kind: "files" }
  /** Messages that carry an embed or an attachment. */
  | { readonly kind: "images" }
  /** One author's messages. */
  | { readonly kind: "user"; readonly userId: string }
  /** Messages whose content contains a substring. */
  | { readonly kind: "contains"; readonly text: string }
  /** Bot messages, optionally narrowed to a command prefix. */
  | { readonly kind: "bot"; readonly prefix: string | null }
  /** Messages that carry a custom emoji. */
  | { readonly kind: "emoji" }
  /** Messages that carry at least one reaction. */
  | { readonly kind: "reactions" };

/**
 * A message, as far as the purge rules care.
 *
 * The rules are written against this shape rather than against discord.js's
 * `Message`, so they can be tested without a Discord connection.
 */
export interface PurgeMessage {
  readonly id: string;
  /** When the message was created, in milliseconds since the epoch. */
  readonly createdAt: number;
  readonly pinned: boolean;
  readonly content: string;
  readonly authorId: string;
  readonly authorIsBot: boolean;
  /** The webhook that sent it, when it did not come from a user. */
  readonly webhookId: string | null;
  readonly embedCount: number;
  readonly attachmentCount: number;
  readonly reactionCount: number;
}

/** What a purge did. */
export interface PurgeOutcome {
  /** How many messages the filter matched. */
  readonly matched: number;
  /** How many messages were actually deleted. */
  readonly deleted: number;
  /** How many matched but were older than Discord's fourteen-day limit. */
  readonly tooOld: number;
  /** How many matched but were pinned, which bulk delete refuses. */
  readonly pinned: number;
  /** How many messages could not be deleted because a batch failed. */
  readonly failed: number;
}

/** What a reaction clear did. */
export interface ReactionClearOutcome {
  /** How many messages were looked at. */
  readonly scanned: number;
  /** How many messages carried at least one reaction. */
  readonly withReactions: number;
  /** How many reactions were removed in total. */
  readonly removed: number;
}

/* ------------------------------------------------------------------ *
 * Members
 * ------------------------------------------------------------------ */

/**
 * Who a moderation action is aimed at.
 *
 * Quotient's `MemberID` converter fell back to a bare snowflake when the
 * member was not in the guild — the hackban case — and returned an object
 * that quacked like a member. A caller could then read `.roles` off it and
 * crash. The union makes the two cases impossible to confuse.
 */
export type MemberTarget =
  /** A member who is in the guild. */
  | { readonly kind: "member"; readonly id: string; readonly member: GuildMember }
  /** An id that may or may not be in the guild. */
  | { readonly kind: "id"; readonly id: string };

/* ------------------------------------------------------------------ *
 * The block list
 * ------------------------------------------------------------------ */

/** One block-list entry. */
export interface BlocklistEntry {
  /** The id that is blocked. */
  readonly blockId: string;
  /** What the id refers to: `"1"` is a user, `"2"` is a guild. */
  readonly blockIdType: BlockIdType;
  /** The moderator who issued the block. */
  readonly blockedBy: string | null;
  /** Why. */
  readonly reason: string | null;
}

/* ------------------------------------------------------------------ *
 * Lockdowns
 * ------------------------------------------------------------------ */

/**
 * The permission a lockdown changes.
 *
 * The names are discord.js's `PermissionFlagsBits` keys, because that is
 * what `permissionOverwrites.edit()` takes.
 *
 * `"ViewChannel"` is Discord's `read_messages`: the API renamed it, and
 * Quotient's `read_messages` is the same bit.
 */
export const LOCK_PERMISSIONS = ["SendMessages", "ViewChannel"] as const;
export type LockPermission = (typeof LOCK_PERMISSIONS)[number];

/**
 * The state of one permission on one target, before a lockdown changed it.
 *
 * `value` is `null` when the permission was inherited rather than set
 * explicitly, and `existed` says whether the channel carried an explicit
 * overwrite for that target at all. Both are needed to put things back
 * exactly as they were.
 */
export interface PriorPermissionState {
  readonly existed: boolean;
  readonly value: boolean | null;
}

/** One lockdown row, as the state machine sees it. */
export interface LockRecord {
  readonly id: string;
  readonly guildId: string;
  readonly type: LockdownType;
  /** The role a maintenance lockdown hides the channels from. */
  readonly roleId: string | null;
  /** The single channel a channel lockdown applies to, or the category. */
  readonly channelId: string | null;
  /** Every channel the lockdown touched. */
  readonly channelIds: readonly string[];
  /** When the lockdown lifts by itself, or `null` when it does not. */
  readonly expireTime: Date | null;
  readonly authorId: string;
  /** The channel the lockdown was started from, for the closing message. */
  readonly sourceChannelId: string | null;
}

/**
 * The durable payload of a lockdown job.
 *
 * This is what the scheduler hands to the expiry handler, and it is the
 * only place the permission state that has to be restored is written down.
 * The `lockdowns` row says *that* a channel is locked; this says *what it
 * looked like before*.
 */
export interface LockdownJobPayload {
  /** The lockdown row this job belongs to. */
  readonly lockdownId: string;
  readonly type: LockdownType;
  readonly guildId: string;
  /** Every channel the lockdown touched. */
  readonly channelIds: readonly string[];
  /** The role a maintenance lockdown hides the channels from. */
  readonly roleId: string | null;
  /** The channel the lockdown was started from, for the closing message. */
  readonly sourceChannelId: string | null;
  /** The permission that was changed, per channel. */
  readonly prior: Readonly<Record<string, PriorPermissionState>>;
  /** The maintenance channels `maintenance on` created. */
  readonly maintenanceChannelIds: readonly string[];
}
