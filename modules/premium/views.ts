/**
 * The premium Discord interactions.
 *
 * One button, one select, one modal:
 *
 * ```
 * /premium  ──▶  premium:buy  ──▶  premium:plan:<token>  ──▶  premium:email:<token>
 *                    (button)          (select menu)            (modal)
 * ```
 *
 * The two wizard steps carry a **token**, not a record id (D18): there is
 * no database row for "a buyer who has not paid yet", and the token
 * points into an in-memory map with a time to live. The token also
 * records who started the flow, so only that person can finish it.
 *
 * The manager's router calls the handlers below through
 * {@link registerPremiumInteractions}; each one returns `true` when the
 * interaction was ours and `false` when it was not, so the router never
 * has to guess an owner from a custom id's shape.
 */

import {
  ActionRowBuilder,
  EmbedBuilder,
  LabelBuilder,
  MessageFlags,
  ModalBuilder,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
} from "discord.js";
import type {
  AnySelectMenuInteraction,
  ButtonInteraction,
  Client,
  ModalSubmitInteraction,
  StringSelectMenuInteraction,
} from "discord.js";
import { randomBytes } from "node:crypto";
import { makeCustomId, parseCustomId, TokenStore } from "../../core/custom-id.js";
import { buildCheckoutUrl, getCheckoutConfig, setCheckoutConfig } from "./checkout.js";
import {
  PREMIUM_BUY_CUSTOM_ID,
  PREMIUM_MODULE,
} from "./gate.js";
import { createTransaction, findPlan, listPlans } from "./repo.js";
import type { PlanRow } from "./repo.js";
import type { PremiumNotifier } from "./notifications.js";

/** The action of the plan select. */
export const PREMIUM_PLAN_ACTION = "plan";

/** The action of the email modal. */
export const PREMIUM_EMAIL_ACTION = "email";

/** The custom id of the plan select. */
export const PREMIUM_PLAN_CUSTOM_ID = makeCustomId(PREMIUM_MODULE, PREMIUM_PLAN_ACTION);

/** The custom id of the email modal. */
export const PREMIUM_EMAIL_CUSTOM_ID = makeCustomId(
  PREMIUM_MODULE,
  PREMIUM_EMAIL_ACTION,
);

/** The field id of the email input. */
export const PREMIUM_EMAIL_FIELD_ID = "premium_email";

/** How long a half-finished checkout stays valid. */
const TOKEN_TTL_MS = 15 * 60_000;

/**
 * What a half-finished checkout remembers.
 *
 * It holds the person who started it, so only they can finish it.
 */
interface CheckoutState {
  readonly userId: string;
  readonly guildId: string;
  /** The plan they picked, once they have picked one. */
  readonly planId?: string;
}

const tokens = new TokenStore<CheckoutState>({ ttlMs: TOKEN_TTL_MS });

/**
 * Releases the token store's timer.
 *
 * Call it when the bot shuts down, and in tests.
 */
export function stopPremiumInteractions(): void {
  tokens.stop();
}

/**
 * The handlers the manager's router calls.
 *
 * Two shapes, because there are two callers:
 *
 *  - {@link PremiumInteractionHandlers.handleButton} and friends take one
 *    argument and answer `true` when the interaction was ours — the shape
 *    the brief asked for, and the shape that works when the manager
 *    dispatches by hand;
 *  - {@link PremiumInteractionHandlers.buttonHandler} and friends take
 *    the router's `(interaction, payload)` pair and answer nothing, which
 *    is what `core/router.ts` wants.
 *
 * The router-shaped handlers narrow the interaction themselves, so they
 * are safe to register for the whole `premium` prefix rather than for one
 * action.
 */
