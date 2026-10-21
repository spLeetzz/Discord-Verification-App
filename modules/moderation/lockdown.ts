/**
 * Lockdowns and maintenance mode.
 *
 * A lockdown is a row in the `lockdowns` table. The row *is* the state: it
 * says which channels are locked, by whom, until when, and what their
 * permissions looked like before. Nothing is stored anywhere else.
 *
 * A lockdown with a duration also has a row in the durable `jobs` table.
 * That row is the **timer** and nothing else: it says when the lockdown
 * lifts by itself. A lockdown with no duration has no job row at all —
 * there is nothing to schedule, and the state it needs is on the
 * lockdown row already.
 *
 * **The expiry is never a `setTimeout`.** A timer dies with the process,
 * and the channel stays locked forever. The job row is in the database,
 * so the unlock survives a restart.
 *
 * Three Quotient bugs are fixed here rather than copied:
 *
 *  1. `unlock server` called `.first()` on a coroutine and always raised
 *     `AttributeError` (`mod/__init__.py:609`). The lookup is a query now.
 *  2. `lock server` without a duration created the row before the null
 *     check and crashed on `None.dt` (`mod/__init__.py:568-578`). The row
 *     is written with a null expiry, which the column allows.
 *  3. The unlock set `send_messages = True` unconditionally, opening a
 *     channel that had been write-locked before. The previous state is
 *     recorded on the lockdown row and restored exactly.
 */

import { ChannelType, PermissionFlagsBits } from "discord.js";
import type {
  Channel,
  Guild,
  GuildBasedChannel,
  GuildMember,
  PermissionOverwriteManager,
  Role,
} from "discord.js";
import { PermissionDeniedError } from "../../core/errors.js";
import { readOverwriteState, planRestore } from "./permissions.js";
import { evaluateLock, evaluateUnlock } from "./lock-state.js";
import { createLockdown, listLockdowns, removeLockdown } from "./repo.js";
import type {
  LockPermission,
  LockRecord,
  LockdownJobPayload,
  PriorPermissionState,
} from "./types.js";

/**
 * A channel the bot can lock.
 *
 * Threads do not have their own permission overwrites and a category is
 * not a channel anybody writes in, so neither is in the union.
 */
export type LockableChannel = Exclude<
  Extract<
    GuildBasedChannel,
    { permissionOverwrites: PermissionOverwriteManager }
  >,
  { type: ChannelType.GuildCategory }
>;

/**
 * Is this channel one the bot can lock?
 *
 * A type guard rather than a cast, so the callers get a `LockableChannel`
 * and not a `Channel` they have to narrow again.
 */
export function isLockableChannel(channel: Channel): channel is LockableChannel {
  if (!("permissionOverwrites" in channel)) return false;

  return channel.type !== ChannelType.GuildCategory;
}

/** What a command needs to know about the moderator. */
export interface LockContext {
  readonly guild: Guild;
  readonly author: GuildMember;
  /** The audit-log reason. */
  readonly reason: string;
  /** The channel the command was run in, for the closing message. */
  readonly sourceChannelId: string | null;
}

/** What a lock did. */
export interface LockApplyResult {
  readonly lockdownId: string;
  /** How many channels were locked. */
  readonly locked: number;
  /** How many channels could not be locked. */
  readonly failed: number;
  readonly expireTime: Date | null;
}

/** What an unlock did. */
export interface LockReleaseResult {
  /** How many channels were put back the way they were. */
  readonly restored: number;
  /** How many channels could not be changed back. */
  readonly failed: number;
  /**
   * How many channels were reset to "inherit" because the record of their
   * previous permissions was missing.
   */
  readonly withoutRecord: number;
}

/* ------------------------------------------------------------------ *
 * Discord adapters
 * ------------------------------------------------------------------ */

/**
 * Reads the state of a permission on a channel for one target.
 */
function captureOverwriteState(
  channel: LockableChannel,
  targetId: string,
  permission: LockPermission,
): PriorPermissionState {
  const overwrite = channel.permissionOverwrites.cache.get(targetId);

  if (!overwrite) return { existed: false, value: null };

  const flag = PermissionFlagsBits[permission];

  return readOverwriteState({
    exists: true,
    allowed: overwrite.allow.has(flag, false),
    denied: overwrite.deny.has(flag, false),
  });
}

