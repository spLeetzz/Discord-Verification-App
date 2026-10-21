/**
 * The premium payment server (D42).
 *
 * It runs **in the same Node process as the bot**. Quotient's handler did
 * `from core import bot` and dispatched into the bot's event bus; a
 * separate service would need an IPC that adds a failure mode for no
 * benefit. So this is a Fastify server in the same process, started and
 * stopped by the manager — `main.ts` belongs to somebody else.
 *
 * The routes:
 *
 * | Route | What it is |
 * |---|---|
 * | `GET /` | health |
 * | `GET /getpremium?txnId=` | the payment page |
 * | `POST /premium_success?txnId=` | the gateway's success redirect |
 * | `POST /premium_failed?txnId=` | the gateway's failure redirect |
 * | `POST /payu/webhook` | the gateway's server-to-server call |
 *
 * **The browser redirect is untrusted until the signature verifies.** The
 * webhook is what makes the grant trustworthy, and both funnel into the
 * same idempotent {@link activatePremium}.
 */

import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import { logger } from "../../../utils/logger.js";
import { seedPremiumPlans } from "../../../db/seed.js";
import { buildFailureUrl, buildSuccessUrl, setCheckoutConfig } from "../checkout.js";
import { findTransaction } from "../repo.js";
import { activatePremium, failPremium } from "../purchase.js";
import {
  formatAmount,
  isPayuOrigin,
  isSuccessfulStatus,
  payuRequestHash,
  verifyPayuCallback,
} from "../payu.js";
import type { PayuCallbackPayload, PayuCredentials } from "../payu.js";
import { PRODUCT_INFO } from "../types.js";
import { registerFormBodyParser } from "./formbody.js";
import { renderMessagePage, renderPayuForm } from "./pages.js";
import type { PremiumNotifier } from "../notifications.js";

/**
 * The phone number sent to the gateway.
 *
 * Quotient sent `"9999999999"`, and the gateway's hosted page shows the
 * number it was given. It is a placeholder carried over from the source:
 * the buyer's real contact address is their email, which is the field the
 * receipt and the database use.
 */
const PHONE_PLACEHOLDER = "9999999999";

/** The default gateway form endpoint. */
const DEFAULT_PAYU_ACTION = "https://secure.payu.in/_payment";

/** The default port the server listens on. */
const DEFAULT_PORT = 8899;

/** The default host the server binds to. */
const DEFAULT_HOST = "0.0.0.0";

/** How the server is configured. */
export interface PremiumServerOptions {
  /** The port to listen on. Defaults to `PREMIUM_SERVER_PORT` or 8899. */
  port?: number;
  /** The host to bind to. Defaults to `PREMIUM_SERVER_HOST` or 0.0.0.0. */
  host?: string;
  /**
   * The address the buyer's browser can reach.
   *
   * Defaults to `PREMIUM_PUBLIC_URL`. It has to be the *public* address:
   * the gateway redirects the browser to it and posts to its webhook.
   */
  publicUrl?: string;
  /** The merchant credentials. Defaults to `PAYU_KEY` and `PAYU_SALT`. */
  credentials?: PayuCredentials | null;
  /** The gateway's form endpoint. Defaults to `PAYU_ACTION`. */
  payuAction?: string;
  /** Told about a completed purchase. */
  notify?: PremiumNotifier;
  /**
   * Whether to write the plan catalogue into the database on start.
   *
   * On by default: Quotient never seeded its own plan table, so every
   * purchase screen was blank.
   */
  seedPlans?: boolean;
}

/** A running server. */
export interface PremiumServerHandle {
  /** The port it is listening on. */
  readonly port: number;
  /** The host it is bound to. */
  readonly host: string;
  /** The public address the checkout uses. */
  readonly publicUrl: string;
  /** The Fastify instance, for tests. */
  readonly app: FastifyInstance;
  /** Stops the server. */
  close(): Promise<void>;
}

/**
 * Reads the merchant credentials from the environment.
 *
 * @returns the credentials, or `null` when they are not configured.
 */
export function readPayuCredentials(
  env: Record<string, string | undefined> = process.env,
): PayuCredentials | null {
  const key = env.PAYU_KEY?.trim();
  const salt = env.PAYU_SALT?.trim();

  if (!key || !salt) return null;

  return { key, salt };
}

