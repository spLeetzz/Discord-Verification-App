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
 *
 * The two routes differ in one way, and it is deliberate: the browser
 * redirect must come from PayU's origin, and the server-to-server
 * webhook has no origin at all. Asking a webhook for an `Origin` header
 * would refuse every one of them.
 *
 * **The failure redirect is verified too.** It used to be the one route
 * that wrote to the database on the strength of a transaction id and
 * nothing else. The gateway signs the failure callback as carefully as
 * the successful one — the status is inside the signature — so the route
 * checks the same things the success route checks before it marks
 * anything failed.
 */

import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import formbody from "@fastify/formbody";
import { logger } from "../../../utils/logger.js";
import { seedPremiumPlans } from "../../../db/seed.js";
import { buildFailureUrl, buildSuccessUrl, setCheckoutConfig } from "../checkout.js";
import { readPremiumEnv, premiumEnvWarnings } from "../env.js";
import { findTransaction } from "../repo.js";
import { activatePremium, failPremium } from "../purchase.js";
import {
  formatAmount,
  payuRequestHash,
  verifyPayuCallback,
  verifyPayuFailureCallback,
} from "../payu.js";
import type {
  PayuCallbackPayload,
  PayuCallbackSource,
  PayuCredentials,
} from "../payu.js";
import { PRODUCT_INFO } from "../types.js";
import type { PremiumTransactionStatus } from "../types.js";
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
  /** The port to listen on. Defaults to `PREMIUM_PORT` or 8899. */
  port?: number;
  /** The host to bind to. Defaults to `PREMIUM_SERVER_HOST` or 0.0.0.0. */
  host?: string;
  /**
   * The address the buyer's browser can reach.
   *
   * Defaults to `PREMIUM_PUBLIC_URL`. It has to be the *public* address:
   * the gateway redirects the browser to it and posts to its webhook.
   */
  publicUrl?: string | null;
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
  /**
   * The public address the checkout uses.
   *
   * `null` when there is none — the checkout is then disabled, and the
   * bot says so rather than sending the buyer to a broken link.
   */
  readonly publicUrl: string | null;
  /** The Fastify instance, for tests. */
  readonly app: FastifyInstance;
  /** Stops the server. */
  close(): Promise<void>;
}

let running: PremiumServerHandle | null = null;

/**
 * Starts the payment server.
 *
 * The manager calls this from `main.ts`; this module never touches
 * `main.ts` itself.
 *
 * Nothing here throws for a missing environment variable. A guild that
 * never sells premium does not have a merchant key, and the bot still
 * has to start: the payment routes answer `503` and the Discord side
 * says the checkout is not set up. What *is* fatal — a port that is
 * already in use, say — still throws.
 */
