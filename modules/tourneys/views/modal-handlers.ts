/**
 * The modal handlers of the tournaments area.
 *
 * A modal submit is the answer to a button that asked for a value. The
 * custom id carries the record and the field, so the handler never has
 * to guess what it is for.
 *
 * Every handler writes **one** thing.
 */

import { AttachmentBuilder } from "discord.js";
import type { ModalSubmitInteraction } from "discord.js";
import { truncate } from "../../../core/text.js";
import { TEAM_NAME_MAX_LENGTH } from "../../../core/team-name.js";
import { PremiumFeature } from "../../../core/constants.js";
import { assertEntitled } from "../../premium/entitlements.js";
import * as repo from "../repo.js";
import * as service from "../service.js";
import { groupSlots } from "../groups.js";
import { parseWallClock } from "../schedule.js";
import { buildEditorPanel } from "./editor.js";
import { acknowledgeAndRender, fail } from "./handlers.js";
import { removeSuccessRole, strikeConfirmMessage } from "./lifecycle.js";
import { modalText } from "./components.js";
import { parseOpenDays, wizardStore } from "./wizard.js";
import { createGroupChannels } from "./group-channels.js";

/**
 * Handles one modal submit.
 *
 * @param kind  the modal's kind, from the custom id;
 * @param parts the parts after the kind.
 */
export async function handleTourneysModal(
  interaction: ModalSubmitInteraction,
  kind: string,
  parts: readonly string[],
): Promise<void> {
  switch (kind) {
    case "wizard_field":
      await onWizardField(interaction, parts);
      return;
    case "editor_field":
      await onEditorField(interaction, parts);
      return;
    case "ban":
      await onBan(interaction, parts);
      return;
    case "rename":
      await onRename(interaction, parts);
      return;
    case "add_slot":
      await onAddSlot(interaction, parts);
      return;
    case "remove_slot":
      await onRemoveSlot(interaction, parts);
      return;
    case "swap":
      await onSwap(interaction, parts);
      return;
    case "export":
      await onExport(interaction, parts);
      return;
    case "group_format":
      await onGroupFormat(interaction, parts);
      return;
    case "set_start_from":
      await onSetStartFrom(interaction, parts);
      return;
    case "partner_add":
      await onPartnerAdd(interaction, parts);
      return;
    default:
      await fail(interaction, "That form is no longer active.");
  }
}

/* ------------------------------------------------------------------ *
 * The wizard
 * ------------------------------------------------------------------ */

async function onWizardField(
  interaction: ModalSubmitInteraction,
  parts: readonly string[],
): Promise<void> {
  const token = parts[0];
  const key = parts[1];

  if (!token || !key) {
    await fail(interaction, "That form is no longer active.");

    return;
  }

  const draft = wizardStore.get(token);

  if (!draft) {
    await fail(
      interaction,
      "This setup wizard has expired. Run the command again to start a new one.",
    );

    return;
  }

  const raw = modalText(interaction);

  const updated = { ...draft };

  switch (key) {
    case "set_mentions": {
      const value = Number(raw);

      if (!Number.isInteger(value) || value < 0 || value > 10) {
        await fail(interaction, "The number of mentions must be between 0 and 10.");

        return;
      }

      updated.requiredMentions = value;
      break;
    }

    case "set_slots": {
      const value = Number(raw);

      if (!Number.isInteger(value) || value < 1 || value > 15000) {
        await fail(interaction, "The number of slots must be between 1 and 15000.");

        return;
      }

      updated.totalSlots = value;
      break;
    }

    case "set_group_size": {
      const value = Number(raw);

      if (!Number.isInteger(value) || value < 2 || value > 25) {
        await fail(
          interaction,
          "The number of teams per group must be between 2 and 25.",
        );

        return;
      }

      updated.groupSize = value;
      break;
    }

    case "set_emojis": {
      const [tick, cross] = raw.split(",").map((emoji) => emoji.trim());

      if (!tick || !cross) {
        await fail(
          interaction,
          "Please enter two emojis, separated by a comma. The first one is the tick.",
        );

        return;
      }

      updated.emojis = { tick, cross };
      break;
    }

    case "set_open_days": {
      updated.openDays = parseOpenDays(raw);
      break;
    }

    case "set_open_time": {
      if (!parseWallClock(raw)) {
        await fail(interaction, "Please enter the time as `HH:MM`, for example `18:00`.");

        return;
      }

      updated.openTime = raw;
      break;
    }

    default:
      await fail(interaction, "That form is no longer active.");

      return;
  }

  wizardStore.set(token, updated);

  const { buildWizardPanel } = await import("./wizard.js");

  await acknowledgeAndRender(interaction, buildWizardPanel(updated, token));
}

