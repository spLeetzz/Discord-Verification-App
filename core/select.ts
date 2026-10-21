/**
 * Waiting for a select menu.
 *
 * Quotient's select menus wrote the chosen value onto the view object
 * (`self.custom_id = interaction.data["values"][0]`) and the caller read it
 * back, sometimes packing two ids into one string
 * (`"slot_id:tourney_id"`). That is the `custom_id` string-packing hack
 * D35 removes: here the value comes back as a plain array of strings.
 *
 * The menu is owned by the caller — only the member who opened it may
 * choose — and the custom id carries a token so two menus open in the
 * same channel cannot be answered by the same click.
 *
 * The token is not a secret: it is in the message, and the message is in a
 * channel other people can read. A select menu is at least as exposed as a
 * button — its options are visible to everybody — so the owner check is
 * on the **user**, not on the id. A caller that wants a menu anyone may
 * answer opts in with `allowOthers: true`.
 *
 * **One interaction yields one collection.** Discord allows an
 * interaction to be replied to once, so a flow that asks two questions
 * puts the second one on a follow-up (`asFollowUp: true`) or on a message
 * it sent itself. This is a Discord constraint, not a limitation of this
 * helper.
 *
 * **Three kinds of menu.** A *string* menu ({@link awaitSelect}) offers
 * the options the caller wrote down. A *channel* menu
 * ({@link awaitChannelSelect}) and a *role* menu ({@link awaitRoleSelect})
 * are **auto-populated**: Discord fills them with the guild's channels and
 * roles, so they are a different component type and need a different
 * helper. The collection rules are the same for all three — the menu
 * belongs to the member who opened it, the timeout takes the menu off the
 * message it is really on — so the three share one implementation.
 *
 * **The wording.** A menu says what it wants in two places: the
 * placeholder on the menu itself and the footer of the panel it sits on.
 * Both say the same thing — "Pick an option", "Pick a channel", "Pick a
 * role" — so the bot asks for things the same way everywhere.
 */

import {
  ActionRowBuilder,
  ChannelSelectMenuBuilder,
  ChannelType,
  ComponentType,
  RoleSelectMenuBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
} from "discord.js";
import type {
  Channel,
  EmbedBuilder,
  MessageComponentInteraction,
  RepliableInteraction,
} from "discord.js";
import { sendCollectable } from "./context.js";
import type { ReplyPayload } from "./context.js";
import { COLLECTOR_CUSTOM_ID_PREFIX, randomId } from "./custom-id.js";
import { panelEmbed } from "./ui.js";

/**
 * The prefix every select-menu custom id starts with.
 *
 * A menu that is *waiting* for an answer is owned by the collector, so
 * these ids carry the collector prefix: the router must leave them alone
 * rather than refuse them as an id nobody owns.
 */
export const SELECT_CUSTOM_ID_PREFIX = `${COLLECTOR_CUSTOM_ID_PREFIX}:select`;

/** The prefix every channel-menu custom id starts with. */
export const CHANNEL_SELECT_CUSTOM_ID_PREFIX =
  `${COLLECTOR_CUSTOM_ID_PREFIX}:channel-select`;

/** The prefix every role-menu custom id starts with. */
export const ROLE_SELECT_CUSTOM_ID_PREFIX =
  `${COLLECTOR_CUSTOM_ID_PREFIX}:role-select`;

/** How long a menu stays open by default. */
const DEFAULT_TIMEOUT_MS = 60_000;

/**
 * The title of a menu's panel.
 *
 * The prompt's panel is titled "Confirm"; a menu's is titled "Choose".
 * Between them they are the two ways the bot asks the user something.
 */
const MENU_TITLE = "Choose";

/** The hint under a menu of options. */
const STRING_MENU_FOOTER = "Pick an option from the menu below.";

/** The hint under a menu of channels. */
const CHANNEL_MENU_FOOTER = "Pick a channel from the menu below.";

/** The hint under a menu of roles. */
const ROLE_MENU_FOOTER = "Pick a role from the menu below.";

