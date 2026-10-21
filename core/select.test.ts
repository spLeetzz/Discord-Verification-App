/**
 * The select menu, and the flow that asks twice.
 *
 * The last test is the one both feature areas needed and neither could
 * express: a confirm and then a choice, out of a single interaction.
 *
 * The menu's owner is the member who opened it: somebody else's choice is
 * not an answer.
 */

import { describe, expect, it } from "vitest";
import { ChannelType, ComponentType } from "discord.js";
import { prompt } from "./prompt.js";
import { awaitChannelSelect, awaitRoleSelect, awaitSelect } from "./select.js";
import { fakeInteraction, sentComponent } from "./interaction.fake.js";

/** One choice. */
const ALPHA = { label: "Alpha", value: "alpha" };

describe("awaitSelect", () => {
  it("collects on the interaction's own reply", async () => {
    const { interaction, sent, reply, followUp } = fakeInteraction({
      selectValues: ["alpha"],
    });

    const values = await awaitSelect(interaction, [ALPHA]);

    expect(values).toEqual(["alpha"]);
    expect(reply).toHaveBeenCalledTimes(1);
    expect(followUp).not.toHaveBeenCalled();
    expect(sent[0]?.method).toBe("reply");
    expect(sent[0]?.handle.awaitMessageComponent).toHaveBeenCalledTimes(1);
  });

  it("collects on the follow-up when the flow asks twice", async () => {
    const { interaction, sent, reply, followUp } = fakeInteraction({
      replied: true,
      selectValues: ["alpha"],
    });

    const values = await awaitSelect(interaction, [ALPHA], {
      asFollowUp: true,
    });

    expect(values).toEqual(["alpha"]);
    expect(followUp).toHaveBeenCalledTimes(1);
    expect(reply).not.toHaveBeenCalled();
    expect(sent[0]?.method).toBe("followUp");
    expect(sent[0]?.handle.awaitMessageComponent).toHaveBeenCalledTimes(1);
  });

  it("falls back to the reply when there is nothing to follow up on", async () => {
    const { interaction, reply, followUp } = fakeInteraction({
      selectValues: ["alpha"],
    });

    const values = await awaitSelect(interaction, [ALPHA], {
      asFollowUp: true,
    });

    expect(values).toEqual(["alpha"]);
    expect(reply).toHaveBeenCalledTimes(1);
    expect(followUp).not.toHaveBeenCalled();
  });
});

describe("the menu's owner", () => {
  it("lets the owner choose", async () => {
    const { interaction, sent } = fakeInteraction({
      userId: "owner",
      selectValues: ["alpha"],
    });

    const values = await awaitSelect(interaction, [ALPHA]);

    expect(values).toEqual(["alpha"]);
    expect(sent[0]?.handle.clicks[0]?.accepted).toBe(true);
  });

  it("ignores another member's choice and keeps waiting for the owner", async () => {
    // A menu's options are visible to everybody in the channel, so it is
    // at least as exposed as a button. The other member's choice is not
    // an answer: the menu stays live for the owner.
    const { interaction, sent } = fakeInteraction({
      userId: "owner",
      clicks: [
        { userId: "someone-else", values: ["beta"] },
        { userId: "owner", values: ["alpha"] },
      ],
    });

    const values = await awaitSelect(interaction, [ALPHA]);

    expect(values).toEqual(["alpha"]);

    const clicks = sent[0]?.handle.clicks ?? [];

    expect(clicks).toHaveLength(2);
    expect(clicks[0]?.userId).toBe("someone-else");
    expect(clicks[0]?.accepted).toBe(false);
    expect(clicks[0]?.update).not.toHaveBeenCalled();
    expect(clicks[1]?.userId).toBe("owner");
    expect(clicks[1]?.accepted).toBe(true);
  });

  it("times out when only another member chooses", async () => {
    // The case that matters: the other member's choice must not answer
    // the menu. It is refused, the menu keeps waiting, and it ends as a
    // timeout — an empty answer.
    const { interaction, sent } = fakeInteraction({
      userId: "owner",
      clicks: [{ userId: "someone-else", values: ["alpha"] }],
    });

    const values = await awaitSelect(interaction, [ALPHA], {
      timeoutMs: 20,
    });

    expect(values).toEqual([]);

    const clicks = sent[0]?.handle.clicks ?? [];

    expect(clicks).toHaveLength(1);
    expect(clicks[0]?.userId).toBe("someone-else");
    expect(clicks[0]?.accepted).toBe(false);
    expect(clicks[0]?.update).not.toHaveBeenCalled();

    // The menu waited for its timeout and took itself off the message.
    expect(sent[0]?.handle.edit).toHaveBeenCalledTimes(1);
  });

  it("lets another member choose when the caller opts in", async () => {
    const { interaction, sent } = fakeInteraction({
      userId: "owner",
      clicks: [{ userId: "someone-else", values: ["alpha"] }],
    });

    const values = await awaitSelect(interaction, [ALPHA], {
      allowOthers: true,
    });

    expect(values).toEqual(["alpha"]);
    expect(sent[0]?.handle.clicks[0]?.userId).toBe("someone-else");
    expect(sent[0]?.handle.clicks[0]?.accepted).toBe(true);
  });
});

