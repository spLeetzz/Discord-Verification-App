/**
 * The guard of the screenshot-verification panel.
 *
 * The panel is a **message**: anybody who can read the channel can press
 * its buttons, and the buttons delete a server's verification setup,
 * repoint the channel the bot reads and change the role the bot grants.
 * So the guard is the thing that stands between an ordinary member and
 * the server's configuration, and it has to fail **closed**: no member, no
 * guild, another guild — all refusals.
 */

import { describe, expect, it } from "vitest";
import { PermissionFlagsBits } from "discord.js";
import type { RepliableInteraction } from "discord.js";
import { canManageSsConfig, SSMOD_DENIAL_MESSAGE } from "./guards.js";

/** The member of the fake guild. */
interface FakeMember {
  readonly permissions: { has(flag: bigint): boolean };
  readonly roles: {
    readonly cache: {
      some(check: (role: { name: string }) => boolean): boolean;
    };
  };
}

/**
 * A member of the fake guild.
 */
function fakeMember(options: {
  admin?: boolean;
  manageGuild?: boolean;
  moderator?: boolean;
}): FakeMember {
  const flags = new Set<bigint>();

  if (options.admin) flags.add(PermissionFlagsBits.Administrator);
  if (options.manageGuild) flags.add(PermissionFlagsBits.ManageGuild);

  const roles = options.moderator ? ["Moderator"] : [];

  return {
    permissions: { has: (flag: bigint) => flags.has(flag) },
    roles: {
      cache: { some: (check) => roles.some((name) => check({ name })) },
    },
  };
}

/** A guild with one member in it. */
function fakeGuild(guildId: string, member: FakeMember | null): unknown {
  const members = member ? new Map([["user-1", member]]) : new Map();

  return {
    id: guildId,
    members: {
      cache: members,
      fetch: async (id: string) => {
        const found = members.get(id);

        if (!found) throw new Error(`no member ${id}`);

        return found;
      },
    },
  };
}

/** An interaction from a guild. */
function interactionIn(
  guildId: string,
  member: FakeMember | null,
): RepliableInteraction {
  return {
    guildId,
    guild: fakeGuild(guildId, member),
    user: { id: "user-1" },
  } as unknown as RepliableInteraction;
}

describe("the panel's guard", () => {
  it("lets a moderator of the guild through", async () => {
    const refusal = await canManageSsConfig(
      interactionIn("guild-1", fakeMember({ moderator: true })),
      "guild-1",
    );

    expect(refusal).toBeNull();
  });

  it("lets an administrator through", async () => {
    const refusal = await canManageSsConfig(
      interactionIn("guild-1", fakeMember({ admin: true })),
      "guild-1",
    );

    expect(refusal).toBeNull();
  });

  it("lets a member who may manage the server through", async () => {
    const refusal = await canManageSsConfig(
      interactionIn("guild-1", fakeMember({ manageGuild: true })),
      "guild-1",
    );

    expect(refusal).toBeNull();
  });

  it("refuses an ordinary member", async () => {
    const refusal = await canManageSsConfig(
      interactionIn("guild-1", fakeMember({})),
      "guild-1",
    );

    expect(refusal).toBe(SSMOD_DENIAL_MESSAGE);
  });

  it("refuses a member it cannot find", async () => {
    const refusal = await canManageSsConfig(
      interactionIn("guild-1", null),
      "guild-1",
    );

    expect(refusal).toBe(SSMOD_DENIAL_MESSAGE);
  });

  it("refuses an interaction that is not in a guild", async () => {
    const refusal = await canManageSsConfig(
      {
        guildId: null,
        guild: null,
        user: { id: "user-1" },
      } as unknown as RepliableInteraction,
      "guild-1",
    );

    expect(refusal).toBe("This only works in a server.");
  });

  it("refuses a call that names no guild", async () => {
    const refusal = await canManageSsConfig(
      interactionIn("guild-1", fakeMember({ moderator: true })),
      null,
    );

    expect(refusal).toBe("This only works in a server.");
  });

  it("refuses a moderator of another guild", async () => {
    const refusal = await canManageSsConfig(
      interactionIn("guild-2", fakeMember({ moderator: true })),
      "guild-1",
    );

    expect(refusal).toBe("That setup belongs to another server.");
  });
});