/**
 * Puts a permission back the way it was.
 *
 * `null` means "inherit", which is what the channel was doing when it had
 * no explicit overwrite for the target.
 */
async function restoreOverwrite(
  channel: LockableChannel,
  target: Role,
  permission: LockPermission,
  prior: PriorPermissionState | undefined,
  reason: string,
): Promise<boolean> {
  const plan = planRestore(
    prior ?? { existed: false, value: null },
  );

  try {
    if (plan.kind === "remove") {
      await channel.permissionOverwrites.delete(target, reason);
    } else {
      await channel.permissionOverwrites.edit(
        target,
        { [permission]: plan.value },
        { reason },
      );
    }

    return true;
  } catch {
    return false;
  }
}

/**
 * May the bot change this channel's permissions?
 */
function botCanEdit(channel: LockableChannel, guild: Guild): boolean {
  const botMember = guild.members.me;
  if (!botMember) return false;

  const permissions = channel.permissionsFor(botMember);
  if (!permissions) return false;

  return permissions.has(PermissionFlagsBits.ManageChannels);
}

/* ------------------------------------------------------------------ *
 * The shared machinery
 * ------------------------------------------------------------------ */

/** What to lock, and how. */
interface ApplyLockInput {
  readonly context: LockContext;
  readonly type: LockRecord["type"];
  /** The permission that is taken away. */
  readonly permission: LockPermission;
  /** Whose permission is changed — `@everyone`, or a role. */
  readonly target: Role;
  /** The channels to change. */
  readonly channels: readonly LockableChannel[];
  /** The channel recorded on the lockdown row. */
  readonly channelId: string | null;
  /** The role recorded on the lockdown row. */
  readonly roleId: string | null;
  /** When the lockdown lifts by itself. */
  readonly expireTime: Date | null;
  /** The maintenance channels that were created with this lockdown. */
  readonly maintenanceChannelIds?: readonly string[];
}

/**
 * Takes the permission away and records everything needed to put it back.
 */
async function applyLock(input: ApplyLockInput): Promise<LockApplyResult> {
  const { context, permission, target } = input;
  const { guild } = context;

  const prior: Record<string, PriorPermissionState> = {};
  const lockedChannels: string[] = [];
  let failed = 0;

  for (const channel of input.channels) {
    if (!botCanEdit(channel, guild)) {
      failed += 1;
      continue;
    }

    const state = captureOverwriteState(channel, target.id, permission);

    try {
      await channel.permissionOverwrites.edit(
        target,
        { [permission]: false },
        { reason: context.reason },
      );
    } catch {
      failed += 1;
      continue;
    }

    prior[channel.id] = state;
    lockedChannels.push(channel.id);
  }

  if (lockedChannels.length === 0) {
    // Nothing was locked, so there is nothing to record. A record with no
    // channels in it would refuse the next attempt to lock.
    throw new PermissionDeniedError(
      "I could not change the permissions of any channel.",
    );
  }

  const record = await createLockdown({
    guildId: guild.id,
    type: input.type,
    roleId: input.roleId,
    channelId: input.channelId,
    channelIds: lockedChannels,
    expireTime: input.expireTime,
    authorId: context.author.id,
    priorState: prior,
    sourceChannelId: context.sourceChannelId,
    maintenanceChannelIds: input.maintenanceChannelIds ?? [],
  });

  return {
    lockdownId: record.id,
    locked: lockedChannels.length,
    failed,
    expireTime: input.expireTime,
  };
}

/** What to unlock, and how. */
interface ReleaseLockInput {
  readonly context: LockContext;
  readonly record: LockRecord;
  /** The permission that was taken away. */
  readonly permission: LockPermission;
  /** Whose permission was changed. */
  readonly target: Role;
  /**
   * Whether the recorded state should be restored. When it is not — a
   * category that was unhidden without a record — the permission is simply
   * turned back on.
   */
  readonly restore: boolean;
}

/**
 * Puts the permission back and removes the record.
 */
