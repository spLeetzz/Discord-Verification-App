/**
 * The media-partner panel.
 *
 * **This is the only feature in the port that crosses guild
 * boundaries.** A media partner is a channel in *another* guild: when
 * somebody registers in that channel, the registration is checked against
 * the partner tournament and then accepted into this guild's tournament.
 *
 * The target bot ignores interactions from other guilds, but this path is
 * **message-driven**: the bot is a member of both guilds, it receives
 * the message, and it decides what to do with it. The cross-guild check
 * is therefore explicit and deliberate — see
 * {@link isForeignPartnerChannel}.
 *
 * The source's checks, all of which are reproduced:
 *
 *  1. the partner tournament is in a **different** guild ("You can't
 *     partner with a tournament running in your server.");
 *  2. the channel is **not already** a partner channel;
 *  3. the author **is a member** of the partner guild ("You are not even
 *     in the server you are trying to media partner with.").
 */

import {
  actionRow,
  assertComponentBudget,
  dangerButton,
  panelEmbed,
  secondaryButton,
  successButton,
} from "../../../core/ui.js";
import type { MediaPartnerRecord, TourneyRecord } from "../types.js";
import { tourneysId } from "./ids.js";
import type { Panel, PanelComponents } from "./handlers.js";

/** The media-partner panel. */
export function buildPartnerPanel(options: {
  readonly tourney: TourneyRecord;
  readonly partners: readonly (MediaPartnerRecord & {
    readonly playerCount: number;
  })[];
}): Panel {
  const { tourney, partners } = options;

  const embed = panelEmbed({
    title: `Media partners — ${tourney.name}`,
    description:
      "A media partner is a channel in another server. The registrations made there are accepted into this tournament.",
    fields: partners.map((partner, index) => ({
      name: `Partner ${String(index + 1).padStart(2, "0")}`,
      value: `<#${partner.channelId}> — **${partner.playerCount}** players`,
      inline: true,
    })),
    footer:
      partners.length === 0
        ? "Add a partner to take registrations from another server."
        : "Add a partner, or remove one that is no longer needed.",
  });

  const rows: PanelComponents = [];

  // The first row holds the one thing to do next: adding a partner
  // creates one, so it is green.
  rows.push(
    actionRow(
      successButton({
        customId: tourneysId("partner_add", tourney.id),
        label: "Add partner",
      }),
    ),
  );

  rows.push(
    actionRow(
      dangerButton({
        customId: tourneysId("partner_remove", tourney.id),
        label: "Remove partner",
        disabled: partners.length === 0,
      }),
      secondaryButton({
        customId: tourneysId("manager", tourney.id),
        label: "Back",
      }),
    ),
  );

  assertComponentBudget(rows);

  return { embeds: [embed], components: rows };
}

/**
 * May this channel be used as a media partner?
 *
 * **The cross-guild check, made explicit.**
 *
 * A media-partner channel has to live in a guild that is **not** this
 * tournament's guild. The source made the same check with
 * `if guild == self.ctx.guild: error(...)`, and it is repeated here
 * because it is the one rule that keeps this feature from being a
 * cross-guild write.
 *
 * @param guildId      the guild the tournament belongs to;
 * @param channelGuildId the guild the channel belongs to.
 */
export function isForeignPartnerChannel(
  guildId: string,
  channelGuildId: string | null,
): boolean {
  if (!channelGuildId) return false;

  return channelGuildId !== guildId;
}
