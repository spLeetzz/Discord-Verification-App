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
 * The two never share a custom id, and the id says which one it is: the
 * **surface** is the segment right after the prefix, and it is either
 * `wizard` (the target is a token) or `edit` (the target is a row id).
 * The panel has **one** prefix — `identity:ssmod` — and one registration
 * per kind of component, so no pair of prefixes can shadow each other and
 * no registration order decides which handler runs. See `./ids.ts`.
 *
 * ## Who may press the buttons
 *
 * The panel is a **control panel**: its buttons delete a server's
 * verification setup, repoint the channel the bot reads, change the role
 * the bot grants, and set the text and the link the bot posts. It is
 * opened by a moderator, but it is a **message** — anybody who can read
 * the channel can press its buttons.
 *
 * So every handler checks the caller itself, before the setup is read or
 * written (`../guards.ts`): the caller must be a moderator of the guild
 * the interaction came from, and the setup must belong to **that** guild.
 * The second half is the lookup's job — every read and every write of a
 * setup is keyed by the guild *and* the row id — and the wizard's draft
 * remembers the guild it was started in.
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
 *  - **The panel had no authorisation at all.** Every handler answered
 *    anybody: an ordinary member could delete the server's setup, repoint
 *    the channel and change the role the bot grants. The callers are
 *    checked now, and the rows are looked up in a guild.
 *  - **Two buttons did nothing.** The list panel's **Setup** button was
 *    swallowed by the wizard's prefix, and the wizard's **Save & setup**
 *    and **Cancel** buttons carried the editor's prefix, so the wizard
 *    could never be saved.
 *  - **The panel's prefixes shadowed each other.** The wizard's prefix
 *    was a segment-prefix of the editor's, so the pair worked only
 *    because the wizard was registered first. There is one prefix now.
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
  RepliableInteraction,
} from "discord.js";
import { TokenStore } from "../../../core/custom-id.js";
import { EMBED_COLOR, ERROR_COLOR } from "../../../core/constants.js";
import { respond } from "../../../core/context.js";
import { errorMessage } from "../../../utils/errors.js";
import { logger } from "../../../utils/logger.js";
import { canManageSsConfig } from "../guards.js";
import * as service from "../service.js";
import type { ScreenshotType, SsConfig } from "../types.js";
import { SCREENSHOT_TYPE_LABELS } from "../types.js";
import { SSMOD_ACTIONS, SSMOD_SURFACES, ssModCustomId } from "./ids.js";
import type {
  SsModEditAction,
  SsModId,
  SsModListAction,
  SsModSetupSurface,
  SsModWizardAction,
} from "./ids.js";

/* ------------------------------------------------------------------ *
 * Custom ids
 * ------------------------------------------------------------------ */

/**
 * The panel's custom ids.
 *
 * The scheme lives in `./ids.ts`: the surfaces, the actions, the builder
 * and the parser. This panel builds its ids with that builder and hands
 * them to the router's **one** registration.
 */

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
const drafts = new TokenStore<SsWizard>();

/**
 * A wizard that is open.
 *
 * The guild is part of it: a wizard belongs to the server it was started
 * in, and a draft is never carried from one server to another. Without
 * it, a member of another server who saw the panel could drive the
 * wizard, and the setup would be created in **their** server.
 */
export interface SsWizard {
  /** The guild the wizard was started in. */
  readonly guildId: string;
  /** The draft itself. */
  readonly draft: SsDraft;
}

/**
 * Opens a wizard.
 *
 * @param guildId the guild the wizard belongs to.
 * @returns the token that goes into the custom ids.
 */
export function startSsWizard(guildId: string): string {
  return drafts.issue({ guildId, draft: emptySsDraft() });
}

/**
 * Reads a wizard.
 */
export function readSsWizard(token: string): SsWizard | undefined {
  return drafts.get(token);
}

/**
 * Reads a draft.
 */
export function readSsDraft(token: string): SsDraft | undefined {
  return drafts.get(token)?.draft;
}

/**
 * Writes a draft back.
 *
 * The draft is stored **by reference**, so a change is made by mutating
 * the object the store holds. `Object.assign` copies the changed fields
 * onto it, which keeps the token valid — `TokenStore.issue` would hand
 * out a *new* token and the button would lose its target.
 */
