/**
 * The premium configuration, read from the environment.
 *
 * Every variable here is **optional**. A guild that never sells premium
 * does not need a merchant key; a bot that is not a payment server does
 * not need a public URL. Nothing in this module throws — the server
 * warns about what is missing, and the payment routes refuse to run
 * without a gateway. That is the difference between `requireEnv` in
 * `utils/env.ts`, which is right for the bot's own token and wrong for
 * a feature a guild may not have bought.
 *
 * `utils/env.js` is imported for its side effect: it loads `.env` from
 * the project root, so the variables are there however the bot was
 * started.
 */

import "../../utils/env.js";
import type { PayuCredentials } from "./payu.js";

/** The variables the premium module reads. */
export const PREMIUM_ENV_VARS = {
  /** The merchant key PayU signs with. */
  payuKey: "PAYU_KEY",
  /** The merchant salt PayU signs with. */
  payuSalt: "PAYU_SALT",
  /** The publicly reachable base URL of the payment server. */
  publicUrl: "PREMIUM_PUBLIC_URL",
  /** The port the payment server listens on. */
  port: "PREMIUM_PORT",
  /** The host the payment server binds to. */
  host: "PREMIUM_SERVER_HOST",
  /** The gateway's form endpoint. */
  action: "PAYU_ACTION",
} as const;

/**
 * The premium configuration, as the environment describes it.
 *
 * Every field is `null` when the variable is not set — nothing here
 * throws, and nothing here guesses.
 */
export interface PremiumEnv {
  /** The merchant credentials, or `null` when they are not configured. */
  readonly credentials: PayuCredentials | null;
  /** The public address of the payment server, or `null`. */
  readonly publicUrl: string | null;
  /** The port the payment server should listen on, or `null`. */
  readonly port: number | null;
  /** The host the payment server should bind to, or `null`. */
  readonly host: string | null;
  /** The gateway's form endpoint, or `null`. */
  readonly action: string | null;
  /**
   * The variables that are set but cannot be used.
   *
   * A port that is not a number is a mistake, not a missing value, and
   * it is worth saying so.
   */
  readonly invalid: readonly string[];
}

/**
 * Reads an environment variable that the bot can run without.
 *
 * @returns the trimmed value, or `null` when it is unset or blank.
 */
export function optionalEnv(
  env: Record<string, string | undefined>,
  name: string,
): string | null {
  const value = env[name]?.trim();

  return value ? value : null;
}

/**
 * Reads a number out of the environment.
 *
 * Strict on purpose: `"42abc"` is a typo, not the number 42, and a
 * silently truncated port is worse than a reported one.
 *
 * @returns the number, or `null` when it is unset or not a number.
 */
export function optionalNumber(
  env: Record<string, string | undefined>,
  name: string,
): number | null {
  const value = optionalEnv(env, name);

  if (value === null) return null;

  const parsed = Number(value);

  if (!Number.isInteger(parsed)) return null;

  return parsed;
}

/**
 * Reads the merchant credentials from the environment.
 *
 * @returns the credentials, or `null` when they are not configured.
 */
export function readPayuCredentials(
  env: Record<string, string | undefined> = process.env,
): PayuCredentials | null {
  const key = optionalEnv(env, PREMIUM_ENV_VARS.payuKey);
  const salt = optionalEnv(env, PREMIUM_ENV_VARS.payuSalt);

  if (!key || !salt) return null;

  return { key, salt };
}

/**
 * Reads the whole premium configuration from the environment.
 */
export function readPremiumEnv(
  env: Record<string, string | undefined> = process.env,
): PremiumEnv {
  const invalid: string[] = [];

  const portValue = optionalEnv(env, PREMIUM_ENV_VARS.port);
  const port = optionalNumber(env, PREMIUM_ENV_VARS.port);

  if (portValue !== null && port === null) {
    invalid.push(PREMIUM_ENV_VARS.port);
  }

  return {
    credentials: readPayuCredentials(env),
    publicUrl: optionalEnv(env, PREMIUM_ENV_VARS.publicUrl),
    port,
    host: optionalEnv(env, PREMIUM_ENV_VARS.host),
    action: optionalEnv(env, PREMIUM_ENV_VARS.action),
    invalid,
  };
}

/**
 * What is wrong with the environment, in words.
 *
 * @returns one line per problem. An empty list means the environment is
 *          complete enough to take a payment.
 */
export function premiumEnvWarnings(env: PremiumEnv): string[] {
  const warnings: string[] = [];

  if (!env.credentials) {
    warnings.push(
      "PAYU_KEY and PAYU_SALT are not set. The payment endpoints will refuse to run.",
    );
  }

  if (!env.publicUrl) {
    warnings.push(
      "PREMIUM_PUBLIC_URL is not set. The premium checkout is disabled.",
    );
  }

  for (const name of env.invalid) {
    warnings.push(`${name} is not a number. The default is used instead.`);
  }

  return warnings;
}
