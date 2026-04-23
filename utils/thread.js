import { ChannelType } from "discord.js";
import { buildPinnedContent, buildDocRequirements } from "./embeds.js";

export async function updateThreadStatus(thread, emoji) {
  const statusEmojis = ["✅", "❌", "❗", "⚠️"];
  let cleanName = thread.name;
  for (const e of statusEmojis) {
    if (cleanName.startsWith(e)) {
      cleanName = cleanName.slice(e.length);
      break;
    }
  }
  const newName = `${emoji}${cleanName}`.slice(0, 100);
  if (thread.name !== newName) {
    await thread.edit({ name: newName });
  }
}

export async function createVerificationThread(
  interaction,
  user,
  eventKey,
  email,
  name,
  result,
  chessRating = null,
) {
  const thread = await interaction.channel.threads.create({
    name: name.slice(0, 100),
    type: ChannelType.PrivateThread,
    invitable: false,
  });

  await thread.members.add(user.id);

  const pinnedMsg = await thread.send(
    buildPinnedContent(user, eventKey, email, result, chessRating),
  );

  setImmediate(async () => {
    try {
      await pinnedMsg.pin();
      await thread.send(buildDocRequirements(eventKey));
    } catch (err) {
      console.error("[Thread] Decoration failed:", err);
    }
  });

  return thread;
}


export async function forwardMedia(thread, backupChannel, summary = "") {
  const allUrls = [];
  let before;

  while (true) {
    const batch = await thread.messages.fetch({ limit: 100, before });
    if (batch.size === 0) break;

    for (const [, msg] of [...batch].reverse()) {          // chronological order
      for (const attachment of msg.attachments.values()) {
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
