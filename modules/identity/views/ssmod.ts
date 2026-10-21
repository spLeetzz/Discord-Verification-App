/**
 * The screenshot-verification panel: the setup wizard and the editor.
 *
 * Quotient had three views for this — `SsmodMainView` (the list of
 * setups), `SetupWizard` (the seven-field wizard) and `SSmodEditor` (the
 * same seven fields plus the success message, over every setup with a
 * pager). discord.js has no views, so the panel is a message whose
 * components carry their state in their custom ids.
 *
 * ## Where the state lives (D18)
 *
 *  - The **wizard** edits a setup that does not exist yet, so its state is
 *    a **token** into an in-memory map. A token is only meaningful to the
 *    process that issued it, which is exactly right for a draft.
 *  - The **editor** edits a row that exists, so the **row id** travels in
 *    the custom id. The panel survives a restart, the message being moved
 *    and the message being edited.
 *
 * The two never share a custom id and never share a handler: the wizard's
 * ids start with `identity:ssmod:setup:` and the editor's with
 * `identity:ssmod:`. The router matches on segment boundaries and the more
 * specific prefix is registered first, so a wizard id is never mistaken
 * for an editor id.
 *
 * ## What was fixed rather than ported
 *
 *  - **The premium type gate (B8).** Quotient assigned the screenshot type
 *    to the record *before* checking the entitlement, and the editor then
 *    wrote every field of the record on the next interaction — so a free
 *    guild ended up with a premium type. The entitlement is checked
 *    **before** the type is assigned, in both paths.
 *  - **The success-message gate (B12).** Quotient disabled the editor's
 *    button for a free guild and had no guard at all in the wizard, so the
 *    gate was bypassable. One `assertEntitled` call covers both paths, and
 *    the button is never silently disabled (D29).
 *  - **Cancelling the wizard (B11).** Quotient added the channel to its
 *    live set as soon as the channel was picked, so cancelling left a
 *    half-configured channel running. The channel only goes live when the
 *    setup is saved.
 */

import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelSelectMenuBuilder,
  ChannelType,
  EmbedBuilder,
  ModalBuilder,
  RoleSelectMenuBuilder,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
} from "discord.js";
import type {
  AnySelectMenuInteraction,
  ButtonInteraction,
  MessageActionRowComponentBuilder,
  ModalSubmitInteraction,
} from "discord.js";
import { TokenStore } from "../../../core/custom-id.js";
import { makeCustomId } from "../../../core/custom-id.js";
import { EMBED_COLOR, ERROR_COLOR } from "../../../core/constants.js";
import { respond } from "../../../core/context.js";
import { errorMessage } from "../../../utils/errors.js";
import { logger } from "../../../utils/logger.js";
import * as service from "../service.js";
import type { ScreenshotType, SsConfig } from "../types.js";
import { SCREENSHOT_TYPE_LABELS } from "../types.js";

/* ------------------------------------------------------------------ *
 * Custom ids
 * ------------------------------------------------------------------ */

/** The prefix of every id of this panel. */
export const SSMOD_PREFIX = "identity:ssmod";

/** The prefix of the **wizard's** ids. Registered before {@link SSMOD_PREFIX}. */
export const SSMOD_SETUP_PREFIX = "identity:ssmod:setup";

