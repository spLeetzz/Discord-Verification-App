/**
 * The Discord client this area was registered with.
 *
 * The published slot list is a **message**, so publishing it and
 * refreshing it both need a client. The area's public API — the one the
 * scrims area calls — does not take a client, because the caller that
 * owns the scrim lifecycle is a job handler and not an interaction, and
 * threading a client through every call site would be noise for one
 * value.
 *
 * The client is therefore captured once, when the area is registered
 * (`registerSlotsListeners`), and read from here afterwards.
 *
 * A publish or a refresh before the area is registered is a **no-op**,
 * not a crash: `slotsClient()` answers `null` and the caller says so.
 */

import type { Client } from "discord.js";

/** The client, once the area has been registered. */
let current: Client | null = null;

/**
 * Remembers the client the area was registered with.
 *
 * Called from `registerSlotsListeners`, which the manager's registry
 * calls with the one client the process has.
 */
export function setSlotsClient(client: Client): void {
  current = client;
}

/**
 * The client the area was registered with.
 *
 * @returns `null` before the area is registered.
 */
export function slotsClient(): Client | null {
  return current;
}
