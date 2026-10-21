import { readFileSync, writeFileSync } from "node:fs";
import { TextChannel } from "discord.js";
import type { Client } from "discord.js";
import { EVENTS, enabledEvents } from "../config/events.js";
import { buildVerificationButtonRow, buildVerificationEmbed } from "../utils/embeds.js";
import { logger } from "../utils/logger.js";
import { MESSAGE_IDS_PATH } from "../utils/paths.js";

type MessageIds = Record<string, string>;

function loadIds(): MessageIds {
  try {
    return JSON.parse(readFileSync(MESSAGE_IDS_PATH, "utf-8")) as MessageIds;
  } catch {
    return {};
  }
}

function saveIds(ids: MessageIds): void {
  writeFileSync(MESSAGE_IDS_PATH, JSON.stringify(ids, null, 2));
}

export async function restoreVerificationEmbeds(client: Client): Promise<void> {
  const ids = loadIds();

  for (const eventKey of enabledEvents()) {
    const cfg = EVENTS[eventKey];

    if (!cfg.verificationChannelId) {
      logger.warn(`[Startup] No channel ID set for ${eventKey} — skipping.`);
      continue;
    }

    const channel = await client.channels
      .fetch(cfg.verificationChannelId)
      .catch(() => null);

    if (!(channel instanceof TextChannel)) {
      logger.warn(`[Startup] Could not fetch channel for ${eventKey}.`);
      continue;
    }

    const embed = buildVerificationEmbed(eventKey);
    const row = buildVerificationButtonRow(eventKey);
    const payload = { embeds: [embed], components: [row] };

    try {
      const storedId = ids[eventKey];
      if (!storedId) throw new Error("No stored ID");

      const msg = await channel.messages.fetch(storedId);
      await msg.edit(payload);
      logger.info(`[Startup] Re-attached view for ${eventKey}.`);
    } catch {
      // Message gone or never created — send fresh
      const msg = await channel.send(payload);
      ids[eventKey] = msg.id;
      saveIds(ids);
      logger.info(`[Startup] Sent fresh embed for ${eventKey}.`);
    }
  }
}
