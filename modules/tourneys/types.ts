/**
 * The tournaments domain types.
 *
 * A tournament is a bracketed competition between teams: a registration
 * channel, a confirm channel, a success role, a number of slots and a
 * group size. Teams register by messaging in the registration channel, and
 * the registered teams are then chunked into **groups**.
 *
 * Quotient modelled this as eleven view classes that each mutated
 * `self.record` and re-rendered. discord.js has no view objects, so the
 * state lives in the database and the message is re-rendered from it —
 * these types are that state, read out of the `tourneys` row.
 *
 * The closed unions come from `db/schema/common.ts` so the TypeScript and
 * the `CHECK` constraints cannot drift apart.
 */

import type { TourneyStatus } from "../../db/schema/common.js";
import type { RegDeny } from "../../core/constants.js";

export type { TourneyStatus };
export type { RegDeny };

/** The two emoji a tournament uses for its accept and reject reactions. */
export interface TourneyEmojis {
  /** The tick a successful registration gets. Defaults to `✅`. */
  readonly tick: string;
  /** The cross a refused registration gets. Defaults to `❌`. */
  readonly cross: string;
}

/**
 * A tournament, as the `tourneys` table holds it.
 *
 * Every field is a column. There is no M2M to the slots (D25) and no
 * "open or closed" inference from two nullable timestamps (D26) — the
 * lifecycle is {@link TourneyStatus}.
 */
export interface TourneyRecord {
  readonly id: string;
  readonly guildId: string;
  readonly name: string;
  /** D26: the lifecycle, as an explicit value. */
  readonly status: TourneyStatus;
  readonly registrationChannelId: string;
  readonly confirmChannelId: string;
  /** The role a successful registrant is given. */
  readonly roleId: string;
  /** The role the registration channel is opened to. */
  readonly openRoleId: string | null;
  /** The role pinged when registration opens. */
  readonly pingRoleId: string | null;
  readonly hostId: string;
  readonly requiredMentions: number;
  readonly requiredLines: number;
  readonly totalSlots: number;
  /** When the tournament was opened. `null` while it is a draft. */
  readonly startedAt: Date | null;
  /** When the tournament was closed. `null` while it is running. */
  readonly closedAt: Date | null;
  readonly multiregister: boolean;
  readonly teamnameCompulsion: boolean;
  readonly noDuplicateName: boolean;
  readonly autodeleteRejects: boolean;
  readonly allowDuplicateTags: boolean;
  /** The first slot number the group list shows. */
  readonly startFrom: number;
  /** How many teams share a group. `null` until it is set. */
  readonly groupSize: number | null;
  /** The message a successful registrant is sent in DMs. */
  readonly successMessage: string | null;
  readonly emojis: TourneyEmojis;
  /** The channel the persistent slot-manager panel lives in. */
  readonly slotmChannelId: string | null;
  /** The slot-manager panel's message id. */
  readonly slotmMessageId: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/**
 * One registered team of a tournament (D25).
 *
 * `num` is a position *within the tournament*, so it is unique per
 * tournament and not per row. "Swap Groups" rewrites two `num` values,
 * which collides with the unique constraint mid-update — so it is done as
 * a three-step swap through a temporary number inside one transaction.
 */
export interface TourneySlotRecord {
  readonly id: string;
  readonly tourneyId: string;
  readonly num: number;
  readonly teamName: string;
  readonly leaderId: string;
  /** The whole team, not just the captain. */
  readonly members: readonly string[];
  /** The registration message. */
  readonly messageId: string | null;
  /** A link to the registration message. */
  readonly jumpUrl: string | null;
  /** A link to the confirmation message. */
  readonly confirmJumpUrl: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** A media-partner channel attached to a tournament. */
export interface MediaPartnerRecord {
  readonly id: string;
  /**
   * The tournament that owns the partner registration.
   *
   * **The owner**, not the partner: the row has to be findable from the
   * guild that set the partnership up, and `ON DELETE CASCADE` has to
   * remove it when that tournament is deleted. The partner tournament
   * lives in another guild and is resolved from the channel.
   */
  readonly tourneyId: string;
  /** The channel in the *other* guild the registrations arrive in. */
  readonly channelId: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** A team that registered through a media-partner channel. */
export interface MediaPartnerSlotRecord {
  readonly id: string;
  readonly mediaPartnerId: string;
  readonly userId: string;
  readonly messageId: string;
  readonly jumpUrl: string | null;
  readonly members: readonly string[];
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/**
 * A published group list — the board for one group.
 *
 * The channel id is stored on the row (D16 / B15): Quotient re-discovered
 * it by substring match, so "Group 1" could pick up "Group 10"'s channel.
 */
export interface TourneyGroupListRecord {
  readonly id: string;
  readonly tourneyId: string;
  /** The message the list is published as. */
  readonly messageId: string;
  /** The channel the list was published in. */
  readonly channelId: string;
  /** Which group this is, counting from 1. */
  readonly groupNumber: number;
  readonly createdAt: Date;
  /**
   * When the list was last refreshed.
   *
   * S4 folds the source's `refresh_at` into `updated_at`, so the column is
   * the row's modification time. The row is only ever *written* by the
   * refresh path, which is what makes this a "written only by the refresh
   * path" timestamp rather than an `auto_now` one (B16).
   */
  readonly updatedAt: Date;
}

/**
 * The fields the editor can change. One field, one write.
 *
 * The source's editor rebuilt the whole model from `dict(self.record)` on
 * every interaction, which relied on Tortoise internals and wrote columns
 * another writer may have changed in the meantime.
 */
export type TourneyField =
  | "name"
  | "registrationChannelId"
  | "confirmChannelId"
  | "roleId"
  | "requiredMentions"
  | "totalSlots"
  | "groupSize"
  | "emojis"
  | "pingRoleId"
  | "openRoleId"
  | "multiregister"
  | "teamnameCompulsion"
  | "noDuplicateName"
  | "autodeleteRejects"
  | "allowDuplicateTags"
  | "requiredLines"
  | "startFrom"
  | "successMessage";

/** A field's current value, as the editor reads it. */
export type TourneyFieldValue = string | number | boolean | null;

/**
 * The open schedule of a tournament.
 *
 * The `tourneys` table has no schedule column, and the schema is
 * ratified and migrated — so the schedule lives in the **payload of the
 * durable job row** that opens the tournament. That is where a schedule
 * belongs anyway: a job row is a schedule, it survives a restart, and the
 * dispatcher deletes it before dispatching it.
 */
export interface TourneySchedule {
  /** The weekdays the tournament opens on. Empty means every day. */
  readonly openDays: readonly string[];
  /**
   * The time of day it opens at, in the server's zone.
   *
   * A wall-clock time, not an instant: the same time every allowed day.
   */
  readonly openTime: string;
}

/**
 * The state the setup wizard collects.
 *
 * It has no database row yet — that is why it travels in a **token**
 * (D18) — but it is still domain state, so it lives here.
 */
export interface WizardDraft {
  readonly guildId: string;
  readonly hostId: string;
  readonly name: string;
  readonly registrationChannelId: string | null;
  readonly confirmChannelId: string | null;
  readonly roleId: string | null;
  readonly requiredMentions: number;
  readonly totalSlots: number | null;
  readonly groupSize: number | null;
  readonly emojis: TourneyEmojis;
  /** The weekdays the tournament opens on. Empty means every day. */
  readonly openDays: string[];
  /** The time of day it opens at, in the server's zone. */
  readonly openTime: string;
}