/* ------------------------------------------------------------------ *
 * The editor
 * ------------------------------------------------------------------ */

async function onEditorField(
  interaction: ModalSubmitInteraction,
  parts: readonly string[],
): Promise<void> {
  const tourneyId = parts[0];
  const key = parts[1];

  if (!tourneyId || !key) {
    await fail(interaction, "That form is no longer active.");

    return;
  }

  const tourney = await repo.getTourney(tourneyId);

  if (!tourney) {
    await fail(interaction, "This tournament no longer exists.");

    return;
  }

  const field = (await import("./components.js")).EDITOR_FIELDS.find(
    (entry) => entry.key === key,
  );

  if (!field) {
    await fail(interaction, "That form is no longer active.");

    return;
  }

  if (field.premium) {
    try {
      await assertEntitled(tourney.guildId, PremiumFeature.tourneyFeatures);
    } catch (error) {
      await fail(
        interaction,
        error instanceof Error
          ? error.message
          : "This feature needs a premium entitlement.",
      );

      return;
    }
  }

  const raw = modalText(interaction);

  switch (key) {
    case "set_name": {
      if (!raw) {
        await fail(interaction, "The name cannot be empty.");

        return;
      }

      await repo.updateTourney(tourney.id, { name: truncate(raw, 30) });
      break;
    }

    case "set_mentions": {
      const value = Number(raw);

      if (!Number.isInteger(value) || value < 0 || value > 10) {
        await fail(interaction, "The number of mentions must be between 0 and 10.");

        return;
      }

      await repo.updateTourney(tourney.id, { requiredMentions: value });
      break;
    }

    case "set_slots": {
      const value = Number(raw);

      if (!Number.isInteger(value) || value < 1 || value > 15000) {
        await fail(interaction, "The number of slots must be between 1 and 15000.");

        return;
      }

      await repo.updateTourney(tourney.id, { totalSlots: value });
      break;
    }

    case "set_group_size": {
      const value = Number(raw);

      if (!Number.isInteger(value) || value < 2 || value > 25) {
        await fail(
          interaction,
          "The number of teams per group must be between 2 and 25.",
        );

        return;
      }

      await repo.updateTourney(tourney.id, { groupSize: value });
      break;
    }

    case "set_emojis": {
      const [tick, cross] = raw.split(",").map((emoji) => emoji.trim());

      if (!tick || !cross) {
        await fail(
          interaction,
          "Please enter two emojis, separated by a comma. The first one is the tick.",
        );

        return;
      }

      await repo.updateTourney(tourney.id, { emojis: { tick, cross } });
      break;
    }

    case "set_lines": {
      const value = Number(raw);

      if (!Number.isInteger(value) || value < 0 || value > 100) {
        await fail(interaction, "The number of lines must be between 0 and 100.");

        return;
      }

      await repo.updateTourney(tourney.id, { requiredLines: value });
      break;
    }

    case "set_start_from": {
      const value = Number(raw);

      if (!Number.isInteger(value) || value < 1 || value > 20) {
        await fail(
          interaction,
          "The slotlist has to start from a slot between 1 and 20.",
        );

        return;
      }

      await repo.updateTourney(tourney.id, { startFrom: value });
      break;
    }

    case "set_open_days": {
      const days = parseOpenDays(raw);
      const schedule = await service.getSchedule(tourney.id);

      await service.armOpenJob(tourney.id, {
        openDays: days,
        openTime: schedule?.openTime ?? "18:00",
      });
      break;
    }

    case "set_open_time": {
      if (!parseWallClock(raw)) {
        await fail(
          interaction,
          "Please enter the time as `HH:MM`, for example `18:00`.",
        );

        return;
      }

      const schedule = await service.getSchedule(tourney.id);

      await service.armOpenJob(tourney.id, {
        openDays: schedule?.openDays ?? [],
        openTime: raw,
      });
      break;
    }

    case "set_success_message": {
      const value = raw.toLowerCase() === "none" ? null : truncate(raw, 500);

      await repo.updateTourney(tourney.id, { successMessage: value });
      break;
    }

    default:
      await fail(interaction, "That form is no longer active.");

      return;
  }

  const fresh = await repo.getTourney(tourney.id);

  if (!fresh) {
    await fail(interaction, "This tournament no longer exists.");

    return;
  }

  const schedule = await service.getSchedule(fresh.id);

  await acknowledgeAndRender(interaction, buildEditorPanel(fresh, schedule));
}

