/**
 * The Sheets client.
 *
 * **Why not `import { google } from "googleapis"`.** The barrel of that
 * package re-exports every Google API, and its type declarations come to
 * 160 MB across 910 files. `skipLibCheck` stops TypeScript *checking*
 * those, but it still parses and binds them, and the build was using
 * 1.9 GB of heap to do it — on a 2 GB box, that is the whole build's
 * memory budget spent on a package we use one API of.
 *
 * These two imports are the same objects the barrel hands out, and the
 * client is the same class with the same prototype: `google.auth.GoogleAuth`
 * *is* `googleapis-common`'s `GoogleAuth`, and `google.sheets(...)` builds
 * a `sheets_v4.Sheets`. Importing them directly loads 300 KB of types
 * instead of 160 MB, and never loads the 35 MB of barrel JavaScript at
 * runtime either.
 *
 * The deep path into `googleapis` is pinned by the lockfile, so it cannot
 * move under us without a lockfile change.
 */
import { GoogleAuth } from "googleapis-common";
import { sheets_v4 } from "googleapis/build/src/apis/sheets/v4.js";
import { EVENTS } from "../config/events.js";
import type { EventKey } from "../config/events.js";

const auth = new GoogleAuth({
  keyFile:
    process.env.GOOGLE_KEY_PATH ??
    process.env.GOOGLE_APPLICATION_CREDENTIALS,
  scopes: ["https://www.googleapis.com/auth/spreadsheets"],
});

const sheets = new sheets_v4.Sheets({ auth });

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
