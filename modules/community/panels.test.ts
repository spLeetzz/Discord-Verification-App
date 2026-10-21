/**
 * The look of the community area's panels.
 *
 * The design language is `core/ui.ts`: a panel has a title, a short
 * description, the data in fields, and a footer that says what to do
 * next. This test pins the parts of that the area is responsible for,
 * because a panel that loses its footer loses its hint — and the hint
 * is what tells a new member what to do.
 */

import { describe, expect, it, vi } from "vitest";
import { ButtonStyle } from "discord.js";
import type { Client } from "discord.js";
import { PANEL_COLOR } from "../../core/ui.js";
import {
  buildAutoPurgeListEmbed,
  buildAutoroleConfigEmbed,
  buildGuildTagStatsEmbed,
  buildMemberTagStatsEmbed,
  buildSnipeEmbed,
  buildTagInfoEmbed,
} from "./views/embeds.js";
import { buildReminderEmbed } from "./views/reminder.js";
import { reminderListPages, tagListPages } from "./views/lists.js";
import {
  emptyAutoPurgePanel,
  emptyAutoRolePanel,
  emptyReminderListPanel,
  emptySnipePanel,
  emptyTagListPanel,
} from "./views/panels.js";
import type { TagRecord } from "./types.js";

/** A tag to build the panels with. */
function aTag(overrides: Partial<TagRecord> = {}): TagRecord {
  return {
    id: "3f2b1c9d8e7a6b5c4d3e2f1a0b9c8d7e",
    guildId: "guild-1",
    name: "rules",
    content: "Be nice.",
    isEmbed: false,
    isNsfw: false,
    ownerId: "member-1",
    usage: 12,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    ...overrides,
  };
}

describe("a panel", () => {
  it("has a title, the panel colour and a footer with the hint", () => {
    const embed = buildTagInfoEmbed(aTag(), "Aditya");

    expect(embed.data.title).toBe("Tag: rules");
    expect(embed.data.color).toBe(PANEL_COLOR);
    expect(embed.data.footer?.text).toBe("Post it with `/tag show <name>`.");
  });

  it("puts the data in the fields", () => {
    const embed = buildTagInfoEmbed(aTag(), "Aditya");

    const fields = embed.data.fields ?? [];

    expect(fields.map((field) => field.name)).toEqual([
      "Owner",
      "ID",
      "Uses",
      "NSFW",
      "Embed",
    ]);
    expect(fields[2]?.value).toBe("12");
  });

  it("escapes a tag name that would break the title", () => {
    const embed = buildTagInfoEmbed(aTag({ name: "the*rules" }), "Aditya");

    expect(embed.data.title).toBe("Tag: the\\*rules");
  });

  it("keeps the deleted message in the snipe panel", () => {
    const embed = buildSnipeEmbed(
      {
        id: "snipe-1",
        channelId: "channel-1",
        authorId: "member-1",
        content: "Oops, wrong channel.",
        nsfw: false,
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
      },
      "Aditya",
      "general",
    );

    expect(embed.data.description).toContain("Oops, wrong channel.");
    expect(embed.data.footer?.text).toBe(
      "Sniped messages are kept for ten days.",
    );
  });

  it("says what the auto-roles are for", () => {
    const embed = buildAutoroleConfigEmbed(["@Member"], []);

    expect(embed.data.title).toBe("Auto-roles");
    expect(embed.data.fields?.[1]?.value).toBe("Not set");
    expect(embed.data.footer?.text).toContain("/autorole humans");
  });

  it("lists the auto-purge channels with their delay", () => {
    const embed = buildAutoPurgeListEmbed(
      [
        {
          id: "row-1",
          guildId: "guild-1",
          channelId: "channel-1",
          deleteAfter: 600,
          createdAt: new Date("2026-01-01T00:00:00.000Z"),
        },
      ],
      new Map([["channel-1", "#general"]]),
    );

    expect(embed.data.description).toBe("`01` #general — 10 minutes");
  });

  it("numbers the statistics instead of drawing them", () => {
    const embed = buildGuildTagStatsEmbed({
      totalTags: 1,
      totalUses: 12,
      topTags: [{ name: "rules", usage: 12 }],
      topUsers: [{ userId: "member-1", uses: 5 }],
      topCreators: [{ ownerId: "member-2", count: 1 }],
    });

    expect(embed.data.description).toBe("1 tags, 12 tag uses");
    expect(embed.data.fields?.[0]?.value).toBe("1. **rules** (12 uses)");
  });

  it("names the member in the member statistics", () => {
    const embed = buildMemberTagStatsEmbed("Aditya", {
      ownedTags: 1,
      ownedUses: 12,
      commandUses: 5,
      tags: [{ name: "rules", usage: 12, totalTags: 1, totalUses: 12 }],
    });

    expect(embed.data.title).toBe("Tag stats for Aditya");
    expect(embed.data.fields?.[0]?.value).toBe("1");
  });
});

