import { MessageFlags } from "discord.js";
import type { ChatInputCommandInteraction, Interaction } from "discord.js";
import { denialMessage } from "../core/errors.js";
import { isStaff } from "../core/guards.js";
import { dispatch } from "../core/router.js";
import { isBlocked, BLOCK_ID_TYPE } from "../modules/moderation/register.js";
import { recordCommandUsage } from "../modules/community/register.js";
import { errorMessage, isIgnorableInteractionError } from "../utils/errors.js";
import { handleCommand } from "../utils/graceful-exit.js";
import { logger } from "../utils/logger.js";
// Imported for its side effect: it registers the frozen `verify_btn`
// handler with the router, and nothing else imports it.
import "./buttons.js";
import { handleModal } from "./modals.js";

/**
 * **There is no rate limit on commands or components.**
 *
 * Quotient applied a cog-level `bot_check` to every command — two per ten
 * seconds per member — and this dispatcher carried that for a while. It is
 * gone: a member who is working through a setup flow (open a panel, pick a
 * select, submit a modal, run a command) was being told to wait, and the
 * ceiling was the bot's rather than Discord's.
 *
 * Discord's own rate limits still apply, and they are the ones that
 * actually protect the bot. The screenshot-verification intake keeps its
 * own limiter, which is about how much a member may push at the OCR
 * service rather than about how fast they may type.
 */

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
    const started = Date.now();
    const firstResponse = markFirstResponse(interaction);

    try {
      // The block list is consulted for **every** interaction type, not
      // just chat-input commands. A blocked member who cannot type a
      // command but can press a button on a published panel is not blocked.
      // The answer is silence: a blocked user learns nothing about why.
      if (await isBlocked(interaction.user.id, BLOCK_ID_TYPE.user)) return;
      if (
        interaction.guildId &&
        (await isBlocked(interaction.guildId, BLOCK_ID_TYPE.guild))
      ) {
        return;
      }

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
    } finally {
      reportSlowInteraction(interaction, started, firstResponse());
      await ensureAnswered(interaction, firstResponse());
    }
  });
}

/**
 * How long an interaction may go without an answer before it is worth
 * shouting about.
 *
 * Discord's limit is three seconds. The alarm goes off a little before
 * that, so the log says what was slow while there is still something to
 * be done about it.
 */
const RESPONSE_ALARM_MS = 2_500;

/**
 * Makes sure an interaction is never left unanswered.
 *
 * Discord expires an interaction after three seconds, and the user is
 * shown "the bot didn't respond in time" — which says nothing about what
 * actually happened, and looks like the bot is broken. A handler that
 * returns without answering is a bug, but the user should still get an
 * answer.
 *
 * So: if the handler finished and nothing was sent, something is sent
 * now. If the handler was *slow* the interaction has already expired and
 * there is nothing to send — that case is logged, because it is the one
 * that needs a fix rather than a message.
 */
async function ensureAnswered(
  interaction: Interaction,
  firstResponse: number | null,
): Promise<void> {
  if (firstResponse !== null) return;

  const what =
    interaction.isChatInputCommand()
      ? `command /${interaction.commandName}`
      : "customId" in interaction && interaction.customId
        ? `custom id "${interaction.customId}"`
        : "interaction";

  logger.error(
    `[Interaction] ${what} was never answered. Discord expires an interaction after three seconds, so the user saw 'didn't respond in time'.`,
  );

  if (!interaction.isRepliable()) return;
  if (interaction.replied || interaction.deferred) return;

  await interaction
    .reply({
      content: "Something went wrong handling that. Please try again.",
      flags: MessageFlags.Ephemeral,
    })
    .catch(() => undefined);
}

/**
 * Discord gives an interaction **three seconds** to be answered. A
 * handler that takes longer is expired by Discord, and the user is shown
 * "the bot didn't respond in time" — which says nothing about what was
 * slow or why.
 *
 * So the time to the *first* response is measured, and a slow one is
 * logged with the interaction it was. The first response is what the
 * clock is about: a handler that opens a select menu answers the button
 * immediately and then waits for the user, which is not slow.
 *
 * @returns a function that gives the moment of the first response, or
 *          `null` if there has not been one.
 */