describe("two collections in one interaction", () => {
  it("asks a confirm, then a choice on a follow-up", async () => {
    // The case both feature areas hit. Discord allows one reply per
    // interaction, so the second question has to be a follow-up.
    const { interaction, sent, reply, followUp } = fakeInteraction({
      selectValues: ["alpha"],
    });

    const confirmed = await prompt(interaction, "Delete the slotlist?");

    expect(confirmed).toBe(true);

    const values = await awaitSelect(interaction, [ALPHA], {
      asFollowUp: true,
    });

    expect(values).toEqual(["alpha"]);
    expect(reply).toHaveBeenCalledTimes(1);
    expect(followUp).toHaveBeenCalledTimes(1);
    expect(sent.map((message) => message.method)).toEqual([
      "reply",
      "followUp",
    ]);
  });

  it("asks a confirm, then a choice, when the dispatcher deferred first", async () => {
    // The same flow on a command the dispatcher deferred: the deferral
    // becomes the prompt, and the choice is a follow-up.
    const { interaction, sent, editReply, followUp } = fakeInteraction({
      deferred: true,
      selectValues: ["alpha"],
    });

    const confirmed = await prompt(interaction, "Delete the slotlist?");

    expect(confirmed).toBe(true);

    const values = await awaitSelect(interaction, [ALPHA], {
      asFollowUp: true,
    });

    expect(values).toEqual(["alpha"]);
    expect(editReply).toHaveBeenCalledTimes(1);
    expect(followUp).toHaveBeenCalledTimes(1);
    expect(sent.map((message) => message.method)).toEqual([
      "editReply",
      "followUp",
    ]);
  });
});

