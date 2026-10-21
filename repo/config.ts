import { google } from "googleapis";
import { EVENTS } from "../config/events.js";
import type { EventKey } from "../config/events.js";

const auth = new google.auth.GoogleAuth({
  keyFile:
    process.env.GOOGLE_KEY_PATH ??
    process.env.GOOGLE_APPLICATION_CREDENTIALS,
  scopes: ["https://www.googleapis.com/auth/spreadsheets"],
});

const sheets = google.sheets({ version: "v4", auth });

/**
 * The spreadsheet an event's tab lives in. Events without an explicit
 * spreadsheet fall back to the shared SPREADSHEET_ID.
 */
export function spreadsheetIdFor(eventKey: EventKey): string {
  const id = EVENTS[eventKey].spreadsheetId ?? process.env.SPREADSHEET_ID ?? "";

  if (!id) {
    throw new Error(
      `No spreadsheet ID configured for event "${eventKey}". Set SPREADSHEET_ID or the event's own spreadsheetId.`,
    );
  }

  return id;
}

export { sheets };
