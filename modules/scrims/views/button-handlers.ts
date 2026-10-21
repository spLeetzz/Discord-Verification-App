/**
 * The button handlers.
 *
 * Every button writes **one** field (or one state transition) and then
 * re-renders the panel from the row that comes back.
 *
 * Two of the source's behaviours are deliberately not ported:
 *
 *  - the "apply to all scrims" question now comes **before** the
 *    re-render, not after it, so the moderator answers the question
 *    about the panel they are looking at;
 *  - the editor's "Skip to" button now does something.
 */

import { ChannelType, MessageFlags } from "discord.js";
import type { ButtonInteraction, EmbedBuilder } from "discord.js";
import { awaitSelect } from "../../../core/select.js";
import { prompt } from "../../../core/prompt.js";
import { parseNaturalTime } from "../../../core/time.js";
import { Day, PremiumFeature } from "../../../core/constants.js";
import type { Weekday } from "../../../db/schema/common.js";
import { assertEntitled, FREE_TIER, isEntitled } from "../../premium/index.js";
import * as repo from "../repo.js";
import * as service from "../service.js";
import { slotNumbers } from "../slots.js";
import { truncate } from "../../../core/text.js";
import type { ScrimRecord } from "../types.js";
import { EDITOR_FIELDS, buildModal } from "./components.js";
import { scrimsId } from "./ids.js";
import {
  buildEditorPanel,
  buildListPanel,
  buildScrimPanel,
  buildWizardPanel,
  newWizardState,
  wizardIsComplete,
  wizardStore,
} from "./manager.js";
import type { PanelComponents } from "./manager.js";
import {
  buildAutocleanPanel,
  buildBanPanel,
  buildDesignPanel,
  buildReservePanel,
  buildSlotlistEditorPanel,
} from "./panels.js";
import {
  fail,
  refuseUnlessMod,
  scrimPosition,
  updatePanel,
} from "./handlers.js";
import { buildSlotlistPanel, publishSlotlist } from "./slotlist.js";
import { writeBanLog } from "./ban-log.js";
import { openRegistrationFlow, closeRegistrationFlow } from "./lifecycle.js";
import { punishSelection } from "./modal-handlers.js";
import { awaitChannelSelect, awaitRoleSelect } from "./select-flow.js";
import { slotSelection } from "./modal-handlers.js";
import { randomId } from "../../../core/custom-id.js";

/**
 * May the guild have one more scrim?
 *
 * The allowance comes from the free-tier table (D45), never from a
 * literal.
 */
export async function canCreateScrim(guildId: string): Promise<boolean> {
  if (await isEntitled(guildId, PremiumFeature.scrimSlots)) return true;

  const current = await repo.countScrims(guildId);

  return current < FREE_TIER.scrims;
}

/**
 * Re-renders a panel onto the message it belongs to.
 *
 * The message is edited directly rather than through the interaction,
 * because by the time a panel is re-rendered the interaction has often
 * already been answered — by `awaitSelect`, or by a prompt.
 */
async function refresh(
  interaction: ButtonInteraction,
  panel: { embeds: EmbedBuilder[]; components: PanelComponents },
): Promise<void> {
  const message = interaction.message;

  if (!message) return;

  await message.edit({ embeds: panel.embeds, components: panel.components });
}

/** Handles one button press. */
export async function handleScrimsButton(
  interaction: ButtonInteraction,
  action: string,
  parts: readonly string[],
): Promise<void> {
  if (await refuseUnlessMod(interaction)) return;

  switch (action) {
    case "list":
      await showList(interaction);
      return;
    case "new":
      await startWizard(interaction);
      return;
    case "wizard":
      await handleWizardButton(interaction, parts);
      return;
    case "editor":
      await handleEditorButton(interaction, parts);
      return;
    case "editor_open":
      await openEditor(interaction, parts);
      return;
    case "editor_nav":
      await handleEditorNav(interaction, parts);
      return;
    case "manager":
      await handleManagerButton(interaction, parts);
      return;
    case "ban":
      await handleBanButton(interaction, parts);
      return;
    case "reserve":
      await handleReserveButton(interaction, parts);
      return;
    case "autoclean":
      await handleAutocleanButton(interaction, parts);
      return;
    case "design":
      await handleDesignButton(interaction, parts);
      return;
    case "slotlist":
      await handleSlotlistButton(interaction, parts);
      return;
    default:
      await fail(interaction, "That button is no longer active.");
  }
}

/** The list panel. */
export async function showList(interaction: ButtonInteraction): Promise<void> {
  const guildId = interaction.guildId;

  if (!guildId) {
    await fail(interaction, "This only works in a server.");

    return;
  }

  const scrims = await repo.listScrims(guildId);
  const panel = buildListPanel(scrims, await canCreateScrim(guildId));

  await updatePanel(interaction, panel);
}

/* ------------------------------------------------------------------ *
 * The wizard
 * ------------------------------------------------------------------ */

/** Starts the creation wizard. */
async function startWizard(interaction: ButtonInteraction): Promise<void> {
  const guildId = interaction.guildId;

  if (!guildId) {
    await fail(interaction, "This only works in a server.");

    return;
  }

  if (!(await canCreateScrim(guildId))) {
    await fail(
      interaction,
      `You can only have ${FREE_TIER.scrims} scrims on this server. The limit comes from the free-tier allowance.`,
    );

    return;
  }

  const state = newWizardState(guildId, interaction.user.id);
  const token = wizardStore.issue(state);

  await updatePanel(interaction, buildWizardPanel(state, token));
}

