import cache, { ensureFresh } from "./cache.js";
import { sheets, spreadsheetId } from "./config.js";
import { EVENTS } from "../config/events.js";
import { logger } from "../utils/logger.js";

function colToLetter(zeroIndex) {
  let n = zeroIndex + 1,
    s = "";
  while (n > 0) {
    const rem = (n - 1) % 26;
    s = String.fromCharCode(65 + rem) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

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

export function findParticipant(sheetName, email) {
  const data = cache.get(sheetName) ?? [];
  if (data.length === 0) return { status: "not_found", rows: [] };

  const headers = data[0];
  const emailCol = headers.findIndex((h) => h?.trim() === "Email Address");
  const colIndex = emailCol === -1 ? 1 : emailCol;

  const norm = email.trim().toLowerCase();
  const matches = [];
  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    if (row[colIndex]?.trim().toLowerCase() === norm) {
      matches.push(row);
      if (matches.length > 1) break;
    }
  }

  if (matches.length === 0) return { status: "not_found", rows: [] };
  if (matches.length === 1) return { status: "unique", rows: matches };
  return { status: "duplicate", rows: matches };
}



export function findAcrossAll(email) {
  const results = [];
  for (const eventKey in EVENTS) {
    const cfg = EVENTS[eventKey];
    const participant = findParticipant(cfg.sheetName, email);
    results.push({
      eventKey,
      status: participant.status,
      rows: participant.rows,
    });
  }
  return results;
}

export function getVerifiedEventForUser(discordId) {
  for (const eventKey in EVENTS) {
    const cfg = EVENTS[eventKey];
    const rows = cache.get(cfg.sheetName) ?? [];
    if (rows.length === 0) continue;

    const headers = rows[0];
    const discordCol = headers.findIndex((h) => h?.trim() === "Discord ID Final");
    const verifiedCol = headers.findIndex((h) => h?.trim() === "Verified?");
    if (discordCol === -1 || verifiedCol === -1) continue;

    for (let i = 1; i < rows.length; i++) {
      const row = rows[i];
      if (
        row[discordCol]?.trim() === discordId &&
        row[verifiedCol]?.trim().toUpperCase() === "TRUE"
      ) {
        return cfg.displayName;
      }
    }
  }
  return null;
}

export async function verifyParticipant(
  sheetName,
  email,
  { staffName, discordId, threadLink },
) {
  await ensureFresh();
  const rows = cache.get(sheetName) ?? [];

  if (rows.length === 0) return { status: "not_found" };

  const headers = rows[0];

  const col = (name) => headers.findIndex((h) => h?.trim() === name);

  const emailCol = col("Email Address");
  const verifiedCol = col("Verified?");
  const verifiedByCol = col("Verified by");
  const discordFinal = col("Discord ID Final");
  const threadLinkCol = col("Thread Link");

  if (
    [
      emailCol,
      verifiedCol,
      verifiedByCol,
      discordFinal,
      threadLinkCol,
    ].includes(-1)
  ) {
    logger.warn(
      `[Sheet] Missing columns in "${sheetName}". Headers: ${headers.join(", ")}`,
    );
    return { status: "missing_columns" };
  }

  const matches = matchByEmail(rows, emailCol, email);

  if (matches.length === 0) return { status: "not_found" };
  if (matches.length > 1) return { status: "duplicate" };

  const { row, sheetRow } = matches[0];


  if (row[verifiedCol]?.trim().toUpperCase() === "TRUE") {
    return { status: "already_verified", row };
  }

  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId,
    requestBody: {
      valueInputOption: "USER_ENTERED",
      data: [
        {
          range: `${sheetName}!${colToLetter(verifiedCol)}${sheetRow}`,
          values: [["TRUE"]],
        },
        {
          range: `${sheetName}!${colToLetter(verifiedByCol)}${sheetRow}`,
          values: [[staffName]],
        },
        {
          range: `${sheetName}!${colToLetter(discordFinal)}${sheetRow}`,
          values: [[discordId]],
        },
        {
          range: `${sheetName}!${colToLetter(threadLinkCol)}${sheetRow}`,
          values: [[threadLink]],
        },
      ],
    },
  });

  logger.info(`[Sheet] Verified ${email} in "${sheetName}" row ${sheetRow}.`);
  return { status: "ok", row };
}

