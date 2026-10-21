import type { GuildMember, Interaction } from "discord.js";

/**
 * Resolves the guild member behind an interaction.
 *
 * `interaction.member` is sometimes an API shape rather than a full member,
 * so go through the guild cache (and the API as a fallback) to always get a
 * real GuildMember with roles and permissions.
 */
export async function getGuildMember(
  interaction: Interaction,
): Promise<GuildMember | null> {
  const guild = interaction.guild;
  if (!guild) return null;

  const cached = guild.members.cache.get(interaction.user.id);
  if (cached) return cached;

  return guild.members.fetch(interaction.user.id).catch(() => null);
}
