/**
 * The ignore role.
 *
 * Quotient created a guild role called `quotient-tag-ignore` and looked
 * it up **by name on every single message**. The port stores the role's
 * id on the configuration row (D16) and compares ids, so a role that
 * merely carries the name does not opt anybody out.
 */

import { describe, expect, it } from "vitest";
import {
  forgetIgnoreRoles,
  isIgnoredMember,
  knownIgnoreRoleId,
  rememberIgnoreRole,
} from "./ignore-role.js";
import { TAG_IGNORE_ROLE_NAME } from "./types.js";

describe("the ignore role's name", () => {
  it("is the name Quotient used", () => {
    // The name is only ever used to **create** the role; the id is what
    // the configuration rows hold.
    expect(TAG_IGNORE_ROLE_NAME).toBe("quotient-tag-ignore");
  });
});

describe("isIgnoredMember", () => {
  it("ignores a member who holds the role", () => {
    expect(isIgnoredMember(["role-1", "role-2"], "role-2")).toBe(true);
  });

  it("does not ignore a member who does not hold the role", () => {
    expect(isIgnoredMember(["role-1"], "role-2")).toBe(false);
  });

  it("ignores nobody when the guild has no ignore role", () => {
    expect(isIgnoredMember(["role-1", "role-2"], null)).toBe(false);
  });

  it("ignores nobody when the member holds no roles", () => {
    expect(isIgnoredMember([], "role-2")).toBe(false);
  });

  it("compares the id, not the name", () => {
    // A role that happens to be called "quotient-tag-ignore" but has a
    // different id is a different role.
    expect(isIgnoredMember(["999999999999999999"], "role-2")).toBe(false);
  });
});

describe("the process-wide role cache", () => {
  it("remembers a role id", () => {
    forgetIgnoreRoles();

    expect(knownIgnoreRoleId("guild-1")).toBeNull();

    rememberIgnoreRole("guild-1", "role-1");

    expect(knownIgnoreRoleId("guild-1")).toBe("role-1");
  });

  it("keeps the roles of two guilds apart", () => {
    forgetIgnoreRoles();

    rememberIgnoreRole("guild-1", "role-1");
    rememberIgnoreRole("guild-2", "role-2");

    expect(knownIgnoreRoleId("guild-1")).toBe("role-1");
    expect(knownIgnoreRoleId("guild-2")).toBe("role-2");

    forgetIgnoreRoles();
  });
});
