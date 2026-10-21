import { EVENTS, enabledEvents } from "../config/events.js";
import type { EventKey } from "../config/events.js";
import { sheets, spreadsheetIdFor } from "./config.js";
import { logger } from "../utils/logger.js";

/** A sheet tab as rows of cell strings. Row 0 holds the headers. */
export type SheetRows = string[][];

/** Cached per event key, not per tab name. */
const cache = new Map<EventKey, SheetRows>();
let lastFetched = 0;

/**
 * A1 notation needs quotes around tab names that contain spaces, e.g.
 * 'Free Fire'!A1. A single quote inside the name is escaped by doubling.
 */
export function quoteTab(name: string): string {
  if (/^[A-Za-z0-9_]+$/.test(name)) return name;
  return `'${name.replace(/'/g, "''")}'`;
}

export function tabRange(tabName: string, range = "A:ZZ"): string {
  return `${quoteTab(tabName)}!${range}`;
}

async function fetchAllSheets(): Promise<void> {
  // Events can live in different spreadsheets, so group them and issue one
  // batched read per spreadsheet.
  const groups = new Map<string, EventKey[]>();

  for (const eventKey of enabledEvents()) {
    const spreadsheetId = spreadsheetIdFor(eventKey);
    const group = groups.get(spreadsheetId) ?? [];
    group.push(eventKey);
    groups.set(spreadsheetId, group);
  }

  for (const [spreadsheetId, eventKeys] of groups) {
    try {
      const res = await sheets.spreadsheets.values.batchGet({
        spreadsheetId,
        ranges: eventKeys.map((key) => tabRange(EVENTS[key].sheetName)),
      });

      (res.data.valueRanges ?? []).forEach((valueRange, i) => {
        const eventKey = eventKeys[i];
        if (!eventKey) return;
        cache.set(eventKey, (valueRange.values ?? []) as SheetRows);
      });

      logger.debug(
        `[Cache] Refreshed ${eventKeys.length} tab(s): ${eventKeys.join(", ")}`,
      );
    } catch (err) {
      logger.error(
        `[Cache] Failed to refresh ${eventKeys.join(", ")}, serving stale data:`,
        err,
      );
    }
  }

  lastFetched = Date.now();
}

export async function ensureFresh(): Promise<void> {
  if (Date.now() - lastFetched < 15_000) {
    logger.debug("[Cache] Fresh, skipping fetch.");
    return;
  }

  await fetchAllSheets();
}

/** Forces a re-read, bypassing the staleness window. */
export async function refreshNow(): Promise<void> {
  await fetchAllSheets();
}

/**
 * Re-reads a single event's tab, even if that event is disabled. Used by the
 * one-off maintenance scripts, which work on events the bot no longer serves.
 */
export async function refreshEvent(eventKey: EventKey): Promise<void> {
  const cfg = EVENTS[eventKey];

  try {
    const res = await sheets.spreadsheets.values.batchGet({
      spreadsheetId: spreadsheetIdFor(eventKey),
      ranges: [tabRange(cfg.sheetName)],
    });

    const valueRange = res.data.valueRanges?.[0];
    cache.set(eventKey, (valueRange?.values ?? []) as SheetRows);
    lastFetched = Date.now();
  } catch (err) {
    logger.error(`[Cache] Failed to refresh ${eventKey}:`, err);
  }
}

/**
 * Populates the cache and keeps it fresh.
 *
 * Started explicitly by main.ts rather than on import, so that importing
 * this module (from deploy, or a script) never kicks off a network call.
 */
export async function startCache(): Promise<void> {
  await fetchAllSheets();

  if (cache.size) {
    logger.info(`[Cache] Initialized with ${cache.size} sheet(s).`);
  } else {
    logger.warn("[Cache] Empty, check sheet names or API access.");
  }

  const refreshTimer = setInterval(fetchAllSheets, 60_000);
  // Don't keep the process alive just for the timer — scripts that call
  // startCache() should be able to exit on their own.
  refreshTimer.unref();
}

export default cache;