export interface PremiumInteractionHandlers {
  /**
   * Handles a button.
   *
   * @returns `true` when the interaction belonged to this module.
   */
  handleButton(interaction: ButtonInteraction): Promise<boolean>;
  /**
   * Handles a select menu.
   *
   * @returns `true` when the interaction belonged to this module.
   */
  handleSelectMenu(interaction: StringSelectMenuInteraction): Promise<boolean>;
  /**
   * Handles a modal submission.
   *
   * @returns `true` when the interaction belonged to this module.
   */
  handleModal(interaction: ModalSubmitInteraction): Promise<boolean>;
  /** The button handler, in the shape a router wants. */
  readonly buttonHandler: PremiumButtonHandler;
  /** The select-menu handler, in the shape a router wants. */
  readonly selectHandler: PremiumSelectHandler;
  /** The modal handler, in the shape a router wants. */
  readonly modalHandler: PremiumModalHandler;
}

/**
 * A button handler, in the shape a component router wants.
 */
export type PremiumButtonHandler = (
  interaction: ButtonInteraction,
  payload: string | null,
) => Promise<void> | void;

/**
 * A select-menu handler, in the shape a component router wants.
 */
export type PremiumSelectHandler = (
  interaction: AnySelectMenuInteraction,
  payload: string | null,
) => Promise<void> | void;

/**
 * A modal-submit handler, in the shape a component router wants.
 */
export type PremiumModalHandler = (
  interaction: ModalSubmitInteraction,
  payload: string | null,
) => Promise<void> | void;

/**
 * Registers the premium interactions.
 *
 * The manager wires the returned handlers into its router. Nothing else
 * in the codebase should look at a `premium:` custom id.
 *
 * @param options `publicUrl` is the address the checkout lives at. It is
 *        the same URL the payment server was started with; passing it
 *        here as well means the module works even if the server has not
 *        been started yet.
 */
export function registerPremiumInteractions(
  options: { publicUrl?: string } = {},
): PremiumInteractionHandlers {
  if (options.publicUrl) {
    setCheckoutConfig({ publicUrl: options.publicUrl });
  }

  return {
    handleButton: (interaction) => handleBuyButton(interaction),
    handleSelectMenu: (interaction) => handlePlanSelect(interaction),
    handleModal: (interaction) => handleEmailModal(interaction),

    buttonHandler: async (interaction) => {
      await handleBuyButton(interaction);
    },

    selectHandler: async (interaction) => {
      if (!interaction.isStringSelectMenu()) return;

      await handlePlanSelect(interaction);
    },

    modalHandler: async (interaction) => {
      await handleEmailModal(interaction);
    },
  };
}

/* ------------------------------------------------------------------ *
 * The button
 * ------------------------------------------------------------------ */

async function handleBuyButton(
  interaction: ButtonInteraction,
): Promise<boolean> {
  if (interaction.customId !== PREMIUM_BUY_CUSTOM_ID) return false;

  // The handler acknowledges the interaction itself, so it does not
  // depend on the router having left it alone — but it must not
  // acknowledge it twice.
  if (!interaction.deferred && !interaction.replied) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  }

  const guildId = interaction.guildId;

  if (!guildId) {
    await interaction.editReply({
      content: "Premium can only be bought from inside a server.",
    });

    return true;
  }

  if (!getCheckoutConfig()) {
    await interaction.editReply({
      content:
        "The premium checkout is not set up on this bot yet. Please contact the server owner.",
    });

    return true;
  }

  const plans = await listPlans();

  if (plans.length === 0) {
    await interaction.editReply({
      content: "There are no premium plans available right now.",
    });

    return true;
  }

  const token = tokens.issue({ userId: interaction.user.id, guildId });

  await interaction.editReply({
    content: "Choose the plan you want to buy.",
    components: [buildPlanSelect(token, plans)],
  });

  return true;
}

/* ------------------------------------------------------------------ *
 * The select
 * ------------------------------------------------------------------ */

