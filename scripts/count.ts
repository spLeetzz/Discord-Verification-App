// Count verified (✅) tickets per event. Run from a REPL that already has a
// logged-in client, e.g. `const bot = new Client(...); await bot.login(token)`.

import { ChannelType } from "discord.js";
import type { Client, TextChannel } from "discord.js";
import { EVENTS } from "../config/events.js";
import type { EventKey } from "../config/events.js";

const GUILD_ID = "1495402417192304711";

export default async function countVerifiedTickets(bot: Client): Promise<void> {
  const guild = await bot.guilds.fetch(GUILD_ID);

  for (const eventKey of Object.keys(EVENTS) as EventKey[]) {
    const channel = await guild.channels.fetch(
      EVENTS[eventKey].verificationChannelId,
    );

    if (!channel || channel.type !== ChannelType.GuildText) {
      console.log(`[${eventKey}] Verification channel is not a text channel.`);
      continue;
    }

    const textChannel = channel as TextChannel;

    const activeThreads = [...textChannel.threads.cache.values()];

    const archivedPublic = await textChannel.threads.fetchArchived({
      type: "public",
      fetchAll: true,
    });

    const archivedPrivate = await textChannel.threads.fetchArchived({
      type: "private",
      fetchAll: true,
    });

    const allThreads = [
      ...activeThreads,
      ...archivedPublic.threads.values(),
      ...archivedPrivate.threads.values(),
    ];

    const verified = allThreads.filter((t) => t.name.startsWith("✅")).length;

    console.log(EVENTS[eventKey].sheetName, verified);
  }
}
