import cache, { ensureFresh, refreshNow, tabRange } from "./cache.js";
import { sheets, spreadsheetIdFor } from "./config.js";
import { EVENTS, enabledEvents } from "../config/events.js";
import type { EventKey } from "../config/events.js";
import type { EventColumns } from "../config/events.js";
import type {
  AppendData,
  AppendResult,
  ParticipantResult,
  VerifyMeta,
  VerifyResult,
} from "../types/sheet.js";
import { logger } from "../utils/logger.js";

export function colToLetter(zeroIndex: number): string {
  let n = zeroIndex + 1;
  let s = "";

  while (n > 0) {
    const rem = (n - 1) % 26;
    s = String.fromCharCode(65 + rem) + s;
    n = Math.floor((n - 1) / 26);
  }

  return s;
}

interface SheetView {
  headers: string[];
  /** Data rows only — sheet row 1 is the header, so data starts at row 2. */
  rows: string[][];
}

function sheetView(eventKey: EventKey): SheetView {
  const data = cache.get(eventKey) ?? [];

  return {
    headers: data[0] ?? [],
    rows: data.slice(1),
  };
}

function colIndex(headers: string[], name: string | undefined): number {
  if (!name) return -1;
  return headers.findIndex((h) => h?.trim() === name);
}

/**
 * A row counts as verified when the event declares a "Verified?" column and
 * that cell says TRUE. Events without such a column (direct-registration)
 * treat every row as a verified record.
 */
function isVerifiedRow(
  eventKey: EventKey,
  headers: string[],
  row: string[],
): boolean {
  const verifiedCol = colIndex(headers, EVENTS[eventKey].columns.verified);
  if (verifiedCol === -1) return true;
  return row[verifiedCol]?.trim().toUpperCase() === "TRUE";
}

interface RowMatch {
  row: string[];
  /** 1-based spreadsheet row number (header is row 1). */
  sheetRow: number;
}

function matchByEmail(
  rows: string[][],
  emailCol: number,
  email: string,
): RowMatch[] {
  const norm = email.trim().toLowerCase();
  const matches: RowMatch[] = [];

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (!row) continue;

    if (row[emailCol]?.trim().toLowerCase() === norm) {
      matches.push({ row, sheetRow: i + 2 });
      if (matches.length > 1) break;
    }
  }

  return matches;
}

/**
 * Looks up a registration by email. For direct-registration events the sheet
 * only holds already-verified teams, so this doubles as the uniqueness check.
 */
export function findParticipant(
  eventKey: EventKey,
  email: string,
): ParticipantResult {
  const { headers, rows } = sheetView(eventKey);
  if (rows.length === 0) return { status: "not_found", rows: [] };

  const emailCol = colIndex(headers, EVENTS[eventKey].columns.email);
  const col = emailCol === -1 ? 1 : emailCol;

  const norm = email.trim().toLowerCase();
  const matches: string[][] = [];

  for (const row of rows) {
    if (row[col]?.trim().toLowerCase() === norm) {
      matches.push(row);
      if (matches.length > 1) break;
    }
  }

  if (matches.length === 0) return { status: "not_found", rows: [] };
  if (matches.length === 1) return { status: "unique", rows: matches };
  return { status: "duplicate", rows: matches };
}

export interface AcrossAllResult {
  eventKey: EventKey;
  status: ParticipantResult["status"];
  rows: string[][];
}

/** Searches every enabled event's sheet. */
export function findAcrossAll(email: string): AcrossAllResult[] {
  const results: AcrossAllResult[] = [];

  for (const eventKey of enabledEvents()) {
    const participant = findParticipant(eventKey, email);

    results.push({
      eventKey,
      status: participant.status,
      rows: participant.rows,
    });
  }

  return results;
}

/** True when this email has already been verified for the event. */
export function isEmailVerified(eventKey: EventKey, email: string): boolean {
  const { headers, rows } = sheetView(eventKey);

  const emailCol = colIndex(headers, EVENTS[eventKey].columns.email);
  if (emailCol === -1) return false;

  const norm = email.trim().toLowerCase();

  return rows.some(
    (row) =>
      row[emailCol]?.trim().toLowerCase() === norm &&
      isVerifiedRow(eventKey, headers, row),
  );
}