export async function releaseLock(
  input: ReleaseLockInput,
): Promise<LockReleaseResult> {
  const { context, record, permission, target } = input;
  const { guild } = context;

  // The prior state is on the lockdown row. It is the property of the
  // lockdown, not of the timer, so it is there whether the lockdown has
  // an expiry or not.
  const prior = record.priorState ?? {};

  let restored = 0;
  let failed = 0;
  let withoutRecord = 0;

  for (const channelId of record.channelIds) {
    const channel = guild.channels.cache.get(channelId);

    if (!channel || !isLockableChannel(channel)) {
      failed += 1;
      continue;
    }

    if (!botCanEdit(channel, guild)) {
      failed += 1;
      continue;
    }

    const state = prior[channelId];

    if (!input.restore || !state) {
      // Nothing was recorded, so the permission goes back to inheriting.
      // Only the bit that was changed is unset — the rest of the
      // overwrite, if there is one, is left alone. The channel is not
      // left write-locked, and nothing else is lost.
      const ok = await restoreOverwrite(
        channel,
        target,
        permission,
        { existed: true, value: null },
        context.reason,
      );

      if (ok) {
        withoutRecord += 1;
      } else {
        failed += 1;
      }

      continue;
    }

    const ok = await restoreOverwrite(
      channel,
      target,
      permission,
      state,
      context.reason,
    );

    if (ok) {
      restored += 1;
    } else {
      failed += 1;
    }
  }

  await removeLockdown(record.id);

  return { restored, failed, withoutRecord };
}

/* ------------------------------------------------------------------ *
 * The commands
 * ------------------------------------------------------------------ */

/**
 * Locks one channel.
 *
 * @throws PermissionDeniedError when the channel is already locked or the
 *         bot may not change it.
 */
export async function lockChannel(input: {
  readonly context: LockContext;
  readonly channel: LockableChannel;
  readonly duration: Date | null;
}): Promise<LockApplyResult> {
  const { context, channel, duration } = input;
  const { guild } = context;

  const existing = await listLockdowns(guild.id);

  const decision = evaluateLock(
    {
      type: "channel",
      guildId: guild.id,
      channelId: channel.id,
      channelIds: [channel.id],
      roleId: null,
      expireTime: duration,
      authorId: context.author.id,
      channelName: channel.name,
    },
    existing,
  );

  if (!decision.allowed) throw new PermissionDeniedError(decision.reason);

  if (!botCanEdit(channel, guild)) {
    throw new PermissionDeniedError(
      `I need \`manage_channels\` permission in **${channel.name}**`,
    );
  }

  return applyLock({
    context,
    type: "channel",
    permission: "SendMessages",
    target: guild.roles.everyone,
    channels: [channel],
    channelId: channel.id,
    roleId: null,
    expireTime: duration,
  });
}

/**
 * The channels a server lockdown would cover.
 */
export function channelsForServerLock(guild: Guild): LockableChannel[] {
  const everyone = guild.roles.everyone;

  return [...guild.channels.cache.values()].filter(
    (channel): channel is LockableChannel => {
      if (!isLockableChannel(channel)) return false;

      const permissions = channel.permissionsFor(everyone);
      return (
        permissions !== null && permissions.has(PermissionFlagsBits.SendMessages)
      );
    },
  );
}

/**
 * The channels a server lockdown would actually cover.
 *
 * The bot may not be able to edit every channel, so the count the
 * moderator is shown is the count that will really be locked.
 */
export function channelsToLockForServer(guild: Guild): LockableChannel[] {
  return channelsForServerLock(guild).filter((channel) =>
    botCanEdit(channel, guild),
  );
}

/**
 * Locks the whole server.
 *
 * @throws PermissionDeniedError when the server is already locked or no
 *         channel can be locked.
 */
export async function lockServer(input: {
  readonly context: LockContext;
  readonly duration: Date | null;
}): Promise<LockApplyResult> {
  const { context, duration } = input;
  const { guild } = context;

  const existing = await listLockdowns(guild.id);

  const decision = evaluateLock(
    {
      type: "guild",
      guildId: guild.id,
      channelId: context.sourceChannelId,
      channelIds: [],
      roleId: null,
      expireTime: duration,
      authorId: context.author.id,
    },
    existing,
  );

  if (!decision.allowed) throw new PermissionDeniedError(decision.reason);

  const channels = channelsToLockForServer(guild);

  if (channels.length === 0) {
    throw new PermissionDeniedError(
      "@everyone has `send_messages` enabled in no channel I can edit.",
    );
  }

  return applyLock({
    context,
    type: "guild",
    permission: "SendMessages",
    target: guild.roles.everyone,
    channels,
    channelId: context.sourceChannelId,
    roleId: null,
    expireTime: duration,
  });
}

