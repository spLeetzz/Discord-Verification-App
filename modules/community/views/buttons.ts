/**
 * The area's own button helper.
 *
 * `core/ui.ts` has the button styles — primary, secondary, success and
 * danger — and none of them is the **link** style, because a link button
 * is the one button that cannot carry a custom id: it is a link, not a
 * command, so it is not the router's business.
 *
 * The reminder's "jump to the original message" button is a link, so the
 * helper lives here until the core grows one. Everything else in the
 * area is a slash command, so this is the area's only button.
 */

import { ButtonBuilder, ButtonStyle } from "discord.js";
import { label } from "../../../core/ui.js";

/** How a link button is shaped. */
export interface LinkButtonOptions {
  /** The label on the button. */
  readonly label: string;
  /** Where the button goes. */
  readonly url: string;
}

/**
 * A link button.
 *
 * Discord draws a link button in grey, which is the colour the design
 * language gives to everything that is neither a creation nor a
 * destruction — a link only takes the reader somewhere.
 */
export function linkButton(options: LinkButtonOptions): ButtonBuilder {
  return new ButtonBuilder()
    .setLabel(label(options.label).slice(0, 80))
    .setURL(options.url)
    .setStyle(ButtonStyle.Link);
}
