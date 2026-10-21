/**
 * The scrims domain types.
 *
 * A scrim is a scheduled practice match between teams: a registration
 * channel, a list of slots, and a moderator-driven lifecycle.
 *
 * Quotient modelled this as seventeen view classes that each mutated
 * `self.record` and re-rendered. discord.js has no view objects, so the
 * state lives in the database and the message is re-rendered from it —
 * these types are that state, read out of the `scrims` row.
 *
 * The closed unions come from `db/schema/common.ts` so the TypeScript and
 * the `CHECK` constraints cannot drift apart.
 */

import type {
  AutocleanKind,
  ScrimStatus,
  SlotState,
  Weekday,
} from "../../db/schema/common.js";
import type { RegDeny } from "../../core/constants.js";
import type { EmbedTemplate } from "./template.js";

export type { AutocleanKind, ScrimStatus, SlotState, Weekday };
export type { RegDeny };

/**
 * The two emoji a scrim uses for its accept and reject reactions.
 *
 * A **type alias**, not an interface: the column is a JSON document
 * (`jsonCol<Record<string, unknown>>`), and only an object type — an
 * interface has no implicit index signature — can be written to one.
 */
export type ScrimEmojis = {
  /** The tick a successful registration gets. Defaults to `✅`. */
  readonly tick: string;
  /** The cross a refused registration gets. Defaults to `❌`. */
  readonly cross: string;
};

/** The registration countdown configuration (Quotient's `cdn` column). */
export interface ScrimCountdown {
  readonly status: boolean;
  readonly countdown: number;
  readonly msg: EmbedTemplate;
}

/**
 * A scrim, as the `scrims` table holds it.
 *
 * Every field is a column. There is no `available_slots` array (D14) and
 * no "open or closed" inference from two nullable timestamps (D26) — the
 * lifecycle is {@link ScrimStatus}.
 */
export interface ScrimRecord {
  readonly id: string;
  readonly guildId: string;
  readonly name: string;
  /** D26: the lifecycle, as an explicit value. */
  readonly status: ScrimStatus;
  readonly registrationChannelId: string;
  readonly slotlistChannelId: string;
  readonly slotlistMessageId: string | null;
  /** The role a successful registrant is given. */
  readonly roleId: string | null;
  /** The role the registration channel is opened to. */
  readonly openRoleId: string | null;
  /** The role pinged when registration opens. */
  readonly pingRoleId: string | null;
  readonly hostId: string;
  readonly requiredMentions: number;
  readonly requiredLines: number;
  /** The first slot number. Slots run from here to `startFrom + totalSlots - 1`. */
  readonly startFrom: number;
  readonly totalSlots: number;
  /** The time of day registration opens, as an instant. */
  readonly openTime: Date;
  readonly openedAt: Date | null;
  readonly closedAt: Date | null;
  /** The time the match starts. The slot manager locks at this instant. */
  readonly matchTime: Date | null;
  /** What the autoclean pass removes. */
  readonly autoclean: AutocleanKind[];
  readonly autocleanTime: Date | null;
  readonly autoslotlist: boolean;
  readonly multiregister: boolean;
  /** D14's replacement for Quotient's `stoggle` typo. */
  readonly enabled: boolean;
  readonly autodeleteRejects: boolean;
  readonly autodeleteExtras: boolean;
  readonly teamnameCompulsion: boolean;
  readonly noDuplicateName: boolean;
  readonly allowDuplicateTags: boolean;
  /** S4: a duration in seconds, formatted at render time. */
  readonly timeElapsedSeconds: number | null;
  readonly openDays: Weekday[];
  /** D32: an embed template, as JSON. */
  readonly slotlistFormat: EmbedTemplate;
  readonly openMessage: EmbedTemplate;
  readonly closeMessage: EmbedTemplate;
  readonly emojis: ScrimEmojis;
  readonly cdn: ScrimCountdown;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/**
 * One slot of a scrim.
 *
 * A free slot is a **row**, not an absence (D14). The claim is one
 * conditional `UPDATE`; zero rows updated means somebody else won.
 */
export interface SlotRecord {
  readonly id: string;
  readonly scrimId: string;
  readonly num: number;
  readonly state: SlotState;
  readonly teamName: string | null;
  readonly ownerUserId: string | null;
  /** The whole team, not just the captain. */
  readonly members: readonly string[];
  readonly messageId: string | null;
  readonly jumpUrl: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** A slot a host set aside before registration opened. */
export interface ReservedSlotRecord {
  readonly id: string;
  readonly scrimId: string;
  readonly num: number;
  readonly userId: string | null;
  readonly teamName: string | null;
  readonly members: readonly string[];
  readonly expires: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** A team banned from a scrim. */
export interface BannedTeamRecord {
  readonly id: string;
  readonly scrimId: string;
  readonly num: number;
  readonly userId: string;
  readonly teamName: string | null;
  readonly members: readonly string[];
  readonly reason: string | null;
  readonly expires: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/**
 * The four ban modes.
 *
 * The source had them as the strings `"1"` … `"4"`, hidden behind a
 * four-button panel. They are a real user-facing matrix, so they get
 * names here — but the numeric values are kept, because they are what the
 * `banned_teams` rows and the ban log record.
 */
export const BanMode = {
  /** Ban the team leader from this scrim. */
  leaderThisScrim: 1,
  /** Ban the whole team from this scrim. */
  teamThisScrim: 2,
  /** Ban the team leader from every scrim in the server. */
  leaderAllScrims: 3,
  /** Ban the whole team from every scrim in the server. */
  teamAllScrims: 4,
} as const;
export type BanMode = (typeof BanMode)[keyof typeof BanMode];

/** Every ban mode, in the order the panel shows them. */
export const BAN_MODES: readonly BanMode[] = [
  BanMode.leaderThisScrim,
  BanMode.teamThisScrim,
  BanMode.leaderAllScrims,
  BanMode.teamAllScrims,
];

/** The human label of each ban mode. */
export const BAN_MODE_LABELS: Record<BanMode, string> = {
  [BanMode.leaderThisScrim]: "Ban the team leader from this scrim",
  [BanMode.teamThisScrim]: "Ban the whole team from this scrim",
  [BanMode.leaderAllScrims]: "Ban the team leader from all scrims",
  [BanMode.teamAllScrims]: "Ban the whole team from all scrims",
};

/** The fields the editor can change. One field, one write. */
export type ScrimField =
  | "name"
  | "registrationChannelId"
  | "slotlistChannelId"
  | "roleId"
  | "requiredMentions"
  | "totalSlots"
  | "openTime"
  | "emojis"
  | "pingRoleId"
  | "openRoleId"
  | "multiregister"
  | "teamnameCompulsion"
  | "noDuplicateName"
  | "autodeleteRejects"
  | "autodeleteExtras"
  | "startFrom"
  | "autoclean"
  | "autocleanTime"
  | "openDays"
  | "requiredLines"
  | "allowDuplicateTags";

/** A field's current value, as the editor reads it. */
export type ScrimFieldValue = string | number | boolean | string[] | Date | null;