describe("awaitChannelSelect", () => {
  it("collects on the interaction's own reply", async () => {
    const { interaction, sent, reply, followUp } = fakeInteraction({
      selectValues: ["channel-1"],
    });

    const channels = await awaitChannelSelect(interaction);

    expect(channels).toEqual(["channel-1"]);
    expect(reply).toHaveBeenCalledTimes(1);
    expect(followUp).not.toHaveBeenCalled();
    expect(sent[0]?.method).toBe("reply");
    expect(sent[0]?.handle.awaitMessageComponent).toHaveBeenCalledTimes(1);
  });

  it("collects on the follow-up when the flow asks twice", async () => {
    const { interaction, sent, reply, followUp } = fakeInteraction({
      replied: true,
      selectValues: ["channel-1"],
    });

    const channels = await awaitChannelSelect(interaction, {
      asFollowUp: true,
    });

    expect(channels).toEqual(["channel-1"]);
    expect(followUp).toHaveBeenCalledTimes(1);
    expect(reply).not.toHaveBeenCalled();
    expect(sent[0]?.method).toBe("followUp");
  });

  it("sends a channel select, not a string select", async () => {
    // The component type is the whole difference between the two menus,
    // and a channel cannot be picked with a string menu.
    const { interaction, sent } = fakeInteraction({
      selectValues: ["channel-1"],
    });

    await awaitChannelSelect(interaction);

    const component = sentComponent(sent[0]?.payload);

    expect(component?.type).toBe(ComponentType.ChannelSelect);
    expect(sent[0]?.handle.clicks[0]?.componentType).toBe(
      ComponentType.ChannelSelect,
    );
  });

  it("offers the channel types it was asked for", async () => {
    const { interaction, sent } = fakeInteraction({
      selectValues: ["channel-1"],
    });

    await awaitChannelSelect(interaction, {
      channelTypes: [ChannelType.GuildVoice, ChannelType.GuildCategory],
    });

    const component = sentComponent(sent[0]?.payload);

    expect(component?.channelTypes).toEqual([
      ChannelType.GuildVoice,
      ChannelType.GuildCategory,
    ]);
  });

  it("offers a text channel and an announcement channel by default", async () => {
    const { interaction, sent } = fakeInteraction({
      selectValues: ["channel-1"],
    });

    await awaitChannelSelect(interaction);

    const component = sentComponent(sent[0]?.payload);

    expect(component?.channelTypes).toEqual([
      ChannelType.GuildText,
      ChannelType.GuildAnnouncement,
    ]);
  });

  it("lets the owner choose", async () => {
    const { interaction, sent } = fakeInteraction({
      userId: "owner",
      selectValues: ["channel-1"],
    });

    const channels = await awaitChannelSelect(interaction);

    expect(channels).toEqual(["channel-1"]);
    expect(sent[0]?.handle.clicks[0]?.accepted).toBe(true);
  });

  it("ignores another member's choice and keeps waiting for the owner", async () => {
    const { interaction, sent } = fakeInteraction({
      userId: "owner",
      clicks: [
        { userId: "someone-else", values: ["channel-2"] },
        { userId: "owner", values: ["channel-1"] },
      ],
    });

    const channels = await awaitChannelSelect(interaction);

    expect(channels).toEqual(["channel-1"]);

    const clicks = sent[0]?.handle.clicks ?? [];

    expect(clicks).toHaveLength(2);
    expect(clicks[0]?.userId).toBe("someone-else");
    expect(clicks[0]?.accepted).toBe(false);
    expect(clicks[0]?.update).not.toHaveBeenCalled();
    expect(clicks[1]?.userId).toBe("owner");
    expect(clicks[1]?.accepted).toBe(true);
  });

  it("times out when only another member chooses", async () => {
    const { interaction, sent } = fakeInteraction({
      userId: "owner",
      clicks: [{ userId: "someone-else", values: ["channel-1"] }],
    });

    const channels = await awaitChannelSelect(interaction, { timeoutMs: 20 });

    expect(channels).toEqual([]);

    const clicks = sent[0]?.handle.clicks ?? [];

    expect(clicks).toHaveLength(1);
    expect(clicks[0]?.accepted).toBe(false);

    // The menu waited for its timeout and took itself off the message.
    expect(sent[0]?.handle.edit).toHaveBeenCalledTimes(1);
  });

  it("lets another member choose when the caller opts in", async () => {
    const { interaction, sent } = fakeInteraction({
      userId: "owner",
      clicks: [{ userId: "someone-else", values: ["channel-1"] }],
    });

    const channels = await awaitChannelSelect(interaction, {
      allowOthers: true,
    });

    expect(channels).toEqual(["channel-1"]);
    expect(sent[0]?.handle.clicks[0]?.accepted).toBe(true);
  });

  it("takes the timeout edit off the message that carries the menu", async () => {
    // The edit has to land on the follow-up, not on the interaction's own
    // reply: the menu is on the follow-up.
    const { interaction, sent, editReply } = fakeInteraction({
      replied: true,
      clicks: [],
    });

    const channels = await awaitChannelSelect(interaction, {
      asFollowUp: true,
      timeoutMs: 20,
    });

    expect(channels).toEqual([]);
    expect(sent[0]?.method).toBe("followUp");
    expect(sent[0]?.handle.edit).toHaveBeenCalledTimes(1);
    expect(editReply).not.toHaveBeenCalled();
  });

  it("refuses a channel of another guild and keeps waiting", async () => {
    // Discord's channel select has no guild mode: the client can hand
    // back a channel of another guild. The menu stays live for the owner.
    const { interaction, sent } = fakeInteraction({
      userId: "owner",
      guildId: "guild-1",
      channelGuilds: { "channel-1": "guild-1", "channel-2": "guild-2" },
      clicks: [
        { userId: "owner", values: ["channel-2"] },
        { userId: "owner", values: ["channel-1"] },
      ],
    });

    const channels = await awaitChannelSelect(interaction);

    expect(channels).toEqual(["channel-1"]);

    const clicks = sent[0]?.handle.clicks ?? [];

    expect(clicks).toHaveLength(2);
    expect(clicks[0]?.accepted).toBe(false);
    expect(clicks[1]?.accepted).toBe(true);
  });

  it("refuses a channel the bot cannot see", async () => {
    const { interaction, sent } = fakeInteraction({
      userId: "owner",
      guildId: "guild-1",
      channelGuilds: { "channel-1": "guild-1" },
      clicks: [{ userId: "owner", values: ["channel-unknown"] }],
    });

    const channels = await awaitChannelSelect(interaction, { timeoutMs: 20 });

    expect(channels).toEqual([]);
    expect(sent[0]?.handle.clicks[0]?.accepted).toBe(false);
  });
});