/** The wizard's buttons. */
async function handleWizardButton(
  interaction: ButtonInteraction,
  parts: readonly string[],
): Promise<void> {
  const [field, token] = parts;

  if (!field || !token) {
    await fail(interaction, "That button is no longer active.");

    return;
  }

  const state = wizardStore.get(token);

  if (!state) {
    await fail(
      interaction,
      "This wizard has expired. Please run the command again.",
    );

    return;
  }

  switch (field) {
    case "cancel": {
      wizardStore.delete(token);

      const guildId = interaction.guildId;

      if (!guildId) return;

      const scrims = await repo.listScrims(guildId);
      await updatePanel(
        interaction,
        buildListPanel(scrims, await canCreateScrim(guildId)),
      );

      return;
    }

    case "save": {
      if (!wizardIsComplete(state)) {
        await fail(interaction, "The scrim is not complete yet.");

        return;
      }

      const scrimId = await service.createScrimFromWizard(state);
      wizardStore.delete(token);

      const scrim = await repo.getScrim(scrimId);

      if (!scrim) {
        await fail(interaction, "The scrim could not be created.");

        return;
      }

      await updatePanel(interaction, buildScrimPanel(scrim));

      return;
    }

    case "set_reg_channel": {
      const channelId = await awaitChannelSelect(interaction, {
        placeholder: "Where do the teams register?",
      });

      if (!channelId) return;

      state.registrationChannelId = channelId;

      // The source did the same: the slotlist channel follows the
      // registration channel until it is set on its own.
      if (!state.slotlistChannelId) state.slotlistChannelId = channelId;

      await refresh(interaction, buildWizardPanel(state, token));

      return;
    }

    case "set_slot_channel": {
      const channelId = await awaitChannelSelect(interaction, {
        placeholder: "Where is the slotlist posted?",
      });

      if (!channelId) return;

      state.slotlistChannelId = channelId;

      await refresh(interaction, buildWizardPanel(state, token));

      return;
    }

    case "set_role": {
      const roleId = await awaitRoleSelect(interaction, {
        placeholder: "The role a team gets when it registers",
      });

      if (!roleId) return;

      state.roleId = roleId;

      await refresh(interaction, buildWizardPanel(state, token));

      return;
    }

    case "set_mentions":
      await interaction.showModal(
        buildModal({
          customId: scrimsId("modal", "wizard", "set_mentions", token),
          title: "Required mentions",
          text: {
            label: "How many mentions are required? (0 - 10)",
            placeholder: "4",
            maxLength: 2,
          },
        }),
      );

      return;

    case "set_slots":
      await interaction.showModal(
        buildModal({
          customId: scrimsId("modal", "wizard", "set_slots", token),
          title: "Total slots",
          text: {
            label: "How many slots does the scrim have? (1 - 30)",
            placeholder: "10",
            maxLength: 2,
          },
        }),
      );

      return;

    case "set_open_time":
      await interaction.showModal(
        buildModal({
          customId: scrimsId("modal", "wizard", "set_open_time", token),
          title: "Open time",
          text: {
            label: "When should registration open? (IST)",
            placeholder: "every day at 7 PM",
            maxLength: 64,
          },
        }),
      );

      return;

    case "set_emojis":
      await interaction.showModal(
        buildModal({
          customId: scrimsId("modal", "wizard", "set_emojis", token),
          title: "Reactions",
          text: {
            label: "Two emojis, separated by a comma",
            placeholder: "✅,❌",
            maxLength: 16,
          },
        }),
      );

      return;

    case "set_days": {
      const options = Object.values(Day).map((day) => ({
        label: day.slice(0, 1).toUpperCase() + day.slice(1),
        value: day,
        description: day.slice(0, 2).toUpperCase(),
      }));

      const chosen = await awaitSelect(interaction, options, {
        maxValues: 7,
        placeholder: "Which days should registration open?",
        question: "Pick the days registration should open on.",
        ephemeral: true,
      });

      if (chosen.length === 0) return;

      state.openDays = chosen as Weekday[];

      await refresh(interaction, buildWizardPanel(state, token));

      return;
    }

    default:
      await fail(interaction, "That button is no longer active.");
  }
}

/* ------------------------------------------------------------------ *
 * The editor
 * ------------------------------------------------------------------ */

/** Opens the editor of a scrim. */
async function openEditor(
  interaction: ButtonInteraction,
  parts: readonly string[],
): Promise<void> {
  const [scrimId] = parts;

  if (!scrimId) {
    await fail(interaction, "That button is no longer active.");

    return;
  }

  const scrim = await repo.getScrim(scrimId);

  if (!scrim) {
    await fail(interaction, "This scrim no longer exists.");

    return;
  }

  const position = await scrimPosition(scrim);

  await updatePanel(interaction, buildEditorPanel(scrim, position, true));
}

