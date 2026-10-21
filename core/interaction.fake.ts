/**
 * A fake Discord interaction, for the tests.
 *
 * `core/` never talks to Discord, so the tests have to stand in for it.
 * This is the stand-in, and it behaves the way discord.js behaves —
 * which is the point:
 *
 *  - `deferred` and `replied` move as the real ones do. A reply sets
 *    `replied`; so does the edit of a deferral.
 *  - `reply()` on an interaction that has already answered throws, the
 *    way the real one does, and so does `followUp()` on one that has not.
 *  - the handle a response hands back resolves a component collector
 *    with the buttons that were **actually sent**, so a test never has
 *    to know the random token in a custom id.
 *  - a collector takes the first click its **filter** accepts and
 *    ignores the rest, the way discord.js does. A click the filter
 *    refuses is not an answer: the collector keeps waiting, and only
 *    gives up when its timeout runs out.
 *  - a collector only ever sees the interactions of the component type
 *    it asked for, and its filter may be asynchronous.
 *
 * Test-only code. Nothing in `core/` imports it.
 */

import { setTimeout as sleep } from "node:timers/promises";
import { vi } from "vitest";
import type { Mock } from "vitest";
import { ComponentType } from "discord.js";
import type {
  AnySelectMenuInteraction,
  ButtonInteraction,
  MessageComponentInteraction,
  ModalBuilder,
  ModalSubmitInteraction,
  RepliableInteraction,
} from "discord.js";

/** The filter a collector is given. */
type CollectorFilter = (
  interaction: MessageComponentInteraction,
) => boolean | Promise<boolean>;

/** The options a collector is given. */
interface CollectorOptions {
  filter?: CollectorFilter;
  /** The type of component the collector waits for. */
  componentType?: ComponentType;
  /** How long the collector waits, in milliseconds. */
  time?: number;
}

/** The handle a response hands back. */
export interface FakeHandle {
  awaitMessageComponent: Mock<
    (options: CollectorOptions) => Promise<MessageComponentInteraction>
  >;
  edit: Mock<(payload: unknown) => Promise<undefined>>;
  /** Every click the collector saw, in order. */
  clicks: SeenClick[];
}

/** One click the collector saw. */
export interface SeenClick {
  /** The id of the member who clicked. */
  userId: string;
  /** The values the click carried. */
  values: string[];
  /** The type of the component that was clicked. */
  componentType: ComponentType;
  /** Whether the collector's filter accepted the click. */
  accepted: boolean;
  /** The `update` the helper made on the click, if it answered. */
  update: Mock;
}

/** Which method sent a message. */
export type SendMethod = "reply" | "editReply" | "followUp";

/** One message the fake sent. */
export interface SentMessage {
  /** Which method sent it. */
  method: SendMethod;
  /** The handle that method handed back. */
  handle: FakeHandle;
  /** The payload the method was given. */
  payload: unknown;
}

/** The spy on one of the interaction's response methods. */
export type ResponseSpy = Mock<(payload: unknown) => Promise<FakeHandle>>;

/** How the fake is set up. */
export interface FakeInteractionOptions {
  /** The interaction starts out deferred, as the dispatcher leaves it. */
  deferred?: boolean;
  /** The interaction starts out having already answered. */
  replied?: boolean;
  /** The values a select menu resolves with. */
  selectValues?: string[];
  /**
   * The id of the member who invoked the interaction.
   *
   * This is the **owner** of a prompt or a menu: the only member whose
   * click the helper accepts, unless the helper was told to allow
   * others.
   */
  userId?: string;
  /**
   * The guild the interaction came from.
   *
   * `null` (the default) means the interaction is not in a guild, so a
   * helper that filters by guild has nothing to filter on.
   */
  guildId?: string | null;
  /**
   * The guild a channel belongs to, by channel id.
   *
   * A `null` value means the channel is a private one, not a channel of
   * any guild. A channel that is not listed cannot be read, the way a
   * channel the bot cannot see cannot be.
   */
  channelGuilds?: Readonly<Record<string, string | null>>;
  /**
   * The clicks to try, in order.
   *
   * The collector takes the first one its filter accepts and ignores the
   * rest. When the list runs out, the collector waits out its timeout
   * and gives up — the way discord.js does.
   *
   * Defaults to a single click by the interaction's own user.
   */
  clicks?: readonly FakeClick[];
}

