/**
 * The slot-manager domain types.
 *
 * The slot manager is Quotient's "let the members run the slot list
 * themselves" feature: a read-only channel with a public panel, a button
 * per action, and a set of moderators' tools that live on the published
 * slot list.
 *
 * The source modelled it as a set of `discord.ui.View` classes that each
 * held a record in memory. discord.js has no views, so the state lives in
 * the database and every panel is re-rendered from it — these types are
 * that state, read out of the rows.
 *
 * The closed unions come from `db/schema/common.ts`, so the TypeScript and
 * the `CHECK` constraints cannot drift apart.
 */

import type { SlotState } from "../../db/schema/common.js";

export type { SlotState };

/**
 * The slot-manager row.
 *
 * One per channel. Which scrims it shows is a many-to-many relation, so
 * it lives in `slot_manager_scrims` rather than in an array (S8).
 */
export interface SlotManagerRecord {
  readonly id: string;
  readonly guildId: string;
  /** The channel the public panel lives in. */
  readonly mainChannelId: string;
  /** The public panel's message id. */
  readonly messageId: string;
  /** Is the panel switched on? */
  readonly toggle: boolean;
  /** Is the "Remind Me" button available? */
  readonly allowReminders: boolean;
  /** May one member hold more than one slot in a scrim? */
  readonly multipleSlots: boolean;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/**
 * A scrim, as far as the slot area cares.
 *
 * The slot area never edits a scrim; it only reads the fields that decide
 * whether a slot may be claimed and which role a claim carries.
 */
export interface ScrimLite {
  readonly id: string;
  readonly guildId: string;
  readonly name: string;
  readonly status: string;
  readonly registrationChannelId: string;
  readonly slotlistChannelId: string;
  readonly slotlistMessageId: string | null;
  /** The role a member gets when they take a slot — the ID/Pass role. */
  readonly roleId: string | null;
  /** The first slot number. */
  readonly startFrom: number;
  /** How many slots the scrim has. */
  readonly totalSlots: number;
  readonly openTime: Date;
  readonly openedAt: Date | null;
  readonly closedAt: Date | null;
  /** The instant the match starts. After it, slots lock. */
  readonly matchTime: Date | null;
  readonly hostId: string;
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
  /**
   * The whole team, not just the captain.
   *
   * The source wrote only the claimer, so the ID-Pass transfer could never
   * find a teammate and the feature had never worked (B3).
   */
  readonly members: readonly string[];
  readonly messageId: string | null;
  readonly jumpUrl: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/**
 * "Tell me when a slot frees up" — one row per (scrim, user).
 *
 * The reminder is a **durable row**. The dispatch happens when a slot is
 * freed, not on a timer, and the row is deleted when it fires: a reminder
 * is one-shot.
 */
export interface SlotReminderRecord {
  readonly id: string;
  readonly scrimId: string;
  readonly userId: string;
  readonly createdAt: Date;
}

/**
 * The four ban modes.
 *
 * The source had them as the strings `"1"` … `"4"`, hidden behind a
 * four-keycap button row that had no stable custom id. The numbers are
 * kept because they are what the ban records and the ban log hold; the
 * names are what this port calls them.
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

/** Every ban mode, in the order the menu shows them. */
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

/**
 * What a claim attempt means.
 *
 * `claimed` — the conditional `UPDATE` updated a row. `taken` — somebody
 * else won the race. `unavailable` — the slot is not claimable at all.
 */
export type ClaimOutcome = "claimed" | "taken" | "unavailable";

/**
 * Why a claim was refused.
 *
 * The refusals are the source's wording, because they are the wording
 * users of the old bot already know.
 */
export type ClaimRefusal =
  | "no_slot"
  | "scrim_gone"
  | "banned"
  | "already_holds"
  | "taken"
  | "invalid_team_name";

/** The result of a claim attempt. */
export type ClaimResult =
  | { readonly ok: true; readonly slot: SlotRecord }
  | { readonly ok: false; readonly reason: ClaimRefusal };

/** The result of a cancel attempt. */
export type CancelResult =
  | {
      readonly ok: true;
      readonly slot: SlotRecord;
      /**
       * Was the scrim's role taken away?
       *
       * The role is only removed when this was the member's **last** slot
       * in that scrim. The rule is load-bearing: a member with two slots
       * keeps the role until the second one goes too.
       */
      readonly roleRemoved: boolean;
    }
  | { readonly ok: false; readonly reason: "not_found" | "not_owner" };

/** The result of an ID-Pass transfer. */
export type TransferResult =
  | { readonly ok: true; readonly slot: SlotRecord; readonly newOwnerId: string }
  | {
      readonly ok: false;
      readonly reason:
        | "no_slot"
        | "no_teammate"
        | "nobody_resolved"
        | "not_owner";
    };

/** A scrim a member may set a reminder for. */
export interface ReminderCandidate {
  readonly scrimId: string;
  readonly scrimName: string;
  readonly registrationChannelId: string;
}

/**
 * A ban of a scrim.
 *
 * The row is the whole truth about a ban: the reason and the expiry
 * are written down nowhere else, so the ban log entry of an unban reads
 * them from here.
 */
export interface BanRecord {
  /** Who is banned. */
  readonly userId: string;
  /** The team they were banned with, when the ban named one. */
  readonly teamName: string | null;
  /** Why they were banned, when the moderator gave a reason. */
  readonly reason: string | null;
  /** When the ban runs out, when it has a duration. */
  readonly expires: Date | null;
}

/**
 * The store the service layer talks to.
 *
 * The service is the state machine; the repository is the SQL. This
 * interface is the seam between them, so the rules can be proved without
 * a database and the SQL can be proved against one.
 */
export interface SlotStore {
  /* --- slot managers --- */
  getSlotManager(id: string): Promise<SlotManagerRecord | null>;
  listSlotManagers(guildId: string): Promise<SlotManagerRecord[]>;
  countSlotManagers(guildId: string): Promise<number>;
  createSlotManager(values: {
    readonly guildId: string;
    readonly mainChannelId: string;
    readonly messageId: string;
  }): Promise<SlotManagerRecord>;
  updateSlotManager(
    id: string,
    patch: Partial<
      Pick<
        SlotManagerRecord,
        "toggle" | "allowReminders" | "multipleSlots" | "messageId" | "mainChannelId"
      >
    >,
  ): Promise<SlotManagerRecord | null>;
  deleteSlotManager(id: string): Promise<void>;
  listSlotManagerScrimIds(managerId: string): Promise<string[]>;
  setSlotManagerScrims(managerId: string, scrimIds: readonly string[]): Promise<void>;
  findSlotManagerForScrim(scrimId: string): Promise<SlotManagerRecord | null>;