/** The editor's field buttons. */
async function handleEditorButton(
  interaction: ButtonInteraction,
  parts: readonly string[],
): Promise<void> {
  const [key, scrimId] = parts;

  if (!key || !scrimId) {
    await fail(interaction, "That button is no longer active.");

    return;
  }

  const scrim = await repo.getScrim(scrimId);

  if (!scrim) {
    await fail(interaction, "This scrim no longer exists.");

    return;
  }

  const field = EDITOR_FIELDS.find((entry) => entry.key === key);

  if (!field) {
    await fail(interaction, "That button is no longer active.");

    return;
  }

  if (field.premium) {
    try {
      await assertEntitled(scrim.guildId, PremiumFeature.scrimSlots);
    } catch (error) {
      await fail(
        interaction,
        error instanceof Error ? error.message : "This feature is premium.",
      );

      return;
    }
  }

  if (field.kind === "toggle") {
    await toggleField(
      interaction,
      scrim,
      field.column ?? field.key,
      field.applyToAll ?? false,
    );

    return;
  }

  if (field.kind === "panel") {
    await updatePanel(interaction, buildAutocleanPanel(scrim));

    return;
  }

  if (field.kind === "channel") {
    // D17: a channel is a select menu, never a typed mention.
    const channelId = await awaitChannelSelect(interaction, {
      placeholder:
        field.key === "set_reg_channel"
          ? "Where do the teams register?"
          : "Where is the slotlist posted?",
    });

    if (!channelId) return;

    await repo.updateScrim(
      scrim.id,
      field.key === "set_reg_channel"
        ? { registrationChannelId: channelId }
        : { slotlistChannelId: channelId },
    );

    const fresh = await repo.getScrim(scrim.id);

    if (!fresh) return;

    await refresh(interaction, buildEditorPanel(fresh, await scrimPosition(fresh), true));

    return;
  }

  if (field.kind === "role") {
    // D17: a role is a select menu, never a typed mention.
    const roleId = await awaitRoleSelect(interaction, {
      placeholder: rolePlaceholder(field.key),
    });

    if (!roleId) return;

    await repo.updateScrim(scrim.id, { [roleField(field.key)]: roleId });

    const fresh = await repo.getScrim(scrim.id);

    if (!fresh) return;

    await refresh(interaction, buildEditorPanel(fresh, await scrimPosition(fresh), true));

    return;
  }

  if (field.kind === "days") {
    const options = Object.values(Day).map((day) => ({
      label: day.slice(0, 1).toUpperCase() + day.slice(1),
      value: day,
      description: day.slice(0, 2).toUpperCase(),
    }));

    const chosen = await awaitSelect(interaction, options, {
      maxValues: 7,
      placeholder: "Which days should registration open?",
      question: "Pick the days registration should open on.",
      ephemeral: true,
    });

    if (chosen.length === 0) return;

    await repo.updateScrim(scrim.id, { openDays: chosen as Weekday[] });

    const fresh = await repo.getScrim(scrim.id);

    if (!fresh) return;

    await updatePanel(
      interaction,
      buildEditorPanel(fresh, await scrimPosition(fresh), true),
    );

    return;
  }

  const modal = fieldModalFor(field.key, scrim.id);

  if (!modal) {
    await fail(interaction, "That button is no longer active.");

    return;
  }

  await interaction.showModal(modal);
}

/** The placeholder of the role menu for a field. */
function rolePlaceholder(key: string): string {
  switch (key) {
    case "set_role":
      return "The role a team gets when it registers";
    case "set_ping_role":
      return "The role pinged when registration opens";
    case "set_open_role":
      return "The role the channel is opened to";
    default:
      return "Pick a role";
  }
}

/** The column a role field writes. */
function roleField(key: string): "roleId" | "pingRoleId" | "openRoleId" {
  switch (key) {
    case "set_ping_role":
      return "pingRoleId";
    case "set_open_role":
      return "openRoleId";
    default:
      return "roleId";
  }
}

/** The modal behind one editor field. */
export function fieldModalFor(
  key: string,
  scrimId: string,
): ReturnType<typeof buildModal> | null {
  switch (key) {
    case "set_name":
      return buildModal({
        customId: scrimsId("modal", "field", key, scrimId),
        title: "Scrim name",
        text: { label: "The name of the scrim (max 30 characters)", maxLength: 30 },
      });

    case "set_mentions":
      return buildModal({
        customId: scrimsId("modal", "field", key, scrimId),
        title: "Required mentions",
        text: { label: "How many mentions are required? (0 - 10)", maxLength: 2 },
      });

    case "set_slots":
      return buildModal({
        customId: scrimsId("modal", "field", key, scrimId),
        title: "Total slots",
        text: { label: "How many slots does the scrim have? (1 - 30)", maxLength: 2 },
      });

    case "set_start_from":
      return buildModal({
        customId: scrimsId("modal", "field", key, scrimId),
        title: "Slotlist start",
        text: { label: "Which slot number does the slotlist start at?", maxLength: 3 },
      });

    case "set_lines":
      return buildModal({
        customId: scrimsId("modal", "field", key, scrimId),
        title: "Required lines",
        text: { label: "How many lines must a registration have? (0 - 100)", maxLength: 3 },
      });

    case "set_open_time":
      return buildModal({
        customId: scrimsId("modal", "field", key, scrimId),
        title: "Open time",
        text: { label: "When should registration open? (IST)", maxLength: 64 },
      });

    case "set_emojis":
      return buildModal({
        customId: scrimsId("modal", "field", key, scrimId),
        title: "Reactions",
        text: { label: "Two emojis, separated by a comma", maxLength: 16 },
      });

    default:
      return null;
  }
}