/** One click to try. */
export interface FakeClick {
  /** The id of the member who clicks. Defaults to the interaction's user. */
  userId?: string;
  /** The values the click carries. Defaults to `selectValues`. */
  values?: string[];
}

/** The fake, and the spies on it. */
export interface FakeInteraction {
  /** The interaction, ready to hand to a helper. */
  interaction: RepliableInteraction;
  reply: ResponseSpy;
  editReply: ResponseSpy;
  followUp: ResponseSpy;
  /** Every message the fake sent, in order. */
  sent: SentMessage[];
}

/**
 * What the fake can tell about the component of a sent message.
 */
export interface SentComponent {
  /** The custom id of the component. */
  readonly customId: string | undefined;
  /** The component type. */
  readonly type: ComponentType | undefined;
  /** The channel types, for a channel select. */
  readonly channelTypes: number[] | undefined;
}

/**
 * Reads the first component of a sent payload.
 *
 * The payload may carry builders or plain data, and the token in a
 * custom id is random, so a test cannot know it in advance — it reads it
 * off the message that was sent.
 */
export function sentComponent(payload: unknown): SentComponent | undefined {
  const rows = (payload as { components?: unknown[] }).components ?? [];
  const row = rows[0] as { components?: unknown[] } | undefined;
  const component = row?.components?.[0] as
    | {
        data?: {
          custom_id?: string;
          type?: ComponentType;
          channel_types?: number[];
        };
        custom_id?: string;
        type?: ComponentType;
        channel_types?: number[];
      }
    | undefined;

  if (!component) return undefined;

  // A builder keeps its data in `data`; plain API data is the data.
  const data = component.data ?? component;

  return {
    customId: data.custom_id,
    type: data.type,
    channelTypes: data.channel_types,
  };
}

/**
 * The component interaction a collector resolves with.
 */
function fakeComponent(
  customId: string,
  values: string[],
  userId: string,
  componentType: ComponentType,
): MessageComponentInteraction & { update: Mock } {
  const update = vi.fn().mockResolvedValue(undefined);

  return {
    customId,
    values,
    user: { id: userId },
    componentType,
    isStringSelectMenu: () => componentType === ComponentType.StringSelect,
    isChannelSelectMenu: () => componentType === ComponentType.ChannelSelect,
    isRoleSelectMenu: () => componentType === ComponentType.RoleSelect,
    update,
  } as unknown as MessageComponentInteraction & { update: Mock };
}

/**
 * Builds a fake interaction.
 */