/* ------------------------------------------------------------------ *
 * Bans
 * ------------------------------------------------------------------ */

async function onBan(
  interaction: ModalSubmitInteraction,
  parts: readonly string[],
): Promise<void> {
  const tourneyId = parts[0];

  if (!tourneyId) {
    await fail(interaction, "That form is no longer active.");

    return;
  }

  const tourney = await repo.getTourney(tourneyId);

  if (!tourney) {
    await fail(interaction, "This tournament no longer exists.");

    return;
  }

  const raw = modalText(interaction);
  const ids = [...raw.matchAll(/<@!?(\d+)>/g)].map((match) => match[1]);

  if (ids.length === 0) {
    await fail(interaction, "You need to mention at least one user.");

    return;
  }

  const banned: string[] = [];
  const unbanned: string[] = [];

  for (const userId of ids) {
    if (!userId) continue;

    if (await repo.isBanned(tourney.id, userId)) {
      await repo.unbanUser(tourney.id, userId);
      unbanned.push(`<@${userId}>`);
    } else {
      await repo.banUser(tourney.id, userId);
      banned.push(`<@${userId}>`);
    }
  }

  await fail(
    interaction,
    [
      `✅ | Banned: ${banned.length > 0 ? banned.join(", ") : "None"}`,
      `✅ | Unbanned: ${unbanned.length > 0 ? unbanned.join(", ") : "None"}`,
    ].join("\n"),
  );
}

/* ------------------------------------------------------------------ *
 * The slot manager
 * ------------------------------------------------------------------ */

async function onRename(
  interaction: ModalSubmitInteraction,
  parts: readonly string[],
): Promise<void> {
  const tourneyId = parts[0];
  const slotId = parts[1];

  if (!tourneyId || !slotId) {
    await fail(interaction, "That form is no longer active.");

    return;
  }

  const tourney = await repo.getTourney(tourneyId);

  if (!tourney) {
    await fail(interaction, "This tournament no longer exists.");

    return;
  }

  const slot = await repo.getSlot(slotId);

  if (!slot || slot.tourneyId !== tourney.id) {
    await fail(interaction, "That slot no longer exists.");

    return;
  }

  const raw = modalText(interaction);

  if (!raw) {
    await fail(interaction, "The team name cannot be empty.");

    return;
  }

  await repo.updateSlotTeamName(
    slot.id,
    truncate(raw, TEAM_NAME_MAX_LENGTH),
  );

  await fail(interaction, "✅ | Your team name was changed.", { ok: true });
}

/* ------------------------------------------------------------------ *
 * Moderator tools
 * ------------------------------------------------------------------ */

async function onAddSlot(
  interaction: ModalSubmitInteraction,
  parts: readonly string[],
): Promise<void> {
  const tourneyId = parts[0];

  if (!tourneyId) {
    await fail(interaction, "That form is no longer active.");

    return;
  }

  const tourney = await repo.getTourney(tourneyId);

  if (!tourney) {
    await fail(interaction, "This tournament no longer exists.");

    return;
  }

  const raw = modalText(interaction, "leader");
  const name = modalText(interaction, "name");
  const leader = /<@!?(\d+)>/.exec(raw)?.[1];

  if (!leader) {
    await fail(interaction, "You need to mention the team leader.");

    return;
  }

  if (!name) {
    await fail(interaction, "You need to enter a team name.");

    return;
  }

  const slot = await service.registerTeam(tourney, {
    teamName: truncate(name, TEAM_NAME_MAX_LENGTH),
    leaderId: leader,
    members: [leader],
    messageId: null,
    jumpUrl: null,
  });

  if (!slot) {
    await fail(interaction, "This tournament is already full.");

    return;
  }

  await fail(interaction, `The slot was added as **Slot ${slot.num}**.`, { ok: true });
}