/**
 * Flips a boolean field.
 *
 * The "apply to all scrims" question comes **before** the write here.
 * The source asked it after the panel had already re-rendered, so the
 * moderator saw the new value and then had to confirm a change to every
 * other scrim.
 */
async function toggleField(
  interaction: ButtonInteraction,
  scrim: ScrimRecord,
  column: string,
  applyToAll: boolean,
): Promise<void> {
  const current = Boolean(
    (scrim as unknown as Record<string, unknown>)[column],
  );

  const next = !current;

  let all = false;

  if (applyToAll) {
    await interaction.deferUpdate().catch(() => undefined);

    const total = await repo.countScrims(scrim.guildId);

    if (total > 1) {
      all = await prompt(
        interaction,
        "Do you want to apply this change to all scrims in this server?",
        { timeoutMs: 60_000, ephemeral: true },
      );
    }
  }

  const patch = { [column]: next } as Parameters<typeof repo.updateScrim>[1];

  if (all) {
    await service.applyToAllScrims(scrim.guildId, patch);
  } else {
    await repo.updateScrim(scrim.id, patch);
  }

  const fresh = await repo.getScrim(scrim.id);

  if (!fresh) {
    await fail(interaction, "This scrim no longer exists.");

    return;
  }

  const position = await scrimPosition(fresh);
  const panel = buildEditorPanel(fresh, position, true);

  if (all) {
    await refresh(interaction, panel);

    return;
  }

  await updatePanel(interaction, panel);
}

/** The editor's navigation buttons. */
async function handleEditorNav(
  interaction: ButtonInteraction,
  parts: readonly string[],
): Promise<void> {
  const [direction, scrimId] = parts;

  if (!direction || !scrimId) {
    await fail(interaction, "That button is no longer active.");

    return;
  }

  const scrim = await repo.getScrim(scrimId);

  if (!scrim) {
    await fail(interaction, "This scrim no longer exists.");

    return;
  }

  const all = await repo.listScrims(scrim.guildId);

  if (all.length < 2) {
    await fail(interaction, "This server has only one scrim.");

    return;
  }

  if (direction === "skip") {
    // The source's "Skip to" button only deferred and did nothing. This
    // one asks which scrim to jump to and goes there.
    await interaction.showModal(
      buildModal({
        customId: scrimsId("modal", "skip_to", scrim.id),
        title: "Skip to a scrim",
        text: {
          label: `Which scrim? (1 - ${all.length})`,
          placeholder: "1",
          maxLength: 3,
        },
      }),
    );

    return;
  }

  const index = all.findIndex((entry) => entry.id === scrim.id);
  const nextIndex =
    direction === "next"
      ? (index + 1) % all.length
      : (index - 1 + all.length) % all.length;

  const target = all[nextIndex];

  if (!target) {
    await fail(interaction, "That scrim no longer exists.");

    return;
  }

  const position = await scrimPosition(target);

  await updatePanel(interaction, buildEditorPanel(target, position, true));
}

/* ------------------------------------------------------------------ *
 * The scrim panel
 * ------------------------------------------------------------------ */

/** The scrim panel's buttons. */
async function handleManagerButton(
  interaction: ButtonInteraction,
  parts: readonly string[],
): Promise<void> {
  const [scrimId, action] = parts;

  if (!scrimId) {
    await fail(interaction, "That button is no longer active.");

    return;
  }

  const scrim = await repo.getScrim(scrimId);

  if (!scrim) {
    await fail(interaction, "This scrim no longer exists.");

    return;
  }

  switch (action) {
    case "toggle": {
      if (scrim.status === "open") {
        await closeRegistrationFlow(interaction, scrim);
      } else {
        await openRegistrationFlow(interaction, scrim);
      }

      return;
    }

    case "enabled": {
      await repo.updateScrim(scrim.id, { enabled: !scrim.enabled });

      const fresh = await repo.getScrim(scrim.id);

      if (!fresh) return;

      await updatePanel(interaction, buildScrimPanel(fresh));

      return;
    }

    case "delete": {
      await interaction.deferUpdate().catch(() => undefined);

      const confirmed = await prompt(
        interaction,
        `\`${scrim.name}\` will be permanently deleted. This cannot be undone.`,
        { timeoutMs: 60_000, ephemeral: true },
      );

      if (!confirmed) {
        const fresh = await repo.getScrim(scrim.id);

        if (fresh) await refresh(interaction, buildScrimPanel(fresh));

        return;
      }

      await repo.deleteScrim(scrim.id);

      const guildId = interaction.guildId;

      if (!guildId) return;

      const scrims = await repo.listScrims(guildId);
      await refresh(
        interaction,
        buildListPanel(scrims, await canCreateScrim(guildId)),
      );

      return;
    }

    case "match_time": {
      await collectMatchTimes(interaction, scrim);

      return;
    }

    default: {
      await updatePanel(interaction, buildScrimPanel(scrim));

      return;
    }
  }
}

/**
 * The match-time editor.
 *
 * This is the **one** flow that keeps a message collector (D17): the
 * user types several `#channel time` lines in one message, and there is
 * no way to express that in a modal. The collector is scoped to the
 * invoking author and the channel, and it times out.
 */
