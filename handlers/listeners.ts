import type { Client } from "discord.js";
import { registerEmbedDesignerInteractions } from "../core/embed-builder.js";
import { registerButton, registerModal, registerSelect } from "../core/router.js";
import { logger } from "../utils/logger.js";
import { registerJobHandler } from "./jobs.js";

/**
 * The module registry.
 *
 * Each feature area owns a directory under `modules/` and exposes three
 * things the manager wires up:
 *
 * ```ts
 * // modules/<area>/register.ts
 * export function register<Area>Interactions(): void
 * export function register<Area>Listeners(client: Client): void
 * export async function handle<Area>Job(client: Client, event: string, payload: unknown): Promise<void>
 * ```
 *
 * The areas are loaded **dynamically** and every failure is a warning, not a
 * crash. The bot must start even when one area is missing or broken — a
 * feature that does not work is a smaller problem than a bot that will not
 * boot.
 */

interface AreaDefinition {
  /** The directory under `modules/`. */
  readonly dir: string;
  /** The router registration function, without the `register`/`Interactions` parts. */
  readonly interactions: string;
  /**
   * The listener registration function, without the `register`/`Listeners`
   * parts. `null` when the area has no client listeners — the premium area
   * for instance notifies through a notifier and listens to nothing.
   */
  readonly listeners: string | null;
  /**
   * The job handler function, without the `handle`/`Job` parts. `null` when
   * the area schedules nothing.
   */
  readonly job: string | null;
  /** The job events this area handles. Read them from the schema's `CHECK`. */
  readonly jobEvents: readonly string[];
}

const AREAS: readonly AreaDefinition[] = [
  {
    dir: "premium",
    interactions: "Premium",
    listeners: null,
    // Premium expiry is evaluated when the entitlement is read (D15), not by
    // a sweep, so this area schedules nothing.
    job: null,
    jobEvents: [],
  },
  {
    dir: "moderation",
    interactions: "Moderation",
    listeners: null,
    job: "Moderation",
    jobEvents: ["lockdown"],
  },
  {
    dir: "community",
    interactions: "Community",
    listeners: "Community",
    job: "Community",
    jobEvents: ["reminder", "autopurge", "community_daily"],
  },
  {
    dir: "identity",
    interactions: "Identity",
    listeners: "Identity",
    job: null,
    jobEvents: [],
  },
  {
    dir: "scrims",
    interactions: "Scrims",
    listeners: "Scrims",
    job: "Scrims",
    jobEvents: ["scrim_open", "autoclean", "scrim_match", "scrim_ban", "scrim_reserve"],
  },
  {
    dir: "slots",
    interactions: "Slots",
    listeners: "Slots",
    job: null,
    jobEvents: [],
  },
  {
    dir: "tourneys",
    interactions: "Tourneys",
    listeners: "Tourneys",
    job: "Tourneys",
    // The room-credential post deletes itself after thirty minutes, and the
    // daily registration-open.
    jobEvents: ["msg_delete", "tourney_open"],
  },
];

type AreaModule = Record<string, unknown>;

/**
 * The router an area registers its component handlers with.
 *
 * The core router module's three `register*` functions, bundled into the
 * shape an area expects. Areas that import `core/router.js` directly ignore
 * this; it is here so an area that takes a router argument can be handed
 * one without importing the module itself.
 */
const router = { registerButton, registerSelect, registerModal };

/**
 * Loads one area's register module.
 *
 * Both `register.ts` and `index.ts` are tried, because an area may expose
 * its entry points from either.
 */
async function loadArea(dir: string): Promise<AreaModule | null> {
  for (const entry of ["register.js", "index.js"]) {
    try {
      const loaded = (await import(`../modules/${dir}/${entry}`)) as AreaModule;
      return loaded;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);

      // A missing file is the expected case while an area is still landing.
      if (message.includes("Cannot find module") || message.includes("ERR_MODULE_NOT_FOUND")) {
        continue;
      }

      // The module exists but threw while loading. That is a real problem,
      // and it should be loud.
      logger.error(`[Registry] ${dir}/${entry} failed to load: ${message}`);
    }
  }

  return null;
}

function pick(mod: AreaModule, name: string): ((...args: never[]) => unknown) | null {
  const value = mod[name];

  if (typeof value !== "function") return null;

  return value as (...args: never[]) => unknown;
}

/**
 * Wires every area up.
 *
 * Returns a report of what was found and what was missing, so the startup
 * log tells the truth about what is actually running.
 */
export async function registerAreas(client: Client): Promise<{
  loaded: string[];
  missing: string[];
}> {
  // The embed designer is core's, and its ids are core's, so core registers
  // them. It is called explicitly here rather than relying on an area
  // happening to import core/embed-builder.js — the wiring should not
  // depend on somebody else's import graph.
  registerEmbedDesignerInteractions();

  const loaded: string[] = [];
  const missing: string[] = [];

  for (const area of AREAS) {
    const mod = await loadArea(area.dir);

    if (!mod) {
      missing.push(area.dir);
      logger.warn(`[Registry] Area "${area.dir}" is not present — skipping.`);
      continue;
    }

    const interactions = pick(mod, `register${area.interactions}Interactions`);
    const listeners = pick(mod, `register${area.listeners}Listeners`);
    const job = pick(mod, `handle${area.job}Job`);

    if (interactions) {
      // The router is passed whether or not the area wants it — a function
      // that takes no arguments simply ignores it.
      (interactions as (r: typeof router) => void)(router);
    } else if (listeners) {
      // Some areas register the components and the listeners together. If
      // there is no separate interactions function, the listeners function
      // is the area's only entry point and it gets the router too.
      (listeners as (c: Client, r: typeof router) => void)(client, router);
    } else {
      const combined = pick(mod, `register${area.interactions}`);

      if (combined) {
        (combined as (c: Client, r: typeof router) => void)(client, router);
      } else {
        logger.warn(
          `[Registry] Area "${area.dir}" exposes no register function — nothing was wired.`,
        );
        missing.push(area.dir);
        continue;
      }
    }

    if (listeners && interactions) {
      (listeners as (c: Client) => void)(client);
    }

    if (job) {
      for (const event of area.jobEvents) {
        registerJobHandler(event, job as never);
      }
    } else if (area.job !== null && area.jobEvents.length) {
      logger.warn(
        `[Registry] Area "${area.dir}" has no handle${area.job}Job for ${area.jobEvents.join(", ")}.`,
      );
    }

    loaded.push(area.dir);
  }

  logger.info(
    `[Registry] Areas loaded: ${loaded.join(", ") || "none"}${missing.length ? ` — missing: ${missing.join(", ")}` : ""}`,
  );

  return { loaded, missing };
}
