// Find users with Confirmed role but missing/invalid verification
// Also cross-check against sheet + show thread (if exists)

import { EVENTS } from "../config/events.js";
import { ChannelType } from "discord.js";
import cache, { ensureFresh } from "../repo/cache.js";

export default async function findUnwantedConfirmed(bot) {
  const guild = await bot.guilds.fetch("1495402417192304711");

  const CONFIRMED_ROLE_ID = EVENTS.EFM.roleId;

  const channel = await guild.channels.fetch(EVENTS.EFM.verificationChannelId);

  if (!channel || channel.type !== ChannelType.GuildText) {
    console.log("Verification channel invalid");
    return;
  }

  // ---- ROLE MEMBERS ----
  const role = await guild.roles.fetch(CONFIRMED_ROLE_ID);

  let confirmedMembers = role.members;

  if (confirmedMembers.size === 0) {
    await guild.members.fetch();
    confirmedMembers = role.members;
  }

  console.log(`Confirmed members: ${confirmedMembers.size}`);

  // ---- SHEET ----
  await ensureFresh();
  const rows = cache.get("EFM") ?? [];

  if (!rows.length) {
    console.log("Sheet empty");
    return;
  }

  const headers = rows[0];

  const discordIdCol = headers.findIndex(
    (h) => h?.trim().toLowerCase() === "discord id final",
  );

  if (discordIdCol === -1) {
    console.log("Missing Discord ID column in sheet");
    return;
  }

  const sheetIds = new Set(
    rows
      .slice(1)
      .map((r) => String(r[discordIdCol] ?? "").trim())
      .filter(Boolean),
  );

  console.log(`Sheet users: ${sheetIds.size}`);

  // ---- THREADS MAP (ALL USERS) ----
  const userThreadMap = new Map(); // userId -> threadName

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

  for (const thread of allThreads) {
    if (!thread.name.startsWith("✅")) continue;

    try {
      const pins = await thread.messages.fetchPins();

      const pinnedMsg = pins.items.find(
        (m) => m.message.author.id === bot.user.id,
      )?.message;

      if (!pinnedMsg) continue;

      const member = pinnedMsg.mentions.members?.first();
      if (!member) continue;

      userThreadMap.set(member.id, thread.name);
    } catch (err) {
      console.log(`Thread failed: ${thread.name}`, err);
    }
  }

  console.log(`Indexed threads: ${userThreadMap.size}`);

  // ---- DIFF ----
  const notVerified = [];
  const missingFromSheet = [];
  const sheetOnly = [];

  for (const member of confirmedMembers.values()) {
    const inSheet = sheetIds.has(member.id);
    const threadName = userThreadMap.get(member.id);

    if (!threadName) {
      notVerified.push({
        id: member.id,
        tag: member.user.tag,
        thread: null,
      });
    }

    if (!inSheet) {
      missingFromSheet.push({
        id: member.id,
        tag: member.user.tag,
        thread: threadName ?? null,
      });
    }
  }

  for (const id of sheetIds) {
    if (!confirmedMembers.has(id)) {
      sheetOnly.push({
        id,
      });
    }
  }

  // ---- OUTPUT ----
  console.log(`\nNO VERIFY: ${notVerified.length}`);
  for (const u of notVerified) {
    console.log(
      `NO VERIFY -> ${u.tag} | ${u.id} | thread:${u.thread ?? "NONE"}`,
    );
  }

  console.log(`\nMISSING SHEET: ${missingFromSheet.length}`);
  for (const u of missingFromSheet) {
    console.log(
      `MISSING SHEET -> ${u.tag} | ${u.id} | thread:${u.thread ?? "NONE"}`,
    );
  }

  console.log(`\nSHEET ONLY: ${sheetOnly.length}`);
  for (const u of sheetOnly) {
    console.log(`SHEET ONLY -> ${u.id}`);
  }

  return {
    notVerified,
    missingFromSheet,
    sheetOnly,
  };
}
