/**
 * The context — functions, not a class (D38).
 *
 * discord.py's `Context` was a class with about eighteen helper members.
 * In discord.js the interaction *is* the context, so there is nothing to
 * subclass and nothing to hold state in: every helper here takes an
 * `Interaction` and returns.
 *
 * The helpers come from Quotient's `core/Context.py`:
 *
 *  - `error`    — a refusal, in red;
 *  - `success`  — a confirmation, with a tick;
 *  - `simple`   — a plain message in the bot's colour;
 *  - `send_file`— a message as a file attachment;
 *  - `error` + "delete when the invoking message goes away".
 *
 * All of them cope with an interaction that has already been replied to
 * or deferred, because the dispatcher defers every chat-input command
 * before the command body runs.
 */

import {
  AttachmentBuilder,
  EmbedBuilder,
  MessageFlags,
} from "discord.js";
import type {
  InteractionReplyOptions,
  Message,
  MessageComponentInteraction,
  MessageComponentType,
  PartialMessage,
  RepliableInteraction,
} from "discord.js";
import { escapeMentions } from "./escape.js";
import { run } from "./fire-and-forget.js";
import { EMBED_COLOR, ERROR_COLOR } from "./constants.js";

/** How long Quotient watched for the invoking message to be deleted. */
const DEFAULT_DELETE_WINDOW_MS = 30_000;

/**
 * A handle on a posted reply.
 *
 * Both `interaction.reply()` and `interaction.editReply()` hand back
 * something that can wait for a component press, and the prompt and the
 * select menu need that. This is the part of it they use.
 */
export interface ReplyHandle {
  awaitMessageComponent(
    options: {
      componentType: MessageComponentType;
      time: number;
      filter: (interaction: MessageComponentInteraction) => boolean;
    },
  ): Promise<MessageComponentInteraction>;
}

/** How a reply is shaped. */
export interface ReplyOptions {
  /**
   * Whether the reply is only visible to the caller.
   *
   * Ignored when the interaction was already deferred or replied to: the
   * ephemeral flag is fixed when the response is first sent.
   */
  ephemeral?: boolean;
  /** Delete the reply after this many seconds. */
  deleteAfter?: number;
}

/** The payload a reply carries. */
export interface ReplyPayload {
  content?: string;
  embeds?: EmbedBuilder[];
  files?: AttachmentBuilder[];
  components?: InteractionReplyOptions["components"];
}

/**
 * Sends a reply, or edits the one that is already there.
 *
 * This is the one place that knows about the deferred/replied distinction,
 * and every other helper in `core/` goes through it.
 */
export async function respond(
  interaction: RepliableInteraction,
  payload: ReplyPayload,
  ephemeral = false,
): Promise<ReplyHandle> {
  if (interaction.deferred || interaction.replied) {
    // `flags` is not accepted by `editReply` — a reply's ephemeral flag is
    // fixed when it is first sent.
    return interaction.editReply(payload);
  }

  return interaction.reply({
    ...payload,
    flags: ephemeral ? MessageFlags.Ephemeral : undefined,
  });
}

/**
 * Schedules the deletion of the interaction's response.
 */
function scheduleDelete(interaction: RepliableInteraction, seconds: number): void {
  const timer = setTimeout(() => {
    run(() => interaction.deleteReply(), "context.deleteAfter");
  }, seconds * 1000);

  // A pending deletion is not a reason to keep the process alive.
  timer.unref();
}

/**
 * A refusal.
 *
 * Red embed, the message as its description.
 */
export async function replyError(
  interaction: RepliableInteraction,
  message: string,
  options: ReplyOptions = {},
): Promise<void> {
  const embed = new EmbedBuilder()
    .setDescription(message)
    .setColor(ERROR_COLOR);

  await respond(interaction, { embeds: [embed] }, options.ephemeral ?? false);

  if (options.deleteAfter !== undefined) {
    scheduleDelete(interaction, options.deleteAfter);
  }
}

/**
 * A confirmation.
 *
 * The bot's colour and a tick in front of the message.
 */