let running: PremiumServerHandle | null = null;

/**
 * Starts the payment server.
 *
 * The manager calls this from `main.ts`; this module never touches
 * `main.ts` itself.
 *
 * @throws Error when the public URL is not configured. The server has to
 *         know its own address — the gateway redirects the buyer to it
 *         and posts to its webhook — and guessing would produce payment
 *         links that go nowhere.
 */
export async function startPremiumServer(
  options: PremiumServerOptions = {},
): Promise<PremiumServerHandle> {
  const env = process.env;

  const publicUrl = (
    options.publicUrl ??
    env.PREMIUM_PUBLIC_URL ??
    ""
  ).trim();

  if (!publicUrl) {
    throw new Error(
      "The premium server needs a public URL. Set PREMIUM_PUBLIC_URL or pass `publicUrl`.",
    );
  }

  const credentials =
    options.credentials === undefined
      ? readPayuCredentials(env)
      : options.credentials;

  const payuAction =
    options.payuAction?.trim() || env.PAYU_ACTION?.trim() || DEFAULT_PAYU_ACTION;

  const port = options.port ?? numberFromEnv(env.PREMIUM_SERVER_PORT) ?? DEFAULT_PORT;
  const host = options.host?.trim() || env.PREMIUM_SERVER_HOST?.trim() || DEFAULT_HOST;

  if (options.seedPlans !== false) {
    await seedPremiumPlans();
  }

  setCheckoutConfig({ publicUrl });

  const app = Fastify({ logger: false, bodyLimit: 256 * 1024 });

  registerFormBodyParser(app);

  registerRoutes(app, { credentials, payuAction, notify: options.notify });

  await app.listen({ port, host });

  // The real port matters when the caller asked for an ephemeral one.
  const address = app.server.address();
  const boundPort = typeof address === "object" && address ? address.port : port;

  const handle: PremiumServerHandle = {
    port: boundPort,
    host,
    publicUrl: publicUrl.replace(/\/+$/, ""),
    app,
    async close() {
      await app.close();
      setCheckoutConfig(null);

      if (running === handle) running = null;
    },
  };

  running = handle;

  logger.info(
    `[Premium] Payment server listening on ${handle.host}:${boundPort} (public: ${handle.publicUrl})`,
  );

  if (!credentials) {
    logger.warn(
      "[Premium] PAYU_KEY / PAYU_SALT are not set. The payment endpoints will refuse to run.",
    );
  }

  return handle;
}

/**
 * Stops the payment server, if one is running.
 *
 * Safe to call when nothing is running.
 */
export async function stopPremiumServer(): Promise<void> {
  const current = running;

  if (!current) return;

  running = null;

  await current.close();
}

/* ------------------------------------------------------------------ *
 * The routes
 * ------------------------------------------------------------------ */

interface RouteDependencies {
  readonly credentials: PayuCredentials | null;
  readonly payuAction: string;
  readonly notify?: PremiumNotifier;
}