/**
 * The hint under each kind of auto-populated menu.
 *
 * A channel menu and a role menu are the same flow with a different
 * component, so the hint follows the component.
 */
const AUTO_MENU_FOOTERS: Readonly<
  Record<ComponentType.ChannelSelect | ComponentType.RoleSelect, string>
> = {
  [ComponentType.ChannelSelect]: CHANNEL_MENU_FOOTER,
  [ComponentType.RoleSelect]: ROLE_MENU_FOOTER,
};

/**
 * The panel a menu is shown on.
 *
 * The question is the description, and the footer carries the hint about
 * what to do next — which is the one thing a menu cannot say for itself.
 */
function menuPanel(question: string, footer: string): EmbedBuilder {
  return panelEmbed({
    title: MENU_TITLE,
    description: question,
    footer,
  });
}

/** Discord's own limits. */
const MAX_OPTIONS = 25;
const MAX_LABEL_LENGTH = 100;
const MAX_VALUE_LENGTH = 100;

/** Discord's limit on how many values one select menu may carry. */
const MAX_VALUES = 25;

/**
 * The channel types a picker offers unless the caller says otherwise.
 *
 * A registration channel and a slotlist channel are text channels, and an
 * announcement channel is the closest thing Discord has to one. A caller
 * that wants voice channels, categories or forums passes `channelTypes`
 * and gets them.
 */
const DEFAULT_CHANNEL_TYPES: readonly ChannelType[] = [
  ChannelType.GuildText,
  ChannelType.GuildAnnouncement,
];

/** One choice in the menu. */
export interface SelectOption {
  /** The text the user reads. At most 100 characters. */
  label: string;
  /** The value handed back to the caller. At most 100 characters. */
  value: string;
  /** A smaller line under the label. */
  description?: string;
  /** The emoji next to the label. */
  emoji?: string;
  /** Whether this option starts out selected. */
  default?: boolean;
}

/** How the menu is shaped. */
export interface AwaitSelectOptions {
  /**
   * How many values the user may choose.
   *
   * Defaults to 1. Discord allows up to 25.
   */
  maxValues?: number;
  /**
   * How long the menu stays open, in milliseconds.
   *
   * Defaults to 60 seconds.
   */
  timeoutMs?: number;
  /** The greyed-out text on the menu. */
  placeholder?: string;
  /** The question shown above the menu. */
  question?: string;
  /**
   * Make the menu ephemeral.
   *
   * Only has an effect when the interaction has not been replied to yet.
   */
  ephemeral?: boolean;
  /**
   * Send the menu as a follow-up message rather than as the interaction's
   * own reply.
   *
   * An interaction can only be replied to once, so a flow that needs two
   * inputs has to use a follow-up for the second one.
   */
  asFollowUp?: boolean;
  /**
   * Let anybody choose, not only the caller.
   *
   * Defaults to `false`: the menu belongs to the member who opened it, and
   * a choice from anybody else is ignored — the collector keeps waiting
   * and the menu stays live for the caller.
   *
   * Turn it on only for a menu that is meant to be open to the channel: a
   * vote, a poll, a "who wants the next slot" question. It is a
   * deliberate, visible choice.
   */
  allowOthers?: boolean;
}

/**
 * How an auto-populated menu is shaped.
 *
 * The same knobs as a string menu, minus the options: Discord fills the
 * menu itself.
 */
export interface AwaitAutoSelectOptions {
  /**
   * How many values the user may choose.
   *
   * Defaults to 1. Discord allows up to 25.
   */
  maxValues?: number;
  /**
   * How long the menu stays open, in milliseconds.
   *
   * Defaults to 60 seconds.
   */
  timeoutMs?: number;
  /** The greyed-out text on the menu. */
  placeholder?: string;
  /** The question shown above the menu. */
  question?: string;
  /**
   * Make the menu ephemeral.
   *
   * Defaults to `true`: a picker is a private choice, and a public one
   * shows the whole channel what is being picked. Only has an effect
   * when the interaction has not been replied to yet.
   */
  ephemeral?: boolean;
  /**
   * Send the menu as a follow-up message rather than as the interaction's
   * own reply.
   *
   * An interaction can only be replied to once, so a flow that needs two
   * inputs has to use a follow-up for the second one.
   */
  asFollowUp?: boolean;
  /**
   * Let anybody choose, not only the caller.
   *
   * Defaults to `false`: the menu belongs to the member who opened it, and
   * a choice from anybody else is ignored — the collector keeps waiting
   * and the menu stays live for the caller.
   *
   * Turn it on only for a menu that is meant to be open to the channel: a
   * vote, a poll, a "who wants the next slot" question. It is a
   * deliberate, visible choice.
   */
  allowOthers?: boolean;
}

