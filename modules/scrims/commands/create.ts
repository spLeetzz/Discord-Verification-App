/**
 * The `/scrims create` subcommand.
 *
 * The source's `create` picked the autoclean time at random between 3am
 * and 6am, with `randint(1, 60)` for the minutes — so about one create
 * in sixty crashed (D44). Ours asks for the autoclean time instead of
 * guessing, and the free-tier allowance comes from the allowance table
 * (D45).
 */

import {
  ChannelType,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from "discord.js";
import { parseNaturalTime } from "../../../core/time.js";
import { FREE_SCrim_LIMIT, isEntitled, PremiumFeature } from "../entitlements.js";
import { canUseScrimMod } from "../guards.js";
import * as repo from "../repo.js";
import * as service from "../service.js";
import type { ScrimSubcommand } from "./types.js";

/** The subcommand. */
export const createSubcommand: ScrimSubcommand = {
  data: new SlashCommandBuilder()
    .setName("create")
    .setDescription("Create a scrim.")
    .addChannelOption((option) =>
      option
        .setName("registration_channel")
        .setDescription("Where the teams register.")
        .addChannelTypes(ChannelType.GuildText)
        .setRequired(true),
    )
    .addChannelOption((option) =>
      option
        .setName("slotlist_channel")
        .setDescription("Where the slotlist is posted.")
        .addChannelTypes(ChannelType.GuildText)
        .setRequired(true),
    )
    .addRoleOption((option) =>
      option
        .setName("success_role")
        .setDescription("The role a team gets when it registers.")
        .setRequired(true),
    )
    .addIntegerOption((option) =>
      option
        .setName("required_mentions")
        .setDescription("How many mentions a registration needs.")
        .setMinValue(0)
        .setMaxValue(10)
        .setRequired(true),
    )
    .addIntegerOption((option) =>
      option
        .setName("total_slots")
        .setDescription("How many slots the scrim has.")
        .setMinValue(1)
        .setMaxValue(30)
        .setRequired(true),
    )
    .addStringOption((option) =>
      option
        .setName("open_time")
        .setDescription("When registration should open, every day (IST).")
        .setRequired(true),
    )
    .addStringOption((option) =>
      option
        .setName("autoclean_time")
        .setDescription("When the autoclean should run, every day (IST).")
        .setRequired(true),
    ),

  async run(interaction) {
    const refusal = await canUseScrimMod(interaction);

    if (refusal) {
      await interaction.editReply({ content: refusal });

      return;
    }

    const guild = interaction.guild;

    if (!guild) {
      await interaction.editReply({ content: "This only works in a server." });

      return;
    }

    const registrationChannel = interaction.options.getChannel(
      "registration_channel",
      true,
    );
    const slotlistChannel = interaction.options.getChannel(
      "slotlist_channel",
      true,
    );
    const successRole = interaction.options.getRole("success_role", true);
    const requiredMentions = interaction.options.getInteger(
      "required_mentions",
      true,
    );
    const totalSlots = interaction.options.getInteger("total_slots", true);
    const openTimeText = interaction.options.getString("open_time", true);
    const autocleanTimeText = interaction.options.getString(
      "autoclean_time",
      true,
    );

    // The free-tier allowance, not a hard-coded three (D45).
    if (!(await isEntitled(guild.id, PremiumFeature.scrimSlots))) {
      const current = await repo.countScrims(guild.id);

      if (current >= FREE_SCrim_LIMIT) {
        await interaction.editReply({
          content: `You can only have ${FREE_SCrim_LIMIT} scrims on this server without the **scrim slots** entitlement. You already have ${current}.`,
        });

        return;
      }
    }

    const me = guild.members.me;

    if (!me) {
      await interaction.editReply({
        content: "I could not find my own member record.",
      });

      return;
    }

    for (const channel of [registrationChannel, slotlistChannel]) {
      const permissions = channel.permissionsFor(me);

      if (
        !permissions?.has(PermissionFlagsBits.ManageChannels) ||
        !permissions?.has(PermissionFlagsBits.ManageRoles)
      ) {
        await interaction.editReply({
          content: `❌ I don't have the permissions I need in ${channel.toString()}.`,
        });

        return;
      }
    }

    const existing = await repo.getScrimByRegistrationChannel(
      registrationChannel.id,
    );

    if (existing) {
      await interaction.editReply({
        content: `❌ A scrim already exists in ${registrationChannel.toString()}.`,
      });

      return;
    }

    if (!me.permissions.has(PermissionFlagsBits.ManageRoles)) {
      await interaction.editReply({
        content: "❌ I don't have permission to manage roles.",
      });

      return;
    }

    if (successRole.managed) {
      await interaction.editReply({
        content: "❌ I can't give a managed role to users.",
      });

      return;
    }

    if (successRole.position >= me.roles.highest.position) {
      await interaction.editReply({
        content: `❌ I can't set a success role (${successRole.toString()}) higher than my top role (${me.roles.highest.toString()}).`,
      });

      return;
    }

    const caller = interaction.member;

    if (
      "roles" in caller &&
      successRole.position >= caller.roles.highest.position
    ) {
      await interaction.editReply({
        content: `❌ You can't set a success role (${successRole.toString()}) higher than your top role (${caller.roles.highest.toString()}).`,
      });

      return;
    }

    const openTime = parseNaturalTime(openTimeText);

    if (!openTime) {
      await interaction.editReply({
        content:
          "❌ I could not understand that open time. Try `7 PM` or `every day at 7 PM`.",
      });

      return;
    }

    const autocleanTime = parseNaturalTime(autocleanTimeText);

    if (!autocleanTime) {
      await interaction.editReply({
        content:
          "❌ I could not understand that autoclean time. Try `4 AM` or `every day at 4 AM`.",
      });

      return;
    }

    const scrimId = await repo.createScrim({
      guildId: guild.id,
      hostId: interaction.user.id,
      name: "Quotient-Scrims",
      registrationChannelId: registrationChannel.id,
      slotlistChannelId: slotlistChannel.id,
      roleId: successRole.id,
      requiredMentions,
      totalSlots,
      openTime,
      startFrom: 1,
      openDays: [
        "monday",
        "tuesday",
        "wednesday",
        "thursday",
        "friday",
        "saturday",
        "sunday",
      ],
      autoclean: ["channel", "role"],
      autocleanTime,
      emojis: { tick: "✅", cross: "❌" },
      openMessage: {},
      closeMessage: {},
      slotlistFormat: {},
    });

    const scrim = await repo.getScrim(scrimId);

    if (scrim) {
      await service.armDailyJobs(scrim);
    }

    await interaction.editReply({
      content: [
        "✅ **Scrim created successfully!**",
        `**Registration Channel:** ${registrationChannel.toString()}`,
        `**Slotlist Channel:** ${slotlistChannel.toString()}`,
        `**Success Role:** ${successRole.toString()}`,
        `**Required Mentions:** \`${requiredMentions}\``,
        `**Total Slots:** \`${totalSlots}\``,
        `**Open Time:** <t:${Math.floor(openTime.getTime() / 1000)}:f>`,
        `**Autoclean Time:** <t:${Math.floor(autocleanTime.getTime() / 1000)}:f>`,
        `**Host:** ${interaction.user.toString()}`,
        "",
        "Use `/scrims manager` to open the panels.",
      ].join("\n"),
    });
  },
};