/** The actions the panel understands. */
export const SSMOD_ACTIONS = {
  /** Start a wizard. */
  setup: "setup",
  /** Open the editor of a setup. */
  edit: "edit",
  /** The frequently asked questions. */
  faq: "faq",
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
 * Builds a custom id of the panel.
 *
 * @param action what the component does.
 * @param target the row id, or the wizard's token.
 * @param setup whether the id belongs to the wizard.
 */
export function ssModCustomId(
  action: SsModAction,
  target?: string,
  setup = false,
): string {
  const prefix = setup ? "setup:" : "";

  const payload =
    target === undefined ? `${prefix}${action}` : `${prefix}${action}:${target}`;

  return makeCustomId("identity", "ssmod", payload);
}

/**
 * Splits a payload back into its action and its target.
 *
 * The payload is everything after the router's prefix, so it is
 * `<action>[:<target>]`.
 */
export function parseSsModPayload(
  payload: string | null,
): { action: string; target: string | null } {
  if (!payload) return { action: "", target: null };

  const separator = payload.indexOf(":");

  if (separator === -1) return { action: payload, target: null };

  return {
    action: payload.slice(0, separator),
    target: payload.slice(separator + 1),
  };
}

/* ------------------------------------------------------------------ *
 * The wizard's draft
 * ------------------------------------------------------------------ */

/** The state of a wizard that has not been saved yet. */
export interface SsDraft {
  channelId: string | null;
  roleId: string | null;
  requiredSs: number;
  ssType: ScreenshotType | null;
  channelName: string;
  channelLink: string;
  keywords: string[];
  allowSame: boolean;
  successMessage: string | null;
}

/** An empty draft. */
export function emptySsDraft(): SsDraft {
  return {
    channelId: null,
    roleId: null,
    requiredSs: 4,
    ssType: null,
    channelName: "",
    channelLink: "",
    keywords: [],
    allowSame: false,
    successMessage: null,
  };
}

/**
 * The drafts of the wizards that are open.
 *
 * A wizard has no database row yet, so its state is a token (D18).
 */
const drafts = new TokenStore<SsDraft>();

/**
 * Opens a wizard.
 *
 * @returns the token that goes into the custom ids.
 */
export function startSsWizard(): string {
  return drafts.issue(emptySsDraft());
}

/**
 * Reads a draft.
 */
export function readSsDraft(token: string): SsDraft | undefined {
  return drafts.get(token);
}

/**
 * Writes a draft back.
 */
export function writeSsDraft(token: string, draft: SsDraft): void {
  drafts.issue(draft);
}

/**
 * Throws a draft away.
 */
export function dropSsDraft(token: string): void {
  drafts.delete(token);
}

/**
 * Stops the draft store's sweep timer.
 *
 * For the shutdown path and the tests.
 */
export function stopSsWizardStore(): void {
  drafts.stop();
}

/* ------------------------------------------------------------------ *
 * The panel
 * ------------------------------------------------------------------ */

/** What the panel is currently editing. */
export type SsTarget =
  | {
      readonly kind: "setup";
      readonly token: string;
      readonly draft: SsDraft;
    }
  | { readonly kind: "edit"; readonly configId: string; readonly config: SsConfig };

/** The panel, as it is sent to Discord. */
export interface SsPanel {
  readonly embed: EmbedBuilder;
  readonly components: ActionRowBuilder<MessageActionRowComponentBuilder>[];
}

/**
 * The screenshot types the picker offers, in the order they are offered.
 */
export const SCREENSHOT_TYPE_OPTIONS: readonly ScreenshotType[] = [
  "youtube",
  "instagram",
  "rooter",
  "loco",
  "any_ss",
  "custom",
];

/**
 * The counts the picker offers.
 *
 * Quotient's wizard asked for a number between 1 and 5.
 */
export const REQUIRED_SS_OPTIONS: readonly number[] = [1, 2, 3, 4, 5];

/**
 * Builds the panel.
 *
 * The same seven fields as Quotient's wizard — channel, role, required
 * screenshots, screenshot type, page name, page link and "the same
 * screenshot may be reused" — plus the success message, which Quotient
 * only had in the editor.
 */
export function buildSsPanel(target: SsTarget): SsPanel {
  const embed = new EmbedBuilder()
    .setColor(EMBED_COLOR)
    .setTitle(
      target.kind === "setup"
        ? "Screenshot Verification — Setup"
        : "Screenshot Verification — Edit",
    );

  const view = readView(target);

  embed.addFields(
    {
      name: "Channel",
      value: view.channelId ? `<#${view.channelId}>` : "`Not-Set`",
      inline: true,
    },
    {
      name: "Role",
      value: view.roleId ? `<@&${view.roleId}>` : "`Not-Set`",
      inline: true,
    },
    {
      name: "Required screenshots",
      value: `\`${view.requiredSs}\``,
      inline: true,
    },
    {
      name: "Screenshot type",
      value: view.ssType ? `\`${SCREENSHOT_TYPE_LABELS[view.ssType]}\`` : "`Not-Set`",
      inline: true,
    },
    {
      name: "Page name",
      value: view.channelName ? `\`${view.channelName}\`` : "`Not-Set`",
      inline: true,
    },
    {
      name: "Page link",
      value: view.channelLink
        ? `[Click Here](${view.channelLink})`
        : "`Not-Set`",
      inline: true,
    },
    {
      name: "Allow the same screenshot",
      value: view.allowSame ? "`Yes`" : "`No`",
      inline: true,
    },
    {
      name: "Success message",
      value: view.successMessage
        ? `\`${view.successMessage.slice(0, 100)}\``
        : "`Not-Set`",
      inline: true,
    },
  );

  const isSetup = target.kind === "setup";

  const id = isSetup ? target.token : target.configId;

  const channelRow =
    new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
      new ChannelSelectMenuBuilder()
        .setCustomId(ssModCustomId(SSMOD_ACTIONS.setChannel, id, isSetup))
        .setChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
        .setMaxValues(1)
        .setPlaceholder("The channel the screenshots are posted in"),
    );

  const roleRow =
    new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
      new RoleSelectMenuBuilder()
        .setCustomId(ssModCustomId(SSMOD_ACTIONS.setRole, id, isSetup))
        .setMaxValues(1)
        .setPlaceholder(
          "The role the bot grants when the verification succeeds",
        ),
    );

  const typeRow =
    new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId(ssModCustomId(SSMOD_ACTIONS.setType, id, isSetup))
        .setPlaceholder("The kind of screenshot")
        .setMaxValues(1)
        .addOptions(
          SCREENSHOT_TYPE_OPTIONS.map((type) => ({
            label: SCREENSHOT_TYPE_LABELS[type],
            value: type,
          })),
        ),
    );

  const countRow =
    new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId(ssModCustomId(SSMOD_ACTIONS.setCount, id, isSetup))
        .setPlaceholder("How many screenshots are required")
        .setMaxValues(1)
        .addOptions(
          REQUIRED_SS_OPTIONS.map((count) => ({
            label: `${count} screenshot${count === 1 ? "" : "s"}`,
            value: String(count),
          })),
        ),
    );

  const fieldRow =
    new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(ssModCustomId(SSMOD_ACTIONS.pageDetails, id, isSetup))
        .setLabel("Page details")
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId(ssModCustomId(SSMOD_ACTIONS.allowSame, id, isSetup))
        .setLabel("Allow same")
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId(ssModCustomId(SSMOD_ACTIONS.successMessage, id, isSetup))
        .setLabel("Success message")
        .setStyle(ButtonStyle.Secondary),
    );

  const components: ActionRowBuilder<MessageActionRowComponentBuilder>[] = [
    channelRow,
    roleRow,
    typeRow,
    countRow,
    fieldRow,
  ];

  if (isSetup) {
    components.push(
      new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(ssModCustomId(SSMOD_ACTIONS.save, id))
          .setLabel("Save & setup")
          .setStyle(ButtonStyle.Success)
          .setDisabled(!isDraftComplete(target.draft)),
        new ButtonBuilder()
          .setCustomId(ssModCustomId(SSMOD_ACTIONS.close, id))
          .setLabel("Cancel")
          .setStyle(ButtonStyle.Danger),
      ),
    );
  } else {
    components.push(
      new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(ssModCustomId(SSMOD_ACTIONS.delete, id))
          .setLabel("Delete setup")
          .setStyle(ButtonStyle.Danger),
        new ButtonBuilder()
          .setCustomId(ssModCustomId(SSMOD_ACTIONS.close))
          .setLabel("Close")
          .setStyle(ButtonStyle.Secondary),
      ),
    );
  }

  return { embed, components };
}

