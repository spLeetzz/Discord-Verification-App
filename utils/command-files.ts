import fs from "node:fs";
import path from "node:path";
import type { Command } from "../types/command.js";

const COMMAND_EXTENSIONS = [".js", ".ts"] as const;

/**
 * Lists the command modules inside a category folder.
 *
 * Handles both the compiled layout (JavaScript files under dist) and running
 * straight from source via tsx (TypeScript files under commands). If both
 * exist for the same command, the compiled file wins.
 */
export function listCommandFiles(categoryPath: string): string[] {
  if (!fs.existsSync(categoryPath)) return [];

  const byBaseName = new Map<string, string>();

  for (const file of fs.readdirSync(categoryPath)) {
    const ext = path.extname(file);

    if (
      !COMMAND_EXTENSIONS.includes(ext as (typeof COMMAND_EXTENSIONS)[number])
    ) {
      continue;
    }

    const baseName = path.basename(file, ext);
    const existing = byBaseName.get(baseName);

    if (!existing || (existing.endsWith(".ts") && ext === ".js")) {
      byBaseName.set(baseName, path.join(categoryPath, file));
    }
  }

  return [...byBaseName.values()].sort();
}

export function isCommand(value: unknown): value is Command {
  if (typeof value !== "object" || value === null) return false;

  const candidate = value as Partial<Command>;
  return Boolean(candidate.data) && typeof candidate.execute === "function";
}
