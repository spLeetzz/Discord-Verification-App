/**
 * Pagination.
 *
 * Quotient's paginator used four buttons with the custom ids `"first"`,
 * `"previous"`, `"next"` and `"last"` — ids that are global, so two
 * paginators in the same guild collide and the wrong one answers (D7).
 * Here every id is namespaced: `pager:<namespace>:<action>:<page>`.
 *
 * The page number travels in the custom id rather than in a token (D18):
 * "which page am I on" belongs to the message, not to a piece of
 * server-side state. That makes the button stateless — a press can be
 * understood without knowing which paginator object produced the message.
 *
 * The *content* is a separate question. A paginator over a database list
 * has to reload its pages on every press, so the paginator is given a
 * `loadPages` function. A paginator over a fixed list of lines can use the
 * in-memory lines instead.
 *
 * **The look.** The paginator is the row of navigation under every list
 * panel in the bot, so it is one row of grey buttons that read as a unit:
 * "First", "Previous", "Next", "Last". The buttons at the ends of the
 * list are disabled, so the row says where in the list the user is, and
 * the page count sits in the footer of the panel, out of the way of the
 * list itself.
 */

import type {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonInteraction,
  EmbedBuilder,
  RepliableInteraction,
} from "discord.js";
import { respond } from "./context.js";
import type { ReplyHandle, ReplyPayload } from "./context.js";
import { registerButton, registeredPrefixes } from "./router.js";
import { run } from "./fire-and-forget.js";
import {
  label,
  navigationRow,
  panelEmbed,
  secondaryButton,
} from "./ui.js";
import { logger } from "../utils/logger.js";

/** The prefix every paginator button id starts with. */
export const PAGER_CUSTOM_ID_PREFIX = "pager";

/** The four buttons a paginator has. */
export const PAGER_ACTIONS = {
  first: "first",
  previous: "previous",
  next: "next",
  last: "last",
} as const;

/** One of the paginator's four actions. */
export type PagerAction = (typeof PAGER_ACTIONS)[keyof typeof PAGER_ACTIONS];

/** The largest description Discord accepts. */
const MAX_DESCRIPTION = 4096;

/** How long the buttons stay live, in milliseconds. */
const DEFAULT_TIMEOUT_MS = 5 * 60_000;

/**
 * Loads the pages of a paginator.
 *
 * Called again on every button press, so a paginator over a database list
 * shows current data rather than a snapshot.
 */
export type PageSource = () => Promise<readonly (readonly string[])[]>;

/** How a paginator is shaped. */
export interface PaginatorOptions {
  /**
   * The namespace the custom ids carry.
   *
   * One namespace per paginator on screen. Two paginators with the same
   * namespace share their buttons, so give each its own name.
   */
  namespace: string;
  /** How many lines go on a page. Defaults to 10. */
  perPage?: number;
  /** How long the buttons stay live, in milliseconds. Defaults to 5 minutes. */
  timeoutMs?: number;
  /** The colour of the embed. Defaults to the bot's colour. */
  color?: number;
  /** The title of the embed. */
  title?: string;
  /** Whether the footer shows the page count. Defaults to `true`. */
  showPageCount?: boolean;
  /**
   * Where the pages come from.
   *
   * When it is absent, the lines added with `addLine` are used.
   */
  loadPages?: PageSource;
}

/** What the router needs to answer a paginator press. */
interface PagerEntry {
  readonly load: PageSource;
  readonly options: PaginatorOptions;
}

/**
 * The registered paginators, by namespace.
 *
 * The router handler resolves the paginator through this map rather than
 * closing over an instance, so a paginator that is rebuilt (a command run
 * twice) does not leave the older message talking to a dead object.
 */
const registry = new Map<string, PagerEntry>();

/**
 * Registers the pages of a namespace.
 *
 * Called by the paginator itself; exposed so a module can refresh the
 * content of a paginator it does not hold an instance of.
 */
export function registerPageSource(
  namespace: string,
  load: PageSource,
  options: PaginatorOptions,
): void {
  registry.set(namespace, { load, options });
}

/**
 * The custom id of a paginator button.
 *
 * @param action what the button does.
 * @param page   the page the button was rendered on. The handler reads it
 *               to work out where "next" and "previous" go.
 */
export function pagerCustomId(
  namespace: string,
  action: PagerAction,
  page: number,
): string {
  return `${PAGER_CUSTOM_ID_PREFIX}:${namespace}:${action}:${page}`;
}