async function handlePlanSelect(
  interaction: StringSelectMenuInteraction,
): Promise<boolean> {
  const parsed = parseCustomId(interaction.customId);

  if (!parsed || parsed.type !== PREMIUM_MODULE) return false;
  if (parsed.action !== PREMIUM_PLAN_ACTION) return false;

  const token = parsed.payload;

  if (!token) return true;

  const state = tokens.get(token);

  if (!state) {
    await refuse(
      interaction,
      "That checkout expired. Run `/premium` again to start a new one.",
    );

    return true;
  }

  if (state.userId !== interaction.user.id) {
    await refuse(
      interaction,
      "Only the person who started this checkout can finish it.",
    );

    return true;
  }

  const planId = interaction.values[0];

  if (!planId) return true;

  const plan = await findPlan(planId);

  if (!plan) {
    await refuse(
      interaction,
      "That plan is no longer available. Run `/premium` again.",
    );

    return true;
  }

  const nextToken = tokens.issue({
    userId: state.userId,
    guildId: state.guildId,
    planId: plan.id,
  });

  // A modal can only be shown on an interaction that has not been
  // acknowledged. The router must not defer a select menu before handing
  // it over.
  if (interaction.deferred || interaction.replied) {
    await interaction.followUp({
      content: "Something went wrong. Run `/premium` again to start a new checkout.",
      flags: MessageFlags.Ephemeral,
    });

    return true;
  }

  await interaction.showModal(buildEmailModal(nextToken, plan));

  return true;
}

/* ------------------------------------------------------------------ *
 * The modal
 * ------------------------------------------------------------------ */

async function handleEmailModal(
  interaction: ModalSubmitInteraction,
): Promise<boolean> {
  const parsed = parseCustomId(interaction.customId);

  if (!parsed || parsed.type !== PREMIUM_MODULE) return false;
  if (parsed.action !== PREMIUM_EMAIL_ACTION) return false;

  if (!interaction.deferred && !interaction.replied) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  }

  const token = parsed.payload;
  const state = token ? tokens.get(token) : undefined;

  if (!state?.planId) {
    await interaction.editReply({
      content: "That checkout expired. Run `/premium` again to start a new one.",
    });

    return true;
  }

  if (state.userId !== interaction.user.id) {
    await interaction.editReply({
      content: "Only the person who started this checkout can finish it.",
    });

    return true;
  }

  const email = normaliseEmail(
    interaction.fields.getTextInputValue(PREMIUM_EMAIL_FIELD_ID),
  );

  if (!email) {
    await interaction.editReply({
      content: "That does not look like an email address. Please try again.",
    });

    return true;
  }

  const plan = await findPlan(state.planId);

  if (!plan) {
    await interaction.editReply({
      content: "That plan is no longer available. Run `/premium` again.",
    });

    return true;
  }

  const txnId = generateTransactionId();

  await createTransaction({
    txnId,
    userId: state.userId,
    guildId: state.guildId,
    planId: plan.id,
    // The plan is snapshotted here, so the payment page still renders
    // after the catalogue changes and the receipt still says what was
    // bought.
    planSnapshot: {
      name: plan.name,
      price: plan.price,
      duration_days: plan.durationDays,
    },
    email,
    buyerName: interaction.user.displayName,
  });

  await interaction.editReply({
    content: [
      `You are about to buy **${plan.name}** for **₹${plan.price}** (${plan.durationDays} days).`,
      "",
      `[Click here to complete the payment](${buildCheckoutUrl(txnId)})`,
      "",
      "The link is yours alone. Do not share it.",
    ].join("\n"),
  });

  return true;
}

/* ------------------------------------------------------------------ *
 * The components
 * ------------------------------------------------------------------ */

/**
 * The plan select.
 */
export function buildPlanSelect(
  token: string,
  plans: readonly PlanRow[],
): ActionRowBuilder<StringSelectMenuBuilder> {
  const select = new StringSelectMenuBuilder()
    .setCustomId(makeCustomId(PREMIUM_MODULE, PREMIUM_PLAN_ACTION, token))
    .setPlaceholder("Select a premium plan…")
    .addOptions(
      plans.map((plan) => ({
        label: `${plan.name} — ₹${plan.price}`,
        description:
          plan.description ?? `Premium for ${plan.durationDays} days`,
        value: plan.id,
      })),
    );

  return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select);
}