function markFirstResponse(interaction: Interaction): () => number | null {
  let at: number | null = null;

  const mark = (): void => {
    if (at === null) at = Date.now();
  };

  // The methods are on the prototype, so an own property shadows them.
  // `showModal` is in the list: opening a modal *is* the answer to an
  // interaction, and leaving it out would report a perfectly good
  // handler as unanswered.
  const methods = [
    "reply",
    "editReply",
    "update",
    "deferReply",
    "deferUpdate",
    "followUp",
    "respond",
    "showModal",
  ] as const;

  for (const method of methods) {
    const original = (interaction as unknown as Record<string, unknown>)[method];

    if (typeof original !== "function") continue;

    (interaction as unknown as Record<string, unknown>)[method] = function (
      ...args: unknown[]
    ) {
      mark();

      return (original as (...a: unknown[]) => unknown).apply(this, args);
    };
  }

  /**
   * The alarm.
   *
   * It fires while the handler is *still running*, because a handler
   * that never returns never reaches the `finally` block — and a handler
   * that never returns is exactly the one that expires the
   * interaction. Waiting for it to finish would mean waiting forever.
   */
  const timer = setTimeout(() => {
    if (at !== null) return;

    const what =
      interaction.isChatInputCommand()
        ? `command /${interaction.commandName}`
        : "customId" in interaction && interaction.customId
          ? `custom id "${interaction.customId}"`
          : "interaction";

    logger.error(
      `[Interaction] ${what} had not been answered after ${RESPONSE_ALARM_MS}ms. Discord expires an interaction after 3000ms, so the user saw 'didn't respond in time'.`,
    );
  }, RESPONSE_ALARM_MS);

  timer.unref();

  return () => {
    clearTimeout(timer);

    return at;
  };
}

/**
 * How long an interaction took to be answered.
 *
 * A warning for a slow one — over a second and a half — because Discord's
 * limit is three seconds and a slow answer is a bug waiting to happen.
 */
function reportSlowInteraction(
  interaction: Interaction,
  started: number,
  firstResponse: number | null,
): void {
  if (firstResponse === null) return;

  const elapsed = firstResponse - started;

  if (elapsed <= 1_500) return;

  const what =
    interaction.isChatInputCommand()
      ? `command /${interaction.commandName}`
      : "customId" in interaction && interaction.customId
        ? `custom id "${interaction.customId}"`
        : "interaction";

  logger.warn(
    `[Interaction] ${what} took ${elapsed}ms to answer. Discord's limit is 3000ms.`,
  );
}

async function handleChatInput(interaction: ChatInputCommandInteraction): Promise<void> {
  const command = interaction.client.commands.get(interaction.commandName);

  if (!command) {
    logger.error(`No command matching ${interaction.commandName}.`);

    // The interaction still has to be answered. Leaving it unanswered
    // means Discord expires it, and the user is shown "the bot didn't
    // respond in time" — which says nothing about what actually
    // happened.
    await interaction
      .reply({
        content: `I do not have a \`/${interaction.commandName}\` command. It may have been renamed or removed — type \`/\` to see what there is.`,
        flags: MessageFlags.Ephemeral,
      })
      .catch(() => undefined);

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
    await recordUsage(interaction, command.data.name, true);
    return;
  }

  try {
    await command.execute(interaction);
  } catch (err) {
    await recordUsage(interaction, command.data.name, true);
    throw err;
  }

  await recordUsage(interaction, command.data.name, false);
}

/**
 * Writes one row to the command-usage log.
 *
 * The log is the source of the tag statistics and the per-guild command
 * counts. It is written on every invocation, successful or not, because a
 * failed command is exactly what a moderator wants to see.
 *
 * A failure to log must never fail the command, so this swallows its errors.
 */
async function recordUsage(
  interaction: ChatInputCommandInteraction,
  cmd: string,
  failed: boolean,
): Promise<void> {
  if (!interaction.guildId || !interaction.channelId) return;

  try {
    await recordCommandUsage({
      guildId: interaction.guildId,
      channelId: interaction.channelId,
      userId: interaction.user.id,
      cmd,
      // The bot has no prefix commands, so there is no prefix to record.
      prefix: "",
      failed,
    });
  } catch (err) {
    logger.warn(
      `[InteractionCreate] Could not record command usage: ${errorMessage(err)}`,
    );
  }
}

export { denialMessage };
