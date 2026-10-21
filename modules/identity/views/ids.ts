/**
 * The custom-id scheme of the screenshot-verification panel.
 *
 * ```
 * identity:ssmod:<surface>:<action>[:<target>]
 * ```
 *
 * The panel has three **surfaces** — the list of a guild's setups, the
 * editor of one setup and the wizard that creates one — and one prefix
 * owns all of them. The surface is the segment right after the prefix,
 * the action is the next one, and the target (a row id, or the wizard's
 * token) is the last.
 *
 * ## Why one prefix
 *
 * The panel used to register two: `identity:ssmod` for the editor and
 * `identity:ssmod:wizard` for the wizard. The first is a segment-prefix
 * of the second, so the pair worked **only because the wizard was
 * registered first** — the router takes the first prefix that matches an
 * id, and the order decided which handler ran. Reorder the
 * registrations, or move one into a lazily-imported module, and half the
 * panel stops working with no error anywhere.
 *
 * One prefix and one registration per kind of component removes the
 * whole class of problem: there is no second prefix to shadow the first,
 * so there is no order to get wrong. This is the shape the scrims and
 * the tournaments areas already use (`scrims:editor:…` and
 * `scrims:wizard:…` under the single prefix `scrims`).
 *
 * ## The rule the layout exists for
 *
 * *The segments of a custom id and the segments a handler switches on
 * must be the same ones.*
 *
 * The builder writes the surface to one segment and the action to the
 * next; the parser reads the surface from that segment and the action
 * from the next; the handler switches on the parsed surface and action.
 * There is one place where that is decided — {@link parseSsModId} — so
 * the id and the handler cannot drift apart.
 *
 * The surface is **not** decoration. It says what the target means: a
 * `wizard` target is a token into the draft store, an `edit` target is a
 * row id in the database, and a `list` target is nothing at all. The
 * handler therefore knows which of the two it is holding instead of
 * trying one and falling back to the other.
 */

import { CUSTOM_ID_SEPARATOR, makeCustomId } from "../../../core/custom-id.js";

/** The module that owns the panel's ids. */
const SSMOD_TYPE = "identity";

/** The feature of that module the panel belongs to. */
const SSMOD_FEATURE = "ssmod";

/**
 * The prefix of every id of the panel.
 *
 * It is built by the same helper the ids are built with, so the prefix
 * and the ids cannot drift apart.
 */
export const SSMOD_PREFIX = makeCustomId(SSMOD_TYPE, SSMOD_FEATURE);

/**
 * The surfaces of the panel.
 *
 * The surface is the segment right after the prefix.
 */
export const SSMOD_SURFACES = {
  /** The list of a guild's setups. */
  list: "list",
  /** The editor of one setup. */
  edit: "edit",
  /** The wizard that creates a setup. */
  wizard: "wizard",
} as const;

/** One of the panel's surfaces. */
export type SsModSurface = (typeof SSMOD_SURFACES)[keyof typeof SSMOD_SURFACES];

/**
 * The surfaces that carry a setup.
 *
 * The list panel carries the **list** of the setups, not one of them,
 * so it has no target.
 */
export type SsModSetupSurface = "edit" | "wizard";

/** The actions the panel understands. */
export const SSMOD_ACTIONS = {
  /** Start a wizard. */
  setup: "setup",
  /** The frequently asked questions. */
  faq: "faq",
  /** Open the editor of a setup. */
  edit: "edit",
  /** Pick the channel. */
  setChannel: "set_channel",
  /** Pick the role. */
  setRole: "set_role",
  /** Pick the screenshot type. */
  setType: "set_type",
  /** Pick how many screenshots are required. */
  setCount: "set_count",
  /** Set the page name and link. */
  pageDetails: "page_details",
  /** Set the success message. */
  successMessage: "success_message",
  /** Turn "the same screenshot may be reused" on or off. */
  allowSame: "allow_same",
  /** Save the wizard. */
  save: "save",
  /** Delete a setup. */
  delete: "delete",
  /** Close the panel. */
  close: "close",
} as const;

/** One of the panel's actions. */
export type SsModAction = (typeof SSMOD_ACTIONS)[keyof typeof SSMOD_ACTIONS];

/**
 * The actions of each surface.
 *
 * The list is the surface's whole vocabulary: an id that names an action
 * of another surface is not one of this area's ids, and the parser
 * refuses it. The list panel's **Setup** button and the wizard's
 * **Save** button are different actions of different surfaces, and
 * neither can be mistaken for the other.
 */
