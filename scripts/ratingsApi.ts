// Fetch chess.com ratings for every registered player and write them back
// into the Chess sheet.

import { refreshEvent } from "../repo/cache.js";
import cache from "../repo/cache.js";
import { sheets, spreadsheetIdFor } from "../repo/config.js";
import type { SheetRows } from "../repo/cache.js";
import type { EventKey } from "../config/events.js";

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

async function getChessRating(
  username: string,
  alreadyFilled: boolean,
): Promise<number | null | undefined> {
  try {
    const res = await fetch(
      `https://api.chess.com/pub/player/${encodeURIComponent(username)}/stats`,
    );

    const data = (await res.json()) as {
      code?: number;
      chess_rapid?: { last?: { rating?: number } };
      chess_blitz?: { last?: { rating?: number } };
      chess_bullet?: { last?: { rating?: number } };
      chess_daily?: { last?: { rating?: number } };
    };

    // api fail case
    if (data.code === 0) return null;

    const rapid = data.chess_rapid?.last?.rating ?? null;
    const blitz = data.chess_blitz?.last?.rating ?? null;
    const bullet = data.chess_bullet?.last?.rating ?? null;
    const daily = data.chess_daily?.last?.rating ?? null;

    // if rating already exists: only update if rapid exists
    if (alreadyFilled) {
      return rapid ?? undefined; // undefined = skip update
    }

    // if empty: prefer rapid, else any other, else 0
    return rapid ?? blitz ?? daily ?? bullet ?? 0;
  } catch (err) {
    console.log(`Chess API error: ${username}`, err);
    return null;
  }
}

export default async function updateChessRatings(): Promise<void> {
  const eventKey: EventKey = "Chess";

  await refreshEvent(eventKey);

  const rows: SheetRows = cache.get(eventKey) ?? [];

  if (!rows.length) {
    console.log("No rows found");
    return;
  }

  const headers = rows[0] ?? [];
  const col = (name: string): number =>
    headers.findIndex((h) => h?.trim() === name);

  const chessIdCol = col("Chess.com ID");
  const ratingCol = col("Chess Rating");

  if ([chessIdCol, ratingCol].includes(-1)) {
    console.log("Missing required columns");
    return;
  }

  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    if (!row) continue;

    const sheetRow = i + 1;

    const username = row[chessIdCol]?.trim();
    const existingRating = row[ratingCol]?.toString().trim();

    if (!username) continue;

    const newRating = await getChessRating(username, Boolean(existingRating));

    // null = api fail/code 0 → skip
    if (newRating === null) {
      console.log(`Skip ${username} (invalid/api fail)`);
      continue;
    }

    // undefined = already had rating, but no rapid found → skip
    if (newRating === undefined) {
      console.log(`Skip ${username} (no rapid, already filled)`);
      continue;
    }

    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: spreadsheetIdFor(eventKey),
      requestBody: {
        valueInputOption: "USER_ENTERED",
        data: [
          {
            range: `Chess!${colToLetter(ratingCol)}${sheetRow}`,
            values: [[newRating]],
          },
        ],
      },
    });

    console.log(`${username} → ${newRating}`);

    await new Promise((resolve) => setTimeout(resolve, 1200));
  }
}
