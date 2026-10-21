import { MessageFlags } from "discord.js";
import type { ChatInputCommandInteraction, Interaction } from "discord.js";
import { denialMessage } from "../core/errors.js";
import { isStaff } from "../core/guards.js";
import { RateLimiter } from "../core/ratelimit.js";
import { dispatch } from "../core/router.js";
import { isBlocked, BLOCK_ID_TYPE } from "../modules/moderation/register.js";
import { errorMessage, isIgnorableInteractionError } from "../utils/errors.js";
import { handleCommand } from "../utils/graceful-exit.js";
import { logger } from "../utils/logger.js";
// Imported for its side effect: it registers the frozen `verify_btn`
// handler with the router, and nothing else imports it.
import "./buttons.js";
import { handleModal } from "./modals.js";

/**
 * The global command rate limit.
 *
 * Quotient applied this in a cog-level `bot_check` that ran before every
 * command in the whole bot. In discord.js there is no cog-level hook, so it
 * has to live in the dispatcher — otherwise there is no rate limit at all,
 * which is an abuse vector rather than a nicety.
 *
 * Two uses per ten seconds per member, as in the source.
 */
const commandRateLimit = new RateLimiter({
  limit: 2,
  windowMs: 10_000,
  bucket: "member",
});

function rateLimitMessage(waitMs: number): string {
  return `You are being rate limited for using commands too fast. Try again in **${(waitMs / 1000).toFixed(2)} seconds**.`;
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

/**
 * Runs a command's guards.
 *
 * A guard returns `null` to allow, or a string to refuse with. The first
 * refusal wins and the rest do not run — a user who is not staff should not
 * also be told their guild is over the free-tier limit.
 */
async function runGuards(
  interaction: ChatInputCommandInteraction,
  command: { staffOnly?: boolean; guards?: readonly ((i: ChatInputCommandInteraction) => Promise<string | null>)[] },
): Promise<string | null> {
  if (command.staffOnly && !(await isStaff(interaction))) {
    return "You do not have permission to use this command. Only members with the **Moderator** role can use staff commands.";
  }

  for (const guard of command.guards ?? []) {
    const denial = await guard(interaction);
    if (denial) return denial;
  }

  return null;
}

export async function handleInteraction(interaction: Interaction): Promise<void> {
  await handleCommand(interaction, async () => {
    try {
      if (interaction.isChatInputCommand()) {
        await handleChatInput(interaction);
        return;
      }

      if (interaction.isModalSubmit()) {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        await handleModal(interaction);
        return;
      }

      if (interaction.isButton()) {
        if (!interaction.isRepliable()) return;
        await dispatch(interaction);
        return;
      }

      if (interaction.isAnySelectMenu()) {
        if (!interaction.isRepliable()) return;
        await dispatch(interaction);
        return;
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

async function handleChatInput(interaction: ChatInputCommandInteraction): Promise<void> {
  const command = interaction.client.commands.get(interaction.commandName);

  if (!command) {
    logger.error(`No command matching ${interaction.commandName}.`);
    return;
  }

  // The block list comes first and answers with silence: a blocked user
  // learns nothing about why.
  if (await isBlocked(interaction.user.id, BLOCK_ID_TYPE.user)) return;
  if (interaction.guildId && (await isBlocked(interaction.guildId, BLOCK_ID_TYPE.guild))) return;

  const waitMs = commandRateLimit.hit(interaction.user.id);
  if (waitMs !== null) {
    await interaction.reply({
      content: rateLimitMessage(waitMs),
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (command.guildOnly !== false && !interaction.guildId) {
    await interaction.reply({
      content: "This command can only be used in a server.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  // 1. Fast Acknowledgement: Defer immediately to stop the 3-second
  // expiration clock. The flag is per command: the pre-existing verification
  // commands stay ephemeral, everything else is public.
  await interaction.deferReply({
    flags: command.ephemeral ? MessageFlags.Ephemeral : undefined,
  });

  const denial = await runGuards(interaction, command);

  if (denial) {
    await interaction.editReply({ content: denial });
    return;
  }

  await command.execute(interaction);
}

export { denialMessage };
