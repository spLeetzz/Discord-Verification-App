import { config as loadEnv } from "dotenv";
import { resolve } from "node:path";
import { PROJECT_ROOT } from "./paths.js";

/**
 * Loads .env from the project root.
 *
 * `dotenv/config` on its own reads from the current working directory, so
 * starting the bot from anywhere else would silently lose the environment.
 * Importing this module has the side effect of populating process.env, which
 * means it has to be imported before anything that reads a variable at
 * module scope.
 */
loadEnv({ path: resolve(PROJECT_ROOT, ".env"), quiet: true });

/**
 * Environment variables are a system boundary — validate them once, at the
 * edge, instead of letting `undefined` leak into the rest of the codebase.
 */
export function requireEnv(name: string): string {
  const value = process.env[name];

  if (!value) {
    throw new Error(
      `Missing required environment variable: ${name}. Check your .env file.`,
    );
  }

  return value;
}