async function collectMatchTimes(
  interaction: ButtonInteraction,
  scrim: { id: string; guildId: string },
): Promise<void> {
  await interaction.deferUpdate().catch(() => undefined);

  const channel = interaction.channel;

  if (!channel || !("awaitMessages" in channel)) {
    await fail(interaction, "This flow needs a text channel.");

    return;
  }

  await interaction.followUp({
    content: [
      "Enter the time of the matches in this format:",
      "`#registration_channel match_time`",
      "",
      "Separate several match times with a new line.",
      "The slot manager locks the scrim at the given time.",
    ].join("\n"),
    flags: MessageFlags.Ephemeral,
  });

  let collected: Awaited<ReturnType<typeof channel.awaitMessages>>;

  try {
    collected = await channel.awaitMessages({
      max: 1,
      time: 300_000,
      filter: (message) =>
        message.author.id === interaction.user.id &&
        message.author.id !== interaction.client.user.id,
    });
  } catch {
    await interaction.followUp({
      content: "⏳ Timed out. The match times were not changed.",
      flags: MessageFlags.Ephemeral,
    });

    return;
  }

  const message = collected.first();

  if (!message) return;

  const lines = message.content
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  const guild = interaction.guild;

  if (!guild) return;

  let applied = 0;

  for (const line of lines) {
    const match = /^<#(\d+)>[\s:]+(.+)$/.exec(line);

    if (!match) continue;

    const channelId = match[1];
    const timeText = match[2];

    if (!channelId || !timeText) continue;

    const target = guild.channels.cache.get(channelId);

    if (!target || target.type !== ChannelType.GuildText) continue;

    const parsed = parseNaturalTime(timeText, { now: new Date() });

    if (!parsed) continue;

    const targetScrim = await repo.getScrimByRegistrationChannel(channelId);

    if (!targetScrim) continue;

    await repo.updateScrim(targetScrim.id, { matchTime: parsed });
    await service.armMatchTimer(targetScrim, new Date());
    applied += 1;
  }

  await interaction.followUp({
    content: `✅ Set the match time for ${applied} scrim(s).`,
    flags: MessageFlags.Ephemeral,
  });

  const fresh = await repo.getScrim(scrim.id);

  if (fresh) await refresh(interaction, buildScrimPanel(fresh));
}

/* ------------------------------------------------------------------ *
 * Bans
 * ------------------------------------------------------------------ */

/** The ban panel's buttons. */
async function handleBanButton(
  interaction: ButtonInteraction,
  parts: readonly string[],
): Promise<void> {
  const [scrimId, action] = parts;

  if (!scrimId) {
    await fail(interaction, "That button is no longer active.");

    return;
  }

  const scrim = await repo.getScrim(scrimId);

  if (!scrim) {
    await fail(interaction, "This scrim no longer exists.");

    return;
  }

  if (action === "ban") {
    await interaction.showModal(
      buildModal({
        customId: scrimsId("modal", "ban", scrim.id),
        title: "Ban users",
        texts: [
          {
            id: "users",
            label: "Who do you want to ban? (mention them)",
            placeholder: "@user @other",
            maxLength: 1000,
          },
          {
            id: "duration",
            label: "Ban duration (optional)",
            placeholder: "7 days, 24h, Friday at 6pm",
            maxLength: 64,
          },
          {
            id: "reason",
            label: "Reason (optional)",
            placeholder: "Why are they banned?",
            maxLength: 200,
          },
        ],
      }),
    );

    return;
  }

  if (action === "unban") {
    const bans = await repo.listBans(scrim.id);

    if (bans.length === 0) {
      await fail(interaction, "No banned user found.");

      return;
    }

    const chosen = await awaitSelect(
      interaction,
      bans.slice(0, 25).map((ban) => ({
        label: `<@${ban.userId}>`.slice(0, 100),
        value: ban.userId,
        description: ban.expires
          ? `Until ${ban.expires.toISOString().slice(0, 16).replace("T", " ")}`
          : "Never expires",
      })),
      {
        maxValues: Math.min(bans.length, 25),
        placeholder: "Select the users to unban",
        question: "Select the users to unban.",
        ephemeral: true,
      },
    );

    if (chosen.length === 0) return;

    const guild = interaction.guild;

    for (const userId of chosen) {
      await service.unbanUser(scrim.id, userId);

      if (guild) {
        const ban = bans.find((entry) => entry.userId === userId);

        await writeBanLog(guild, {
          action: "unbanned",
          userId,
          scrimName: scrim.name,
          reason: ban?.reason ?? null,
          expires: ban?.expires ?? null,
          moderatorId: interaction.user.id,
        });
      }
    }

    const bans2 = await repo.listBans(scrim.id);
    await refresh(interaction, buildBanPanel(scrim, bans2));

    return;
  }

  if (action === "unban_all") {
    await interaction.deferUpdate().catch(() => undefined);

    const confirmed = await prompt(
      interaction,
      "Every banned user will be unbanned from this scrim.",
      { timeoutMs: 60_000, ephemeral: true },
    );

    if (!confirmed) {
      const bans = await repo.listBans(scrim.id);
      await refresh(interaction, buildBanPanel(scrim, bans));

      return;
    }

    const bans = await repo.listBans(scrim.id);
    const guild = interaction.guild;

    for (const ban of bans) {
      await service.unbanUser(scrim.id, ban.userId);

      if (guild) {
        await writeBanLog(guild, {
          action: "unbanned",
          userId: ban.userId,
          scrimName: scrim.name,
          reason: ban.reason,
          expires: ban.expires,
          moderatorId: interaction.user.id,
        });
      }
    }

    await refresh(interaction, buildBanPanel(scrim, []));

    return;
  }

  const bans = await repo.listBans(scrim.id);
  await updatePanel(interaction, buildBanPanel(scrim, bans));
}

