import { EVENTS } from "../config/events.js";
import {
  SlashCommandBuilder,
  ChannelType,
  MessageFlags,
  PermissionFlagsBits,
} from "discord.js";

export default async function fn(bot) {
  for (const e of Object.values(EVENTS)) {
    const channel = await (
      await bot.guilds.fetch("1495402417192304711")
    ).channels.fetch(e.verificationChannelId);

    if (channel.type !== ChannelType.GuildText) {
      console.log("Please select a standard text channel.");
    }

    const activeThreads = [...channel.threads.cache.values()];

    const archivedPublic = await channel.threads.fetchArchived({
      type: "public",
      fetchAll: true,
    });

    const archivedPrivate = await channel.threads.fetchArchived({
      type: "private",
      fetchAll: true,
    });

    const allThreads = [
      ...activeThreads,
      ...archivedPublic.threads.values(),
      ...archivedPrivate.threads.values(),
    ];

    let c = 0;

    for (const thread of allThreads) {
      if (thread.name.startsWith("✅")) c++;
    }

    console.log(e.sheetName, c);
  }
}
