/**
 * The slot area's entry points.
 *
 * Two things are exported:
 *
 *  - `registerSlotsInteractions()` wires the custom ids into the core
 *    router. The manager calls it.
 *  - `registerSlotsListeners(client)` remembers the client the area
 *    runs with. The manager's registry calls it.
 *
 * Neither touches a file another area owns.
 */

import type { Client } from "discord.js";
import { MessageFlags } from "discord.js";
import { registerButton, registerModal, registerSelect } from "../../core/router.js";
import { logger } from "../../utils/logger.js";
import { setSlotsClient } from "./client.js";
import { parseSlotsId, payloadOf } from "./ids.js";
import { handlePublicButton } from "./views/public.js";
import { handleSlotListButton } from "./views/slotlist.js";
import { handleManagerButton } from "./views/manager.js";
import { handleSlotModal } from "./views/modals.js";
import {
  handleAddTeamPick,
  handleChangeTeamPick,
  handleInfoPick,
  handlePunishModePick,
  handlePunishSlotsPick,
  handleRemoveTeamPick,
} from "./views/slotlist.js";
import { handleClaimPick } from "./views/public.js";
import { handlePick, registerPickHandler } from "./views/pick.js";

/**
 * Registers the slot area's listeners.
 *
 * The slot area listens for nothing: the claim, the cancel, the
 * reminder and the ID-Pass transfer are all component interactions, and
 * the messages they send are replies to those.
 *
 * What it does need is the **client**, because the published slot list
 * is a message and the area's public API — the one the scrims area
 * calls — publishes and refreshes it. The client is remembered here,
 * once, instead of being threaded through every call site.
 */
export function registerSlotsListeners(client: Client): void {
  setSlotsClient(client);

  logger.info("[Slots] Registered.");
}

/**
 * The name the brief used.
 *
 * The manager's registry looks for `registerSlotsListeners`.
 */
export const registerSlots = registerSlotsListeners;

/**
 * Registers the slot area's custom ids.
 *
 * Every id starts with `slots:`, so one prefix owns them all and the
 * router never has to guess. The action names the behaviour and the
 * payload names the record (D18).
 */
export function registerSlotsInteractions(): void {
  registerButton("slots", async (interaction, payload) => {
    const id = parseSlotsId(payload === null ? "slots:" : `slots:${payload}`);

    if (!id) {
      await interaction.reply({
        content: "That button is no longer active. Please run the command again.",
        flags: MessageFlags.Ephemeral,
      });

      return;
    }

    const record = payloadOf(id);

    if (
      id.action === "claim" ||
      id.action === "cancel" ||
      id.action === "remind" ||
      id.action === "idp"
    ) {
      await handlePublicButton(interaction, id.action, record);
      return;
    }

    if (
      id.action === "slotlist_edit" ||
      id.action === "slotlist_punish" ||
      id.action === "slotlist_info" ||
      id.action === "slotlist_add" ||
      id.action === "slotlist_remove" ||
      id.action === "slotlist_change"
    ) {
      await handleSlotListButton(interaction, id.action, record);
      return;
    }

    if (id.action.startsWith("manager_")) {
      await handleManagerButton(interaction, id.action, record);
      return;
    }

    await interaction.reply({
      content: "That button is no longer active. Please run the command again.",
      flags: MessageFlags.Ephemeral,
    });
  });

  registerSelect("slots", async (interaction, payload) => {
    const id = parseSlotsId(payload === null ? "slots:" : `slots:${payload}`);

    if (!id || id.action !== "pick") {
      await interaction.reply({
        content: "That menu is no longer active. Please run the command again.",
        flags: MessageFlags.Ephemeral,
      });

      return;
    }

    const token = payloadOf(id);

    if (!token) {
      await interaction.reply({
        content: "That menu is no longer active. Please run the command again.",
        flags: MessageFlags.Ephemeral,
      });

      return;
    }

    await handlePick(interaction, token);
  });

  registerModal("slots", async (interaction, payload) => {
    const id = parseSlotsId(payload === null ? "slots:" : `slots:${payload}`);

    if (!id) {
      await interaction.editReply({
        content: "That form is no longer active. Please run the command again.",
      });

      return;
    }

    await handleSlotModal(interaction, id.action, payloadOf(id));
  });

  registerPickHandler("claim", handleClaimPick);
  registerPickHandler("add_team", handleAddTeamPick);
  registerPickHandler("change_team", handleChangeTeamPick);
  registerPickHandler("remove_team", handleRemoveTeamPick);
  registerPickHandler("info", handleInfoPick);
  registerPickHandler("punish_slots", handlePunishSlotsPick);
  registerPickHandler("punish_mode", handlePunishModePick);
}

export { handleSlotModal, handlePublicButton, handleSlotListButton };
export { handleManagerButton } from "./views/manager.js";
export { dispatchReminders } from "./views/public.js";
export { refreshPublicMessage } from "./views/panel.js";
export { stopSlotTokens } from "./views/pick.js";

/**
 * The job handler the scheduler calls.
 *
 * The manager's registry looks for `handleSlotsJob(client, event,
 * payload)`; the scheduler is manager-owned and this is the half that
 * belongs to the slot area. Today the area handles one event —
 * `scrim_ban`, the ban whose time is up.
 */
export { handleSlotsJob } from "./jobs.js";

/**
 * The published slot list's public API.
 *
 * The scrims area calls these when the scrim lifecycle says a slot list
 * has to be published or re-rendered. See `modules/slots/slotlist.ts`.
 */
export {
  buildSlotListEmbed,
  buildSlotListPanel,
  publishSlotList,
  refreshSlotListMessage,
} from "./slotlist.js";
