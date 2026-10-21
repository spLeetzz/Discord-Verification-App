import { describe, expect, it } from "vitest";
import { TtlCache } from "./ttl-cache.js";

describe("TtlCache", () => {
  it("stores and reads a value", () => {
    const cache = new TtlCache<string>({ ttlMs: 1000 });

    cache.set("a", "hello");

    expect(cache.get("a")).toBe("hello");
    expect(cache.has("a")).toBe(true);

    cache.stop();
  });

  it("reports a missing key as missing", () => {
    const cache = new TtlCache<string>({ ttlMs: 1000 });

    expect(cache.get("nope")).toBeUndefined();
    expect(cache.has("nope")).toBe(false);

    cache.stop();
  });

  it("drops a value once it has expired", () => {
    let now = 0;
    const cache = new TtlCache<string>({ ttlMs: 1000, now: () => now });

    cache.set("a", "hello");

    now = 999;
    expect(cache.get("a")).toBe("hello");

    now = 1000;
    expect(cache.get("a")).toBeUndefined();

    cache.stop();
  });

  it("takes a time to live for one entry", () => {
    let now = 0;
    const cache = new TtlCache<string>({ ttlMs: 1000, now: () => now });

    cache.set("short", "hello", 100);
    cache.set("long", "hello", 5000);

    now = 200;
    expect(cache.get("short")).toBeUndefined();
    expect(cache.get("long")).toBe("hello");

    cache.stop();
  });

  it("sweeps the expired entries away", () => {
    let now = 0;
    const cache = new TtlCache<string>({ ttlMs: 1000, now: () => now });

    cache.set("a", "hello");
    cache.set("b", "hello");

    now = 1500;

    expect(cache.sweep()).toBe(2);
    expect(cache.size).toBe(0);

    cache.stop();
  });

  it("deletes and clears", () => {
    const cache = new TtlCache<string>({ ttlMs: 1000 });

    cache.set("a", "hello");

    expect(cache.delete("a")).toBe(true);
    expect(cache.delete("a")).toBe(false);

    cache.set("b", "hello");
    cache.clear();

    expect(cache.size).toBe(0);

    cache.stop();
  });

  it("drops the oldest entry when it is full", () => {
    const cache = new TtlCache<string>({ ttlMs: 1000, maxSize: 2 });

    cache.set("a", "one");
    cache.set("b", "two");
    cache.set("c", "three");

    expect(cache.size).toBe(2);
    expect(cache.get("a")).toBeUndefined();
    expect(cache.get("b")).toBe("two");
    expect(cache.get("c")).toBe("three");

    cache.stop();
  });

  it("re-inserting a key moves it to the end", () => {
    const cache = new TtlCache<string>({ ttlMs: 1000, maxSize: 2 });

    cache.set("a", "one");
    cache.set("b", "two");
    cache.set("a", "one again");
    cache.set("c", "three");

    expect(cache.get("b")).toBeUndefined();
    expect(cache.get("a")).toBe("one again");

    cache.stop();
  });
});