function registerRoutes(
  app: FastifyInstance,
  dependencies: RouteDependencies,
): void {
  // Health.
  app.get("/", async (_request, reply) => {
    return reply.send({
      status: "ok",
      service: "premium",
      configured: dependencies.credentials !== null,
    });
  });

  // The payment page. It renders the form and submits itself.
  app.get("/getpremium", async (request, reply) => {
    const txnId = readQueryString(request.query, "txnId");

    if (!txnId) {
      return reply
        .code(400)
        .type("text/html")
        .send(renderMessagePage("Missing transaction", "No transaction id was given.", "error"));
    }

    const transaction = await findTransaction(txnId);

    if (!transaction) {
      return reply
        .code(404)
        .type("text/html")
        .send(
          renderMessagePage(
            "Unknown transaction",
            "That transaction id is not one of ours.",
            "error",
          ),
        );
    }

    if (transaction.status === "paid") {
      return reply
        .code(409)
        .type("text/html")
        .send(
          renderMessagePage(
            "Already paid",
            "This transaction has already been completed.",
            "info",
          ),
        );
    }

    const snapshot = transaction.planSnapshot;

    if (!snapshot) {
      return reply
        .code(409)
        .type("text/html")
        .send(
          renderMessagePage(
            "No plan attached",
            "This transaction has no plan attached to it.",
            "error",
          ),
        );
    }

    if (!dependencies.credentials) {
      return reply
        .code(503)
        .type("text/html")
        .send(
          renderMessagePage(
            "Checkout unavailable",
            "The payment gateway is not configured on this server.",
            "error",
          ),
        );
    }

    // The amount is a decimal string, and the hash is computed over the
    // very same string — the gateway signs the bytes it received.
    const amount = formatAmount(snapshot.price);
    const firstName = transaction.buyerName ?? "";
    const email = transaction.email ?? "";

    const hash = payuRequestHash(dependencies.credentials, {
      txnId,
      amount,
      productInfo: PRODUCT_INFO,
      firstName,
      email,
    });

    return reply
      .type("text/html")
      .send(
        renderPayuForm({
          action: dependencies.payuAction,
          key: dependencies.credentials.key,
          txnid: txnId,
          amount,
          productinfo: PRODUCT_INFO,
          firstname: firstName,
          email,
          phone: PHONE_PLACEHOLDER,
          surl: buildSuccessUrl(txnId),
          furl: buildFailureUrl(txnId),
          hash,
        }),
      );
  });

  // The gateway's success redirect. The browser is not trusted until the
  // signature verifies.
  app.post("/premium_success", async (request, reply) => {
    const body = readFormBody(request.body);

    if (!body) {
      return reply
        .code(400)
        .type("text/html")
        .send(renderMessagePage("Bad request", "The form could not be read.", "error"));
    }

    const origin = request.headers.origin;

    if (origin !== undefined && !isPayuOrigin(origin)) {
      return reply
        .code(403)
        .type("text/html")
        .send(
          renderMessagePage(
            "Invalid origin",
            "That request did not come from the payment gateway.",
            "error",
          ),
        );
    }

    const txnId = readQueryString(request.query, "txnId") ?? body.txnid ?? "";

    const outcome = await completePayment({
      body,
      txnId,
      credentials: dependencies.credentials,
      notify: dependencies.notify,
    });

    if (!outcome.ok) {
      return reply
        .code(outcome.status)
        .type("text/html")
        .send(renderMessagePage(outcome.title, outcome.body, "error"));
    }

    return reply
      .type("text/html")
      .send(
        renderMessagePage(
          "Payment complete",
          "Your premium has been activated. You can close this tab and go back to Discord.",
          "success",
        ),
      );
  });

  // The gateway's failure redirect.
  app.post("/premium_failed", async (request, reply) => {
    const body = readFormBody(request.body);

    if (!body) {
      return reply
        .code(400)
        .type("text/html")
        .send(renderMessagePage("Bad request", "The form could not be read.", "error"));
    }

    const txnId = readQueryString(request.query, "txnId") ?? body.txnid ?? "";

    if (txnId) {
      await failPremium({ txnId, raw: body });
    }

    return reply
      .type("text/html")
      .send(
        renderMessagePage(
          "Payment cancelled",
          "The payment was not completed. You can try again from the link in Discord.",
          "info",
        ),
      );
  });

  // The gateway's server-to-server call. This is the trustworthy path.
  app.post("/payu/webhook", async (request, reply) => {
    const body = readFormBody(request.body);

    if (!body) {
      return reply.code(400).send({ error: "The form could not be read." });
    }

    const outcome = await completePayment({
      body,
      txnId: body.txnid ?? "",
      credentials: dependencies.credentials,
      notify: dependencies.notify,
    });

    if (!outcome.ok) {
      return reply.code(outcome.status).send({ error: outcome.body });
    }

    return reply.send({ success: true, outcome: outcome.result });
  });
}

/* ------------------------------------------------------------------ *
 * The shared completion path
 * ------------------------------------------------------------------ */

interface CompletePaymentInput {
  readonly body: Record<string, string>;
  readonly txnId: string;
  readonly credentials: PayuCredentials | null;
  readonly notify?: PremiumNotifier;
}

type CompletePaymentOutcome =
  | { readonly ok: true; readonly result: string }
  | {
      readonly ok: false;
      readonly status: number;
      readonly title: string;
      readonly body: string;
    };

/**
 * Verifies a callback and grants the subscription.
 *
 * The browser redirect and the webhook both come through here, so both
 * are verified the same way and both are idempotent.
 */