describe("awaitRoleSelect", () => {
  it("collects on the interaction's own reply", async () => {
    const { interaction, sent, reply, followUp } = fakeInteraction({
      selectValues: ["role-1"],
    });

    const roles = await awaitRoleSelect(interaction);

    expect(roles).toEqual(["role-1"]);
    expect(reply).toHaveBeenCalledTimes(1);
    expect(followUp).not.toHaveBeenCalled();
    expect(sent[0]?.method).toBe("reply");
  });

  it("collects on the follow-up when the flow asks twice", async () => {
    const { interaction, sent, reply, followUp } = fakeInteraction({
      replied: true,
      selectValues: ["role-1"],
    });

    const roles = await awaitRoleSelect(interaction, { asFollowUp: true });

    expect(roles).toEqual(["role-1"]);
    expect(followUp).toHaveBeenCalledTimes(1);
    expect(reply).not.toHaveBeenCalled();
    expect(sent[0]?.method).toBe("followUp");
  });

  it("sends a role select, not a string select", async () => {
    const { interaction, sent } = fakeInteraction({
      selectValues: ["role-1"],
    });

    await awaitRoleSelect(interaction);

    const component = sentComponent(sent[0]?.payload);

    expect(component?.type).toBe(ComponentType.RoleSelect);
  });

  it("lets the owner choose", async () => {
    const { interaction, sent } = fakeInteraction({
      userId: "owner",
      selectValues: ["role-1"],
    });

    const roles = await awaitRoleSelect(interaction);

    expect(roles).toEqual(["role-1"]);
    expect(sent[0]?.handle.clicks[0]?.accepted).toBe(true);
  });

  it("ignores another member's choice and keeps waiting for the owner", async () => {
    const { interaction, sent } = fakeInteraction({
      userId: "owner",
      clicks: [
        { userId: "someone-else", values: ["role-2"] },
        { userId: "owner", values: ["role-1"] },
      ],
    });

    const roles = await awaitRoleSelect(interaction);

    expect(roles).toEqual(["role-1"]);

    const clicks = sent[0]?.handle.clicks ?? [];

    expect(clicks).toHaveLength(2);
    expect(clicks[0]?.userId).toBe("someone-else");
    expect(clicks[0]?.accepted).toBe(false);
    expect(clicks[0]?.update).not.toHaveBeenCalled();
    expect(clicks[1]?.userId).toBe("owner");
    expect(clicks[1]?.accepted).toBe(true);
  });

  it("times out when only another member chooses", async () => {
    const { interaction, sent } = fakeInteraction({
      userId: "owner",
      clicks: [{ userId: "someone-else", values: ["role-1"] }],
    });

    const roles = await awaitRoleSelect(interaction, { timeoutMs: 20 });

    expect(roles).toEqual([]);

    const clicks = sent[0]?.handle.clicks ?? [];

    expect(clicks).toHaveLength(1);
    expect(clicks[0]?.accepted).toBe(false);
    expect(sent[0]?.handle.edit).toHaveBeenCalledTimes(1);
  });

  it("lets another member choose when the caller opts in", async () => {
    const { interaction, sent } = fakeInteraction({
      userId: "owner",
      clicks: [{ userId: "someone-else", values: ["role-1"] }],
    });

    const roles = await awaitRoleSelect(interaction, { allowOthers: true });

    expect(roles).toEqual(["role-1"]);
    expect(sent[0]?.handle.clicks[0]?.accepted).toBe(true);
  });
});