/**
 * Splits a paginator button id back into its parts.
 *
 * @returns the namespace, the action and the page, or `null` when the id
 *          is not a paginator id.
 */
export function parsePagerCustomId(
  customId: string,
): { namespace: string; action: PagerAction; page: number } | null {
  const parts = customId.split(":");

  if (parts.length < 3) return null;
  if (parts[0] !== PAGER_CUSTOM_ID_PREFIX) return null;

  const namespace = parts[1];
  const action = parts[2];

  if (!namespace) return null;
  if (!action || !isPagerAction(action)) return null;

  const page = Number(parts[3] ?? "0");

  return { namespace, action, page: Number.isFinite(page) ? page : 0 };
}

/**
 * Is this one of the four actions?
 */
function isPagerAction(value: string): value is PagerAction {
  return (
    value === PAGER_ACTIONS.first ||
    value === PAGER_ACTIONS.previous ||
    value === PAGER_ACTIONS.next ||
    value === PAGER_ACTIONS.last
  );
}

/**
 * The embed for a page.
 *
 * A panel is a title, the data, and a footer that says where the user
 * is: the page count goes in the footer, where it is out of the way of
 * the list.
 */
export function buildPagerEmbed(
  pages: readonly (readonly string[])[],
  index: number,
  options: PaginatorOptions,
): EmbedBuilder {
  const lines = pages[index] ?? [];
  const description = lines.join("\n").slice(0, MAX_DESCRIPTION);

  return panelEmbed({
    title: pagerTitle(options),
    description,
    color: options.color,
    footer:
      options.showPageCount !== false
        ? `Page ${index + 1} of ${pages.length}`
        : undefined,
  });
}

/**
 * The title of a paginator's panel.
 *
 * A caller usually names its own list, and that name is the title. A
 * paginator without one still gets a title, because a panel without a
 * title is not a panel.
 */
function pagerTitle(options: PaginatorOptions): string {
  const title = options.title?.trim();

  return title ? title : "Results";
}

/**
 * The button row for a page.
 *
 * One row of navigation, all of it grey: the buttons at the ends of the
 * list are disabled, as in Quotient, so the disabled state says which
 * end of the list the user is on.
 */
export function buildPagerRow(
  namespace: string,
  index: number,
  pageCount: number,
): ActionRowBuilder<ButtonBuilder> {
  const isFirst = index <= 0;
  const isLast = index >= pageCount - 1;

  return navigationRow(
    secondaryButton({
      customId: pagerCustomId(namespace, PAGER_ACTIONS.first, index),
      label: label(PAGER_ACTIONS.first),
      disabled: isFirst,
    }),
    secondaryButton({
      customId: pagerCustomId(namespace, PAGER_ACTIONS.previous, index),
      label: label(PAGER_ACTIONS.previous),
      disabled: isFirst,
    }),
    secondaryButton({
      customId: pagerCustomId(namespace, PAGER_ACTIONS.next, index),
      label: label(PAGER_ACTIONS.next),
      disabled: isLast,
    }),
    secondaryButton({
      customId: pagerCustomId(namespace, PAGER_ACTIONS.last, index),
      label: label(PAGER_ACTIONS.last),
      disabled: isLast,
    }),
  );
}

/**
 * A paginator over a list of lines.
 */
export class Paginator {
  /** The namespace the custom ids carry. */
  readonly namespace: string;

  private readonly options: PaginatorOptions;
  private readonly lines: string[] = [];

  constructor(options: PaginatorOptions) {
    this.options = options;
    this.namespace = options.namespace;

    const load: PageSource =
      options.loadPages ?? (async () => this.buildPages());

    registerPageSource(options.namespace, load, options);

    // The router handler resolves the paginator through the registry, so a
    // paginator that is rebuilt does not orphan the older message.
    //
    // The handler is the same for every paginator of a namespace — it looks
    // the paginator up by namespace — so the prefix is registered once.
    // Registering it again would be a duplicate, and the router warns about
    // duplicates: a rebuild is normal, and a warning that fires on a normal
    // path is a warning nobody reads.
    const prefix = `${PAGER_CUSTOM_ID_PREFIX}:${options.namespace}`;

    if (!registeredPrefixes().buttons.includes(prefix)) {
      registerButton(prefix, async (interaction, payload) => {
        await handlePagerPress(interaction, options.namespace, payload);
      });
    }
  }

  /**
   * Adds one line.
   */
  addLine(line: string): void {
    this.lines.push(line);
  }