  /* --- scrims --- */
  getScrim(id: string): Promise<ScrimLite | null>;
  listScrims(guildId: string): Promise<ScrimLite[]>;
  listScrimsForManager(managerId: string): Promise<ScrimLite[]>;
  listScrimIds(guildId: string): Promise<string[]>;

  /* --- slots --- */
  listSlots(scrimId: string): Promise<SlotRecord[]>;
  getSlot(id: string): Promise<SlotRecord | null>;
  getSlotByNum(scrimId: string, num: number): Promise<SlotRecord | null>;
  countFreeSlots(scrimId: string): Promise<number>;
  /** The conditional `UPDATE` from S7. `null` means somebody else won. */
  claimSlot(
    scrimId: string,
    num: number,
    values: {
      readonly teamName: string;
      readonly ownerUserId: string;
      readonly members: readonly string[];
    },
  ): Promise<SlotRecord | null>;
  /** The conditional cancel. `null` means the member does not own it. */
  releaseSlot(slotId: string, ownerUserId: string): Promise<SlotRecord | null>;
  /** How many other claimed slots the member holds in that scrim. */
  countUserSlotsInScrim(
    scrimId: string,
    userId: string,
    exceptSlotId?: string,
  ): Promise<number>;
  /** Moves the ownership and writes the member list back (B9). */
  transferSlot(
    slotId: string,
    newOwnerId: string,
    members: readonly string[],
  ): Promise<SlotRecord | null>;
  listUserSlots(
    scrimIds: readonly string[],
    userId: string,
  ): Promise<SlotRecord[]>;

  /* --- reminders --- */
  listReminders(scrimId: string): Promise<SlotReminderRecord[]>;
  addReminder(scrimId: string, userId: string): Promise<void>;
  deleteReminders(scrimId: string): Promise<void>;
  listReminderScrimIds(userId: string): Promise<string[]>;

  /* --- bans --- */
  isBanned(scrimId: string, userId: string): Promise<boolean>;
  listBannedUserIds(scrimId: string): Promise<string[]>;
  banUsers(
    entries: readonly { readonly scrimId: string; readonly userId: string }[],
    reason: string | null,
    expires: Date | null,
  ): Promise<void>;
  /** The bans of a scrim, with the reason and the expiry. */
  listBans(scrimId: string): Promise<BanRecord[]>;
  /** Lifts a ban. */
  unbanUser(scrimId: string, userId: string): Promise<void>;
}
