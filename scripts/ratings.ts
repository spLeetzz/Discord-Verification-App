// Reads the chess.com rating that staff typed into each ticket's pinned
// message and writes it into the Chess sheet.

import { ChannelType } from "discord.js";
import type { Client } from "discord.js";
import { EVENTS } from "../config/events.js";
import type { EventKey } from "../config/events.js";
import cache, { refreshEvent } from "../repo/cache.js";
import type { SheetRows } from "../repo/cache.js";
import { sheets, spreadsheetIdFor } from "../repo/config.js";

const GUILD_ID = "1495402417192304711";

function colToLetter(zeroIndex: number): string {
  let n = zeroIndex + 1;
  let s = "";

  while (n > 0) {
    const rem = (n - 1) % 26;
    s = String.fromCharCode(65 + rem) + s;
    n = Math.floor((n - 1) / 26);
  }

  return s;
}

function matchByEmail(
  rows: SheetRows,
  emailCol: number,
  email: string,
): { row: string[]; sheetRow: number }[] {
  const norm = email.trim().toLowerCase();
  const matches: { row: string[]; sheetRow: number }[] = [];

  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    if (!row) continue;

    if (row[emailCol]?.trim().toLowerCase() === norm) {
      matches.push({ row, sheetRow: i + 1 });
      if (matches.length > 1) break;
    }
  }

  return matches;
}

export async function addRating(
  eventKey: EventKey,
  email: string,
  chessRating: string,
): Promise<{ status: string }> {
  await refreshEvent(eventKey);

  const rows = cache.get(eventKey) ?? [];

  if (rows.length === 0) return { status: "not_found" };

  const headers = rows[0] ?? [];
  const col = (name: string): number =>
    headers.findIndex((h) => h?.trim() === name);

  const emailCol = col("Email Address");
  const ratingCol = col("Chess Rating");

  if ([emailCol, ratingCol].includes(-1)) {
    console.log(
      `[Sheet] Missing columns in "${EVENTS[eventKey].sheetName}". Headers: ${headers.join(", ")}`,
    );
    return { status: "missing_columns" };
  }

  const matches = matchByEmail(rows, emailCol, email);

  if (matches.length === 0) return { status: "not_found" };
  if (matches.length > 1) return { status: "duplicate" };

  const match = matches[0];
  if (!match) return { status: "not_found" };

  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId: spreadsheetIdFor(eventKey),
    requestBody: {
      valueInputOption: "USER_ENTERED",
      data: [
        {
          range: `${EVENTS[eventKey].sheetName}!${colToLetter(ratingCol)}${match.sheetRow}`,
          values: [[chessRating]],
        },
      ],
    },
  });

  console.log(
    `[Sheet] Edited ${email} in "${EVENTS[eventKey].sheetName}" row ${match.sheetRow}.`,
  );

  return { status: "ok" };
}

export default async function syncRatingsFromTickets(
  bot: Client,
): Promise<void> {
  const guild = await bot.guilds.fetch(GUILD_ID);
  const channel = await guild.channels.fetch(
    EVENTS.Chess.verificationChannelId,
  );

  if (!channel || channel.type !== ChannelType.GuildText) {
    console.log("Please select a standard text channel.");
    return;
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

  for (const thread of allThreads) {
    if (!thread.name.startsWith("✅")) continue;

    const pins = await thread.messages.fetchPins();
    const pinnedMsg = pins.items.find(
      (m) => m.message.author.id === bot.user?.id,
    )?.message;

    if (!pinnedMsg) {
      console.log(`Could not find the bot's pinned message in ${thread.name}.`);
      continue;
    }

    const emailMatch = pinnedMsg.content.match(/\*\*Email:\*\* (.+)/);

    if (!emailMatch) {
      console.log(
        `Could not parse email from the pinned message in ${thread.name}. Use /setemail to fix it.`,
      );
      continue;
    }

    const email = emailMatch[1]?.trim() ?? "";

    const ratingLine = pinnedMsg.content
      .split("\n")
      .find((l) => l.startsWith("**Chess.com Rating:**"));

    if (!ratingLine) {
      console.log(`No chess rating found in ${thread.name}.`);
      continue;
    }

    const chessRating = ratingLine.replace("**Chess.com Rating:**", "").trim();

    if (!chessRating) {
      console.log(
        `Rating line exists but could not read the rating in ${thread.name}.`,
      );
      continue;
    }

    await addRating("Chess", email, chessRating);
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
}