describe("an empty state", () => {
  it("says what to do next", () => {
    for (const panel of [
      emptyTagListPanel("This server has no tags yet."),
      emptyReminderListPanel(),
      emptyAutoPurgePanel(),
      emptyAutoRolePanel(),
      emptySnipePanel(),
    ]) {
      expect(panel.embeds).toHaveLength(1);

      const embed = panel.embeds[0];

      expect(embed?.data.title).toBeTruthy();
      expect(embed?.data.description).toBeTruthy();
      expect(embed?.data.footer?.text).toBeTruthy();
    }
  });

  it("names the command that fills the list", () => {
    const panel = emptyTagListPanel("This server has no tags yet.");

    expect(panel.embeds[0]?.data.footer?.text).toBe(
      "Create one with `/tag create`.",
    );
    expect(panel.components).toHaveLength(0);
  });
});

describe("a list of tags", () => {
  it("reads as a list, with the name first", () => {
    const pages = tagListPages([aTag()], 12);

    expect(pages).toHaveLength(1);

    const lines = pages[0] ?? [];

    expect(lines[0]).toBe("Post one with `/tag show <name>`.");
    expect(lines[2]).toBe(
      "`01` **rules** — `3f2b1c9d8e7a6b5c4d3e2f1a0b9c8d7e`",
    );
  });

  it("numbers the tags across the pages", () => {
    const pages = tagListPages([aTag(), aTag({ name: "faq" })], 1);

    expect(pages).toHaveLength(2);
    expect(pages[0]?.[2]).toContain("`01`");
    expect(pages[1]?.[2]).toContain("`02`");
  });
});

describe("a list of reminders", () => {
  it("shows the id, because that is what the delete command needs", () => {
    const pages = reminderListPages([
      {
        id: "reminder-1",
        expiresAt: new Date("2026-02-01T00:00:00.000Z"),
        message: "Stand up and stretch",
        channelId: "channel-1",
        userId: "member-1",
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
      },
    ]);

    const lines = pages[0] ?? [];

    expect(lines[0]).toBe("Delete one with `/reminder delete`.");
    expect(lines[2]).toContain("`reminder-1`");
    expect(lines[2]).toContain("Stand up and stretch");
  });
});

describe("the reminder panel", () => {
  it("has a title, the message and the id", () => {
    const embed = buildReminderEmbed(
      "reminder-1",
      "Stand up and stretch",
      new Date("2026-01-01T00:00:00.000Z"),
      null,
    );

    expect(embed.data.title).toBe("Reminder");
    expect(embed.data.description).toBe("Stand up and stretch");
    expect(embed.data.fields?.[1]?.value).toBe("`reminder-1`");
    expect(embed.data.footer?.text).toBe(
      "Delete it early with `/reminder delete`.",
    );
  });
});

describe("the jump button of a reminder", () => {
  it("is a grey link, with a sentence-case label", async () => {
    const { deliverReminder } = await import("./views/reminder.js");

    const sent: {
      components?: {
        components?: { data?: { style?: number; label?: string; url?: string } }[];
      }[];
    }[] = [];

    const channel = {
      id: "channel-1",
      guildId: "guild-1",
      isTextBased: () => true,
      isDMBased: () => false,
      isSendable: () => true,
      send: async (payload: (typeof sent)[number]) => {
        sent.push(payload);

        return {};
      },
    };

    const client = {
      channels: { cache: new Map([["channel-1", channel]]), fetch: vi.fn() },
    } as unknown as Client;

    await deliverReminder(
      client,
      {
        channelId: "channel-1",
        userId: "member-1",
        message: "Stand up and stretch",
        reminderId: "reminder-1",
        sourceMessageId: "message-1",
      },
      { reminderId: "reminder-1", createdAt: new Date() },
    );

    const button = sent[0]?.components?.[0]?.components?.[0]?.data;

    expect(button?.label).toBe("Jump to original message");
    expect(button?.style).toBe(ButtonStyle.Link);
    expect(button?.url).toContain("/channels/guild-1/channel-1/message-1");
  });
});
