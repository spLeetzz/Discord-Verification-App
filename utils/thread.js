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
) {
  const thread = await interaction.channel.threads.create({
    name: name.slice(0, 100),
    type: ChannelType.PrivateThread,
    invitable: false,
  });

  await thread.members.add(user.id);

  const pinnedMsg = await thread.send(
    buildPinnedContent(user, eventKey, email, result),
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


export async function forwardMedia(thread, backupChannel) {
  let before;

  while (true) {
    const batch = await thread.messages.fetch({ limit: 100, before });
    if (batch.size === 0) break;

    for (const [, msg] of batch) {
      if (msg.attachments.size > 0) {
        const files = [...msg.attachments.values()].map((a) => a.url);
        await backupChannel.send({
          content: `Thread: ${thread.name} ${thread.url}`,
          files,
        });
        await new Promise((r) => setTimeout(r, 1000));
      }
    }

    before = batch.last()?.id;
    if (batch.size < 100) break;
  }
}