/** The fields the panel shows, whichever target it is editing. */
interface SsView {
  readonly channelId: string | null;
  readonly roleId: string | null;
  readonly requiredSs: number;
  readonly ssType: ScreenshotType | null;
  readonly channelName: string;
  readonly channelLink: string;
  readonly allowSame: boolean;
  readonly successMessage: string | null;
}

function readView(target: SsTarget): SsView {
  if (target.kind === "setup") {
    const draft = target.draft;

    return {
      channelId: draft.channelId,
      roleId: draft.roleId,
      requiredSs: draft.requiredSs,
      ssType: draft.ssType,
      channelName: draft.channelName,
      channelLink: draft.channelLink,
      allowSame: draft.allowSame,
      successMessage: draft.successMessage,
    };
  }

  const config = target.config;

  return {
    channelId: config.channelId,
    roleId: config.roleId,
    requiredSs: config.requiredSs,
    ssType: config.ssType,
    channelName: config.channelName,
    channelLink: config.channelLink,
    allowSame: config.allowSame,
    successMessage: config.successMessage,
  };
}

/**
 * Is the wizard ready to be saved?
 *
 * Quotient enabled the save button once the channel, the role, the
 * required count, the type and the page name were set.
 */
export function isDraftComplete(draft: SsDraft): boolean {
  return (
    draft.channelId !== null &&
    draft.roleId !== null &&
    draft.requiredSs > 0 &&
    draft.ssType !== null &&
    draft.channelName.length > 0
  );
}

/* ------------------------------------------------------------------ *
 * Modals
 * ------------------------------------------------------------------ */

/** The custom id of the page-details modal. */
export function pageDetailsModalId(target: string, setup: boolean): string {
  return ssModCustomId(SSMOD_ACTIONS.pageDetails, target, setup);
}

