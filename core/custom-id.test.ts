import { describe, expect, it } from "vitest";
import {
  CUSTOM_ID_SEPARATOR,
  makeCustomId,
  parseCustomId,
  randomId,
  TokenStore,
} from "./custom-id.js";

describe("makeCustomId", () => {
  it("joins the parts with a separator", () => {
    expect(makeCustomId("scrims", "claim", "42")).toBe("scrims:claim:42");
  });

  it("leaves the payload out when there is none", () => {
    expect(makeCustomId("premium", "buy")).toBe("premium:buy");
  });

  it("leaves the payload out when it is empty", () => {
    expect(makeCustomId("premium", "buy", "")).toBe("premium:buy");
  });

  it("refuses an empty type", () => {
    expect(() => makeCustomId("", "buy")).toThrow(TypeError);
  });

  it("refuses an empty action", () => {
    expect(() => makeCustomId("premium", "")).toThrow(TypeError);
  });

  it("refuses a type with a separator in it", () => {
    expect(() => makeCustomId("scrims:claim", "buy")).toThrow(TypeError);
  });

  it("refuses an action with a separator in it", () => {
    expect(() => makeCustomId("scrims", "cl:aim")).toThrow(TypeError);
  });
});

describe("parseCustomId", () => {
  it("splits an id back into its parts", () => {
    expect(parseCustomId("scrims:claim:42")).toEqual({
      type: "scrims",
      action: "claim",
      payload: "42",
    });
  });

  it("reads an id with no payload", () => {
    expect(parseCustomId("premium:buy")).toEqual({
      type: "premium",
      action: "buy",
      payload: null,
    });
  });

  it("keeps the rest of the id as the payload", () => {
    expect(parseCustomId("scrims:claim:42:extra:bits")).toEqual({
      type: "scrims",
      action: "claim",
      payload: "42:extra:bits",
    });
  });

  it("still parses the legacy verification id", () => {
    // The frozen `verify_btn:<eventKey>` id follows the same scheme: its
    // type is `verify_btn` and its action is the event key.
    expect(parseCustomId("verify_btn:FF")).toEqual({
      type: "verify_btn",
      action: "FF",
      payload: null,
    });
  });

  it("returns null for an empty id", () => {
    expect(parseCustomId("")).toBeNull();
  });

  it("returns null for an id with no action", () => {
    expect(parseCustomId("scrims")).toBeNull();
  });

  it("round-trips with makeCustomId", () => {
    const id = makeCustomId("scrims", "claim", "42");

    expect(parseCustomId(id)).toEqual({
      type: "scrims",
      action: "claim",
      payload: "42",
    });
  });
});

describe("randomId", () => {
  it("produces a different id every time", () => {
    const ids = new Set(Array.from({ length: 50 }, () => randomId()));

    expect(ids.size).toBe(50);
  });

  it("produces a URL-safe id", () => {
    expect(randomId()).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});

describe("TokenStore", () => {
  it("stores and reads a value", () => {
    const store = new TokenStore<string>();

    const token = store.issue("hello");

    expect(store.get(token)).toBe("hello");
    expect(store.has(token)).toBe(true);

    store.stop();
  });

  it("reads a value without consuming it", () => {
    const store = new TokenStore<string>();

    const token = store.issue("hello");

    expect(store.get(token)).toBe("hello");
    expect(store.get(token)).toBe("hello");

    store.stop();
  });

  it("consumes a value when it is taken", () => {
    const store = new TokenStore<string>();

    const token = store.issue("hello");

    expect(store.take(token)).toBe("hello");
    expect(store.get(token)).toBeUndefined();

    store.stop();
  });

  it("replaces the value behind a token", () => {
    const store = new TokenStore<string>();

    const token = store.issue("hello");

    expect(store.set(token, "goodbye")).toBe(true);
    expect(store.get(token)).toBe("goodbye");

    store.stop();
  });

  it("refuses to replace the value behind a dead token", () => {
    const store = new TokenStore<string>();

    expect(store.set("nope", "hello")).toBe(false);

    store.stop();
  });

  it("drops a value that has expired", () => {
    let now = 0;
    const store = new TokenStore<string>({ ttlMs: 1000, now: () => now });

    const token = store.issue("hello");

    now = 999;
    expect(store.get(token)).toBe("hello");

    now = 1000;
    expect(store.get(token)).toBeUndefined();

    store.stop();
  });

  it("sweeps the expired values away", () => {
    let now = 0;
    const store = new TokenStore<string>({ ttlMs: 1000, now: () => now });

    store.issue("a");
    store.issue("b");

    now = 1500;

    expect(store.sweep()).toBe(2);
    expect(store.size).toBe(0);

    store.stop();
  });

  it("deletes and clears", () => {
    const store = new TokenStore<string>();

    const token = store.issue("hello");

    expect(store.delete(token)).toBe(true);
    expect(store.delete(token)).toBe(false);

    store.issue("a");
    store.clear();

    expect(store.size).toBe(0);

    store.stop();
  });
});

describe("CUSTOM_ID_SEPARATOR", () => {
  it("is a colon", () => {
    expect(CUSTOM_ID_SEPARATOR).toBe(":");
  });
});