/** How a channel menu is shaped. */
export interface AwaitChannelSelectOptions extends AwaitAutoSelectOptions {
  /**
   * The channel types the menu may offer.
   *
   * Defaults to a text channel and an announcement channel — the two types
   * every picker in the bot wants. Pass
   * `[ChannelType.GuildVoice]`, `[ChannelType.GuildCategory]` and so on to
   * widen it, or an empty list to let Discord offer every type it has.
   */
  channelTypes?: readonly ChannelType[];
  /**
   * The guild whose channels may be chosen.
   *
   * Defaults to the guild the interaction came from. A channel of another
   * guild is not an answer: the collector keeps waiting and the menu stays
   * live for the caller.
   *
   * Discord's channel select has no "guild mode" parameter — when the bot
   * is in more than one guild, the client offers a guild picker — so the
   * filter is enforced here, on the answer.
   */
  guildId?: string;
}

/** How a role menu is shaped. */
export type AwaitRoleSelectOptions = AwaitAutoSelectOptions;

/**
 * Opens a select menu and waits for the user to choose.
 *
 * Only the caller may choose, unless `allowOthers` says otherwise.
 *
 * @returns the chosen values, in the order the user chose them. An empty
 *          array means the menu timed out or nobody chose anything.
 */
export async function awaitSelect(
  interaction: RepliableInteraction,
  options: readonly SelectOption[],
  settings: AwaitSelectOptions = {},
): Promise<string[]> {
  if (options.length === 0) {
    throw new TypeError("awaitSelect needs at least one option");
  }

  if (options.length > MAX_OPTIONS) {
    throw new RangeError(
      `awaitSelect accepts at most ${MAX_OPTIONS} options, got ${options.length}`,
    );
  }

  const maxValues = settings.maxValues ?? 1;

  if (maxValues < 1 || maxValues > MAX_OPTIONS) {
    throw new RangeError(
      `awaitSelect needs maxValues between 1 and ${MAX_OPTIONS}, got ${maxValues}`,
    );
  }

  for (const option of options) {
    if (option.label.length > MAX_LABEL_LENGTH) {
      throw new RangeError(
        `A select option's label may be at most ${MAX_LABEL_LENGTH} characters`,
      );
    }

    if (option.value.length > MAX_VALUE_LENGTH) {
      throw new RangeError(
        `A select option's value may be at most ${MAX_VALUE_LENGTH} characters`,
      );
    }
  }

  const timeoutMs = settings.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const allowOthers = settings.allowOthers ?? false;
  const ownerId = interaction.user.id;
  const customId = `${SELECT_CUSTOM_ID_PREFIX}:${randomId()}`;

  const menu = new StringSelectMenuBuilder()
    .setCustomId(customId)
    .setPlaceholder(settings.placeholder ?? "Pick an option")
    .setMinValues(1)
    .setMaxValues(Math.min(maxValues, options.length));

  for (const option of options) {
    const builder = new StringSelectMenuOptionBuilder()
      .setLabel(option.label)
      .setValue(option.value);

    if (option.description) builder.setDescription(option.description);
    if (option.emoji) builder.setEmoji(option.emoji);
    if (option.default) builder.setDefault(true);

    menu.addOptions(builder);
  }

  const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
    menu,
  );

  const handle = await sendCollectable(
    interaction,
    settings.question
      ? {
          embeds: [menuPanel(settings.question, STRING_MENU_FOOTER)],
          components: [row],
        }
      : { components: [row] },
    {
      ephemeral: settings.ephemeral ?? false,
      asFollowUp: settings.asFollowUp ?? false,
    },
  );

  try {
    const answer = await handle.awaitMessageComponent({
      componentType: ComponentType.StringSelect,
      time: timeoutMs,
      // The owner check. A choice from somebody else is not an answer:
      // the collector keeps waiting, and the menu stays live for the
      // caller.
      filter: (candidate) =>
        (allowOthers || candidate.user.id === ownerId) &&
        candidate.customId === customId,
    });

    const values = answer.isStringSelectMenu() ? answer.values : [];

    await answer.update({ components: [] });

    return values;
  } catch {
    // Timed out. Nobody chose anything.
    try {
      // The edit lands on the message the menu is on — the interaction's
      // reply, or the follow-up the menu was sent as.
      await handle.edit({ components: [] });
    } catch {
      // The interaction expired. Nothing to clean up.
    }

    return [];
  }
}

