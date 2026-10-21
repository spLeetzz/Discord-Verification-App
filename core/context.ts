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
 *
 * The distinction that matters is Discord's: **an interaction can only
 * be replied to once.** A response is either the interaction's own reply,
 * the edit of a deferral, or — once the interaction has answered — a
 * follow-up message.
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
      /**
       * The filter may be asynchronous.
       *
       * A filter that has to look something up — whether a channel is in
       * this guild, say — cannot answer in a tick, and discord.js waits
       * for a promise.
       */
      filter: (
        interaction: MessageComponentInteraction,
      ) => boolean | Promise<boolean>;
    },
  ): Promise<MessageComponentInteraction>;

  /**
   * Edits the message this handle points at.
   *
   * The handle is a message of its own — the interaction's reply, the
   * edit of a deferral, or a follow-up — so an edit lands on the message
   * that actually carries the buttons. `interaction.editReply()` would
   * not: it always edits the interaction's *own* reply, which is a
   * different message once a follow-up is in play.
   */
  edit(payload: ReplyPayload): Promise<unknown>;
}

/** How a reply is shaped. */
export interface ReplyOptions {
  /**
   * Whether the reply is only visible to the caller.
   *
   * Ignored when the interaction was already deferred: the ephemeral flag
   * is fixed when the response is first sent. A follow-up is a message of
   * its own, so it can be ephemeral even when the reply was not.
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
 *
 * | the interaction | what happens                  |
 * | --------------- | ----------------------------- |
 * | fresh           | `interaction.reply(...)`     |
 * | deferred        | `interaction.editReply(...)` |
 * | already replied | `interaction.followUp(...)`  |
 *
 * The last row is the one that surprises people: Discord allows one
 * answer per interaction, so once the interaction has answered, a second
 * message has to be a **follow-up**. It is a message of its own, and it
 * can carry its own components — which is how a flow collects twice out
 * of one interaction.
 */
export async function respond(
  interaction: RepliableInteraction,
  payload: ReplyPayload,
  ephemeral = false,
): Promise<ReplyHandle> {
  if (interaction.replied) {
    // The interaction has answered already. A second answer cannot be a
    // reply — Discord would throw — so it is a follow-up: a new message.
    return interaction.followUp({
      ...payload,
      flags: ephemeral ? MessageFlags.Ephemeral : undefined,
    });
  }

  if (interaction.deferred) {
    // A deferred interaction already has a placeholder message. Editing
    // it is what turns the deferral into the real answer.
    //
    // `flags` is not accepted by `editReply` — a reply's ephemeral flag is
    // fixed when it is first sent.
    return interaction.editReply(payload);
  }

  return interaction.reply({
    ...payload,
    flags: ephemeral ? MessageFlags.Ephemeral : undefined,
  });
}

/** How a message a collector waits on is sent. */
export interface CollectableOptions {
  /**
   * Whether the message is only visible to the caller.
   *
   * Ignored when the interaction was already deferred: the ephemeral flag
   * is fixed when the response is first sent. A follow-up is a message
   * of its own, so it can be ephemeral even when the reply was not.
   */
  ephemeral?: boolean;
  /**
   * Send the message as a follow-up rather than as the interaction's own
   * reply.
   *
   * An interaction can only be replied to once, so a flow that needs two
   * inputs has to use a follow-up for the second one.
   */
  asFollowUp?: boolean;
}

/**
 * Sends the message a component collector will wait on.
 *
 * The same rule as {@link respond}, with one addition: the message can be
 * sent as a **follow-up**, which is how a flow gets a second collector out
 * of one interaction.
 *
 * A follow-up needs an interaction that has already answered — Discord
 * refuses one otherwise — so `asFollowUp` on a fresh interaction falls
 * back to the interaction's own reply. The flow still works; it just
 * cannot have two messages.
 */
export async function sendCollectable(
  interaction: RepliableInteraction,
  payload: ReplyPayload,
  options: CollectableOptions = {},
): Promise<ReplyHandle> {
  if (options.asFollowUp && (interaction.deferred || interaction.replied)) {
    return interaction.followUp({
      ...payload,
      flags: options.ephemeral ? MessageFlags.Ephemeral : undefined,
    });
  }

  return respond(interaction, payload, options.ephemeral ?? false);
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