async function onRemoveSlot(
  interaction: ModalSubmitInteraction,
  parts: readonly string[],
): Promise<void> {
  const tourneyId = parts[0];

  if (!tourneyId) {
    await fail(interaction, "That form is no longer active.");

    return;
  }

  const tourney = await repo.getTourney(tourneyId);

  if (!tourney) {
    await fail(interaction, "This tournament no longer exists.");

    return;
  }

  const userId = /<@!?(\d+)>/.exec(modalText(interaction, "member"))?.[1];

  if (!userId) {
    await fail(interaction, "You need to mention a user.");

    return;
  }

  const num = Number(modalText(interaction, "num"));

  if (!Number.isInteger(num) || num < 1) {
    await fail(interaction, "You need to enter the slot number.");

    return;
  }

  const slots = await repo.listSlotsOfUser(tourney.id, userId);

  const slot = slots.find((entry) => entry.num === num);

  if (!slot) {
    await fail(
      interaction,
      `<@${userId}> does not have slot ${num} in this tournament.`,
    );

    return;
  }

  await service.removeSlot(tourney.id, slot.id);

  const guild = interaction.guild;

  if (guild) {
    await strikeConfirmMessage(guild, slot.confirmJumpUrl);

    if (!(await service.hasOtherSlot(tourney.id, slot.leaderId, slot.id))) {
      await removeSuccessRole(guild, tourney, slot.leaderId);
    }
  }

  await fail(
    interaction,
    `Done! The slot of <@${userId}> was removed.`,
    { ok: true },
  );
}

/**
 * Swaps the slots of two teams.
 *
 * **One transaction** (D25) — see {@link repo.swapSlotNumbers}. The
 * source did two independent `UPDATE`s, which meant the intermediate
 * state had both rows on the same number.
 */
async function onSwap(
  interaction: ModalSubmitInteraction,
  parts: readonly string[],
): Promise<void> {
  const tourneyId = parts[0];

  if (!tourneyId) {
    await fail(interaction, "That form is no longer active.");

    return;
  }

  const tourney = await repo.getTourney(tourneyId);

  if (!tourney) {
    await fail(interaction, "This tournament no longer exists.");

    return;
  }

  const first = /<@!?(\d+)>/.exec(modalText(interaction, "first"))?.[1];
  const second = /<@!?(\d+)>/.exec(modalText(interaction, "second"))?.[1];

  if (!first || !second) {
    await fail(interaction, "You need to mention both team leaders.");

    return;
  }

  if (first === second) {
    await fail(interaction, "You can't mention the same user twice.");

    return;
  }

  const firstSlots = await repo.listSlotsOfUser(tourney.id, first);
  const secondSlots = await repo.listSlotsOfUser(tourney.id, second);

  const firstSlot = firstSlots[0];
  const secondSlot = secondSlots[0];

  if (!firstSlot) {
    await fail(
      interaction,
      `<@${first}> does not have a slot in this tournament.`,
    );

    return;
  }

  if (!secondSlot) {
    await fail(
      interaction,
      `<@${second}> does not have a slot in this tournament.`,
    );

    return;
  }

  const swapped = await service.swapGroups(
    tourney.id,
    firstSlot.id,
    secondSlot.id,
  );

  if (!swapped) {
    await fail(interaction, "Those two slots could not be swapped.");

    return;
  }

  await fail(
    interaction,
    "✅ | The groups were swapped. Press **Refresh** under the group list.",
    { ok: true },
  );
}

async function onExport(
  interaction: ModalSubmitInteraction,
  parts: readonly string[],
): Promise<void> {
  const tourneyId = parts[0];

  if (!tourneyId) {
    await fail(interaction, "That form is no longer active.");

    return;
  }

  const tourney = await repo.getTourney(tourneyId);

  if (!tourney) {
    await fail(interaction, "This tournament no longer exists.");

    return;
  }

  const slots = await repo.listSlots(tourney.id);

  const header =
    "Reg Posi,Team Name,Leader,Leader ID,Teammates,Teammates in Server,Jump URL\n";

  const rows = slots
    .map((slot) => {
      const team = slot.members
        .map((memberId) => `${memberId}`)
        .join(" | ");

      return `${slot.num},${slot.teamName},${slot.leaderId},${slot.leaderId},${team},${slot.members.length},${slot.jumpUrl ?? ""}\n`;
    })
    .join("");

  const attachment = new AttachmentBuilder(
    Buffer.from(`${header}${rows}`, "utf-8"),
    { name: `tourney_data_${tourney.id}.csv` },
  );

  // The dispatcher defers every modal submit, so the reply is already
  // there: the file goes into it.
  await interaction.editReply({ files: [attachment] });
}