export const SSMOD_SURFACE_ACTIONS = {
  list: [SSMOD_ACTIONS.setup, SSMOD_ACTIONS.faq, SSMOD_ACTIONS.edit],
  edit: [
    SSMOD_ACTIONS.setChannel,
    SSMOD_ACTIONS.setRole,
    SSMOD_ACTIONS.setType,
    SSMOD_ACTIONS.setCount,
    SSMOD_ACTIONS.pageDetails,
    SSMOD_ACTIONS.successMessage,
    SSMOD_ACTIONS.allowSame,
    SSMOD_ACTIONS.delete,
    SSMOD_ACTIONS.close,
  ],
  wizard: [
    SSMOD_ACTIONS.setChannel,
    SSMOD_ACTIONS.setRole,
    SSMOD_ACTIONS.setType,
    SSMOD_ACTIONS.setCount,
    SSMOD_ACTIONS.pageDetails,
    SSMOD_ACTIONS.successMessage,
    SSMOD_ACTIONS.allowSame,
    SSMOD_ACTIONS.save,
    SSMOD_ACTIONS.close,
  ],
} as const;

/** The actions of the list panel. */
export type SsModListAction = (typeof SSMOD_SURFACE_ACTIONS.list)[number];

/** The actions of the editor. */
export type SsModEditAction = (typeof SSMOD_SURFACE_ACTIONS.edit)[number];

/** The actions of the wizard. */
export type SsModWizardAction = (typeof SSMOD_SURFACE_ACTIONS.wizard)[number];

/** The action of each surface. */
export interface SsModSurfaceActions {
  readonly list: SsModListAction;
  readonly edit: SsModEditAction;
  readonly wizard: SsModWizardAction;
}

/**
 * A parsed custom id of the panel.
 *
 * The union is discriminated by the **surface**, so a handler that
 * switches on the surface knows exactly which actions it has to answer
 * and what its target means.
 */
export type SsModId =
  | {
      readonly surface: "list";
      readonly action: SsModListAction;
      readonly target: string | null;
    }
  | {
      readonly surface: "edit";
      readonly action: SsModEditAction;
      readonly target: string | null;
    }
  | {
      readonly surface: "wizard";
      readonly action: SsModWizardAction;
      readonly target: string | null;
    };

/**
 * Builds a custom id of the panel.
 *
 * The layout is the same for every id of this area, so the surface and
 * the action are always in the same two segments:
 *
 * ```
 * identity:ssmod:<surface>:<action>[:<target>]
 * ```
 *
 * @param surface the surface the id belongs to.
 * @param action  what the component does. It has to be an action of
 *                that surface — the type says so, and the parser agrees.
 * @param target  the row id, or the wizard's token.
 */
export function ssModCustomId<S extends SsModSurface>(
  surface: S,
  action: SsModSurfaceActions[S],
  target?: string | null,
): string {
  const head = `${surface}${CUSTOM_ID_SEPARATOR}${action}`;

  const payload =
    target === undefined || target === null || target === ""
      ? head
      : `${head}${CUSTOM_ID_SEPARATOR}${target}`;

  return makeCustomId(SSMOD_TYPE, SSMOD_FEATURE, payload);
}

/**
 * Parses the payload the router hands over.
 *
 * The payload is everything after the prefix, so it is
 * `<surface>[:<action>[:<target>]]`.
 *
 * @returns `null` when the payload does not name a surface and an action
 *          of that surface.
 */
export function parseSsModId(payload: string | null): SsModId | null {
  if (!payload) return null;

  const segments = payload.split(CUSTOM_ID_SEPARATOR);

  const surface = segments[0];
  const action = segments[1];

  if (!surface || !action) return null;

  const target = segments.slice(2).join(CUSTOM_ID_SEPARATOR) || null;

  switch (surface) {
    case SSMOD_SURFACES.list:
      return isActionOf(SSMOD_SURFACE_ACTIONS.list, action)
        ? { surface, action, target }
        : null;

    case SSMOD_SURFACES.edit:
      return isActionOf(SSMOD_SURFACE_ACTIONS.edit, action)
        ? { surface, action, target }
        : null;

    case SSMOD_SURFACES.wizard:
      return isActionOf(SSMOD_SURFACE_ACTIONS.wizard, action)
        ? { surface, action, target }
        : null;

    default:
      return null;
  }
}

/**
 * Is this one of the actions of a surface?
 *
 * The check is the surface's own list, so an id that names an action of
 * another surface is refused.
 */
function isActionOf<T extends string>(
  actions: readonly T[],
  value: string,
): value is T {
  return (actions as readonly string[]).includes(value);
}
