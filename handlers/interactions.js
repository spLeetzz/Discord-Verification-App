import { MessageFlags, PermissionFlagsBits } from "discord.js";
import { handleButton } from "./buttons.js";
import { handleModal } from "./modals.js";
import { handleCommand } from "../utils/graceful-exit.js";
import { logger } from "../utils/logger.js";

export async function handleInteraction(interaction) {
  await handleCommand(interaction, async () => {
    try {
      // 1. Fast Acknowledgement: Defer immediately for commands and modals
      // to stop the 3-second expiration clock.
      if (interaction.isChatInputCommand() || interaction.isModalSubmit()) {
        // We catch here because if it already timed out or was acknowledged by another instance,
        // we want to stop execution immediately.
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      }

      if (interaction.isChatInputCommand()) {
        const command = interaction.client.commands.get(interaction.commandName);
        if (!command) {
          logger.error(`No command matching ${interaction.commandName}.`);
          return;
        }

        if (command.staffOnly) {
          const isModerator = interaction.member?.roles.cache.some(
            (role) => role.name === "Moderator",
          );
          const isAdmin = interaction.member?.permissions.has(
            PermissionFlagsBits.Administrator,
          );
          if (!isModerator && !isAdmin) {
            const content =
              "You do not have permission to use this command. Only members with the **Moderator** role can use staff commands.";
            if (interaction.deferred) {
              return interaction.editReply({ content });
            }
            return interaction.reply({ content, flags: MessageFlags.Ephemeral });
          }
        }
        await command.execute(interaction);
      } else if (interaction.isButton()) {
        if (!interaction.isRepliable()) return;
        await handleButton(interaction);
      } else if (interaction.isModalSubmit()) {
        await handleModal(interaction);
      }
    } catch (err) {
      // 2. Smart Error Reporting: Don't try to reply if the interaction is already dead.
      if (err.code === 10062 || err.code === 40060) {
        logger.warn(
          `[InteractionCreate] Interaction ${err.code === 10062 ? "expired" : "already acknowledged"}.`,
        );
        return;
      }

      logger.error("[InteractionCreate]", err);
      const reply = {
        content: "Something went wrong processing your request.",
        flags: MessageFlags.Ephemeral,
      };

      try {
        if (interaction.deferred || interaction.replied) {
          await interaction.editReply(reply);
        } else {
          await interaction.reply(reply);
        }
      } catch (innerErr) {
        console.error(innerErr)
      }
    }
  });
}