/** The custom id of the-success-message modal. */
export function successMessageModalId(target: string, setup: boolean): string {
  return ssModCustomId(SSMOD_ACTIONS.successMessage, target, setup);
}

/**
 * Builds the modal that asks for the page name and the page link.
 */
export function buildPageDetailsModal(
  target: string,
  setup: boolean,
  current: { channelName: string; channelLink: string },
): ModalBuilder {
  return new ModalBuilder()
    .setCustomId(pageDetailsModalId(target, setup))
    .setTitle("The page the screenshot must belong to")
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("name")
          .setLabel("Page name")
          .setPlaceholder("The exact name of the page or channel.")
          .setMaxLength(50)
          .setRequired(true)
          .setStyle(TextInputStyle.Short)
          .setDefault(current.channelName),
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("link")
          .setLabel("Page link")
          .setPlaceholder("The direct link to the page or channel.")
          .setMaxLength(150)
          .setRequired(false)
          .setStyle(TextInputStyle.Short)
          .setDefault(current.channelLink),
      ),
    );
}

/**
 * Builds the modal that asks for the success message.
 */
export function buildSuccessMessageModal(
  target: string,
  setup: boolean,
  current: string | null,
): ModalBuilder {
  return new ModalBuilder()
    .setCustomId(successMessageModalId(target, setup))
    .setTitle("The message shown on a successful verification")
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("message")
          .setLabel("Success message")
          .setPlaceholder("Leave empty to remove it.")
          .setMaxLength(500)
          .setRequired(false)
          .setStyle(TextInputStyle.Paragraph)
          .setDefault(current ?? ""),
      ),
    );
}

/* ------------------------------------------------------------------ *
 * The main panel
 * ------------------------------------------------------------------ */

/**
 * Builds the panel that lists a guild's setups.
 */
export function buildSsListPanel(configs: readonly SsConfig[]): SsPanel {
  const embed = new EmbedBuilder()
    .setColor(EMBED_COLOR)
    .setTitle("Screenshot Verification");

  if (configs.length === 0) {
    embed.setDescription(
      "No screenshot-verification setups yet.\nUse **Setup** to create one.",
    );
  } else {
    embed.setDescription(
      configs
        .map(
          (config, index) =>
            `\`${index + 1}.\` <#${config.channelId}> — ${SCREENSHOT_TYPE_LABELS[config.ssType]}`,
        )
        .join("\n"),
    );
  }

  const setupRow =
    new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(ssModCustomId(SSMOD_ACTIONS.setup))
        .setLabel("Setup")
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(ssModCustomId(SSMOD_ACTIONS.faq))
        .setLabel("FAQ")
        .setStyle(ButtonStyle.Secondary),
    );

  const components: ActionRowBuilder<MessageActionRowComponentBuilder>[] = [setupRow];

  if (configs.length > 0) {
    components.push(
      new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
        ...configs.slice(0, 5).map((config) =>
          new ButtonBuilder()
            .setCustomId(ssModCustomId(SSMOD_ACTIONS.edit, config.id))
            .setLabel(`Edit ${SCREENSHOT_TYPE_LABELS[config.ssType]}`)
            .setStyle(ButtonStyle.Primary),
        ),
      ),
    );
  }

  return { embed, components };
}

/**
 * The frequently asked questions.
 */
export function buildSsFaqEmbed(): EmbedBuilder {
  return new EmbedBuilder()
    .setColor(EMBED_COLOR)
    .setTitle("Screenshot Verification — FAQ")
    .setDescription(
      [
        "**How do I set a verification channel?**",
        "> Press **Setup**, pick the channel, the role, how many screenshots are needed and the kind of screenshot. Then press **Save & setup**.",
        "",
        "**What is a custom filter?**",
        "> A custom filter checks a screenshot for a name and a list of words you choose. Use it for any app — an installation screen, a game, anything.",
        "",
        "**What happens when a screenshot is not valid?**",
        "> The bot says why it was refused and does not count it. Submit enough valid screenshots and the role is granted.",
      ].join("\n"),
    );
}

/* ------------------------------------------------------------------ *
 * The targets
 * ------------------------------------------------------------------ */

/**
 * A target the panel can write to.
 *
 * The setup variant holds the draft by reference so a change is visible to
 * the renderer without another lookup.
 */
export type ResolvedTarget =
  | {
      readonly kind: "setup";
      readonly token: string;
      readonly guildId: string | null;
      readonly draft: SsDraft;
      keywords(): readonly string[];
    }
  | {
      readonly kind: "edit";
      readonly configId: string;
      readonly guildId: string;
      config: SsConfig;
      keywords(): readonly string[];
    };

/**
 * Resolves a wizard's token.
 */
