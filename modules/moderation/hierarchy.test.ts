/**
 * The role hierarchy, for actions aimed at a member.
 *
 * Quotient checked two things before it let a moderation action through:
 * the moderator has to be above the target, and so does the bot. Both are
 * checked here, and the order matters — the moderator's refusal is the
 * one the moderator needs to read.
 */

import { describe, expect, it } from "vitest";
import {
  ACTOR_HIERARCHY_REFUSAL,
  BOT_HIERARCHY_REFUSAL,
  checkActorHierarchy,
  checkBotHierarchy,
  outranks,
} from "./hierarchy.js";

/** A participant in the comparison. */
function subject(id: string, topRolePosition: number) {
  return { id, topRolePosition };
}

describe("outranks", () => {
  it("is strictly above", () => {
    expect(outranks(subject("a", 5), subject("b", 4))).toBe(true);
  });

  it("is not above its equal", () => {
    expect(outranks(subject("a", 5), subject("b", 5))).toBe(false);
  });

  it("is not above somebody higher", () => {
    expect(outranks(subject("a", 3), subject("b", 5))).toBe(false);
  });
});

describe("checkActorHierarchy", () => {
  it("allows the moderator to act on somebody below them", () => {
    const refusal = checkActorHierarchy({
      actor: subject("moderator", 5),
      target: subject("target", 4),
      isGuildOwner: false,
      isBotOwner: false,
    });

    expect(refusal).toBeNull();
  });

  it("refuses the moderator when they are not above the target", () => {
    const refusal = checkActorHierarchy({
      actor: subject("moderator", 3),
      target: subject("target", 5),
      isGuildOwner: false,
      isBotOwner: false,
    });

    expect(refusal).toBe(ACTOR_HIERARCHY_REFUSAL);
  });

  it("refuses the moderator when they have the same top role", () => {
    const refusal = checkActorHierarchy({
      actor: subject("moderator", 5),
      target: subject("target", 5),
      isGuildOwner: false,
      isBotOwner: false,
    });

    expect(refusal).toBe(ACTOR_HIERARCHY_REFUSAL);
  });

  it("lets the guild's owner act on anybody", () => {
    const refusal = checkActorHierarchy({
      actor: subject("owner", 1),
      target: subject("target", 9),
      isGuildOwner: true,
      isBotOwner: false,
    });

    expect(refusal).toBeNull();
  });

  it("lets the bot's owner act on anybody", () => {
    const refusal = checkActorHierarchy({
      actor: subject("owner", 1),
      target: subject("target", 9),
      isGuildOwner: false,
      isBotOwner: true,
    });

    expect(refusal).toBeNull();
  });
});

describe("checkBotHierarchy", () => {
  it("allows the bot to act on somebody below it", () => {
    expect(checkBotHierarchy(subject("bot", 5), subject("target", 4))).toBeNull();
  });

  it("refuses the bot when it is not above the target", () => {
    expect(checkBotHierarchy(subject("bot", 3), subject("target", 5))).toBe(
      BOT_HIERARCHY_REFUSAL,
    );
  });

  it("has no owner exemption — the bot owns nothing", () => {
    expect(checkBotHierarchy(subject("bot", 1), subject("target", 5))).toBe(
      BOT_HIERARCHY_REFUSAL,
    );
  });
});
