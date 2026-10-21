/**
 * A fake slot store.
 *
 * The service is the state machine and the repository is the SQL. This
 * is the seam between them: a store that answers from memory, so the
 * rules can be proved without a database.
 *
 * Every method the service does not use throws, so a test that reaches
 * for one it did not expect fails loudly instead of quietly getting
 * `undefined`.
 */

import type {
  ClaimValues,
} from "./repo.js";
import type {
  ScrimLite,
  SlotManagerRecord,
  SlotRecord,
  SlotReminderRecord,
  SlotStore,
} from "./types.js";

/** A slot, with sensible defaults. */
export function makeSlot(overrides: Partial<SlotRecord> = {}): SlotRecord {
  return {
    id: overrides.id ?? "slot-1",
    scrimId: overrides.scrimId ?? "scrim-1",
    num: overrides.num ?? 1,
    state: overrides.state ?? "claimed",
    teamName: overrides.teamName ?? "Team Alpha",
    ownerUserId:
      overrides.ownerUserId === undefined ? "captain" : overrides.ownerUserId,
    members: overrides.members ?? ["captain"],
    messageId: overrides.messageId ?? null,
    jumpUrl: overrides.jumpUrl ?? null,
    createdAt: overrides.createdAt ?? new Date(),
    updatedAt: overrides.updatedAt ?? new Date(),
  };
}

/** A scrim, with sensible defaults. */
export function makeScrim(overrides: Partial<ScrimLite> = {}): ScrimLite {
  return {
    id: overrides.id ?? "scrim-1",
    guildId: overrides.guildId ?? "guild-1",
    name: overrides.name ?? "Test Scrim",
    status: overrides.status ?? "closed",
    registrationChannelId:
      overrides.registrationChannelId ?? "channel-registration",
    slotlistChannelId: overrides.slotlistChannelId ?? "channel-slotlist",
    slotlistMessageId:
      overrides.slotlistMessageId === undefined
        ? null
        : overrides.slotlistMessageId,
    roleId: overrides.roleId === undefined ? "role-1" : overrides.roleId,
    startFrom: overrides.startFrom ?? 1,
    totalSlots: overrides.totalSlots ?? 10,
    openTime: overrides.openTime ?? new Date(),
    openedAt: overrides.openedAt ?? null,
    closedAt:
      overrides.closedAt === undefined ? new Date() : overrides.closedAt,
    matchTime:
      overrides.matchTime === undefined
        ? new Date(Date.now() + 3_600_000)
        : overrides.matchTime,
    hostId: overrides.hostId ?? "host-1",
  };
}

/** A slot manager, with sensible defaults. */
export function makeManager(
  overrides: Partial<SlotManagerRecord> = {},
): SlotManagerRecord {
  return {
    id: overrides.id ?? "manager-1",
    guildId: overrides.guildId ?? "guild-1",
    mainChannelId: overrides.mainChannelId ?? "channel-manager",
    messageId: overrides.messageId ?? "message-1",
    toggle: overrides.toggle ?? true,
    allowReminders: overrides.allowReminders ?? true,
    multipleSlots: overrides.multipleSlots ?? false,
    createdAt: overrides.createdAt ?? new Date(),
    updatedAt: overrides.updatedAt ?? new Date(),
  };
}

/** What the fake store recorded. */
export interface FakeStoreCalls {
  readonly claims: {
    readonly scrimId: string;
    readonly num: number;
    readonly values: ClaimValues;
  }[];
  readonly releases: { readonly slotId: string; readonly ownerUserId: string }[];
  readonly transfers: {
    readonly slotId: string;
    readonly newOwnerId: string;
    readonly members: readonly string[];
  }[];
  readonly reminders: { readonly scrimId: string; readonly userId: string }[];
}

/** How the fake store is set up. */
export interface FakeStoreOptions {
  readonly scrims?: readonly ScrimLite[];
  readonly slots?: readonly SlotRecord[];
  readonly reminders?: readonly SlotReminderRecord[];
  /**
   * The bans the store starts with.
   *
   * The reason and the expiry are there because the ban log entry of an
   * unban says what the ban was, and the row is the only place that is
   * written down.
   */
  readonly banned?: readonly {
    readonly scrimId: string;
    readonly userId: string;
    readonly teamName?: string | null;
    readonly reason?: string | null;
    readonly expires?: Date | null;
  }[];
  /** What `claimSlot` answers. `null` means somebody else won. */
  readonly claimResult?: SlotRecord | null;
  /** The slots a member holds, per scrim. */
  readonly userSlots?: readonly SlotRecord[];
}

/**
 * A store that answers from memory.
 *
 * @returns the store and the log of what it was asked to do.
 */
