import { sheets, spreadsheetId } from "./config.js";
import { logger } from "../utils/logger.js";

const cache = new Map();
let lastFetched = 0;

const SHEET_NAMES = ["BGMI", "Chess", "EFM", "FC26", "STREET FIGHTER 6"];

async function fetchAllSheets() {
  try {
    const res = await sheets.spreadsheets.values.batchGet({
      spreadsheetId,
      ranges: SHEET_NAMES.map((name) => `${name}!A:ZZ`),
    });
    res.data.valueRanges.forEach((vr, i) => {
      cache.set(SHEET_NAMES[i], vr.values ?? []);
    });
    lastFetched = Date.now();
    logger.debug(`[Cache] Refreshed ${SHEET_NAMES.length} sheets.`);
  } catch (err) {
    logger.error("[Cache] Failed to refresh, serving stale data:", err);
  }
}

export async function ensureFresh() {
  if (Date.now() - lastFetched < 15_000) {
    logger.debug("[Cache] Fresh, skipping fetch.");
    return;
  }
  await fetchAllSheets();
}
async function startCache() {
  await fetchAllSheets();
  if (cache.size) {
    logger.info(`[Cache] Initialized with ${cache.size} sheets.`);
  } else {
    logger.warn("[Cache] Empty, check sheet names or API access.");
  }
  setInterval(fetchAllSheets, 60_000);
}

await startCache();
export default cache;