/**
 * Opens a channel menu and waits for a channel.
 *
 * Only the caller may choose, unless `allowOthers` says otherwise.
 *
 * @returns the chosen channel ids. An empty array means the menu timed
 *          out or nobody chose anything.
 */
export async function awaitChannelSelect(
  interaction: RepliableInteraction,
  settings: AwaitChannelSelectOptions = {},
): Promise<string[]> {
  const customId = `${CHANNEL_SELECT_CUSTOM_ID_PREFIX}:${randomId()}`;
  const channelTypes = settings.channelTypes ?? DEFAULT_CHANNEL_TYPES;

  const menu = new ChannelSelectMenuBuilder()
    .setCustomId(customId)
    .setPlaceholder(settings.placeholder ?? "Pick a channel")
    .setMinValues(1)
    .setMaxValues(Math.min(settings.maxValues ?? 1, MAX_VALUES));

  // An empty list means "every type Discord has", which is what leaving
  // `channel_types` off the component does. Sending an empty list would
  // be a menu with nothing in it.
  if (channelTypes.length > 0) {
    menu.setChannelTypes(...channelTypes);
  }

  const row = new ActionRowBuilder<ChannelSelectMenuBuilder>().addComponents(
    menu,
  );

  const guildId = settings.guildId ?? interaction.guildId;

  return collectAutoSelect(
    interaction,
    {
      customId,
      componentType: ComponentType.ChannelSelect,
      components: [row],
      readValues: (answer) =>
        answer.isChannelSelectMenu() ? answer.values : [],
      accepts: guildId
        ? (answer) => channelsAreInGuild(interaction, answer, guildId)
        : undefined,
    },
    settings,
  );
}

/**
 * Opens a role menu and waits for a role.
 *
 * Only the caller may choose, unless `allowOthers` says otherwise.
 *
 * Discord's role select has no role-type filter — the component carries
 * no such field, so a menu cannot be narrowed to, say, the roles a bot
 * manages. The menu offers the guild's roles and nothing else.
 *
 * @returns the chosen role ids. An empty array means the menu timed out
 *          or nobody chose anything.
 */
export async function awaitRoleSelect(
  interaction: RepliableInteraction,
  settings: AwaitRoleSelectOptions = {},
): Promise<string[]> {
  const customId = `${ROLE_SELECT_CUSTOM_ID_PREFIX}:${randomId()}`;

  const menu = new RoleSelectMenuBuilder()
    .setCustomId(customId)
    .setPlaceholder(settings.placeholder ?? "Pick a role")
    .setMinValues(1)
    .setMaxValues(Math.min(settings.maxValues ?? 1, MAX_VALUES));

  const row = new ActionRowBuilder<RoleSelectMenuBuilder>().addComponents(menu);

  return collectAutoSelect(
    interaction,
    {
      customId,
      componentType: ComponentType.RoleSelect,
      components: [row],
      readValues: (answer) => (answer.isRoleSelectMenu() ? answer.values : []),
    },
    settings,
  );
}