export function makeFakeStore(
  options: FakeStoreOptions = {},
): { readonly store: SlotStore; readonly calls: FakeStoreCalls } {
  const calls: FakeStoreCalls = {
    claims: [],
    releases: [],
    transfers: [],
    reminders: [],
  };

  const slots = [...(options.slots ?? [])];
  const scrims = [...(options.scrims ?? [])];
  const reminders = [...(options.reminders ?? [])];
  const banned = [...(options.banned ?? [])];
  const userSlots = [...(options.userSlots ?? [])];

  const store: SlotStore = {
    async getSlotManager(id) {
      return id === "manager-1" || id === "missing"
        ? makeManager({ id })
        : null;
    },
    async listSlotManagers() {
      return [makeManager()];
    },
    async countSlotManagers() {
      return 1;
    },
    async createSlotManager() {
      return makeManager();
    },
    async updateSlotManager(id, patch) {
      return makeManager({ id, ...patch });
    },
    async deleteSlotManager() {
      return;
    },
    async listSlotManagerScrimIds() {
      return scrims.map((scrim) => scrim.id);
    },
    async setSlotManagerScrims() {
      return;
    },
    async findSlotManagerForScrim() {
      return makeManager();
    },

    async getScrim(id) {
      return scrims.find((scrim) => scrim.id === id) ?? null;
    },
    async listScrims() {
      return scrims;
    },
    async listScrimsForManager() {
      return scrims;
    },
    async listScrimIds() {
      return scrims.map((scrim) => scrim.id);
    },

    async listSlots(scrimId) {
      return slots.filter((slot) => slot.scrimId === scrimId);
    },
    async getSlot(id) {
      return slots.find((slot) => slot.id === id) ?? null;
    },
    async getSlotByNum(scrimId, num) {
      return (
        slots.find((slot) => slot.scrimId === scrimId && slot.num === num) ??
        null
      );
    },
    async countFreeSlots(scrimId) {
      return slots.filter(
        (slot) => slot.scrimId === scrimId && slot.state === "free",
      ).length;
    },
    async claimSlot(scrimId, num, values) {
      calls.claims.push({ scrimId, num, values });

      if (options.claimResult === undefined) {
        return makeSlot({ scrimId, num, ...values });
      }

      return options.claimResult;
    },
    async releaseSlot(slotId, ownerUserId) {
      calls.releases.push({ slotId, ownerUserId });

      const slot = slots.find((entry) => entry.id === slotId);

      if (!slot) return null;
      if (slot.ownerUserId !== ownerUserId) return null;

      return makeSlot({ ...slot, state: "free", ownerUserId: null });
    },
    async countUserSlotsInScrim(scrimId, userId, exceptSlotId) {
      return userSlots.filter(
        (slot) =>
          slot.scrimId === scrimId &&
          slot.ownerUserId === userId &&
          slot.id !== exceptSlotId &&
          slot.state === "claimed",
      ).length;
    },
    async transferSlot(slotId, newOwnerId, members) {
      calls.transfers.push({ slotId, newOwnerId, members });

      const slot = slots.find((entry) => entry.id === slotId);

      if (!slot) return null;

      return makeSlot({ ...slot, ownerUserId: newOwnerId, members: [...members] });
    },
    async listUserSlots(scrimIds, userId) {
      return userSlots.filter(
        (slot) =>
          scrimIds.includes(slot.scrimId) && slot.ownerUserId === userId,
      );
    },

    async listReminders(scrimId) {
      return reminders.filter((reminder) => reminder.scrimId === scrimId);
    },
    async addReminder(scrimId, userId) {
      calls.reminders.push({ scrimId, userId });
    },
    async deleteReminders() {
      return;
    },
    async listReminderScrimIds(userId) {
      return reminders
        .filter((reminder) => reminder.userId === userId)
        .map((reminder) => reminder.scrimId);
    },

    async isBanned(scrimId, userId) {
      return banned.some(
        (entry) => entry.scrimId === scrimId && entry.userId === userId,
      );
    },
    async listBannedUserIds(scrimId) {
      return banned
        .filter((entry) => entry.scrimId === scrimId)
        .map((entry) => entry.userId);
    },
    async banUsers() {
      return;
    },
    async listBans(scrimId) {
      return banned
        .filter((entry) => entry.scrimId === scrimId)
        .map((entry) => ({
          userId: entry.userId,
          teamName: entry.teamName ?? null,
          reason: entry.reason ?? null,
          expires: entry.expires ?? null,
        }));
    },
    async unbanUser(scrimId, userId) {
      const index = banned.findIndex(
        (entry) => entry.scrimId === scrimId && entry.userId === userId,
      );

      if (index >= 0) banned.splice(index, 1);
    },
  };

  return { store, calls };
}