export function fakeInteraction(
  options: FakeInteractionOptions = {},
): FakeInteraction {
  const state = {
    deferred: options.deferred ?? false,
    replied: options.replied ?? false,
  };

  const ownerId = options.userId ?? "user-1";
  const guildId = options.guildId ?? null;
  const channelGuilds = options.channelGuilds ?? {};

  const sent: SentMessage[] = [];

  const script = (options.clicks ?? [{}]).map((click) => ({
    userId: click.userId ?? ownerId,
    values: click.values ?? options.selectValues ?? [],
  }));

  const client = {
    channels: {
      fetch: vi.fn(async (id: string) => {
        if (!(id in channelGuilds)) {
          throw new Error(`Unknown channel ${id}`);
        }

        const channelGuild = channelGuilds[id] ?? null;

        return {
          id,
          guildId: channelGuild,
          isDMBased: () => channelGuild === null,
        };
      }),
    },
  };

  const send = (method: SendMethod, payload: unknown): FakeHandle => {
    const component = sentComponent(payload);
    const clicks: SeenClick[] = [];

    const handle: FakeHandle = {
      awaitMessageComponent: vi.fn(
        async (collector: CollectorOptions) => {
          if (!component?.customId) {
            throw new Error(`The ${method} carried no component to collect`);
          }

          for (const click of script) {
            // A user clicking the menu that was sent produces a click of
            // that menu's type.
            const componentType = component.type ?? ComponentType.StringSelect;

            // Discord only hands the collector the interactions of the
            // component type it asked for. A click on anything else is
            // not even seen.
            if (
              collector.componentType !== undefined &&
              componentType !== collector.componentType
            ) {
              continue;
            }

            const interaction = fakeComponent(
              component.customId,
              click.values,
              click.userId,
              componentType,
            );

            const accepted =
              !collector.filter || (await collector.filter(interaction));

            clicks.push({
              userId: click.userId,
              values: click.values,
              componentType,
              accepted,
              update: interaction.update,
            });

            if (accepted) {
              return interaction;
            }

            // The filter refused the click. The collector keeps waiting,
            // the way discord.js does — it is not an answer.
          }

          // Nobody's click was accepted. The collector waits out its
          // timeout and then gives up.
          await sleep(collector.time ?? 0);

          throw new Error("No component matched the filter before the timeout");
        },
      ),
      edit: vi.fn().mockResolvedValue(undefined),
      clicks,
    };

    sent.push({ method, handle, payload });

    return handle;
  };

  const reply: ResponseSpy = vi.fn(async (payload: unknown) => {
    if (state.deferred || state.replied) {
      throw new Error("Cannot reply to a deferred or replied interaction");
    }

    state.replied = true;

    return send("reply", payload);
  });

  const editReply: ResponseSpy = vi.fn(async (payload: unknown) => {
    if (!state.deferred && !state.replied) {
      throw new Error("Cannot edit a reply that was never sent");
    }

    state.replied = true;

    return send("editReply", payload);
  });

  const followUp: ResponseSpy = vi.fn(async (payload: unknown) => {
    if (!state.deferred && !state.replied) {
      throw new Error(
        "Cannot follow up on an interaction that has not answered",
      );
    }

    state.replied = true;

    return send("followUp", payload);
  });

  const interaction = {
    get deferred(): boolean {
      return state.deferred;
    },
    get replied(): boolean {
      return state.replied;
    },
    user: { id: ownerId },
    guildId,
    client,
    reply,
    editReply,
    followUp,
  } as unknown as RepliableInteraction;

  return { interaction, reply, editReply, followUp, sent };
}

/* ------------------------------------------------------------------ *
 * The component interactions
 * ------------------------------------------------------------------ */

/**
 * A message a component sits on.
 *
 * The fake carries an `edit` spy, which is what a handler that
 * re-renders a panel reaches for.
 */
export interface FakeMessage {
  /** The id of the message. */
  readonly id: string;
  /** The edits the message was given. */
  readonly edit: Mock<(payload: unknown) => Promise<void>>;
}

/**
 * Builds a message.
 */
export function fakeMessage(id = "message-1"): FakeMessage {
  return { id, edit: vi.fn(async () => undefined) };
}

/** How a select-menu fake is built. */
export interface FakeSelectOptions {
  /** The custom id the menu carries. */
  readonly customId: string;
  /** The values the menu was answered with. */
  readonly values: readonly string[];
  /** The id of the member who pressed it. */
  readonly userId?: string;
}

/** A select-menu interaction, and the spies on it. */
export interface FakeSelect {
  /** The interaction, ready to hand to the router. */
  readonly interaction: AnySelectMenuInteraction;
  /** The modal the interaction showed. */
  readonly showModal: Mock<(modal: ModalBuilder) => Promise<void>>;
  /** The reply the interaction made. */
  readonly reply: Mock<(payload?: unknown) => Promise<void>>;
}

/**
 * Builds a select-menu interaction.
 */
