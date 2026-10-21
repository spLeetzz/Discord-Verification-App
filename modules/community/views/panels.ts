/**
 * The area's empty states.
 *
 * An empty state is the first thing a new user sees, so it says what to
 * do rather than only reporting the absence. `core/ui.ts`'s `emptyPanel`
 * is the shape: a title, a short description, and a footer with the hint
 * about what to do next.
 *
 * A panel that shows a **list** renders its empty state here. A refusal
 * — "that channel is not an auto-purge channel" — is not an empty
 * state, and stays a refusal.
 */

import { emptyPanel } from "../../../core/ui.js";
import type { Panel } from "../../../core/ui.js";
import type { ReplyPayload } from "../../../core/context.js";

/**
 * The panel of a tag list with nothing in it.
 *
 * @param description what is empty, in a sentence.
 * @param footer      the hint about what to do next.
 */
export function emptyTagListPanel(
  description: string,
  footer = "Create one with `/tag create`.",
): Panel {
  return emptyPanel({
    title: "No tags",
    description,
    footer,
  });
}

/**
 * The panel of a reminder list with nothing in it.
 */
export function emptyReminderListPanel(): Panel {
  return emptyPanel({
    title: "No reminders",
    description: "You have no running reminders.",
    footer: "Set one with `/reminder set`.",
  });
}

/**
 * The panel of the auto-purge list with nothing in it.
 */
export function emptyAutoPurgePanel(): Panel {
  return emptyPanel({
    title: "No auto-purge channels",
    description: "This server has no channels set up for auto-purge.",
    footer: "Set one up with `/autopurge set`.",
  });
}

/**
 * The panel of the auto-role configuration with nothing in it.
 */
export function emptyAutoRolePanel(): Panel {
  return emptyPanel({
    title: "No auto-roles",
    description: "This server has no auto-roles yet.",
    footer: "Add one with `/autorole humans` or `/autorole bots`.",
  });
}

/**
 * The panel of a channel with no deleted message to show.
 */
export function emptySnipePanel(): Panel {
  return emptyPanel({
    title: "Nothing to snipe",
    description: "No message has been deleted in this channel yet.",
    footer: "Try again after a message is deleted.",
  });
}

/**
 * Turns a panel into a reply payload.
 *
 * The panel holds its rows and its embed; a reply carries them as a
 * payload. The rows are only sent when there are any, so a panel with
 * no buttons does not answer with an empty row list.
 */
export function panelPayload(panel: Panel): ReplyPayload {
  return {
    embeds: [...panel.embeds],
    ...(panel.components.length > 0
      ? { components: [...panel.components] }
      : {}),
  };
}
