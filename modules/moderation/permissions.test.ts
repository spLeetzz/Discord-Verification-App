/**
 * Recording and restoring a channel's permissions.
 *
 * The bug this prevents: Quotient's unlock set `send_messages = True`
 * unconditionally, so a channel that had been write-locked before the
 * lockdown was silently opened by the unlock.
 */

import { describe, expect, it } from "vitest";
import { planRestore, readOverwriteState } from "./permissions.js";

describe("readOverwriteState", () => {
  it('says "inherit" when the channel had no overwrite at all', () => {
    const state = readOverwriteState({
      exists: false,
      allowed: false,
      denied: false,
    });

    expect(state.existed).toBe(false);
    expect(state.value).toBeNull();
  });

  it("reads an explicit allow", () => {
    const state = readOverwriteState({
      exists: true,
      allowed: true,
      denied: false,
    });

    expect(state.existed).toBe(true);
    expect(state.value).toBe(true);
  });

  it("reads an explicit deny", () => {
    const state = readOverwriteState({
      exists: true,
      allowed: false,
      denied: true,
    });

    expect(state.existed).toBe(true);
    expect(state.value).toBe(false);
  });

  it("reads an inherit when the permission is in neither set", () => {
    const state = readOverwriteState({
      exists: true,
      allowed: false,
      denied: false,
    });

    expect(state.existed).toBe(true);
    expect(state.value).toBeNull();
  });
});

describe("planRestore", () => {
  it("removes the overwrite when there was not one before", () => {
    const plan = planRestore({ existed: false, value: null });

    expect(plan).toEqual({ kind: "remove" });
  });

  it("puts an explicit allow back", () => {
    const plan = planRestore({ existed: true, value: true });

    expect(plan).toEqual({ kind: "restore", value: true });
  });

  it("puts an explicit deny back", () => {
    const plan = planRestore({ existed: true, value: false });

    expect(plan).toEqual({ kind: "restore", value: false });
  });

  it("puts an inherit back", () => {
    const plan = planRestore({ existed: true, value: null });

    expect(plan).toEqual({ kind: "restore", value: null });
  });
});