export function resolveSetupTarget(
  token: string,
  guildId: string | null,
): ResolvedTarget | null {
  const draft = readSsDraft(token);

  if (!draft) return null;

  return {
    kind: "setup",
    token,
    guildId,
    draft,
    keywords: () => draft.keywords,
  };
}

/**
 * Resolves a setup's row id.
 */
export async function resolveEditTarget(
  configId: string,
): Promise<ResolvedTarget | null> {
  const config = await service.findSsConfig(configId);

  if (!config) return null;

  return {
    kind: "edit",
    configId,
    guildId: config.guildId,
    config,
    keywords: () => config.keywords,
  };
}

/* ------------------------------------------------------------------ *
 * Handlers — the wizard
 * ------------------------------------------------------------------ */

/**
 * Answers a button of the **wizard**.
 *
 * Registered for the prefix `identity:ssmod:setup`.
 */
export async function handleSsSetupButton(
  interaction: ButtonInteraction,
  payload: string | null,
): Promise<void> {
  const { action, target } = parseSsModPayload(payload);

  try {
    switch (action) {
      case SSMOD_ACTIONS.setup:
        return await startWizard(interaction);
      case SSMOD_ACTIONS.save:
        return await saveWizard(interaction, target);
      case SSMOD_ACTIONS.close:
        return await closePanel(interaction, target);
      case SSMOD_ACTIONS.allowSame:
        return await toggleAllowSame(interaction, target);
      case SSMOD_ACTIONS.pageDetails:
        return await openPageDetailsModal(interaction, target);
      case SSMOD_ACTIONS.successMessage:
        return await openSuccessMessageModal(interaction, target);
      default:
        logger.debug(`[Identity] Unknown ssmod wizard action "${action}".`);

        return undefined;
    }
  } catch (error) {
    await respond(interaction, { content: errorMessage(error) }, true);
  }
}

/**
 * Answers a select menu of the **wizard**.
 */
export async function handleSsSetupSelect(
  interaction: AnySelectMenuInteraction,
  payload: string | null,
): Promise<void> {
  const { action, target } = parseSsModPayload(payload);

  const resolved = resolveSetupTarget(target ?? "", interaction.guildId);

  if (!resolved) {
    await respond(
      interaction,
      { content: "This wizard has expired. Please run the command again." },
      true,
    );

    return;
  }

  try {
    switch (action) {
      case SSMOD_ACTIONS.setChannel: {
        const value = interaction.values[0];

        if (value) await applyChannel(resolved, value);

        break;
      }
      case SSMOD_ACTIONS.setRole: {
        const value = interaction.values[0];

        if (value) await applyRole(resolved, value);

        break;
      }
      case SSMOD_ACTIONS.setType: {
        const value = interaction.values[0];

        if (value) await applyType(resolved, value);

        break;
      }
      case SSMOD_ACTIONS.setCount: {
        const value = interaction.values[0];

        if (value) await applyCount(resolved, value);

        break;
      }
      default:
        logger.debug(`[Identity] Unknown ssmod wizard select "${action}".`);

        return;
    }
  } catch (error) {
    await respond(interaction, { content: errorMessage(error) }, true);

    return;
  }

  await renderPanel(interaction, resolved);
}

/**
 * Answers a modal of the **wizard**.
 */
export async function handleSsSetupModal(
  interaction: ModalSubmitInteraction,
  payload: string | null,
): Promise<void> {
  const { action, target } = parseSsModPayload(payload);

  const resolved = resolveSetupTarget(target ?? "", interaction.guildId);

  if (!resolved) {
    await respond(
      interaction,
      { content: "This wizard has expired. Please run the command again." },
      true,
    );

    return;
  }

  try {
    if (action === SSMOD_ACTIONS.pageDetails) {
      const name = interaction.fields.getTextInputValue("name").trim();
      const link = interaction.fields.getTextInputValue("link").trim();

      await applyPageDetails(resolved, name, link);
    } else if (action === SSMOD_ACTIONS.successMessage) {
      const message = interaction.fields.getTextInputValue("message").trim();

      await applySuccessMessage(resolved, message);
    }
  } catch (error) {
    await respond(interaction, { content: errorMessage(error) }, true);

    return;
  }

  await renderPanel(interaction, resolved);
}

/* ------------------------------------------------------------------ *
 * Handlers — the editor
 * ------------------------------------------------------------------ */

/**
 * Answers a button of the **editor** and of the list panel.
 *
 * Registered for the prefix `identity:ssmod`.
 */
