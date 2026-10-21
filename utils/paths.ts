import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Walks up from this module until it finds the directory that holds
 * package.json. Resolves identically whether we run from source (tsx) or from
 * the compiled output in dist/, so config and log paths never drift.
 */
function findProjectRoot(startDir: string): string {
  let dir = startDir;

  for (;;) {
    if (existsSync(resolve(dir, "package.json"))) return dir;

    const parent = dirname(dir);
    if (parent === dir) return startDir;
    dir = parent;
  }
}

export const PROJECT_ROOT = findProjectRoot(
  dirname(fileURLToPath(import.meta.url)),
);

export const CONFIG_DIR = resolve(PROJECT_ROOT, "config");
export const MESSAGE_IDS_PATH = resolve(CONFIG_DIR, "messageIds.json");
export const LOG_PATH = resolve(PROJECT_ROOT, "bot.log");
