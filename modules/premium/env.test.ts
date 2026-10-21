/**
 * The premium environment reader.
 *
 * The rule it has to keep: **a bot that does not sell premium still
 * starts.** Nothing here throws, everything that is not set comes back
 * as `null`, and the caller is told what is missing in words it can log.
 */

import { describe, expect, it } from "vitest";
import {
  optionalEnv,
  optionalNumber,
  PREMIUM_ENV_VARS,
  premiumEnvWarnings,
  readPayuCredentials,
  readPremiumEnv,
} from "./env.js";

const COMPLETE = {
  PAYU_KEY: "gtMP0Xrl6",
  PAYU_SALT: "1wPayLO7nm",
  PREMIUM_PUBLIC_URL: "https://premium.example.com",
  PREMIUM_PORT: "8890",
} as const;

describe("modules/premium/env — reading the variables", () => {
  it("reads the merchant credentials", () => {
    expect(readPayuCredentials(COMPLETE)).toEqual({
      key: "gtMP0Xrl6",
      salt: "1wPayLO7nm",
    });
  });

  it("has no credentials when either half is missing", () => {
    expect(readPayuCredentials({ PAYU_KEY: "k" })).toBeNull();
    expect(readPayuCredentials({ PAYU_SALT: "s" })).toBeNull();
    expect(readPayuCredentials({})).toBeNull();
  });

  it("trims the credentials", () => {
    expect(readPayuCredentials({ PAYU_KEY: " k ", PAYU_SALT: " s " })).toEqual({
      key: "k",
      salt: "s",
    });
  });

  it("reads the whole configuration", () => {
    const env = readPremiumEnv(COMPLETE);

    expect(env.credentials).toEqual({ key: "gtMP0Xrl6", salt: "1wPayLO7nm" });
    expect(env.publicUrl).toBe("https://premium.example.com");
    expect(env.port).toBe(8890);
    expect(env.invalid).toEqual([]);
  });

  it("reads nothing but nulls from an empty environment", () => {
    const env = readPremiumEnv({});

    expect(env.credentials).toBeNull();
    expect(env.publicUrl).toBeNull();
    expect(env.port).toBeNull();
    expect(env.host).toBeNull();
    expect(env.action).toBeNull();
    expect(env.invalid).toEqual([]);
  });

  it("does not throw for a missing environment", () => {
    // The bot has to start on a guild that never bought premium.
    expect(() => readPremiumEnv({})).not.toThrow();
  });

  it("treats a blank value as unset", () => {
    expect(optionalEnv({ X: "   " }, "X")).toBeNull();
    expect(optionalEnv({ X: " value " }, "X")).toBe("value");
    expect(optionalEnv({}, "X")).toBeNull();
  });

  it("reads a number, or nothing", () => {
    expect(optionalNumber({ X: "42" }, "X")).toBe(42);
    expect(optionalNumber({ X: "abc" }, "X")).toBeNull();
    expect(optionalNumber({ X: "42abc" }, "X")).toBeNull();
    expect(optionalNumber({ X: "4.5" }, "X")).toBeNull();
    expect(optionalNumber({}, "X")).toBeNull();
  });

  it("names the variables it reads", () => {
    expect(PREMIUM_ENV_VARS.payuKey).toBe("PAYU_KEY");
    expect(PREMIUM_ENV_VARS.payuSalt).toBe("PAYU_SALT");
    expect(PREMIUM_ENV_VARS.publicUrl).toBe("PREMIUM_PUBLIC_URL");
    expect(PREMIUM_ENV_VARS.port).toBe("PREMIUM_PORT");
  });
});

describe("modules/premium/env — the warnings", () => {
  it("says nothing when the environment is complete", () => {
    expect(premiumEnvWarnings(readPremiumEnv(COMPLETE))).toEqual([]);
  });

  it("says what is missing", () => {
    const warnings = premiumEnvWarnings(readPremiumEnv({}));

    expect(warnings.join("\n")).toContain("PAYU_KEY");
    expect(warnings.join("\n")).toContain("PAYU_SALT");
    expect(warnings.join("\n")).toContain("PREMIUM_PUBLIC_URL");
  });

  it("says so when a port is not a number", () => {
    const env = readPremiumEnv({ ...COMPLETE, PREMIUM_PORT: "eight" });

    expect(env.port).toBeNull();
    expect(env.invalid).toEqual(["PREMIUM_PORT"]);
    expect(premiumEnvWarnings(env).join("\n")).toContain("PREMIUM_PORT");
  });
});