export async function handleSsModButton(
  interaction: ButtonInteraction,
  payload: string | null,
): Promise<void> {
  const { action, target } = parseSsModPayload(payload);

  try {
    switch (action) {
      case SSMOD_ACTIONS.edit:
        return await openEditor(interaction, target);
      case SSMOD_ACTIONS.faq:
        return await respond(interaction, { embeds: [buildSsFaqEmbed()] }, true);
      case SSMOD_ACTIONS.allowSame:
        return await toggleAllowSame(interaction, target);
      case SSMOD_ACTIONS.pageDetails:
        return await openPageDetailsModal(interaction, target);
      case SSMOD_ACTIONS.successMessage:
        return await openSuccessMessageModal(interaction, target);
      case SSMOD_ACTIONS.delete:
        return await deleteSetup(interaction, target);
      case SSMOD_ACTIONS.close:
        return await closePanel(interaction, null);
      default:
        logger.debug(`[Identity] Unknown ssmod button action "${action}".`);

        return undefined;
    }
  } catch (error) {
    await respond(interaction, { content: errorMessage(error) }, true);
  }
}

/**
 * Answers a select menu of the **editor**.
 */
export async function handleSsModSelect(
  interaction: AnySelectMenuInteraction,
  payload: string | null,
): Promise<void> {
  const { action, target } = parseSsModPayload(payload);

  const resolved = await resolveEditTarget(target ?? "");

  if (!resolved) {
    await respond(
      interaction,
      { content: "This panel has expired. Please run the command again." },
      true,
    );

    return;
  }

  try {
    switch (action) {
      case SSMOD_ACTIONS.setChannel: {
        const value = interaction.values[0];

        if (value) await applyChannel(resolved, value);

        break;
      }
      case SSMOD_ACTIONS.setRole: {
        const value = interaction.values[0];

        if (value) await applyRole(resolved, value);

        break;
      }
      case SSMOD_ACTIONS.setType: {
        const value = interaction.values[0];

        if (value) await applyType(resolved, value);

        break;
      }
      case SSMOD_ACTIONS.setCount: {
        const value = interaction.values[0];

        if (value) await applyCount(resolved, value);

        break;
      }
      default:
        logger.debug(`[Identity] Unknown ssmod select "${action}".`);

        return;
    }
  } catch (error) {
    await respond(interaction, { content: errorMessage(error) }, true);

    return;
  }

  await renderPanel(interaction, resolved);
}

/**
 * Answers a modal of the **editor**.
 */
export async function handleSsModModal(
  interaction: ModalSubmitInteraction,
  payload: string | null,
): Promise<void> {
  const { action, target } = parseSsModPayload(payload);

  const resolved = await resolveEditTarget(target ?? "");

  if (!resolved) {
    await respond(
      interaction,
      { content: "This panel has expired. Please run the command again." },
      true,
    );

    return;
  }

  try {
    if (action === SSMOD_ACTIONS.pageDetails) {
      const name = interaction.fields.getTextInputValue("name").trim();
      const link = interaction.fields.getTextInputValue("link").trim();

      await applyPageDetails(resolved, name, link);
    } else if (action === SSMOD_ACTIONS.successMessage) {
      const message = interaction.fields.getTextInputValue("message").trim();

      await applySuccessMessage(resolved, message);
    }
  } catch (error) {
    await respond(interaction, { content: errorMessage(error) }, true);

    return;
  }

  await renderPanel(interaction, resolved);
}

/* ------------------------------------------------------------------ *
 * The handlers, one by one
 * ------------------------------------------------------------------ */

async function startWizard(interaction: ButtonInteraction): Promise<void> {
  const guildId = interaction.guildId;

  if (!guildId) {
    await respond(interaction, { content: "This only works in a server." }, true);

    return;
  }

  // Refuse before the wizard is opened, so the user is not walked through
  // a setup that cannot be saved.
  await service.assertSsConfigAllowance(guildId);

  const token = startSsWizard();

  const panel = buildSsPanel({
    kind: "setup",
    token,
    draft: emptySsDraft(),
  });

  await interaction.update({
    embeds: [panel.embed],
    components: panel.components,
  });
}