export async function startPremiumServer(
  options: PremiumServerOptions = {},
): Promise<PremiumServerHandle> {
  const environment = readPremiumEnv(process.env);

  const publicUrl = (
    options.publicUrl ??
    environment.publicUrl ??
    ""
  ).trim();

  const credentials =
    options.credentials === undefined
      ? environment.credentials
      : options.credentials;

  const payuAction =
    options.payuAction?.trim() || environment.action || DEFAULT_PAYU_ACTION;

  const port = options.port ?? environment.port ?? DEFAULT_PORT;
  const host = options.host?.trim() || environment.host || DEFAULT_HOST;

  if (options.seedPlans !== false) {
    await seedPremiumPlans();
  }

  // The checkout needs to know its own address. Without one there is no
  // checkout, and the Discord side refuses to sell rather than sending
  // the buyer to a link that goes nowhere.
  setCheckoutConfig(publicUrl ? { publicUrl } : null);

  const app = Fastify({ logger: false, bodyLimit: 256 * 1024 });

  // PayU posts `application/x-www-form-urlencoded`. The plugin is a
  // `fastify-plugin`, so the parser it adds is visible to the routes
  // below — a parser registered inside an ordinary plugin would be
  // encapsulated, and the routes would never see it.
  await app.register(formbody);

  registerRoutes(app, {
    credentials,
    publicUrl: publicUrl || null,
    payuAction,
    notify: options.notify,
  });

  await app.listen({ port, host });

  // The real port matters when the caller asked for an ephemeral one.
  const address = app.server.address();
  const boundPort = typeof address === "object" && address ? address.port : port;

  const handle: PremiumServerHandle = {
    port: boundPort,
    host,
    publicUrl: publicUrl ? publicUrl.replace(/\/+$/, "") : null,
    app,
    async close() {
      await app.close();
      setCheckoutConfig(null);

      if (running === handle) running = null;
    },
  };

  running = handle;

  logger.info(
    `[Premium] Payment server listening on ${handle.host}:${boundPort} (public: ${handle.publicUrl ?? "not configured"})`,
  );

  for (const warning of premiumEnvWarnings(environment)) {
    logger.warn(`[Premium] ${warning}`);
  }

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
  readonly publicUrl: string | null;
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

    if (!dependencies.publicUrl) {
      return reply
        .code(503)
        .type("text/html")
        .send(
          renderMessagePage(
            "Checkout unavailable",
            "This server does not know its own public address, so it cannot take a payment.",
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
  // signature verifies, and it has to come from PayU's origin.
  app.post("/premium_success", async (request, reply) => {
    const body = readFormBody(request.body);

    if (!body) {
      return reply
        .code(400)
        .type("text/html")
        .send(renderMessagePage("Bad request", "The form could not be read.", "error"));
    }

    const outcome = await completePayment({
      body,
      queryTxnId: readQueryString(request.query, "txnId"),
      credentials: dependencies.credentials,
      source: "browser",
      origin: request.headers.origin,
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
  //
  // This one used to be the weakest route in the server: it took the
  // transaction id out of the body or the query string and marked the
  // transaction failed, with no signature, no origin check and no
  // merchant check. It is now verified the same way the success route
  // is — the gateway signs the failure callback too, and the status is
  // inside the signature, so a failure cannot be forged.
  app.post("/premium_failed", async (request, reply) => {
    const body = readFormBody(request.body);

    if (!body) {
      return reply
        .code(400)
        .type("text/html")
        .send(renderMessagePage("Bad request", "The form could not be read.", "error"));
    }

    const outcome = await completeFailure({
      body,
      queryTxnId: readQueryString(request.query, "txnId"),
      credentials: dependencies.credentials,
      origin: request.headers.origin,
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
      queryTxnId: readQueryString(request.query, "txnId"),
      credentials: dependencies.credentials,
      source: "webhook",
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
  /** The transaction id in the query string, when there was one. */
  readonly queryTxnId?: string | undefined;
  readonly credentials: PayuCredentials | null;
  /** Where the callback came from. */
  readonly source: PayuCallbackSource;
  /** The request's `Origin` header, when it had one. */
  readonly origin?: string | undefined;
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
 *
 * The order of the checks is the order of the questions:
 *
 *  1. is the gateway configured at all?
 *  2. did the callback name a transaction?
 *  3. does it name the one the link said?
 *  4. **is that transaction ours** — it has to exist in the database;
 *  5. does it have a plan?
 *  6. **does the callback verify** — the signature, the status, the
 *     origin and the amount;
 *  7. only then, the grant.
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

  // The transaction id in the body is the signed one, so it is the one
  // that decides which transaction this is about. The one in the query
  // string is a hint from the link, and the two have to agree.
  const txnId = input.body.txnid ?? "";

  if (!txnId) {
    return {
      ok: false,
      status: 400,
      title: "Missing transaction",
      body: "The callback did not name a transaction.",
    };
  }

  if (input.queryTxnId && input.queryTxnId !== txnId) {
    return {
      ok: false,
      status: 400,
      title: "Transaction mismatch",
      body: "The callback named a different transaction than the link did.",
    };
  }

  const transaction = await findTransaction(txnId);

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

  const verification = verifyPayuCallback(readCallback(input.body), {
    txnId,
    amount: formatAmount(snapshot.price),
    credentials: input.credentials,
    source: input.source,
    origin: input.origin,
  });

  if (!verification.ok) {
    logger.warn(
      `[Premium] Refused a payment callback for ${txnId}: ${verification.reason}`,
    );

    return {
      ok: false,
      status: verification.code === "wrong_origin" ? 403 : 400,
      title: "Payment could not be verified",
      body: verification.reason,
    };
  }

  const result = await activatePremium({
    txnId,
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
  if (
    (result.outcome === "activated" || result.outcome === "repaired") &&
    input.notify &&
    result.expiresAt
  ) {
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
        `[Premium] Could not notify the buyer of ${txnId}:`,
        error instanceof Error ? error : String(error),
      );
    }
  }

  return { ok: true, result: result.outcome };
}

/* ------------------------------------------------------------------ *
 * The shared failure path
 * ------------------------------------------------------------------ */

interface CompleteFailureInput {
  readonly body: Record<string, string>;
  /** The transaction id in the query string, when there was one. */
  readonly queryTxnId?: string | undefined;
  readonly credentials: PayuCredentials | null;
  /** The request's `Origin` header, when it had one. */
  readonly origin?: string | undefined;
}

type CompleteFailureOutcome =
  | {
      readonly ok: true;
      readonly status: PremiumTransactionStatus | "unknown_transaction";
    }
  | {
      readonly ok: false;
      readonly status: number;
      readonly title: string;
      readonly body: string;
    };

/**
 * Verifies a failure callback and records the failure.
 *
 * The same questions the success route asks, in the same order, with one
 * difference: the status has to be a **failure**. A callback that says
 * `success` is not a failure — the success route and the webhook own
 * that one — and a callback that says nothing at all must not be allowed
 * to change a transaction.
 *
 * Nothing is written until the callback has been verified. That is the
 * whole point: an unauthenticated request must not be able to flip a
 * transaction to `failed` or to overwrite the audit data with whatever
 * JSON it liked.
 */
async function completeFailure(
  input: CompleteFailureInput,
): Promise<CompleteFailureOutcome> {
  if (!input.credentials) {
    return {
      ok: false,
      status: 503,
      title: "Checkout unavailable",
      body: "The payment gateway is not configured on this server.",
    };
  }

  // The transaction id in the body is the signed one, so it is the one
  // that decides which transaction this is about. The one in the query
  // string is a hint from the link, and the two have to agree.
  const txnId = input.body.txnid ?? input.queryTxnId ?? "";

  if (!txnId) {
    return {
      ok: false,
      status: 400,
      title: "Missing transaction",
      body: "The callback did not name a transaction.",
    };
  }

  if (
    input.body.txnid &&
    input.queryTxnId &&
    input.body.txnid !== input.queryTxnId
  ) {
    return {
      ok: false,
      status: 400,
      title: "Transaction mismatch",
      body: "The callback named a different transaction than the link did.",
    };
  }

  const transaction = await findTransaction(txnId);

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
      body: "That transaction has no plan attached to it.",
    };
  }

  const verification = verifyPayuFailureCallback(readCallback(input.body), {
    txnId,
    amount: formatAmount(snapshot.price),
    credentials: input.credentials,
    origin: input.origin,
  });

  if (!verification.ok) {
    logger.warn(
      `[Premium] Refused a failure callback for ${txnId}: ${verification.reason}`,
    );

    return {
      ok: false,
      status: verification.code === "wrong_origin" ? 403 : 400,
      title: "Payment could not be verified",
      body: verification.reason,
    };
  }

  // The transaction becomes `failed` — a conditional update, so a `paid`
  // transaction is never un-bought, and a failed one can be retried.
  const status = await failPremium({ txnId, raw: input.body });

  return { ok: true, status };
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
    key: body.key,
    udf1: body.udf1,
    udf2: body.udf2,
    udf3: body.udf3,
    udf4: body.udf4,
    udf5: body.udf5,
  };
}