/* ------------------------------------------------------------------ *
 * Reserved slots
 * ------------------------------------------------------------------ */

/** The reserved-slots panel's buttons. */
async function handleReserveButton(
  interaction: ButtonInteraction,
  parts: readonly string[],
): Promise<void> {
  const [scrimId, action] = parts;

  if (!scrimId) {
    await fail(interaction, "That button is no longer active.");

    return;
  }

  const scrim = await repo.getScrim(scrimId);

  if (!scrim) {
    await fail(interaction, "This scrim no longer exists.");

    return;
  }

  if (action === "new") {
    await interaction.showModal(
      buildModal({
        customId: scrimsId("modal", "reserve", scrim.id),
        title: "Reserve a slot",
        texts: [
          {
            id: "num",
            label: `Slot number (${scrim.startFrom} - ${scrim.startFrom + scrim.totalSlots - 1})`,
            maxLength: 3,
          },
          {
            id: "team_name",
            label: "Team name",
            maxLength: 25,
          },
          {
            id: "owner",
            label: "Team owner (optional)",
            placeholder: "@owner",
            maxLength: 64,
          },
          {
            id: "expires",
            label: "Expires (optional)",
            placeholder: "7 days, 24h, Friday at 6pm",
            maxLength: 64,
          },
        ],
      }),
    );

    return;
  }

  if (action === "remove") {
    const reserved = await repo.listReservedSlots(scrim.id);

    if (reserved.length === 0) {
      await fail(interaction, "No reserved slot found.");

      return;
    }

    const chosen = await awaitSelect(
      interaction,
      reserved.slice(0, 25).map((slot) => ({
        label: `Slot ${slot.num}`.slice(0, 100),
        value: slot.id,
        description: (slot.teamName ?? "Reserved").slice(0, 100),
      })),
      {
        maxValues: Math.min(reserved.length, 25),
        placeholder: "Select the reservations to remove",
        question: "Select the reservations to remove.",
        ephemeral: true,
      },
    );

    if (chosen.length === 0) return;

    for (const reservationId of chosen) {
      await service.removeReservation(scrim.id, reservationId);
    }

    const fresh = await repo.listReservedSlots(scrim.id);
    await refresh(interaction, buildReservePanel(scrim, fresh));

    return;
  }

  const reserved = await repo.listReservedSlots(scrim.id);
  await updatePanel(interaction, buildReservePanel(scrim, reserved));
}

/* ------------------------------------------------------------------ *
 * Autoclean
 * ------------------------------------------------------------------ */

/** The autoclean panel's buttons. */
async function handleAutocleanButton(
  interaction: ButtonInteraction,
  parts: readonly string[],
): Promise<void> {
  const [scrimId, action] = parts;

  if (!scrimId) {
    await fail(interaction, "That button is no longer active.");

    return;
  }

  const scrim = await repo.getScrim(scrimId);

  if (!scrim) {
    await fail(interaction, "This scrim no longer exists.");

    return;
  }

  if (action === "channel" || action === "role") {
    const kind = action === "channel" ? "channel" : "role";
    const next = scrim.autoclean.includes(kind)
      ? scrim.autoclean.filter((entry) => entry !== kind)
      : [...scrim.autoclean, kind];

    await repo.updateScrim(scrim.id, { autoclean: next });

    const fresh = await repo.getScrim(scrim.id);

    if (!fresh) return;

    await updatePanel(interaction, buildAutocleanPanel(fresh));

    return;
  }

  if (action === "time") {
    await interaction.showModal(
      buildModal({
        customId: scrimsId("modal", "autoclean_time", scrim.id),
        title: "Autoclean time",
        text: { label: "When should the autoclean run? (IST)", maxLength: 64 },
      }),
    );

    return;
  }

  await updatePanel(interaction, buildAutocleanPanel(scrim));
}

/* ------------------------------------------------------------------ *
 * The design
 * ------------------------------------------------------------------ */

/** The design panel's buttons. */
async function handleDesignButton(
  interaction: ButtonInteraction,
  parts: readonly string[],
): Promise<void> {
  const [scrimId, action] = parts;

  if (!scrimId) {
    await fail(interaction, "That button is no longer active.");

    return;
  }

  const scrim = await repo.getScrim(scrimId);

  if (!scrim) {
    await fail(interaction, "This scrim no longer exists.");

    return;
  }

  if (action === "open" || action === "close" || action === "slotlist") {
    await interaction.showModal(
      buildModal({
        customId: scrimsId("modal", "design", action, scrim.id),
        title:
          action === "open"
            ? "Open message"
            : action === "close"
              ? "Close message"
              : "Slotlist design",
        texts: [
          {
            id: "title",
            label: "Title (leave empty for the default)",
            maxLength: 256,
          },
          {
            id: "description",
            label: "Description (leave empty for the default)",
            maxLength: 4000,
          },
          {
            id: "footer",
            label: "Footer (leave empty for the default)",
            maxLength: 256,
          },
        ],
      }),
    );

    return;
  }

  if (action === "autoslotlist") {
    // The column was honoured when the scrim closed but nothing set it,
    // so the switch was unreachable. It lives in the design panel
    // because that is where the close-time behaviour is decided.
    await repo.updateScrim(scrim.id, { autoslotlist: !scrim.autoslotlist });

    const fresh = await repo.getScrim(scrim.id);

    if (!fresh) {
      await fail(interaction, "This scrim no longer exists.");

      return;
    }

    await updatePanel(interaction, buildDesignPanel(fresh));

    return;
  }

  await updatePanel(interaction, buildDesignPanel(scrim));
}

