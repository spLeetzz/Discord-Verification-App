/**
 * The command definitions of this area.
 *
 * Three top-level commands, one per group:
 *
 *  - `/tagcheck` — the channels where a captain registers his team;
 *  - `/easytag`  — the channels where raw ids become mentions;
 *  - `/ssverify` — the screenshot-verification panel.
 *
 * The files under `commands/` are thin adapters; the rules live in the
 * module.
 */

export { tagCheckCommand } from "./tagcheck.js";
export { easyTagCommand } from "./easytag.js";
export { ssVerifyCommand } from "./ssverify.js";

import { tagCheckCommand } from "./tagcheck.js";
import { easyTagCommand } from "./easytag.js";
import { ssVerifyCommand } from "./ssverify.js";

/** Every command of this area. */
export const identityCommands = [
  tagCheckCommand,
  easyTagCommand,
  ssVerifyCommand,
] as const;