/** True when this Discord account has already been verified for the event. */
export function isDiscordVerified(
  eventKey: EventKey,
  discordId: string,
): boolean {
  const { headers, rows } = sheetView(eventKey);

  const discordCol = colIndex(headers, EVENTS[eventKey].columns.discordId);
  if (discordCol === -1) return false;

  return rows.some(
    (row) =>
      row[discordCol]?.trim() === discordId &&
      isVerifiedRow(eventKey, headers, row),
  );
}

/** Number of verified registrations for the event. */
export function countVerified(eventKey: EventKey): number {
  const { headers, rows } = sheetView(eventKey);

  return rows.filter((row) => isVerifiedRow(eventKey, headers, row)).length;
}

/**
 * Human-readable summary of a sheet row, used by /lookup.
 */
export function describeRow(eventKey: EventKey, row: string[]): string {
  const cfg = EVENTS[eventKey];
  const { headers } = sheetView(eventKey);

  if (cfg.mode === "direct-registration") {
    const parts: string[] = [];

    const push = (header: string | undefined, label: string): void => {
      if (!header) return;
      const index = colIndex(headers, header);
      if (index === -1) return;
      const value = row[index];
      if (!value) return;
      parts.push(`${label}: ${value}`);
    };

    push(cfg.columns.teamName, "Team");
    push(cfg.columns.email, "Email");
    push(cfg.columns.phone, "Phone");

    return parts.join(" | ") || "No details";
  }

  return cfg.isTeamEvent
    ? `Team: ${row[3] || "N/A"} | Captain: ${row[4] || "N/A"} | DOB: ${row[6] || "N/A"}`
    : `Name: ${row[3] || "N/A"} | DOB: ${row[5] || "N/A"}`;
}

/**
 * Builds the row appended to a direct-registration event's sheet.
 *
 * The values follow the event's column map, in declaration order, so the
 * sheet layout always matches the configuration.
 */
export function buildAppendRow(
  eventKey: EventKey,
  data: AppendData,
): string[] {
  const cfg = EVENTS[eventKey];

  return (Object.keys(cfg.columns) as (keyof EventColumns)[]).map((key) => {
    switch (key) {
      case "teamName":
        return data.teamName ?? "";
      case "email":
        return data.email;
      case "phone":
        return data.phone ?? "";
      case "discordId":
        return data.discordId;
      case "timestamp":
        return new Date().toISOString();
      case "threadLink":
        return data.threadLink ?? "";
      default:
        return "";
    }
  });
}

/**
 * Appends a verified team to a direct-registration event's sheet.
 *
 * The row is built from the event's column map, in declaration order, so the
 * sheet layout always matches the configuration.
 */
export async function appendParticipant(
  eventKey: EventKey,
  data: AppendData,
): Promise<AppendResult> {
  await ensureFresh();

  const cfg = EVENTS[eventKey];
  const spreadsheetId = spreadsheetIdFor(eventKey);

  const { headers } = sheetView(eventKey);

  if (colIndex(headers, cfg.columns.email) === -1) {
    logger.warn(
      `[Sheet] Missing "${cfg.columns.email}" column in "${cfg.sheetName}". Headers: ${headers.join(", ")}`,
    );
    return { status: "missing_columns" };
  }

  const values = buildAppendRow(eventKey, data);

  await sheets.spreadsheets.values.append({
    spreadsheetId,
    range: tabRange(cfg.sheetName, `A:${colToLetter(values.length - 1)}`),
    valueInputOption: "USER_ENTERED",
    insertDataOption: "INSERT_ROWS",
    requestBody: { values: [values] },
  });

  // Make the new row visible to the duplicate checks right away.
  await refreshNow();

  logger.info(`[Sheet] Appended ${data.email} to "${cfg.sheetName}".`);

  return { status: "ok" };
}

/**
 * Removes a team's row from a direct-registration event's sheet.
 *
 * Only meaningful for direct-registration events, where the sheet holds
 * verified teams and nothing else. In the sheet-lookup flow a row is the
 * pre-existing registration, and deleting it would destroy a registration
 * that has nothing to do with the outcome of this ticket.
 */