/* ------------------------------------------------------------------ *
 * The slotlist
 * ------------------------------------------------------------------ */

/** The slotlist panel's buttons. */
async function handleSlotlistButton(
  interaction: ButtonInteraction,
  parts: readonly string[],
): Promise<void> {
  const [scrimId, action] = parts;

  if (!scrimId) {
    await fail(interaction, "That button is no longer active.");

    return;
  }

  const scrim = await repo.getScrim(scrimId);

  if (!scrim) {
    await fail(interaction, "This scrim no longer exists.");

    return;
  }

  if (action === "edit") {
    await updatePanel(interaction, buildSlotlistEditorPanel(scrim));

    return;
  }

  if (action === "add_team") {
    await addTeam(interaction, scrim);

    return;
  }

  if (action === "remove_team") {
    await removeTeam(interaction, scrim);

    return;
  }

  if (action === "change_team") {
    await changeTeam(interaction, scrim);

    return;
  }

  if (action === "repost") {
    await repostSlotlist(interaction, scrim);

    return;
  }

  if (action === "punish") {
    await punishSlot(interaction, scrim);

    return;
  }

  if (action === "info") {
    await showSlotInfo(interaction, scrim);

    return;
  }

  const slots = await repo.listSlots(scrim.id);
  await updatePanel(interaction, buildSlotlistPanel(scrim, slots));
}

/**
 * The slotlist editor's "Add Team".
 *
 * The slots on offer are the scrim's **own** free slot numbers. The
 * source offered `range(start_from, 30)`, so twenty numbers that did
 * not exist were on offer (B4).
 */
async function addTeam(
  interaction: ButtonInteraction,
  scrim: ScrimRecord,
): Promise<void> {
  const slots = await repo.listSlots(scrim.id);
  const free = slots.filter((slot) => slot.state === "free");

  if (free.length === 0) {
    await fail(interaction, "No slots available to add this time.");

    return;
  }

  const chosen = await awaitSelect(
    interaction,
    free.slice(0, 25).map((slot) => ({
      label: `Slot ${slot.num}`.slice(0, 100),
      value: slot.id,
      description: `Slot ${slot.num}`.slice(0, 100),
    })),
    {
      maxValues: 1,
      placeholder: "Select the slot to add a team to",
      question: "Select the slot to add a team to.",
      ephemeral: true,
    },
  );

  const slotId = chosen[0];

  if (!slotId) return;

  const token = randomId();
  slotSelection.set(token, { scrimId: scrim.id, slotId });

  await interaction.showModal(
    buildModal({
      customId: scrimsId("modal", "slot_team", token),
      title: "Add a team",
      texts: [
        {
          id: "team_name",
          label: "The team name",
          maxLength: 25,
        },
        {
          id: "leader",
          label: "The team leader (optional)",
          placeholder: "@leader",
          maxLength: 64,
        },
      ],
    }),
  );
}

/** The slotlist editor's "Remove Team". */
async function removeTeam(
  interaction: ButtonInteraction,
  scrim: ScrimRecord,
): Promise<void> {
  const slots = await repo.listSlots(scrim.id);
  const claimed = slots.filter((slot) => slot.state === "claimed");

  if (claimed.length === 0) {
    await fail(interaction, "No slot available to remove.");

    return;
  }

  const chosen = await awaitSelect(
    interaction,
    claimed.slice(0, 25).map((slot) => ({
      label: `Slot ${slot.num}`.slice(0, 100),
      value: slot.id,
      description: (slot.teamName ?? "—").slice(0, 100),
    })),
    {
      maxValues: 1,
      placeholder: "Select the slot to remove",
      question: "Select the slot to remove.",
      ephemeral: true,
    },
  );

  const slotId = chosen[0];

  if (!slotId) return;

  const slot = await repo.getSlot(slotId);

  if (!slot) {
    await fail(interaction, "That slot no longer exists.");

    return;
  }

  // The slot goes back to being free. The source appended the number to
  // `available_slots` and then deleted the row — two writes that could
  // disagree. Here it is one state change.
  await repo.setSlotState(slot.id, "free", {
    teamName: null,
    ownerUserId: null,
    members: [],
  });

  await refresh(interaction, buildSlotlistEditorPanel(scrim));
}