export function writeSsDraft(token: string, draft: SsDraft): void {
  const stored = drafts.get(token);

  if (!stored) return;

  Object.assign(stored.draft, draft);
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

  // The surface is the segment right after the prefix, and it says what
  // the target is: a token for the wizard, a row id for the editor.
  const surface: SsModSetupSurface = isSetup ? "wizard" : "edit";

  const id = isSetup ? target.token : target.configId;

  const channelRow =
    new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
      new ChannelSelectMenuBuilder()
        .setCustomId(ssModCustomId(surface, SSMOD_ACTIONS.setChannel, id))
        .setChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
        .setMaxValues(1)
        .setPlaceholder("The channel the screenshots are posted in"),
    );

  const roleRow =
    new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
      new RoleSelectMenuBuilder()
        .setCustomId(ssModCustomId(surface, SSMOD_ACTIONS.setRole, id))
        .setMaxValues(1)
        .setPlaceholder(
          "The role the bot grants when the verification succeeds",
        ),
    );

  const typeRow =
    new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId(ssModCustomId(surface, SSMOD_ACTIONS.setType, id))
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
        .setCustomId(ssModCustomId(surface, SSMOD_ACTIONS.setCount, id))
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
        .setCustomId(ssModCustomId(surface, SSMOD_ACTIONS.pageDetails, id))
        .setLabel("Page details")
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId(ssModCustomId(surface, SSMOD_ACTIONS.allowSame, id))
        .setLabel("Allow same")
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId(ssModCustomId(surface, SSMOD_ACTIONS.successMessage, id))
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
          // The wizard's own buttons carry the wizard's **surface**, like
          // every other button of the wizard. Without it they were the
          // editor's ids, and the wizard could never be saved.
          .setCustomId(ssModCustomId("wizard", SSMOD_ACTIONS.save, id))
          .setLabel("Save & setup")
          .setStyle(ButtonStyle.Success)
          .setDisabled(!isDraftComplete(target.draft)),
        new ButtonBuilder()
          .setCustomId(ssModCustomId("wizard", SSMOD_ACTIONS.close, id))
          .setLabel("Cancel")
          .setStyle(ButtonStyle.Danger),
      ),
    );
  } else {
    components.push(
      new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(ssModCustomId("edit", SSMOD_ACTIONS.delete, id))
          .setLabel("Delete setup")
          .setStyle(ButtonStyle.Danger),
        new ButtonBuilder()
          .setCustomId(ssModCustomId("edit", SSMOD_ACTIONS.close, id))
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
export function pageDetailsModalId(
  surface: SsModSetupSurface,
  target: string,
): string {
  return ssModCustomId(surface, SSMOD_ACTIONS.pageDetails, target);
}

/** The custom id of the-success-message modal. */
export function successMessageModalId(
  surface: SsModSetupSurface,
  target: string,
): string {
  return ssModCustomId(surface, SSMOD_ACTIONS.successMessage, target);
}

/**
 * Builds the modal that asks for the page name and the page link.
 */
export function buildPageDetailsModal(
  surface: SsModSetupSurface,
  target: string,
  current: { channelName: string; channelLink: string },
): ModalBuilder {
  return new ModalBuilder()
    .setCustomId(pageDetailsModalId(surface, target))
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
          .setValue(current.channelName),
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("link")
          .setLabel("Page link")
          .setPlaceholder("The direct link to the page or channel.")
          .setMaxLength(150)
          .setRequired(false)
          .setStyle(TextInputStyle.Short)
          .setValue(current.channelLink),
      ),
    );
}

/**
 * Builds the modal that asks for the success message.
 */
