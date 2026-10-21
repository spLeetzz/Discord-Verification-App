// Find users with the Confirmed role but missing/invalid verification.
// Also cross-check against the sheet + show the ticket (if it exists).

import { ChannelType } from "discord.js";
import type { Client } from "discord.js";
import { EVENTS } from "../config/events.js";
import cache, { refreshEvent } from "../repo/cache.js";

const GUILD_ID = "1495402417192304711";

interface UnwantedUser {
  id: string;
  tag: string;
  thread: string | null;
}

export interface UnwantedReport {
  notVerified: UnwantedUser[];
  missingFromSheet: UnwantedUser[];
  sheetOnly: string[];
}

export default async function findUnwantedConfirmed(
  bot: Client,
): Promise<UnwantedReport> {
  const guild = await bot.guilds.fetch(GUILD_ID);

  const CONFIRMED_ROLE_ID = EVENTS.EFM.roleId;

  const channel = await guild.channels.fetch(
    EVENTS.EFM.verificationChannelId,
  );

  if (!channel || channel.type !== ChannelType.GuildText) {
    console.log("Verification channel invalid");
    return { notVerified: [], missingFromSheet: [], sheetOnly: [] };
  }

  // ---- ROLE MEMBERS ----
  const role = await guild.roles.fetch(CONFIRMED_ROLE_ID);

  if (!role) {
    console.log(`Role ${CONFIRMED_ROLE_ID} not found`);
    return { notVerified: [], missingFromSheet: [], sheetOnly: [] };
  }

  let confirmedMembers = role.members;

  if (confirmedMembers.size === 0) {
    await guild.members.fetch();
    confirmedMembers = role.members;
  }

  console.log(`Confirmed members: ${confirmedMembers.size}`);

  // ---- SHEET ----
  await refreshEvent("EFM");
  const rows = cache.get("EFM") ?? [];

  if (!rows.length) {
    console.log("Sheet empty");
    return { notVerified: [], missingFromSheet: [], sheetOnly: [] };
  }

  const headers = rows[0] ?? [];

  const discordIdCol = headers.findIndex(
    (h) => h?.trim().toLowerCase() === "discord id final",
  );

  if (discordIdCol === -1) {
    console.log("Missing Discord ID column in sheet");
    return { notVerified: [], missingFromSheet: [], sheetOnly: [] };
  }

  const sheetIds = new Set(
    rows
      .slice(1)
      .map((r) => String(r[discordIdCol] ?? "").trim())
      .filter(Boolean),
  );

  console.log(`Sheet users: ${sheetIds.size}`);

  // ---- THREADS MAP (ALL USERS) ----
  const userThreadMap = new Map<string, string>(); // userId -> threadName

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
        (m) => m.message.author.id === bot.user?.id,
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
  const notVerified: UnwantedUser[] = [];
  const missingFromSheet: UnwantedUser[] = [];
  const sheetOnly: string[] = [];

  for (const member of confirmedMembers.values()) {
    const inSheet = sheetIds.has(member.id);
    const threadName = userThreadMap.get(member.id) ?? null;

    if (!threadName) {
      notVerified.push({ id: member.id, tag: member.user.tag, thread: null });
    }

    if (!inSheet) {
      missingFromSheet.push({
        id: member.id,
        tag: member.user.tag,
        thread: threadName,
      });
    }
  }

  for (const id of sheetIds) {
    if (!confirmedMembers.has(id)) {
      sheetOnly.push(id);
    }
  }

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
  for (const id of sheetOnly) {
    console.log(`SHEET ONLY -> ${id}`);
  }

  return { notVerified, missingFromSheet, sheetOnly };
}