async function completePayment(
  input: CompletePaymentInput,
): Promise<CompletePaymentOutcome> {
  if (!input.credentials) {
    return {
      ok: false,
      status: 503,
      title: "Checkout unavailable",
      body: "The payment gateway is not configured on this server.",
    };
  }

  if (!input.txnId) {
    return {
      ok: false,
      status: 400,
      title: "Missing transaction",
      body: "No transaction id was given.",
    };
  }

  const transaction = await findTransaction(input.txnId);

  if (!transaction) {
    return {
      ok: false,
      status: 404,
      title: "Unknown transaction",
      body: "That transaction id is not one of ours.",
    };
  }

  const snapshot = transaction.planSnapshot;

  if (!snapshot) {
    return {
      ok: false,
      status: 409,
      title: "No plan attached",
      body: "This transaction has no plan attached to it.",
    };
  }

  const payload = readCallback(input.body);

  if (!isSuccessfulStatus(payload.status)) {
    return {
      ok: false,
      status: 400,
      title: "Payment not successful",
      body: `The gateway reported "${payload.status || "no status"}".`,
    };
  }

  const verification = verifyPayuCallback(payload, {
    txnId: input.txnId,
    amount: formatAmount(snapshot.price),
    credentials: input.credentials,
  });

  if (!verification.ok) {
    logger.warn(
      `[Premium] Refused a payment callback for ${input.txnId}: ${verification.reason}`,
    );

    return {
      ok: false,
      status: 400,
      title: "Payment could not be verified",
      body: verification.reason,
    };
  }

  const result = await activatePremium({
    txnId: input.txnId,
    amount: verification.amount,
    email: verification.email,
    buyerName: verification.firstName,
    status: verification.status,
    raw: input.body,
  });

  if (result.outcome === "unknown_transaction") {
    return {
      ok: false,
      status: 404,
      title: "Unknown transaction",
      body: "That transaction id is not one of ours.",
    };
  }

  // The rows are committed by now. Telling somebody is a separate step,
  // and a failure to tell must not undo the purchase.
  if (result.outcome === "activated" && input.notify && result.expiresAt) {
    try {
      await input.notify({
        userId: result.userId,
        guildId: result.guildId,
        guildName: "",
        planName: result.planName,
        amount: result.amount,
        durationDays: result.durationDays,
        expiresAt: result.expiresAt,
      });
    } catch (error) {
      logger.error(
        `[Premium] Could not notify the buyer of ${input.txnId}:`,
        error instanceof Error ? error : String(error),
      );
    }
  }

  return { ok: true, result: result.outcome };
}

/* ------------------------------------------------------------------ *
 * Small readers
 * ------------------------------------------------------------------ */

/**
 * Reads a string out of a query object.
 *
 * Fastify types the query as `unknown` by default, and a repeated
 * parameter arrives as an array.
 */
function readQueryString(query: unknown, key: string): string | undefined {
  if (typeof query !== "object" || query === null) return undefined;

  const value = (query as Record<string, unknown>)[key];

  if (typeof value === "string") return value;

  if (Array.isArray(value) && typeof value[0] === "string") return value[0];

  return undefined;
}

/**
 * Reads the posted form.
 *
 * @returns the fields, or `null` when the body was not a form.
 */
function readFormBody(body: unknown): Record<string, string> | null {
  if (typeof body !== "object" || body === null) return null;

  const fields: Record<string, string> = {};

  for (const [key, value] of Object.entries(body as Record<string, unknown>)) {
    if (typeof value === "string") fields[key] = value;
  }

  return fields;
}

/**
 * Reads the fields the gateway posted back.
 */
function readCallback(body: Record<string, string>): PayuCallbackPayload {
  return {
    txnid: body.txnid ?? "",
    amount: body.amount ?? "",
    productinfo: body.productinfo ?? "",
    firstname: body.firstname ?? "",
    email: body.email ?? "",
    status: body.status ?? "",
    hash: body.hash ?? "",
    udf1: body.udf1,
    udf2: body.udf2,
    udf3: body.udf3,
    udf4: body.udf4,
    udf5: body.udf5,
  };
}

/**
 * Reads a number out of the environment.
 *
 * @returns the number, or `null` when it is not a number.
 */
function numberFromEnv(value: string | undefined): number | null {
  if (!value) return null;

  const parsed = Number.parseInt(value, 10);

  if (!Number.isFinite(parsed)) return null;

  return parsed;
}
