// to fetch chess rating from discord and add in sheet

import { EVENTS } from "../config/events.js";
import {
  SlashCommandBuilder,
  ChannelType,
  MessageFlags,
  PermissionFlagsBits,
} from "discord.js";
import cache, { ensureFresh } from "../repo/cache.js";
import { sheets, spreadsheetId } from "../repo/config.js";

function matchByEmail(rows, emailCol, email) {
  const norm = email.trim().toLowerCase();
  const matches = [];
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    if (row[emailCol]?.trim().toLowerCase() === norm) {
      matches.push({ row, sheetRow: i + 1 });
      if (matches.length > 1) break;
    }
  }
  return matches;
}

export async function addRating(sheetName, email, chessRating) {
  await ensureFresh();
  const rows = cache.get(sheetName) ?? [];

  if (rows.length === 0) return { status: "not_found" };

  const headers = rows[0];

  const col = (name) => headers.findIndex((h) => h?.trim() === name);

  const emailCol = col("Email Address");
  const ratingCol = col("Chess Rating");

  if ([emailCol, ratingCol].includes(-1)) {
    console.log(
      `[Sheet] Missing columns in "${sheetName}". Headers: ${headers.join(", ")}`,
    );
    return { status: "missing_columns" };
  }

  const matches = matchByEmail(rows, emailCol, email);

  if (matches.length === 0) return { status: "not_found" };
  if (matches.length > 1) return { status: "duplicate" };

  const { row, sheetRow } = matches[0];

  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId,
    requestBody: {
      valueInputOption: "USER_ENTERED",
      data: [
        {
          range: `${sheetName}!N${sheetRow}`,
          values: [[chessRating]],
        },
      ],
    },
  });
  console.log(`[Sheet] Edited ${email} in "${sheetName}" row ${sheetRow}.`);
  return { status: "ok", row };
}

export default async function name(bot) {
  const channel = await (
    await bot.guilds.fetch("1495402417192304711")
  ).channels.fetch(EVENTS.Chess.verificationChannelId);

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
    if (thread.name.startsWith("✅")) {
      if (thread.name.startsWith("✅")) {
        const pins = await thread.messages.fetchPins();
        const pinnedMsg = pins.items.find(
          (m) => m.message.author.id === bot.user.id,
        )?.message;

        if (!pinnedMsg) {
          console.log(
            "Could not find the bot's pinned message in this ticket.",
          );
        }

        const emailMatch = pinnedMsg.content.match(/\*\*Email:\*\* (.+)/);
        if (!emailMatch) {
          return interaction.editReply({
            content:
              "Could not parse email from the pinned message. Use `/setemail` to fix it.",
          });
        }
        const email = emailMatch[1].trim();

        const member = pinnedMsg.mentions.members?.first();
        const user = member?.user ?? { toString: () => "Unknown" };

        let chessRating = null;

        const ratingLine = pinnedMsg.content
          .split("\n")
          .find((l) => l.startsWith("**Chess.com Rating:**"));
        if (ratingLine) {
          chessRating = ratingLine.replace("**Chess.com Rating:**", "").trim();
          if (chessRating) {
            await addRating("Chess", email, chessRating);
            await new Promise((resolve) => setTimeout(resolve, 2000));
          } else
            console.log(
              "Rating line exists but cant find rating,",
              ratingLine,
              thread.name,
            );
        } else console.log("No chess rating found.", thread.name);
      }
    }
  }
}
