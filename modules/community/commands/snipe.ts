/**
 * `/snipe` — the last deleted message of a channel.
 *
 * The source kept one row per channel and overwrote it on every delete,
 * which is what this does too.
 *
 * The NSFW rule is the source's and it is kept: a message that was
 * deleted in an NSFW channel is not shown in a channel that is not NSFW.
 */

import { SlashCommandBuilder } from "discord.js";
import { InputError } from "../../../core/errors.js";
import { canShowSnipe } from "../rules.js";
import * as service from "../service.js";
import { buildSnipeEmbed } from "../views/embeds.js";
import { emptySnipePanel, panelPayload } from "../views/panels.js";
import { respondSafe } from "../views/reply.js";
import { displayName, requireGuild, runCommand } from "./shared.js";
import type { CommunityCommand } from "./shared.js";

/**
 * Is the channel NSFW?
 */
function isNsfw(channel: unknown): boolean {
  if (typeof channel !== "object" || channel === null) return false;

  if (!("nsfw" in channel)) return false;

  const value = (channel as { nsfw?: unknown }).nsfw;

  return typeof value === "boolean" ? value : false;
}

const snipeCommand: CommunityCommand = {
  data: new SlashCommandBuilder()
    .setName("snipe")
    .setDescription("Show the last deleted message of a channel.")
    .addChannelOption((option) =>
      option
        .setName("channel")
        .setDescription("The channel to snipe. Defaults to this one."),
    ),

  async execute(interaction) {
    await runCommand(interaction, async () => {
      const guild = requireGuild(interaction);

      const option = interaction.options.getChannel("channel");

      const channelId = option?.id ?? interaction.channelId;

      if (!channelId) {
        throw new InputError("This command only works in a server channel.");
      }

      const snipe = await service.getSnipe(channelId);

      if (!snipe) {
        await respondSafe(
          interaction,
          panelPayload(emptySnipePanel()),
        );

        return;
      }

      // The check is on the channel the snipe is *shown* in, as it was in
      // the source: the message was deleted in an NSFW channel, so it is
      // not shown in one that is not.
      if (
        !canShowSnipe({
          snipeIsNsfw: snipe.nsfw,
          channelIsNsfw: isNsfw(interaction.channel),
        })
      ) {
        throw new InputError(
          "The snipe is marked NSFW but the current channel isn't.",
        );
      }

      const channelName =
        guild.channels.cache.get(channelId)?.name ?? "another channel";

      await respondSafe(interaction, {
        embeds: [
          buildSnipeEmbed(
            snipe,
            displayName(guild, snipe.authorId),
            channelName,
          ),
        ],
      });
    });
  },
};

export default snipeCommand;
