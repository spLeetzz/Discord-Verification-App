import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { EVENTS } from "../config/events.js";
import { buildVerificationEmbed, buildVerificationButtonRow } from "../utils/embeds.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const IDS_PATH = path.join(__dirname, "../config/messageIds.json");

function loadIds() {
  try {
    return JSON.parse(readFileSync(IDS_PATH, "utf-8"));
  } catch {
    return {};
  }
}

function saveIds(ids) {
  writeFileSync(IDS_PATH, JSON.stringify(ids, null, 2));
}

import { logger } from "../utils/logger.js";

export async function restoreVerificationEmbeds(client) {
  const ids = loadIds();

  for (const [eventKey, cfg] of Object.entries(EVENTS)) {
    if (!cfg.verificationChannelId) {
      logger.warn(`[Startup] No channel ID set for ${eventKey} — skipping.`);
      continue;
    }

    const channel = await client.channels
      .fetch(cfg.verificationChannelId)
      .catch(() => null);
    if (!channel) {
      logger.warn(`[Startup] Could not fetch channel for ${eventKey}.`);
      continue;
    }

    const embed = buildVerificationEmbed(eventKey);
    const row = buildVerificationButtonRow(eventKey);
    const payload = { embeds: [embed], components: [row] };

    try {
      if (ids[eventKey]) {
        const msg = await channel.messages.fetch(ids[eventKey]);
        await msg.edit(payload);
        logger.info(`[Startup] Re-attached view for ${eventKey}.`);
      } else {
        throw new Error("No stored ID");
      }
    } catch {
      // Message gone or never created — send fresh
      const msg = await channel.send(payload);
      ids[eventKey] = msg.id;
      saveIds(ids);
      logger.info(`[Startup] Sent fresh embed for ${eventKey}.`);
    }
  }
}