export async function removeParticipant(
  eventKey: EventKey,
  email: string,
): Promise<{ status: "removed" | "not_found"; removed: number }> {
  const cfg = EVENTS[eventKey];

  if (cfg.mode !== "direct-registration") {
    return { status: "not_found", removed: 0 };
  }

  await ensureFresh();

  const spreadsheetId = spreadsheetIdFor(eventKey);
  const { headers, rows } = sheetView(eventKey);

  const emailCol = colIndex(headers, cfg.columns.email);
  if (emailCol === -1) return { status: "not_found", removed: 0 };

  const norm = email.trim().toLowerCase();

  // Grid indices are 0-based and include the header row.
  const gridRows = rows
    .map((row, index) => ({ row, gridIndex: index + 1 }))
    .filter(({ row }) => row[emailCol]?.trim().toLowerCase() === norm)
    .map(({ gridIndex }) => gridIndex);

  if (!gridRows.length) return { status: "not_found", removed: 0 };

  const meta = await sheets.spreadsheets.get({ spreadsheetId });
  const sheet = meta.data.sheets?.find(
    (s) => s.properties?.title === cfg.sheetName,
  );
  const sheetId = sheet?.properties?.sheetId;

  if (typeof sheetId !== "number") {
    logger.warn(
      `[Sheet] Could not find the sheet id for "${cfg.sheetName}".`,
    );
    return { status: "not_found", removed: 0 };
  }

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: {
      // Delete from the bottom up, so the remaining indices stay valid.
      requests: gridRows
        .sort((a, b) => b - a)
        .map((gridIndex) => ({
          deleteDimension: {
            range: {
              sheetId,
              dimension: "ROWS",
              startIndex: gridIndex,
              endIndex: gridIndex + 1,
            },
          },
        })),
    },
  });

  await refreshNow();

  logger.info(
    `[Sheet] Removed ${gridRows.length} row(s) for ${email} from "${cfg.sheetName}".`,
  );

  return { status: "removed", removed: gridRows.length };
}

/**
 * Marks an existing registration row as verified (the original flow, where
 * the team was already in the sheet before the ticket was opened).
 */
export async function verifyParticipant(
  eventKey: EventKey,
  email: string,
  { staffName, discordId, threadLink }: VerifyMeta,
): Promise<VerifyResult> {
  await ensureFresh();

  const cfg = EVENTS[eventKey];
  const { headers, rows } = sheetView(eventKey);

  if (rows.length === 0) return { status: "not_found" };

  const emailCol = colIndex(headers, cfg.columns.email);
  const verifiedCol = colIndex(headers, cfg.columns.verified);
  const verifiedByCol = colIndex(headers, cfg.columns.verifiedBy);
  const discordFinal = colIndex(headers, cfg.columns.discordId);
  const threadLinkCol = colIndex(headers, cfg.columns.threadLink);

  if (
    [emailCol, verifiedCol, verifiedByCol, discordFinal, threadLinkCol].includes(
      -1,
    )
  ) {
    logger.warn(
      `[Sheet] Missing columns in "${cfg.sheetName}". Headers: ${headers.join(", ")}`,
    );
    return { status: "missing_columns" };
  }

  const matches = matchByEmail(rows, emailCol, email);

  if (matches.length === 0) return { status: "not_found" };
  if (matches.length > 1) return { status: "duplicate" };

  const match = matches[0];
  if (!match) return { status: "not_found" };

  const { row, sheetRow } = match;

  if (row[verifiedCol]?.trim().toUpperCase() === "TRUE") {
    return { status: "already_verified", row };
  }

  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId: spreadsheetIdFor(eventKey),
    requestBody: {
      valueInputOption: "USER_ENTERED",
      data: [
        {
          range: `${tabRange(cfg.sheetName, `${colToLetter(verifiedCol)}${sheetRow}`)}`,
          values: [["TRUE"]],
        },
        {
          range: `${tabRange(cfg.sheetName, `${colToLetter(verifiedByCol)}${sheetRow}`)}`,
          values: [[staffName]],
        },
        {
          range: `${tabRange(cfg.sheetName, `${colToLetter(discordFinal)}${sheetRow}`)}`,
          values: [[discordId]],
        },
        {
          range: `${tabRange(cfg.sheetName, `${colToLetter(threadLinkCol)}${sheetRow}`)}`,
          values: [[threadLink]],
        },
      ],
    },
  });

  logger.info(
    `[Sheet] Verified ${email} in "${cfg.sheetName}" row ${sheetRow}.`,
  );

  return { status: "ok", row };
}
