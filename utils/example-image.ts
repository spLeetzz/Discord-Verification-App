import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { extname, resolve } from "node:path";
import { EVENTS } from "../config/events.js";
import type { EventKey } from "../config/events.js";
import { errorMessage } from "./errors.js";
import { logger } from "./logger.js";
import { PROJECT_ROOT } from "./paths.js";

/** Downloaded images live here. Git-ignored. */
const CACHE_DIR = resolve(PROJECT_ROOT, ".cache");

/**
 * Resolves the example image for an event, downloading it once if needed.
 *
 * Discord signs its CDN links with an expiry, so linking to one directly
 * means the image breaks a day later. Downloading the bytes once and keeping
 * them on disk means the example keeps working, without putting a binary in
 * the repository.
 *
 * Returns null when there is no example image, or when it can neither be
 * found in the cache nor downloaded.
 */
export async function fetchExampleImage(
  eventKey: EventKey,
): Promise<string | null> {
  const cfg = EVENTS[eventKey];
  const url = cfg.requestExampleUrl;

  if (!url) return null;

  let extension = ".jpg";

  try {
    extension = extname(new URL(url).pathname) || extension;
  } catch {
    // keep the default
  }

  const cached = resolve(CACHE_DIR, `${eventKey}-example${extension}`);

  if (existsSync(cached)) return cached;

  try {
    const res = await fetch(url);

    if (!res.ok) {
      throw new Error(`HTTP ${res.status} ${res.statusText}`);
    }

    const bytes = Buffer.from(await res.arrayBuffer());

    mkdirSync(CACHE_DIR, { recursive: true });
    writeFileSync(cached, bytes);

    logger.info(
      `[Example] Downloaded the example image for ${eventKey} (${bytes.length} bytes).`,
    );

    return cached;
  } catch (err) {
    logger.warn(
      `[Example] Could not download the example image for ${eventKey}: ${errorMessage(err)}`,
    );
    return null;
  }
}