async function saveWizard(
  interaction: ButtonInteraction,
  target: string | null,
): Promise<void> {
  if (!target) {
    await respond(interaction, { content: "This wizard has expired." }, true);

    return;
  }

  const draft = readSsDraft(target);

  if (!draft || !isDraftComplete(draft) || draft.ssType === null) {
    await respond(
      interaction,
      { content: "The setup is not finished yet." },
      true,
    );

    return;
  }

  const guildId = interaction.guildId;

  if (!guildId) {
    await respond(interaction, { content: "This only works in a server." }, true);

    return;
  }

  // The entitlement is checked **before** the row is written.
  await service.assertScreenshotTypeAllowed(guildId, draft.ssType);

  const created = await service.createSsConfig({
    guildId,
    channelId: draft.channelId ?? "",
    roleId: draft.roleId ?? "",
    requiredSs: draft.requiredSs,
    channelName: draft.channelName,
    channelLink: draft.channelLink,
    keywords: draft.keywords.length > 0 ? draft.keywords : [draft.channelName],
    allowSame: draft.allowSame,
    ssType: draft.ssType,
    successMessage: draft.successMessage,
  });

  dropSsDraft(target);

  const panel = buildSsPanel({
    kind: "edit",
    configId: created.id,
    config: created,
  });

  await interaction.update({
    embeds: [panel.embed],
    components: panel.components,
  });

  await respond(
    interaction,
    { content: `✅ The setup is live in <#${created.channelId}>.` },
    true,
  );
}

async function openEditor(
  interaction: ButtonInteraction,
  configId: string | null,
): Promise<void> {
  if (!configId) {
    await respond(interaction, { content: "This panel has expired." }, true);

    return;
  }

  const config = await service.findSsConfig(configId);

  if (!config) {
    await respond(
      interaction,
      { content: "That setup no longer exists." },
      true,
    );

    return;
  }

  const panel = buildSsPanel({ kind: "edit", configId, config });

  await interaction.update({
    embeds: [panel.embed],
    components: panel.components,
  });
}

async function toggleAllowSame(
  interaction: ButtonInteraction,
  target: string | null,
): Promise<void> {
  if (!target) {
    await respond(interaction, { content: "This panel has expired." }, true);

    return;
  }

  const resolved =
    resolveSetupTarget(target, interaction.guildId) ??
    (await resolveEditTarget(target));

  if (!resolved) {
    await respond(
      interaction,
      { content: "This panel has expired. Please run the command again." },
      true,
    );

    return;
  }

  if (resolved.kind === "setup") {
    resolved.draft.allowSame = !resolved.draft.allowSame;

    writeSsDraft(resolved.token, resolved.draft);
  } else {
    await service.updateSsConfig(resolved.configId, {
      allowSame: !resolved.config.allowSame,
    });

    resolved.config = {
      ...resolved.config,
      allowSame: !resolved.config.allowSame,
    };
  }

  await renderPanel(interaction, resolved);
}

async function openPageDetailsModal(
  interaction: ButtonInteraction,
  target: string | null,
): Promise<void> {
  if (!target) {
    await respond(interaction, { content: "This panel has expired." }, true);

    return;
  }

  const resolved =
    resolveSetupTarget(target, interaction.guildId) ??
    (await resolveEditTarget(target));

  if (!resolved) {
    await respond(
      interaction,
      { content: "This panel has expired. Please run the command again." },
      true,
    );

    return;
  }

  const current =
    resolved.kind === "setup"
      ? {
          channelName: resolved.draft.channelName,
          channelLink: resolved.draft.channelLink,
        }
      : {
          channelName: resolved.config.channelName,
          channelLink: resolved.config.channelLink,
        };

  await interaction.showModal(
    buildPageDetailsModal(target, resolved.kind === "setup", current),
  );
}

async function openSuccessMessageModal(
  interaction: ButtonInteraction,
  target: string | null,
): Promise<void> {
  if (!target) {
    await respond(interaction, { content: "This panel has expired." }, true);

    return;
  }

  const resolved =
    resolveSetupTarget(target, interaction.guildId) ??
    (await resolveEditTarget(target));

  if (!resolved) {
    await respond(
      interaction,
      { content: "This panel has expired. Please run the command again." },
      true,
    );

    return;
  }

  const current =
    resolved.kind === "setup"
      ? resolved.draft.successMessage
      : resolved.config.successMessage;

  await interaction.showModal(
    buildSuccessMessageModal(target, resolved.kind === "setup", current),
  );
}

async function deleteSetup(
  interaction: ButtonInteraction,
  target: string | null,
): Promise<void> {
  if (!target) {
    await respond(interaction, { content: "This panel has expired." }, true);

    return;
  }

  const config = await service.findSsConfig(target);

  if (!config) {
    await respond(
      interaction,
      { content: "That setup no longer exists." },
      true,
    );

    return;
  }

  await service.deleteSsConfig(config.id);

  await interaction.update({
    embeds: [
      new EmbedBuilder()
        .setColor(EMBED_COLOR)
        .setDescription(
          `🗑️ The setup in <#${config.channelId}> was deleted. Its submissions went with it.`,
        ),
    ],
    components: [],
  });
}