export async function replySuccess(
  interaction: RepliableInteraction,
  message: string,
  options: ReplyOptions = {},
): Promise<void> {
  const embed = new EmbedBuilder()
    .setDescription(`✅ | ${message}`)
    .setColor(EMBED_COLOR);

  await respond(interaction, { embeds: [embed] }, options.ephemeral ?? false);

  if (options.deleteAfter !== undefined) {
    scheduleDelete(interaction, options.deleteAfter);
  }
}

/**
 * A plain message in the bot's colour.
 */
export async function replySimple(
  interaction: RepliableInteraction,
  message: string,
  options: ReplyOptions = {},
): Promise<void> {
  const embed = new EmbedBuilder()
    .setDescription(message)
    .setColor(EMBED_COLOR);

  await respond(interaction, { embeds: [embed] }, options.ephemeral ?? false);

  if (options.deleteAfter !== undefined) {
    scheduleDelete(interaction, options.deleteAfter);
  }
}

/** How a file reply is shaped. */
export interface SendFileOptions extends ReplyOptions {
  /** The attachment's file name. Defaults to `Message.txt`. */
  name?: string;
  /**
   * Escape mentions in the content.
   *
   * Defaults to `true`, as in Quotient: a file's contents are user data
   * and must not be able to ping.
   */
  escapeMentions?: boolean;
}

/**
 * Sends a message as a file attachment.
 *
 * Used by `tag raw`, where the content may be longer than a message or may
 * contain text that has to survive verbatim.
 */
export async function sendFile(
  interaction: RepliableInteraction,
  content: string,
  options: SendFileOptions = {},
): Promise<void> {
  const body =
    options.escapeMentions === false ? content : escapeMentions(content);

  const attachment = new AttachmentBuilder(Buffer.from(body, "utf-8"), {
    name: options.name ?? "Message.txt",
  });

  await respond(
    interaction,
    { files: [attachment] },
    options.ephemeral ?? false,
  );

  if (options.deleteAfter !== undefined) {
    scheduleDelete(interaction, options.deleteAfter);
  }
}

/** How {@link replyErrorUntilDeleted} is shaped. */
export interface ReplyErrorUntilDeletedOptions extends ReplyOptions {
  /**
   * The id of the message to watch.
   *
   * Defaults to the interaction's target message, when it has one — a
   * message context-menu command. A plain slash command has no invoking
   * message, and nothing is watched.
   */
  messageId?: string;
  /**
   * How long to watch, in milliseconds. Defaults to 30 seconds, which is
   * what Quotient waited for.
   */
  windowMs?: number;
}

/**
 * The id of the message an interaction was aimed at, when it has one.
 */
function targetMessageId(interaction: RepliableInteraction): string | undefined {
  if ("targetId" in interaction && typeof interaction.targetId === "string") {
    return interaction.targetId;
  }

  return undefined;
}

/**
 * A refusal that goes away when the invoking message does.
 *
 * Quotient's `ctx.error` posted the error and then watched for the user's
 * own message to be deleted; when it was, the error was deleted too, so a
 * user who cleaned up after themselves did not leave a refusal behind.
 *
 * The watch is **non-blocking**: the handler returns as soon as the error
 * is posted. The deletion happens later, from a `messageDelete` listener,
 * and never inside the handler.
 */
export async function replyErrorUntilDeleted(
  interaction: RepliableInteraction,
  message: string,
  options: ReplyErrorUntilDeletedOptions = {},
): Promise<void> {
  await replyError(interaction, message, options);

  const messageId = options.messageId ?? targetMessageId(interaction);

  if (!messageId) return;

  const client = interaction.client;
  const windowMs = options.windowMs ?? DEFAULT_DELETE_WINDOW_MS;

  const onDelete = (deleted: Message | PartialMessage): void => {
    if (deleted.id !== messageId) return;

    client.off("messageDelete", onDelete);

    run(() => interaction.deleteReply(), "context.replyErrorUntilDeleted");
  };

  client.on("messageDelete", onDelete);

  const timer = setTimeout(() => {
    client.off("messageDelete", onDelete);
  }, windowMs);

  timer.unref();
}