export function fakeSelect(options: FakeSelectOptions): FakeSelect {
  const state = { replied: false };

  const showModal = vi.fn(async (_modal: ModalBuilder) => undefined);
  const reply = vi.fn(async (_payload?: unknown) => {
    state.replied = true;
  });

  const interaction = {
    customId: options.customId,
    values: [...options.values],
    user: { id: options.userId ?? "user-1" },
    isButton: () => false,
    isAnySelectMenu: () => true,
    isModalSubmit: () => false,
    showModal,
    reply,
    get replied(): boolean {
      return state.replied;
    },
    deferred: false,
  } as unknown as AnySelectMenuInteraction;

  return { interaction, showModal, reply };
}

/** How a modal-submit fake is built. */
export interface FakeModalOptions {
  /** The custom id the modal carries. */
  readonly customId: string;
  /**
   * The values of the modal's fields, by their custom id.
   *
   * A field that is not listed is not there, and reading it throws —
   * which is what discord.js does.
   */
  readonly fields?: Readonly<Record<string, string>>;
  /** The id of the member who submitted it. */
  readonly userId?: string;
  /** The message the modal was opened from. */
  readonly message?: FakeMessage | null;
  /**
   * The interaction starts out deferred.
   *
   * The dispatcher defers every modal submit with an ephemeral reply
   * before it hands the interaction to the router, so this is the
   * normal case.
   */
  readonly deferred?: boolean;
}

/** A modal-submit interaction, and the spies on it. */
export interface FakeModal {
  /** The interaction, ready to hand to the router. */
  readonly interaction: ModalSubmitInteraction;
  /** The deferred update the interaction made. */
  readonly deferUpdate: Mock<() => Promise<void>>;
  /** The edit of the reply the interaction made. */
  readonly editReply: Mock<(payload?: unknown) => Promise<void>>;
  /** The reply the interaction made. */
  readonly reply: Mock<(payload?: unknown) => Promise<void>>;
}

/**
 * Builds a modal-submit interaction.
 */
export function fakeModal(options: FakeModalOptions): FakeModal {
  const values = options.fields ?? {};
  const state = { replied: false, deferred: options.deferred ?? false };

  const deferUpdate = vi.fn(async () => {
    state.deferred = true;
  });

  const editReply = vi.fn(async (_payload?: unknown) => {
    state.replied = true;
  });

  const reply = vi.fn(async (_payload?: unknown) => {
    state.replied = true;
  });

  const interaction = {
    customId: options.customId,
    user: { id: options.userId ?? "user-1" },
    isButton: () => false,
    isAnySelectMenu: () => false,
    isModalSubmit: () => true,
    fields: {
      getTextInputValue: (id: string): string => {
        const value = values[id];

        if (value === undefined) {
          throw new Error(`The modal carried no field with the id "${id}"`);
        }

        return value;
      },
    },
    message: options.message ?? null,
    deferUpdate,
    editReply,
    reply,
    get replied(): boolean {
      return state.replied;
    },
    get deferred(): boolean {
      return state.deferred;
    },
  } as unknown as ModalSubmitInteraction;

  return { interaction, deferUpdate, editReply, reply };
}

/** How a button fake is built. */
export interface FakeButtonOptions {
  /** The custom id the button carries. */
  readonly customId: string;
  /** The id of the member who pressed it. */
  readonly userId?: string;
}

/** A button interaction, and the spies on it. */
export interface FakeButton {
  /** The interaction, ready to hand to the router. */
  readonly interaction: ButtonInteraction;
  /** The reply the interaction made. */
  readonly reply: Mock<(payload?: unknown) => Promise<void>>;
}

/**
 * Builds a button interaction.
 */
export function fakeButton(options: FakeButtonOptions): FakeButton {
  const state = { replied: false };

  const reply = vi.fn(async (_payload?: unknown) => {
    state.replied = true;
  });

  const interaction = {
    customId: options.customId,
    user: { id: options.userId ?? "user-1" },
    isButton: () => true,
    isAnySelectMenu: () => false,
    isModalSubmit: () => false,
    reply,
    get replied(): boolean {
      return state.replied;
    },
    deferred: false,
  } as unknown as ButtonInteraction;

  return { interaction, reply };
}