async function closePanel(
  interaction: ButtonInteraction,
  target: string | null,
): Promise<void> {
  if (target) {
    // Throwing the draft away is the whole point: nothing was written, so
    // the channel never went live.
    dropSsDraft(target);
  }

  await interaction.update({
    embeds: [
      new EmbedBuilder()
        .setColor(ERROR_COLOR)
        .setDescription("This panel is closed."),
    ],
    components: [],
  });
}

/* ------------------------------------------------------------------ *
 * Applying a change
 * ------------------------------------------------------------------ */

async function applyChannel(
  resolved: ResolvedTarget,
  channelId: string,
): Promise<void> {
  if (resolved.kind === "setup") {
    resolved.draft.channelId = channelId;

    writeSsDraft(resolved.token, resolved.draft);

    return;
  }

  await service.updateSsConfig(resolved.configId, { channelId });

  resolved.config = { ...resolved.config, channelId };
}

async function applyRole(
  resolved: ResolvedTarget,
  roleId: string,
): Promise<void> {
  if (resolved.kind === "setup") {
    resolved.draft.roleId = roleId;

    writeSsDraft(resolved.token, resolved.draft);

    return;
  }

  await service.updateSsConfig(resolved.configId, { roleId });

  resolved.config = { ...resolved.config, roleId };
}

async function applyType(
  resolved: ResolvedTarget,
  value: string,
): Promise<void> {
  const type = value as ScreenshotType;

  const guildId = resolved.guildId;

  if (!guildId) return;

  // **The check happens before the assignment.** Quotient assigned the
  // type first and checked afterwards, so a free guild ended up with a
  // premium type (B8).
  await service.assertScreenshotTypeAllowed(guildId, type);

  if (resolved.kind === "setup") {
    resolved.draft.ssType = type;

    writeSsDraft(resolved.token, resolved.draft);

    return;
  }

  await service.updateSsConfig(resolved.configId, { ssType: type });

  resolved.config = { ...resolved.config, ssType: type };
}

async function applyCount(
  resolved: ResolvedTarget,
  value: string,
): Promise<void> {
  const count = Number.parseInt(value, 10);

  if (!Number.isInteger(count) || count < 1 || count > 5) {
    throw new RangeError(`"${value}" is not a valid screenshot count.`);
  }

  if (resolved.kind === "setup") {
    resolved.draft.requiredSs = count;

    writeSsDraft(resolved.token, resolved.draft);

    return;
  }

  await service.updateSsConfig(resolved.configId, { requiredSs: count });

  resolved.config = { ...resolved.config, requiredSs: count };
}

async function applyPageDetails(
  resolved: ResolvedTarget,
  name: string,
  link: string,
): Promise<void> {
  const keywords = [
    name,
    ...resolved.keywords().filter((word) => word !== name),
  ];

  if (resolved.kind === "setup") {
    resolved.draft.channelName = name;
    resolved.draft.channelLink = link;
    resolved.draft.keywords = keywords;

    writeSsDraft(resolved.token, resolved.draft);

    return;
  }

  await service.updateSsConfig(resolved.configId, {
    channelName: name,
    channelLink: link,
    keywords,
  });

  resolved.config = {
    ...resolved.config,
    channelName: name,
    channelLink: link,
    keywords,
  };
}

async function applySuccessMessage(
  resolved: ResolvedTarget,
  message: string,
): Promise<void> {
  const guildId = resolved.guildId;

  if (!guildId) return;

  // One gate, both paths. Quotient disabled the editor's button and had
  // no guard in the wizard at all, so the gate was bypassable (B12).
  await service.assertSuccessMessageAllowed(guildId);

  const value = message.length === 0 ? null : message;

  if (resolved.kind === "setup") {
    resolved.draft.successMessage = value;

    writeSsDraft(resolved.token, resolved.draft);

    return;
  }

  await service.updateSsConfig(resolved.configId, { successMessage: value });

  resolved.config = { ...resolved.config, successMessage: value };
}

/* ------------------------------------------------------------------ *
 * Rendering
 * ------------------------------------------------------------------ */

/**
 * Re-renders the panel.
 */
async function renderPanel(
  interaction:
    | ButtonInteraction
    | AnySelectMenuInteraction
    | ModalSubmitInteraction,
  resolved: ResolvedTarget,
): Promise<void> {
  const target: SsTarget =
    resolved.kind === "setup"
      ? { kind: "setup", token: resolved.token, draft: resolved.draft }
      : {
          kind: "edit",
          configId: resolved.configId,
          config: resolved.config,
        };

  const panel = buildSsPanel(target);

  await interaction.update({
    embeds: [panel.embed],
    components: panel.components,
  });
}
