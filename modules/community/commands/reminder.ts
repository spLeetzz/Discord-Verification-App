/**
 * `/reminder` — "remind me of this later".
 *
 * The time is free text. `"2d unmute someone"` is a time and a message,
 * and the split is done by `rules.ts`'s `splitTimedText`, which uses
 * `core/time.ts`.
 *
 * The reminder is posted in the channel it was created in — not by DM.
 * When that channel is gone, the reminder is dropped and the drop is
 * logged.
 *
 * The source's `all` command said "the 10 latest currently running
 * reminders" and then showed **every** running reminder, soonest first.
 * It is now the ten latest, latest first, and the wording says what it
 * does.
 */

import { SlashCommandBuilder } from "discord.js";
import type { ChatInputCommandInteraction } from "discord.js";
import { respond } from "../../../core/context.js";
import { InputError } from "../../../core/errors.js";
import { Paginator } from "../../../core/paginator.js";
import { discordTimestamp } from "../../../core/time.js";
import { truncate } from "../../../core/text.js";
import { readReminder } from "../rules.js";
import * as service from "../service.js";
import { requireGuild, runCommand } from "./shared.js";
import type { CommunityCommand } from "./shared.js";

/** How many reminders the list shows. */
const REMINDER_LIST_LIMIT = 10;

const reminderCommand: CommunityCommand = {
  data: new SlashCommandBuilder()
    .setName("reminder")
    .setDescription("Remind you of something later.")
    .addSubcommand((sub) =>
      sub
        .setName("set")
        .setDescription("Set a reminder.")
        .addStringOption((option) =>
          option
            .setName("when")
            .setDescription(
              "When, e.g. `2d`, `9pm` or `tomorrow at 7pm`. Anything after it is the message.",
            )
            .setMaxLength(200)
            .setRequired(true),
        )
        .addStringOption((option) =>
          option
            .setName("text")
            .setDescription("What to be reminded of. Taken from `when` when you leave it out.")
            .setMaxLength(500),
        ),
    )
    .addSubcommand((sub) =>
      sub.setName("list").setDescription("Show your running reminders."),
    ),

  async execute(interaction) {
    await runCommand(interaction, async () => {
      switch (interaction.options.getSubcommand()) {
        case "set":
          await setReminder(interaction);
          return;
        case "list":
          await listReminders(interaction);
          return;
        default:
          throw new InputError("I do not know that reminder command.");
      }
    });
  },
};

/**
 * Sets a reminder.
 */
async function setReminder(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  const guild = requireGuild(interaction);

  const channelId = interaction.channelId;

  if (!channelId) {
    throw new InputError("This command only works in a server channel.");
  }

  const when = interaction.options.getString("when") ?? "";
  const text = interaction.options.getString("text");

  const reminder = readReminder(when, text);

  await service.createReminder({
    guildId: guild.id,
    channelId,
    userId: interaction.user.id,
    message: reminder.message,
    dueAt: reminder.time,
  });

  await respond(interaction, {
    content: `Alright **${interaction.user.username}**, I'll remind you ${discordTimestamp(reminder.time)}: ${reminder.message}`,
  });
}

/**
 * Shows the caller's running reminders.
 */
async function listReminders(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  const userId = interaction.user.id;

  const reminders = await service.listReminders(userId, REMINDER_LIST_LIMIT);

  if (reminders.length === 0) {
    throw new InputError("You have no running reminders.");
  }

  const total = await service.countReminders(userId);

  const pager = new Paginator({
    namespace: `reminders-${userId}`,
    perPage: 10,
    title: `Your running reminders (${total})`,
    loadPages: async () => {
      const rows = await service.listReminders(userId, REMINDER_LIST_LIMIT);

      if (rows.length === 0) return [];

      return [
        rows.map((row) => {
          const when = discordTimestamp(row.expiresAt);

          return `\`${row.id}\`: ${truncate(row.message, 40)} (${when})`;
        }),
      ];
    },
  });

  await pager.start(interaction);
}

export default reminderCommand;
