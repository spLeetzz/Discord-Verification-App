import { ChannelType } from "discord.js";
import type { PrivateThreadChannel, TextChannel, User } from "discord.js";
import type { EventKey } from "../config/events.js";
import type { ParticipantResult } from "../types/sheet.js";
import type { TicketSubmission } from "../types/ticket.js";
import {
  buildDocRequirements,
  buildPinnedContent,
  buildRequestExamplePayload,
} from "./embeds.js";
import { fetchExampleImage } from "./example-image.js";

const STATUS_EMOJIS = ["✅", "❌", "❗", "⚠️"] as const;

export async function updateThreadStatus(
  thread: PrivateThreadChannel,
  emoji: string,
): Promise<void> {
  let cleanName = thread.name.trim();

  for (const status of STATUS_EMOJIS) {
    if (cleanName.startsWith(status)) {
      cleanName = cleanName.slice(status.length).trim();
      break;
    }
  }

  // Always "✅ Name" — with the space — whether or not the thread already
  // carried a status prefix.
  const newName = `${emoji} ${cleanName}`.slice(0, 100);

  if (thread.name !== newName) {
    await thread.edit({ name: newName });
  }
}

export async function createVerificationThread(
  parent: TextChannel,
  user: User,
  eventKey: EventKey,
  submission: TicketSubmission,
  result: ParticipantResult,
): Promise<PrivateThreadChannel> {
  // `TextChannel` allows both public and private threads, so the manager's
  // return type is a union. We always create a private one.
  const thread = (await parent.threads.create({
    name: submission.name.slice(0, 100),
    type: ChannelType.PrivateThread,
    invitable: false,
  })) as PrivateThreadChannel;

  await thread.members.add(user.id);

  const pinnedMsg = await thread.send(
    buildPinnedContent(user, eventKey, submission, result),
  );

  setImmediate(async () => {
    try {
      await pinnedMsg.pin();
      await thread.send(buildDocRequirements(eventKey));

      const example = buildRequestExamplePayload(
        await fetchExampleImage(eventKey),
      );

      if (example) {
        await thread.send(example);
      }
    } catch (err) {
      console.error("[Thread] Decoration failed:", err);
    }
  });

  return thread;
}

/**
 * Copies every attachment in the ticket to a backup channel, oldest first.
 */
export async function forwardMedia(
  thread: PrivateThreadChannel,
  backupChannel: TextChannel,
  summary = "",
): Promise<void> {
  const allUrls: string[] = [];
  let before: string | undefined;

  for (;;) {
    const batch = await thread.messages.fetch({ limit: 100, before });

    if (batch.size === 0) break;

    for (const [, message] of [...batch].reverse()) {
      // chronological order
      for (const attachment of message.attachments.values()) {
        allUrls.push(attachment.url);
      }
    }

    before = batch.last()?.id;
    if (batch.size < 100) break;
  }

  // Always send the header (even if no files) so the summary is never lost
  const header = [`📁 **Thread:** ${thread.name}`, `🔗 ${thread.url}`];
  if (summary) header.push(summary);
  await backupChannel.send(header.join("\n"));

  const CHUNK = 10;

  for (let i = 0; i < allUrls.length; i += CHUNK) {
    await backupChannel.send({ files: allUrls.slice(i, i + CHUNK) });
    if (i + CHUNK < allUrls.length) {
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
}