/**
 * One auto-populated menu, and how to collect it.
 *
 * A channel picker and a role picker are the same flow with a different
 * component: Discord has a dedicated component type for each, so the menu
 * that is built differs, but the collection — the owner check, the
 * timeout, the cleanup — does not. One implementation, two wrappers.
 */
interface AutoSelectMenu {
  /** The custom id the menu carries. */
  readonly customId: string;
  /** The component type the collector waits for. */
  readonly componentType:
    | ComponentType.ChannelSelect
    | ComponentType.RoleSelect;
  /** The row that carries the menu. */
  readonly components: NonNullable<ReplyPayload["components"]>;
  /** The chosen ids, read off the answer. */
  readonly readValues: (answer: MessageComponentInteraction) => string[];
  /**
   * Whether the answer is acceptable, beyond the owner check.
   *
   * A refusal is not an answer: the collector keeps waiting and the menu
   * stays live for the owner.
   */
  readonly accepts?: (
    answer: MessageComponentInteraction,
  ) => boolean | Promise<boolean>;
}

/**
 * Opens an auto-populated menu and waits for the answer.
 *
 * The owner check, the timeout and the cleanup are the ones
 * {@link awaitSelect} uses.
 */
async function collectAutoSelect(
  interaction: RepliableInteraction,
  menu: AutoSelectMenu,
  settings: AwaitAutoSelectOptions,
): Promise<string[]> {
  const timeoutMs = settings.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const allowOthers = settings.allowOthers ?? false;
  const ownerId = interaction.user.id;

  const handle = await sendCollectable(
    interaction,
    settings.question
      ? {
          embeds: [
            menuPanel(
              settings.question,
              AUTO_MENU_FOOTERS[menu.componentType],
            ),
          ],
          components: menu.components,
        }
      : { components: menu.components },
    {
      ephemeral: settings.ephemeral ?? true,
      asFollowUp: settings.asFollowUp ?? false,
    },
  );

  try {
    const answer = await handle.awaitMessageComponent({
      componentType: menu.componentType,
      time: timeoutMs,
      filter: async (candidate) => {
        if (candidate.customId !== menu.customId) return false;

        // The owner check. A choice from somebody else is not an answer:
        // the collector keeps waiting, and the menu stays live for the
        // caller.
        if (!allowOthers && candidate.user.id !== ownerId) return false;

        if (!menu.accepts) return true;

        return menu.accepts(candidate);
      },
    });

    const values = menu.readValues(answer);

    await answer.update({ components: [] });

    return values;
  } catch {
    // Timed out. Nobody chose anything.
    try {
      // The edit lands on the message the menu is on — the interaction's
      // reply, or the follow-up the menu was sent as.
      await handle.edit({ components: [] });
    } catch {
      // The interaction expired. Nothing to clean up.
    }

    return [];
  }
}

/**
 * Are all the chosen channels channels of this guild?
 *
 * The guild filter, enforced on the answer: Discord's channel select has
 * no "guild mode" parameter, so a menu shown in a guild can still hand
 * back a channel of another guild when the client offers its guild
 * picker.
 */
async function channelsAreInGuild(
  interaction: RepliableInteraction,
  answer: MessageComponentInteraction,
  guildId: string,
): Promise<boolean> {
  if (!answer.isChannelSelectMenu()) return false;

  for (const channelId of answer.values) {
    if (!(await channelIsInGuild(interaction, channelId, guildId))) {
      return false;
    }
  }

  return true;
}

/**
 * Does this channel belong to this guild?
 *
 * The channel is fetched, because only the channel knows what guild it
 * is in. A channel that cannot be read is not one of the guild's
 * channels: it is either gone or out of the bot's reach.
 */
async function channelIsInGuild(
  interaction: RepliableInteraction,
  channelId: string,
  guildId: string,
): Promise<boolean> {
  try {
    const channel = await interaction.client.channels.fetch(channelId);

    return guildOfChannel(channel) === guildId;
  } catch {
    return false;
  }
}

/**
 * The guild a channel belongs to, or `null` for a private one.
 */
function guildOfChannel(channel: Channel | null): string | null {
  if (!channel) return null;

  return channel.isDMBased() ? null : channel.guildId;
}
