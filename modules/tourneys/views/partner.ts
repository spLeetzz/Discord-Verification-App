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

import { ButtonStyle, EmbedBuilder } from "discord.js";
import { EMBED_COLOR } from "../../../core/constants.js";
import type { MediaPartnerRecord, TourneyRecord } from "../types.js";
import {
  assertComponentBudget,
  button,
  buttonRow,
} from "./components.js";
import { tourneysId } from "./ids.js";
import type { Panel } from "./handlers.js";

/** The media-partner panel. */
export function buildPartnerPanel(options: {
  readonly tourney: TourneyRecord;
  readonly partners: readonly (MediaPartnerRecord & {
    readonly playerCount: number;
  })[];
}): Panel {
  const { tourney, partners } = options;

  const embed = new EmbedBuilder()
    .setTitle(`Media Partnership — ${tourney.name}`)
    .setColor(EMBED_COLOR)
    .setDescription(
      [
        "A media partner is a channel in **another server**. Registrations made there are checked against that server's tournament and then accepted into this one.",
        "",
        partners.length === 0
          ? "No partner channel yet."
          : partners
              .map(
                (partner, index) =>
                  `\`${String(index + 1).padStart(2, "0")}.\` <#${partner.channelId}> — **${partner.playerCount}** players`,
              )
              .join("\n"),
        "",
        "Click **Add New** to create a new media partner.",
      ].join("\n"),
    );

  const rows: Panel["components"] = [
    buttonRow(
      button({
        customId: tourneysId("partner_add", tourney.id),
        label: "Add New",
        style: ButtonStyle.Success,
      }),
      button({
        customId: tourneysId("partner_remove", tourney.id),
        label: "Remove",
        style: ButtonStyle.Danger,
        disabled: partners.length === 0,
      }),
      button({
        customId: tourneysId("manager", tourney.id),
        label: "Main Menu",
        style: ButtonStyle.Secondary,
      }),
    ),
  ];

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