export function buildSuccessMessageModal(
  surface: SsModSetupSurface,
  target: string,
  current: string | null,
): ModalBuilder {
  return new ModalBuilder()
    .setCustomId(successMessageModalId(surface, target))
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
          .setValue(current ?? ""),
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
        .setCustomId(ssModCustomId("list", SSMOD_ACTIONS.setup))
        .setLabel("Setup")
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(ssModCustomId("list", SSMOD_ACTIONS.faq))
        .setLabel("FAQ")
        .setStyle(ButtonStyle.Secondary),
    );

  const components: ActionRowBuilder<MessageActionRowComponentBuilder>[] = [setupRow];

  if (configs.length > 0) {
    components.push(
      new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
        ...configs.slice(0, 5).map((config) =>
          new ButtonBuilder()
            .setCustomId(ssModCustomId("list", SSMOD_ACTIONS.edit, config.id))
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
      /** The guild the wizard belongs to. */
      readonly guildId: string;
      readonly draft: SsDraft;
      keywords(): readonly string[];
    }
  | {
      readonly kind: "edit";
      readonly configId: string;
      /** The guild the setup belongs to. */
      readonly guildId: string;
      config: SsConfig;
      keywords(): readonly string[];
    };

/**
 * Resolves a wizard's token.
 *
 * The wizard belongs to the guild it was started in, so a token that is
 * used from another server resolves to nothing. The guild the caller is
 * acting in is the one that is compared — the caller has already been
 * checked against it.
 */
export function resolveSetupTarget(
  token: string,
  guildId: string | null,
): ResolvedTarget | null {
  const wizard = readSsWizard(token);

  if (!wizard) return null;

  if (wizard.guildId !== guildId) return null;

  return {
    kind: "setup",
    token,
    guildId: wizard.guildId,
    draft: wizard.draft,
    keywords: () => wizard.draft.keywords,
  };
}

/**
 * Resolves a setup's row id, **in a guild**.
 *
 * The lookup is scoped: a setup of another server is not found, so a row
 * id on its own never reaches another guild's configuration.
 */
export async function resolveEditTarget(
  guildId: string | null,
  configId: string,
): Promise<ResolvedTarget | null> {
  if (!guildId) return null;

  const config = await service.findSsConfig(guildId, configId);

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
 * The handlers
 * ------------------------------------------------------------------ */

/**
 * What the panel answers when its target is gone.
 *
 * A token that has expired and a row that has been deleted look the
 * same from the outside: there is nothing left to edit.
 */
const EXPIRED_MESSAGE = "This panel has expired. Please run the command again.";

/**
 * Refuses an interaction from somebody who may not manage the setups.
 *
 * The check comes **before** the configuration is read or written: a
 * member who may not manage the setups must not be able to change them,
 * and must not learn anything about them either.
 *
 * @returns whether the interaction was refused.
 */
async function refuseSsMod(
  interaction: RepliableInteraction,
  guildId: string | null,
): Promise<boolean> {
  const refusal = await canManageSsConfig(interaction, guildId);

  if (!refusal) return false;

  await respond(interaction, { content: refusal }, true);

  return true;
}

/**
 * Resolves the target of an action.
 *
 * The **surface** says what the target is: a `wizard` target is a token
 * into the draft store, an `edit` target is a row id in the database.
 * The handler therefore knows which one it is holding, instead of trying
 * the wizard first and falling back to the editor.
 *
 * @returns the target, or `null` when the interaction has been answered.
 */
async function resolveTarget(
  interaction: RepliableInteraction,
  surface: SsModSetupSurface,
  target: string | null,
): Promise<ResolvedTarget | null> {
  const resolved =
    surface === "wizard"
      ? resolveSetupTarget(target ?? "", interaction.guildId)
      : await resolveEditTarget(interaction.guildId, target ?? "");

  if (!resolved) {
    await respond(interaction, { content: EXPIRED_MESSAGE }, true);
  }

  return resolved;
}

/**
 * The surface a target belongs to.
 */
function surfaceOf(resolved: ResolvedTarget): SsModSetupSurface {
  return resolved.kind === "setup" ? "wizard" : "edit";
}

/**
 * The id the target is written under: the wizard's token, or the row
 * id.
 */
function targetOf(resolved: ResolvedTarget): string {
  return resolved.kind === "setup" ? resolved.token : resolved.configId;
}

/**
 * Answers a button of the panel.
 *
 * There is **one** handler for every kind of component and **one**
 * prefix for the whole area, so nothing here depends on the order the
 * registrations were made in. The id says which surface the button is
 * on and what it does, and the handler switches on exactly those two
 * segments.
 */
export async function handleSsModButton(
  interaction: ButtonInteraction,
  id: SsModId,
): Promise<void> {
  // The authorisation comes first — before the setup is read, before it is
  // written, and before the panel is even opened.
  if (await refuseSsMod(interaction, interaction.guildId)) return;

  try {
    switch (id.surface) {
      case SSMOD_SURFACES.list:
        await handleListButton(interaction, id.action, id.target);
        return;

      case SSMOD_SURFACES.edit:
        await handleEditorButton(interaction, id.action, id.target);
        return;

      case SSMOD_SURFACES.wizard:
        await handleWizardButton(interaction, id.action, id.target);
        return;
    }
  } catch (error) {
    await respond(interaction, { content: errorMessage(error) }, true);
  }
}

/**
 * Answers a button of the **list panel**.
 */
async function handleListButton(
  interaction: ButtonInteraction,
  action: SsModListAction,
  target: string | null,
): Promise<void> {
  switch (action) {
    case SSMOD_ACTIONS.setup:
      return await startWizard(interaction);

    case SSMOD_ACTIONS.faq:
      await respond(interaction, { embeds: [buildSsFaqEmbed()] }, true);
      return;

    case SSMOD_ACTIONS.edit:
      return await openEditor(interaction, target);
  }
}

/**
 * Answers a button of the **editor**.
 */
async function handleEditorButton(
  interaction: ButtonInteraction,
  action: SsModEditAction,
  target: string | null,
): Promise<void> {
  switch (action) {
    case SSMOD_ACTIONS.delete:
      return await deleteSetup(interaction, target);

    case SSMOD_ACTIONS.close:
      return await closePanel(interaction);

    case SSMOD_ACTIONS.allowSame: {
      const resolved = await resolveTarget(interaction, "edit", target);

      if (!resolved) return;

      return await toggleAllowSame(interaction, resolved);
    }

    case SSMOD_ACTIONS.pageDetails: {
      const resolved = await resolveTarget(interaction, "edit", target);

      if (!resolved) return;

      return await openPageDetailsModal(interaction, resolved);
    }

    case SSMOD_ACTIONS.successMessage: {
      const resolved = await resolveTarget(interaction, "edit", target);

      if (!resolved) return;

      return await openSuccessMessageModal(interaction, resolved);
    }

    default:
      // The rest belong to the select menus.
      logger.debug(`[Identity] The ssmod editor has no button "${action}".`);
      return;
  }
}

/**
 * Answers a button of the **wizard**.
 */
async function handleWizardButton(
  interaction: ButtonInteraction,
  action: SsModWizardAction,
  target: string | null,
): Promise<void> {
  switch (action) {
    case SSMOD_ACTIONS.save:
      return await saveWizard(interaction, target);

    case SSMOD_ACTIONS.close:
      return await closeWizard(interaction, target);

    case SSMOD_ACTIONS.allowSame: {
      const resolved = await resolveTarget(interaction, "wizard", target);

      if (!resolved) return;

      return await toggleAllowSame(interaction, resolved);
    }

    case SSMOD_ACTIONS.pageDetails: {
      const resolved = await resolveTarget(interaction, "wizard", target);

      if (!resolved) return;

      return await openPageDetailsModal(interaction, resolved);
    }

    case SSMOD_ACTIONS.successMessage: {
      const resolved = await resolveTarget(interaction, "wizard", target);

      if (!resolved) return;

      return await openSuccessMessageModal(interaction, resolved);
    }

    default:
      // The rest belong to the select menus.
      logger.debug(`[Identity] The ssmod wizard has no button "${action}".`);
      return;
  }
}

/**
 * Answers a select menu of the panel.
 *
 * The four menus are the same on the editor and on the wizard — the
 * channel, the role, the type and the count — so one handler answers
 * both, and the surface says which target it writes to.
 */
export async function handleSsModSelect(
  interaction: AnySelectMenuInteraction,
  id: SsModId,
): Promise<void> {
  if (await refuseSsMod(interaction, interaction.guildId)) return;

  if (id.surface === SSMOD_SURFACES.list) {
    // The list panel has no menus.
    logger.debug("[Identity] The ssmod list panel has no select menu.");
    return;
  }

  // The setup is looked up **in the caller's guild**, so a row id of
  // another server is not found and cannot be changed.
  const resolved = await resolveTarget(interaction, id.surface, id.target);

  if (!resolved) return;

  try {
    switch (id.action) {
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
        logger.debug(
          `[Identity] The ssmod ${id.surface} has no select "${id.action}".`,
        );

        return;
    }
  } catch (error) {
    await respond(interaction, { content: errorMessage(error) }, true);

    return;
  }

  await renderPanel(interaction, resolved);
}

/**
 * Answers a modal of the panel.
 *
 * A modal is only shown to the person who pressed the button that opened
 * it, so it is owner-only by Discord's own doing — but the guild check
 * still applies: a moderator may have opened a modal on a setup of
 * another server, and the row id in the modal's custom id is not a
 * permission.
 */
export async function handleSsModModal(
  interaction: ModalSubmitInteraction,
  id: SsModId,
): Promise<void> {
  if (await refuseSsMod(interaction, interaction.guildId)) return;

  if (id.surface === SSMOD_SURFACES.list) {
    // The list panel has no modals.
    logger.debug("[Identity] The ssmod list panel has no modal.");
    return;
  }

  const resolved = await resolveTarget(interaction, id.surface, id.target);

  if (!resolved) return;

  try {
    if (id.action === SSMOD_ACTIONS.pageDetails) {
      const name = interaction.fields.getTextInputValue("name").trim();
      const link = interaction.fields.getTextInputValue("link").trim();

      await applyPageDetails(resolved, name, link);
    } else if (id.action === SSMOD_ACTIONS.successMessage) {
      const message = interaction.fields.getTextInputValue("message").trim();

      await applySuccessMessage(resolved, message);
    } else {
      logger.debug(
        `[Identity] The ssmod ${id.surface} has no modal "${id.action}".`,
      );

      return;
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

  // The wizard belongs to this guild, so it cannot be driven from another
  // one.
  const token = startSsWizard(guildId);

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

  // The wizard belongs to the guild it was started in. A wizard that
  // belongs to another server is not saved here.
  const wizard = readSsWizard(target);

  if (!wizard || wizard.guildId !== guildId) {
    await respond(
      interaction,
      { content: "This wizard belongs to another server." },
      true,
    );

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

  const guildId = interaction.guildId;

  if (!guildId) {
    await respond(interaction, { content: "This only works in a server." }, true);

    return;
  }

  // The setup is looked up **in the caller's guild**: a row id of another
  // server is not found.
  const config = await service.findSsConfig(guildId, configId);

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

/**
 * Turns "the same screenshot may be reused" on or off.
 *
 * The target is already resolved, so the handler knows whether it is
 * holding a draft or a row.
 */
async function toggleAllowSame(
  interaction: ButtonInteraction,
  resolved: ResolvedTarget,
): Promise<void> {
  if (resolved.kind === "setup") {
    resolved.draft.allowSame = !resolved.draft.allowSame;

    writeSsDraft(resolved.token, resolved.draft);
  } else {
    await service.updateSsConfig(resolved.guildId, resolved.configId, {
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
  resolved: ResolvedTarget,
): Promise<void> {
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
    buildPageDetailsModal(surfaceOf(resolved), targetOf(resolved), current),
  );
}

async function openSuccessMessageModal(
  interaction: ButtonInteraction,
  resolved: ResolvedTarget,
): Promise<void> {
  const current =
    resolved.kind === "setup"
      ? resolved.draft.successMessage
      : resolved.config.successMessage;

  await interaction.showModal(
    buildSuccessMessageModal(surfaceOf(resolved), targetOf(resolved), current),
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

  const guildId = interaction.guildId;

  if (!guildId) {
    await respond(interaction, { content: "This only works in a server." }, true);

    return;
  }

  // The setup is looked up **in the caller's guild**: a row id of another
  // server is not found, so it cannot be deleted.
  const config = await service.findSsConfig(guildId, target);

  if (!config) {
    await respond(
      interaction,
      { content: "That setup no longer exists." },
      true,
    );

    return;
  }

  await service.deleteSsConfig(config.guildId, config.id);

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

/**
 * Closes the panel.
 *
 * The editor's **Close** button: the setup stays as it is, and the
 * message is closed.
 */
async function closePanel(interaction: ButtonInteraction): Promise<void> {
  await interaction.update({
    embeds: [
      new EmbedBuilder()
        .setColor(ERROR_COLOR)
        .setDescription("This panel is closed."),
    ],
    components: [],
  });
}

/**
 * Closes the **wizard**.
 *
 * Throwing the draft away is the whole point: nothing was written, so
 * the channel never went live.
 */
async function closeWizard(
  interaction: ButtonInteraction,
  target: string | null,
): Promise<void> {
  if (target) {
    dropSsDraft(target);
  }

  await closePanel(interaction);
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

  await service.updateSsConfig(resolved.guildId, resolved.configId, {
    channelId,
  });

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

  await service.updateSsConfig(resolved.guildId, resolved.configId, { roleId });

  resolved.config = { ...resolved.config, roleId };
}

async function applyType(
  resolved: ResolvedTarget,
  value: string,
): Promise<void> {
  const type = value as ScreenshotType;

  // **The check happens before the assignment.** Quotient assigned the
  // type first and checked afterwards, so a free guild ended up with a
  // premium type (B8).
  await service.assertScreenshotTypeAllowed(resolved.guildId, type);

  if (resolved.kind === "setup") {
    resolved.draft.ssType = type;

    writeSsDraft(resolved.token, resolved.draft);

    return;
  }

  await service.updateSsConfig(resolved.guildId, resolved.configId, {
    ssType: type,
  });

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

  await service.updateSsConfig(resolved.guildId, resolved.configId, {
    requiredSs: count,
  });

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

  await service.updateSsConfig(resolved.guildId, resolved.configId, {
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
  // One gate, both paths. Quotient disabled the editor's button and had
  // no guard in the wizard at all, so the gate was bypassable (B12).
  await service.assertSuccessMessageAllowed(resolved.guildId);

  const value = message.length === 0 ? null : message;

  if (resolved.kind === "setup") {
    resolved.draft.successMessage = value;

    writeSsDraft(resolved.token, resolved.draft);

    return;
  }

  await service.updateSsConfig(resolved.guildId, resolved.configId, {
    successMessage: value,
  });

  resolved.config = { ...resolved.config, successMessage: value };
}

/* ------------------------------------------------------------------ *
 * Rendering
 * ------------------------------------------------------------------ */

/**
 * The interactions that carry the panel.
 */
type SsPanelInteraction =
  | ButtonInteraction
  | AnySelectMenuInteraction
  | ModalSubmitInteraction;

/**
 * Re-renders the panel.
 *
 * A button press and a select-menu press are answered with `update`, which
 * acknowledges the interaction and edits the message the component sits on.
 *
 * A **modal submit** has no `update` — the method is not part of
 * `ModalSubmitInteraction` — so the panel message is edited directly and the
 * interaction is acknowledged with a deferred update instead. The modal is
 * always launched from a button on the panel, so the message the modal
 * carries is the panel; the reply path is only a fallback for a modal that
 * was launched from somewhere else.
 */
async function renderPanel(
  interaction: SsPanelInteraction,
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

  if (interaction.isModalSubmit()) {
    await renderPanelAfterModal(interaction, panel);

    return;
  }

  await interaction.update({
    embeds: [panel.embed],
    components: panel.components,
  });
}

/**
 * Re-renders the panel after a modal was submitted.
 */
async function renderPanelAfterModal(
  interaction: ModalSubmitInteraction,
  panel: SsPanel,
): Promise<void> {
  if (!interaction.deferred && !interaction.replied) {
    await interaction.deferUpdate().catch(() => undefined);
  }

  const message = interaction.message;

  if (message) {
    await message.edit({
      embeds: [panel.embed],
      components: panel.components,
    });

    return;
  }

  await interaction.editReply({
    embeds: [panel.embed],
    components: panel.components,
  });
}