  /**
   * Adds several lines.
   */
  addLines(lines: readonly string[]): void {
    for (const line of lines) this.addLine(line);
  }

  /** How many lines there are. */
  get totalLines(): number {
    return this.lines.length;
  }

  /**
   * The pages, as arrays of lines.
   */
  buildPages(): readonly (readonly string[])[] {
    const perPage = this.options.perPage ?? 10;

    if (perPage <= 0) {
      return this.lines.length === 0 ? [] : [[...this.lines]];
    }

    const pages: string[][] = [];

    for (let index = 0; index < this.lines.length; index += perPage) {
      pages.push(this.lines.slice(index, index + perPage));
    }

    return pages;
  }

  /**
   * The embed for a page.
   */
  buildEmbed(
    pages: readonly (readonly string[])[],
    index: number,
  ): EmbedBuilder {
    return buildPagerEmbed(pages, index, this.options);
  }

  /**
   * The button row for a page.
   */
  buildRow(
    namespace: string,
    index: number,
    pageCount: number,
  ): ActionRowBuilder<ButtonBuilder> {
    return buildPagerRow(namespace, index, pageCount);
  }

  /**
   * Posts the first page.
   *
   * The buttons expire after `timeoutMs`: the row is taken off the message
   * and the page is left where it is. A component collector that never
   * expires is a hazard.
   */
  async start(interaction: RepliableInteraction): Promise<void> {
    const pages = await this.load();

    if (pages.length === 0) {
      await respond(interaction, this.buildEmptyPanel());

      return;
    }

    const handle = await respond(interaction, {
      embeds: [this.buildEmbed(pages, 0)],
      components: [this.buildRow(this.namespace, 0, pages.length)],
    });

    this.expireLater(handle);
  }

  /**
   * The panel for a list with nothing in it.
   *
   * The empty state is the first thing a new user sees, so it is a
   * panel like any other: a title and a line that says what is going
   * on.
   */
  private buildEmptyPanel(): ReplyPayload {
    return {
      embeds: [
        panelEmbed({
          title: pagerTitle(this.options),
          description: "There is nothing to show.",
          color: this.options.color,
        }),
      ],
    };
  }

  /**
   * Takes the buttons off the message when the paginator times out.
   *
   * The edit goes through the handle, so it lands on the message the
   * buttons are on — the interaction's reply, or a follow-up.
   */
  private expireLater(handle: ReplyHandle): void {
    const timeoutMs = this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    const timer = setTimeout(() => {
      run(() => handle.edit({ components: [] }), "paginator.expire");
    }, timeoutMs);

    // A pending expiry is not a reason to keep the process alive.
    timer.unref();
  }

  /**
   * Loads the pages, from the source or from the in-memory lines.
   */
  private async load(): Promise<readonly (readonly string[])[]> {
    const source = this.options.loadPages;

    if (source) return source();

    return this.buildPages();
  }
}

/**
 * Answers a press of one of the paginator's buttons.
 */
async function handlePagerPress(
  interaction: ButtonInteraction,
  namespace: string,
  payload: string | null,
): Promise<void> {
  const entry = registry.get(namespace);

  if (!entry) {
    logger.error(
      `[Paginator] No paginator is registered for the namespace "${namespace}".`,
    );

    return;
  }

  const parts = (payload ?? "").split(":");
  const action = parts[0];

  if (!action || !isPagerAction(action)) {
    logger.error(
      `[Paginator] "${payload}" is not a paginator action. Ignoring the press.`,
    );

    return;
  }

  const page = Number(parts[1] ?? "0");
  const current = Number.isFinite(page) ? page : 0;

  const pages = await entry.load();

  if (pages.length === 0) {
    await interaction.update({
      embeds: [
        panelEmbed({
          title: pagerTitle(entry.options),
          description: "There is nothing to show.",
        }),
      ],
      components: [],
    });

    return;
  }

  const last = pages.length - 1;

  let next = current;

  switch (action) {
    case PAGER_ACTIONS.first:
      next = 0;
      break;
    case PAGER_ACTIONS.previous:
      next = Math.max(0, current - 1);
      break;
    case PAGER_ACTIONS.next:
      next = Math.min(last, current + 1);
      break;
    case PAGER_ACTIONS.last:
      next = last;
      break;
  }

  await interaction.update({
    embeds: [buildPagerEmbed(pages, next, entry.options)],
    components: [buildPagerRow(namespace, next, pages.length)],
  });
}