/**
 * Unlocks one channel.
 *
 * @throws PermissionDeniedError when there is no lockdown to lift.
 */
export async function unlockChannel(input: {
  readonly context: LockContext;
  readonly channel: LockableChannel;
}): Promise<LockReleaseResult> {
  const { context, channel } = input;
  const { guild } = context;

  const existing = await listLockdowns(guild.id);

  const decision = evaluateUnlock(
    {
      type: "channel",
      guildId: guild.id,
      channelId: channel.id,
      channelIds: [channel.id],
      roleId: null,
      expireTime: null,
      authorId: context.author.id,
      channelName: channel.name,
    },
    existing,
  );

  if (!decision.allowed) throw new PermissionDeniedError(decision.reason);
  if (!decision.record) {
    throw new PermissionDeniedError("That channel is not locked.");
  }

  return releaseLock({
    context,
    record: decision.record,
    permission: "SendMessages",
    target: guild.roles.everyone,
    restore: decision.restore,
  });
}

/**
 * Unlocks the whole server.
 *
 * @throws PermissionDeniedError when the server is not locked.
 */
export async function unlockServer(
  context: LockContext,
): Promise<LockReleaseResult> {
  const { guild } = context;

  const existing = await listLockdowns(guild.id);

  const decision = evaluateUnlock(
    {
      type: "guild",
      guildId: guild.id,
      channelId: context.sourceChannelId,
      channelIds: [],
      roleId: null,
      expireTime: null,
      authorId: context.author.id,
    },
    existing,
  );

  if (!decision.allowed) throw new PermissionDeniedError(decision.reason);
  if (!decision.record) {
    throw new PermissionDeniedError("The server is not locked.");
  }

  return releaseLock({
    context,
    record: decision.record,
    permission: "SendMessages",
    target: guild.roles.everyone,
    restore: decision.restore,
  });
}

/** The channels a maintenance mode would hide. */
export function channelsForMaintenance(
  guild: Guild,
  role: Role,
): LockableChannel[] {
  return [...guild.channels.cache.values()].filter(
    (channel): channel is LockableChannel => {
      if (!isLockableChannel(channel)) return false;

      const permissions = channel.permissionsFor(role);
      return (
        permissions !== null && permissions.has(PermissionFlagsBits.ViewChannel)
      );
    },
  );
}

/**
 * The channels a maintenance mode would actually hide.
 */
export function channelsToHideForMaintenance(
  guild: Guild,
  role: Role,
): LockableChannel[] {
  return channelsForMaintenance(guild, role).filter((channel) =>
    botCanEdit(channel, guild),
  );
}

/**
 * Turns maintenance mode on.
 *
 * @throws PermissionDeniedError when the server is already under
 *         maintenance for that role.
 */
export async function maintenanceOn(input: {
  readonly context: LockContext;
  readonly role: Role;
  readonly expireTime?: Date | null;
  /** The maintenance channels that were created alongside the lockdown. */
  readonly maintenanceChannelIds?: readonly string[];
}): Promise<LockApplyResult> {
  const { context, role } = input;
  const { guild } = context;

  const existing = await listLockdowns(guild.id);

  const decision = evaluateLock(
    {
      type: "maintenance",
      guildId: guild.id,
      channelId: context.sourceChannelId,
      channelIds: [],
      roleId: role.id,
      expireTime: input.expireTime ?? null,
      authorId: context.author.id,
      roleName: role.name,
    },
    existing,
  );

  if (!decision.allowed) throw new PermissionDeniedError(decision.reason);

  const channels = channelsToHideForMaintenance(guild, role);

  if (channels.length === 0) {
    throw new PermissionDeniedError(
      `**${role.name}** has \`read_messages\` enabled in no channel I can edit.`,
    );
  }

  return applyLock({
    context,
    type: "maintenance",
    permission: "ViewChannel",
    target: role,
    channels,
    channelId: context.sourceChannelId,
    roleId: role.id,
    expireTime: input.expireTime ?? null,
    maintenanceChannelIds: input.maintenanceChannelIds ?? [],
  });
}

/**
 * Turns maintenance mode off.
 *
 * @throws PermissionDeniedError when the server is not under maintenance
 *         for that role.
 */
