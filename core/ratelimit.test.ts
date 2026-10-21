import { describe, expect, it } from "vitest";
import { describeWait, RateLimiter } from "./ratelimit.js";

describe("RateLimiter — the guild bucket", () => {
  it("uses a sliding window", () => {
    let now = 0;
    const limiter = new RateLimiter({
      limit: 3,
      windowMs: 1000,
      bucket: "guild",
      now: () => now,
    });

    expect(limiter.hit("g")).toBeNull();
    now = 100;
    expect(limiter.hit("g")).toBeNull();
    now = 200;
    expect(limiter.hit("g")).toBeNull();

    // The window is full. The wait is until the oldest hit falls out.
    now = 300;
    expect(limiter.hit("g")).toBe(700);
  });

  it("lets a hit through once the oldest one has fallen out", () => {
    let now = 0;
    const limiter = new RateLimiter({
      limit: 3,
      windowMs: 1000,
      bucket: "guild",
      now: () => now,
    });

    limiter.hit("g");
    now = 100;
    limiter.hit("g");
    now = 200;
    limiter.hit("g");

    now = 1000;
    expect(limiter.hit("g")).toBeNull();
  });

  it("counts each key on its own", () => {
    let now = 0;
    const limiter = new RateLimiter({
      limit: 1,
      windowMs: 1000,
      bucket: "guild",
      now: () => now,
    });

    expect(limiter.hit("a")).toBeNull();
    expect(limiter.hit("b")).toBeNull();
    expect(limiter.hit("a")).toBe(1000);
  });

  it("does not slide the window forward when a hit is refused", () => {
    let now = 0;
    const limiter = new RateLimiter({
      limit: 1,
      windowMs: 1000,
      bucket: "guild",
      now: () => now,
    });

    expect(limiter.hit("g")).toBeNull();

    now = 100;
    expect(limiter.hit("g")).toBe(900);

    // The window has not moved, so the wait is still measured from the
    // first hit.
    now = 200;
    expect(limiter.hit("g")).toBe(800);
  });
});

describe("RateLimiter — the member bucket", () => {
  it("uses a simple timestamp", () => {
    let now = 0;
    const limiter = new RateLimiter({
      limit: 1,
      windowMs: 1000,
      bucket: "member",
      now: () => now,
    });

    expect(limiter.hit("m")).toBeNull();

    now = 500;
    expect(limiter.hit("m")).toBe(500);

    now = 1000;
    expect(limiter.hit("m")).toBeNull();
  });

  it("does not move the timestamp when a hit is refused", () => {
    let now = 0;
    const limiter = new RateLimiter({
      limit: 1,
      windowMs: 1000,
      bucket: "member",
      now: () => now,
    });

    limiter.hit("m");

    now = 500;
    expect(limiter.hit("m")).toBe(500);

    now = 900;
    expect(limiter.hit("m")).toBe(100);
  });

  it("counts each key on its own", () => {
    let now = 0;
    const limiter = new RateLimiter({
      limit: 1,
      windowMs: 1000,
      bucket: "member",
      now: () => now,
    });

    expect(limiter.hit("a")).toBeNull();
    expect(limiter.hit("b")).toBeNull();
  });

  it("treats the user and channel buckets the same way", () => {
    for (const bucket of ["user", "channel"] as const) {
      let now = 0;
      const limiter = new RateLimiter({
        limit: 1,
        windowMs: 1000,
        bucket,
        now: () => now,
      });

      expect(limiter.hit("k")).toBeNull();

      now = 999;
      expect(limiter.hit("k")).toBe(1);
    }
  });
});

describe("RateLimiter — housekeeping", () => {
  it("forgets one key", () => {
    let now = 0;
    const limiter = new RateLimiter({
      limit: 1,
      windowMs: 1000,
      bucket: "member",
      now: () => now,
    });

    limiter.hit("a");
    limiter.reset("a");

    expect(limiter.hit("a")).toBeNull();
  });

  it("forgets every key", () => {
    let now = 0;
    const limiter = new RateLimiter({
      limit: 1,
      windowMs: 1000,
      bucket: "member",
      now: () => now,
    });

    limiter.hit("a");
    limiter.hit("b");
    limiter.reset();

    expect(limiter.size).toBe(0);
    expect(limiter.hit("a")).toBeNull();
  });
});

describe("describeWait", () => {
  it("reads the way Quotient's messages did", () => {
    expect(describeWait(4320)).toBe("4.32 seconds");
  });
});
