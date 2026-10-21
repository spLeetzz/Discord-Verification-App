import { MessageFlags, PermissionFlagsBits } from "discord.js";
import type { Interaction } from "discord.js";
import { handleButton } from "./buttons.js";
import { handleModal } from "./modals.js";
import { errorMessage, isIgnorableInteractionError } from "../utils/errors.js";
import { handleCommand } from "../utils/graceful-exit.js";
import { logger } from "../utils/logger.js";
import { getGuildMember } from "../utils/member.js";

const STAFF_ROLE_NAME = "Moderator";

async function isStaff(interaction: Interaction): Promise<boolean> {
  const member = await getGuildMember(interaction);
  if (!member) return false;

  if (member.permissions.has(PermissionFlagsBits.Administrator)) return true;

  // Role names are not stable identifiers, but the staff role has always been
  // called "Moderator" in this guild.
  return member.roles.cache.some((role) => role.name === STAFF_ROLE_NAME);
}

async function reportError(interaction: Interaction, err: unknown): Promise<void> {
  logger.error("[InteractionCreate]", err);

  const content = "Something went wrong processing your request.";

  try {
    // `flags` is not accepted by editReply — a reply's ephemeral flag is
    // fixed when it is first sent.
    if (interaction.isChatInputCommand()) {
      await interaction.editReply({ content });
    } else if (interaction.isModalSubmit()) {
      await interaction.editReply({ content });
    } else if (interaction.isButton()) {
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply({ content });
      } else {
        await interaction.reply({ content, flags: MessageFlags.Ephemeral });
      }
    }
  } catch (innerErr) {
    logger.error(
      `[InteractionCreate] Could not deliver error reply: ${errorMessage(innerErr)}`,
    );
  }
}

export async function handleInteraction(interaction: Interaction): Promise<void> {
  await handleCommand(interaction, async () => {
    try {
      // 1. Fast Acknowledgement: Defer immediately for commands and modals
      // to stop the 3-second expiration clock.
      if (interaction.isChatInputCommand()) {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        const command = interaction.client.commands.get(interaction.commandName);

        if (!command) {
          logger.error(`No command matching ${interaction.commandName}.`);
          return;
        }

        if (command.staffOnly && !(await isStaff(interaction))) {
          await interaction.editReply({
            content:
              "You do not have permission to use this command. Only members with the **Moderator** role can use staff commands.",
          });
          return;
        }

        await command.execute(interaction);
        return;
      }

      if (interaction.isModalSubmit()) {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        await handleModal(interaction);
        return;
      }

      if (interaction.isButton()) {
        if (!interaction.isRepliable()) return;
        await handleButton(interaction);
      }
    } catch (err) {
      // 2. Smart Error Reporting: Don't try to reply if the interaction is already dead.
      if (isIgnorableInteractionError(err)) {
        logger.warn(
          "[InteractionCreate] Interaction expired or already acknowledged.",
        );
        return;
      }

      await reportError(interaction, err);
    }
  });
}