export async function maintenanceOff(input: {
  readonly context: LockContext;
  readonly role: Role;
}): Promise<LockReleaseResult> {
  const { context, role } = input;
  const { guild } = context;

  const existing = await listLockdowns(guild.id);

  const decision = evaluateUnlock(
    {
      type: "maintenance",
      guildId: guild.id,
      channelId: context.sourceChannelId,
      channelIds: [],
      roleId: role.id,
      expireTime: null,
      authorId: context.author.id,
      roleName: role.name,
    },
    existing,
  );

  if (!decision.allowed) throw new PermissionDeniedError(decision.reason);
  if (!decision.record) {
    throw new PermissionDeniedError(
      `The server is not under maintenance for **${role.name}**.`,
    );
  }

  return releaseLock({
    context,
    record: decision.record,
    permission: "ViewChannel",
    target: role,
    restore: decision.restore,
  });
}

/**
 * The channels a category hide would cover.
 */
export function channelsForCategory(
  guild: Guild,
  categoryId: string,
): LockableChannel[] {
  return [...guild.channels.cache.values()].filter(
    (channel): channel is LockableChannel =>
      isLockableChannel(channel) && channel.parentId === categoryId,
  );
}

/**
 * Hides a category.
 *
 * @throws PermissionDeniedError when the category is already hidden.
 */
export async function hideCategory(input: {
  readonly context: LockContext;
  readonly categoryId: string;
  readonly categoryName: string;
}): Promise<LockApplyResult> {
  const { context, categoryId, categoryName } = input;
  const { guild } = context;

  const existing = await listLockdowns(guild.id);

  const decision = evaluateLock(
    {
      type: "category",
      guildId: guild.id,
      channelId: categoryId,
      channelIds: [],
      roleId: null,
      expireTime: null,
      authorId: context.author.id,
      channelName: categoryName,
    },
    existing,
  );

  if (!decision.allowed) throw new PermissionDeniedError(decision.reason);

  const channels = channelsForCategory(guild, categoryId).filter((channel) =>
    botCanEdit(channel, guild),
  );

  if (channels.length === 0) {
    throw new PermissionDeniedError(
      `**${categoryName}** has no channel I can edit.`,
    );
  }

  return applyLock({
    context,
    type: "category",
    permission: "ViewChannel",
    target: guild.roles.everyone,
    channels,
    channelId: categoryId,
    roleId: null,
    expireTime: null,
  });
}

/**
 * Unhides a category.
 *
 * @throws PermissionDeniedError when the category cannot be unhidden.
 */
export async function unhideCategory(input: {
  readonly context: LockContext;
  readonly categoryId: string;
  readonly categoryName: string;
}): Promise<LockReleaseResult> {
  const { context, categoryId, categoryName } = input;
  const { guild } = context;

  const existing = await listLockdowns(guild.id);

  const decision = evaluateUnlock(
    {
      type: "category",
      guildId: guild.id,
      channelId: categoryId,
      channelIds: [],
      roleId: null,
      expireTime: null,
      authorId: context.author.id,
      channelName: categoryName,
    },
    existing,
  );

  if (!decision.allowed) throw new PermissionDeniedError(decision.reason);

  if (!decision.record) {
    // There is no record, so the channels are simply opened again.
    const channels = channelsForCategory(guild, categoryId);
    let restored = 0;
    let failed = 0;

    for (const channel of channels) {
      if (!botCanEdit(channel, guild)) {
        failed += 1;
        continue;
      }

      const ok = await restoreOverwrite(
        channel,
        guild.roles.everyone,
        "ViewChannel",
        { existed: true, value: true },
        context.reason,
      );

      if (ok) {
        restored += 1;
      } else {
        failed += 1;
      }
    }

    return { restored, failed, withoutRecord: restored };
  }

  return releaseLock({
    context,
    record: decision.record,
    permission: "ViewChannel",
    target: guild.roles.everyone,
    restore: decision.restore,
  });
}

/**
 * The lockdown a job payload belongs to, for the expiry handler.
 */
export async function recordForPayload(
  payload: LockdownJobPayload,
): Promise<LockRecord | null> {
  const existing = await listLockdowns(payload.guildId);
  return existing.find((record) => record.id === payload.lockdownId) ?? null;
}