/**
 * The email modal.
 *
 * The buyer's **real** email is what the gateway gets and what the
 * receipt shows. Quotient sent `"abcd@gmail.com"` and put the Discord
 * user id in the `firstname` field.
 */
export function buildEmailModal(
  token: string,
  plan: PlanRow,
): ModalBuilder {
  const input = new TextInputBuilder()
    .setCustomId(PREMIUM_EMAIL_FIELD_ID)
    .setLabel("Email address")
    .setPlaceholder("you@example.com")
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setMaxLength(254);

  const label = new LabelBuilder()
    .setLabel("Email address")
    .setDescription(
      `We send the receipt for ${plan.name} to this address. It is not shared with anyone else.`,
    )
    .setTextInputComponent(input);

  return new ModalBuilder()
    .setCustomId(makeCustomId(PREMIUM_MODULE, PREMIUM_EMAIL_ACTION, token))
    .setTitle(`Premium — ${plan.name}`)
    .addLabelComponents(label);
}

/* ------------------------------------------------------------------ *
 * The notification
 * ------------------------------------------------------------------ */

/**
 * Tells the buyer that the purchase went through.
 *
 * The purchase is already committed when this runs, so a failure to send
 * the message must not undo anything — the error is swallowed and the
 * purchase stands.
 *
 * Pass it to the payment server:
 *
 * ```ts
 * startPremiumServer({ notify: createDiscordNotifier(client) });
 * ```
 */
export function createDiscordNotifier(client: Client): PremiumNotifier {
  return async (notification) => {
    const user = await client.users.fetch(notification.userId).catch(() => null);

    if (!user) return;

    const guild = client.guilds.cache.get(notification.guildId);
    const guildName = notification.guildName || guild?.name || "this server";

    const embed = new EmbedBuilder()
      .setTitle("💎 Premium activated")
      .setDescription(
        [
          `Thanks for buying **${notification.planName}** for **${guildName}**.`,
          "",
          `> Amount: ₹${notification.amount}`,
          `> Length: ${notification.durationDays} days`,
          `> Ends: <t:${Math.floor(notification.expiresAt.getTime() / 1000)}:f>`,
          "",
          "The server's premium features are live now.",
        ].join("\n"),
      )
      .setColor(0x00ffb3);

    await user.send({ embeds: [embed] }).catch(() => undefined);
  };
}

/* ------------------------------------------------------------------ *
 * Small helpers
 * ------------------------------------------------------------------ */

/**
 * Refuses an interaction, whichever way it has been acknowledged.
 *
 * The router may or may not have deferred the interaction before handing
 * it over, and a refusal that throws because of that is a refusal the
 * user never sees.
 */
async function refuse(
  interaction:
    | ButtonInteraction
    | StringSelectMenuInteraction
    | ModalSubmitInteraction,
  content: string,
): Promise<void> {
  if (interaction.deferred || interaction.replied) {
    await interaction.followUp({ content, flags: MessageFlags.Ephemeral });
    return;
  }

  await interaction.reply({ content, flags: MessageFlags.Ephemeral });
}

/**
 * A transaction id.
 *
 * `QP_` plus 16 random bytes, hex encoded — the same shape Quotient used,
 * and it carries nothing but entropy.
 */
export function generateTransactionId(): string {
  return `QP_${randomBytes(16).toString("hex")}`;
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Normalises an email address.
 *
 * @returns the address, or `null` when it is not one.
 */
export function normaliseEmail(raw: string): string | null {
  const value = raw.trim().toLowerCase();

  if (!EMAIL_PATTERN.test(value)) return null;

  return value;
}