/** The slotlist editor's "Change Team". */
async function changeTeam(
  interaction: ButtonInteraction,
  scrim: ScrimRecord,
): Promise<void> {
  const slots = await repo.listSlots(scrim.id);
  const claimed = slots.filter((slot) => slot.state === "claimed");

  if (claimed.length === 0) {
    await fail(interaction, "No slot available to replace.");

    return;
  }

  const chosen = await awaitSelect(
    interaction,
    claimed.slice(0, 25).map((slot) => ({
      label: `Slot ${slot.num}`.slice(0, 100),
      value: slot.id,
      description: (slot.teamName ?? "—").slice(0, 100),
    })),
    {
      maxValues: 1,
      placeholder: "Select the slot to change",
      question: "Select the slot to change.",
      ephemeral: true,
    },
  );

  const slotId = chosen[0];

  if (!slotId) return;

  const token = randomId();
  slotSelection.set(token, { scrimId: scrim.id, slotId });

  await interaction.showModal(
    buildModal({
      customId: scrimsId("modal", "slot_team", token),
      title: "Change the team",
      texts: [
        {
          id: "team_name",
          label: "The team name",
          maxLength: 25,
        },
        {
          id: "leader",
          label: "The team leader (optional)",
          placeholder: "@leader",
          maxLength: 64,
        },
      ],
    }),
  );
}

/** Reposts the slotlist into the slotlist channel. */
async function repostSlotlist(
  interaction: ButtonInteraction,
  scrim: Awaited<ReturnType<typeof repo.getScrim>> & object,
): Promise<void> {
  const slots = await repo.listSlots(scrim.id);
  const claimed = slots.filter((slot) => slot.state === "claimed");

  if (claimed.length === 0) {
    await fail(interaction, "No registrations found in this scrim.");

    return;
  }

  const channel = interaction.guild?.channels.cache.get(scrim.slotlistChannelId);

  if (!channel || !("send" in channel)) {
    await fail(interaction, "I could not find the slotlist channel.");

    return;
  }

  const message = await publishSlotlist(channel as never, scrim, claimed);

  await repo.updateScrim(scrim.id, { slotlistMessageId: message.id });

  await interaction.followUp({
    content: `Slotlist sent: ${message.url}`,
    flags: MessageFlags.Ephemeral,
  });
}

/** The slotlist's "Punish" button: ban the teams of the chosen slots. */
async function punishSlot(
  interaction: ButtonInteraction,
  scrim: Awaited<ReturnType<typeof repo.getScrim>> & object,
): Promise<void> {
  const slots = await repo.listSlots(scrim.id);
  const claimed = slots.filter((slot) => slot.state === "claimed");

  if (claimed.length === 0) {
    await fail(interaction, "No slot in the scrim to punish.");

    return;
  }

  const chosen = await awaitSelect(
    interaction,
    claimed.slice(0, 25).map((slot) => ({
      label: `Slot ${slot.num}`.slice(0, 100),
      value: slot.id,
      description: (slot.teamName ?? "—").slice(0, 100),
    })),
    {
      maxValues: Math.min(claimed.length, 25),
      placeholder: "Select the slots to ban",
      question: "Select the slots to ban.",
      ephemeral: true,
    },
  );

  if (chosen.length === 0) return;

  punishSelection.set(scrim.id, chosen);

  await interaction.showModal(
    buildModal({
      customId: scrimsId("modal", "punish", scrim.id),
      title: "Ban time and reason",
      texts: [
        {
          id: "duration",
          label: "Ban duration (optional)",
          placeholder: "7 days, 24h, Friday at 6pm",
          maxLength: 64,
        },
        {
          id: "reason",
          label: "Reason (optional)",
          placeholder: "Why are they banned?",
          maxLength: 200,
        },
      ],
    }),
  );
}

/** The slotlist's "Info" button. */
async function showSlotInfo(
  interaction: ButtonInteraction,
  scrim: Awaited<ReturnType<typeof repo.getScrim>> & object,
): Promise<void> {
  const slots = await repo.listSlots(scrim.id);
  const claimed = slots.filter((slot) => slot.state === "claimed");

  if (claimed.length === 0) {
    await fail(interaction, "No slot in the scrim to fetch info about.");

    return;
  }

  const chosen = await awaitSelect(
    interaction,
    claimed.slice(0, 25).map((slot) => ({
      label: `Slot ${slot.num}`.slice(0, 100),
      value: slot.id,
      description: (slot.teamName ?? "—").slice(0, 100),
    })),
    {
      maxValues: 1,
      placeholder: "Select the slot to get info about",
      question: "Select the slot to get info about.",
      ephemeral: true,
    },
  );

  const slotId = chosen[0];

  if (!slotId) return;

  const slot = await repo.getSlot(slotId);

  if (!slot) {
    await fail(interaction, "That slot no longer exists.");

    return;
  }

  const lines = [
    `**Slot No:** \`${slot.num}\``,
    `**Name:** \`${slot.teamName ?? "—"}\``,
    `**Captain:** ${slot.ownerUserId ? `<@${slot.ownerUserId}>` : "`None`"}`,
    `**Team:** ${slot.members.map((id) => `<@${id}>`).join(", ") || "`None`"}`,
  ];

  if (slot.jumpUrl) {
    lines.push(`**Registration message:** [Click me to jump](${slot.jumpUrl})`);
  }

  await interaction.followUp({
    content: lines.join("\n"),
    flags: MessageFlags.Ephemeral,
  });
}

/** A short team name, for the reserved-slot form. */
export function shortTeamName(value: string): string {
  return truncate(value, 25);
}

/** The slot numbers a scrim has. */
export function scrimSlotNumbers(
  scrim: { startFrom: number; totalSlots: number },
): number[] {
  return slotNumbers(scrim.startFrom, scrim.totalSlots);
}