async function onGroupFormat(
  interaction: ModalSubmitInteraction,
  parts: readonly string[],
): Promise<void> {
  const tourneyId = parts[0];

  if (!tourneyId) {
    await fail(interaction, "That form is no longer active.");

    return;
  }

  const tourney = await repo.getTourney(tourneyId);

  if (!tourney) {
    await fail(interaction, "This tournament no longer exists.");

    return;
  }

  const format = modalText(interaction, "format");
  const range = modalText(interaction, "range");

  if (format.length > 35) {
    await fail(interaction, "The name is too long. The maximum is 35 characters.");

    return;
  }

  if (!format.includes("{0}")) {
    await fail(interaction, "No `{0}` found in the name. It is replaced by the group number.");

    return;
  }

  const bounds = /^(\d+)\s*-\s*(\d+)$/.exec(range.trim());

  if (!bounds) {
    await fail(interaction, "Invalid range. Use `1-5` for example.");

    return;
  }

  const from = Number(bounds[1]);
  const to = Number(bounds[2]);

  if (!Number.isInteger(from) || !Number.isInteger(to) || from === to) {
    await fail(interaction, "Invalid range. The two numbers have to be different.");

    return;
  }

  const guild = interaction.guild;

  if (!guild) {
    await fail(interaction, "This only works in a server.");

    return;
  }

  const groups = await service.listGroups(tourney.id);

  const result = await createGroupChannels({
    guild,
    tourney,
    format,
    from,
    to,
    groups,
  });

  if (!result.ok) {
    await fail(interaction, result.reason);

    return;
  }

  await fail(
    interaction,
    `The group channels and roles were created (${result.created} channels).`,
    { ok: true },
  );
}

async function onSetStartFrom(
  interaction: ModalSubmitInteraction,
  parts: readonly string[],
): Promise<void> {
  const tourneyId = parts[0];

  if (!tourneyId) {
    await fail(interaction, "That form is no longer active.");

    return;
  }

  const tourney = await repo.getTourney(tourneyId);

  if (!tourney) {
    await fail(interaction, "This tournament no longer exists.");

    return;
  }

  const value = Number(modalText(interaction));

  if (!Number.isInteger(value) || value < 1 || value > 20) {
    await fail(
      interaction,
      "The slotlist has to start from a slot between 1 and 20.",
    );

    return;
  }

  await repo.updateTourney(tourney.id, { startFrom: value });

  await fail(interaction, "The slotlist start was updated.");
}

/* ------------------------------------------------------------------ *
 * Media partners
 * ------------------------------------------------------------------ */

async function onPartnerAdd(
  interaction: ModalSubmitInteraction,
  parts: readonly string[],
): Promise<void> {
  const tourneyId = parts[0];

  if (!tourneyId) {
    await fail(interaction, "That form is no longer active.");

    return;
  }

  const tourney = await repo.getTourney(tourneyId);

  if (!tourney) {
    await fail(interaction, "This tournament no longer exists.");

    return;
  }

  const channelId = modalText(interaction).replace(/\D/g, "");

  if (!channelId) {
    await fail(interaction, "You need to enter the id of the partner channel.");

    return;
  }

  const guild = interaction.guild;

  if (!guild) {
    await fail(interaction, "This only works in a server.");

    return;
  }

  const channel = guild.channels.cache.get(channelId);

  if (!channel) {
    await fail(
      interaction,
      "I could not find that channel. Is the bot in that server?",
    );

    return;
  }

  // The cross-guild check, made explicit.
  if (channel.guild.id === tourney.guildId) {
    await fail(
      interaction,
      "The partner channel has to be in another server. A tournament cannot partner with itself.",
    );

    return;
  }

  const existing = await repo.getMediaPartnerByChannel(channelId);

  if (existing) {
    await fail(interaction, "That channel is already a media partner channel.");

    return;
  }

  // The source checked that the author was a member of the partner
  // server. The bot has to be in that server too, or it cannot read the
  // channel at all.
  const partnerGuild = await interaction.client.guilds
    .fetch(channel.guild.id)
    .catch(() => null);

  if (!partnerGuild) {
    await fail(
      interaction,
      "I am not in that server, so I cannot be its media partner. Ask me to join first.",
    );

    return;
  }

  const author = await partnerGuild.members
    .fetch(interaction.user.id)
    .catch(() => null);

  if (!author) {
    await fail(
      interaction,
      "You are not in the server you are trying to media partner with. Join it first.",
    );

    return;
  }

  await service.addMediaPartner(tourney.id, channelId);

  await fail(interaction, "The media partner was added.", { ok: true });
}

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

/** The group list of a tournament, for the export. */
export function groupsOf(
  slots: readonly { num: number; teamName: string }[],
  groupSize: number,
) {
  return groupSlots(slots, groupSize);
}
