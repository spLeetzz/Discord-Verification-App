/**
 * The payment server, proved against the live database.
 *
 * The properties that matter (D37, D42):
 *
 *  - the payment page renders the amount as a decimal string and signs
 *    it with the **request** hash;
 *  - a callback with a good signature grants the subscription;
 *  - a callback with a tampered amount, a tampered email or the wrong
 *    merchant key is refused, and the transaction stays `pending`;
 *  - the browser redirect must come from **PayU's** origin — a missing
 *    one is a clean refusal, not a crash, and a foreign one is refused;
 *  - the server-to-server webhook needs no origin at all (there is none
 *    in a server-to-server call) and grants the same way;
 *  - the grant is idempotent.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { closeDatabase, db } from "../../../db/client.js";
import {
  guildEntitlements,
  guildSettings,
  premiumTransactions,
} from "../../../db/schema.js";
import { isEntitled } from "../entitlements.js";
import { payuRequestHash, payuResponseHash } from "../payu.js";
import type { PayuCredentials, PayuFieldLayout } from "../payu.js";
import { createTransaction, findPlanByCode, findTransaction } from "../repo.js";
import { startPremiumServer } from "./index.js";
import type { PremiumServerHandle } from "./index.js";

const GUILD_ID = `premium-server-${Date.now()}-${Math.random().toString(36).slice(2)}`;
const USER_ID = "222222222222222222";

const CREDENTIALS: PayuCredentials = {
  key: "test-key",
  salt: "test-salt",
};

const PUBLIC_URL = "https://premium.example.test";

let server: PremiumServerHandle;
let counter = 0;

beforeAll(async () => {
  server = await startPremiumServer({
    port: 0,
    host: "127.0.0.1",
    publicUrl: PUBLIC_URL,
    credentials: CREDENTIALS,
    payuAction: "https://secure.payu.in/_payment",
  });
});

beforeEach(async () => {
  await db
    .delete(premiumTransactions)
    .where(sql`${premiumTransactions.guildId} = ${GUILD_ID}`);

  await db.delete(guildEntitlements).where(sql`${guildEntitlements.guildId} = ${GUILD_ID}`);

  await db.delete(guildSettings).where(sql`${guildSettings.guildId} = ${GUILD_ID}`);
});

afterAll(async () => {
  await server.close();

  await db
    .delete(premiumTransactions)
    .where(sql`${premiumTransactions.guildId} = ${GUILD_ID}`);

  await db.delete(guildEntitlements).where(sql`${guildEntitlements.guildId} = ${GUILD_ID}`);

  await db.delete(guildSettings).where(sql`${guildSettings.guildId} = ${GUILD_ID}`);

  await closeDatabase();
});

/**
 * Encodes a form the way a browser or the gateway would.
 */
function encode(fields: GatewayForm | Record<string, string>): string {
  return new URLSearchParams(fields as Record<string, string>).toString();
}

/**
 * Creates a pending transaction for the cheapest plan.
 */
async function makeTransaction(): Promise<{ txnId: string; price: number }> {
  // By code, not by price: another test file inserts a temporary plan
  // with a lower price, and "the cheapest plan" would pick it up and then
  // lose it mid-test.
  const plan = await findPlanByCode("trial");

  if (!plan) throw new Error("the plan catalogue is empty");

  counter += 1;

  const txnId = `premium-server-txn-${Date.now()}-${counter}`;

  await createTransaction({
    txnId,
    userId: USER_ID,
    guildId: GUILD_ID,
    planId: plan.id,
    planSnapshot: {
      name: plan.name,
      price: plan.price,
      duration_days: plan.durationDays,
    },
    email: "buyer@example.com",
    buyerName: "Buyer",
  });

  return { txnId, price: plan.price };
}

/**
 * The form a genuine gateway would post back.
 */
interface GatewayForm {
  txnid: string;
  amount: string;
  productinfo: string;
  firstname: string;
  email: string;
  status: string;
  hash: string;
}

function makeForm(
  txnId: string,
  amount: string,
  overrides: Partial<GatewayForm> = {},
  layout: PayuFieldLayout = "udf-with-blanks",
): GatewayForm {
  const fields: GatewayForm = {
    txnid: txnId,
    amount,
    productinfo: "premium",
    firstname: "Buyer",
    email: "buyer@example.com",
    status: "success",
    hash: "",
    ...overrides,
  };

  fields.hash = payuResponseHash(
    CREDENTIALS,
    {
      txnId: fields.txnid,
      amount: fields.amount,
      productInfo: fields.productinfo,
      firstName: fields.firstname,
      email: fields.email,
      status: fields.status,
    },
    layout,
  );

  return fields;
}

describe("modules/premium/server — the routes", () => {
  it("answers the health check", async () => {
    const response = await server.app.inject({ method: "GET", url: "/" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ status: "ok", service: "premium" });
  });

  it("renders the payment page with the amount as a decimal string", async () => {
    const { txnId, price } = await makeTransaction();

    const response = await server.app.inject({
      method: "GET",
      url: `/getpremium?txnId=${txnId}`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/html");

    // "29", not "29.00" — the gateway signs the bytes it received, so
    // the form and the hash have to agree.
    expect(response.body).toContain(`name="amount" value="${price.toFixed(2)}"`);
    expect(response.body).toContain(`name="txnid" value="${txnId}"`);
    expect(response.body).toContain(`name="surl" value="${PUBLIC_URL}/premium_success?txnId=${txnId}"`);
    expect(response.body).toContain(`name="furl" value="${PUBLIC_URL}/premium_failed?txnId=${txnId}"`);
    expect(response.body).toContain("hash");
  });

  it("signs the payment page with the request hash", async () => {
    const { txnId, price } = await makeTransaction();

    const response = await server.app.inject({
      method: "GET",
      url: `/getpremium?txnId=${txnId}`,
    });

    // The hash on the page has to be over the very bytes the gateway is
    // given, or the gateway refuses the transaction before it starts.
    const expected = payuRequestHash(CREDENTIALS, {
      txnId,
      amount: price.toFixed(2),
      productInfo: "premium",
      firstName: "Buyer",
      email: "buyer@example.com",
    });

    expect(response.body).toContain(`name="hash" value="${expected}"`);
  });

  it("refuses an unknown transaction on the payment page", async () => {
    const response = await server.app.inject({
      method: "GET",
      url: "/getpremium?txnId=premium-server-unknown",
    });

    expect(response.statusCode).toBe(404);
  });

  it("grants the subscription on a genuine callback", async () => {
    const { txnId, price } = await makeTransaction();

    const response = await server.app.inject({
      method: "POST",
      url: `/premium_success?txnId=${txnId}`,
      payload: encode(makeForm(txnId, price.toFixed(2))),
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        origin: "https://secure.payu.in",
      },
    });

    expect(response.statusCode).toBe(200);
    expect((await findTransaction(txnId))?.status).toBe("paid");
    expect(await isEntitled(GUILD_ID, "scrim_slots")).toBe(true);
  });

  it("refuses a browser callback with no Origin header", async () => {
    // A browser redirect has to come from PayU. A missing header is a
    // clean refusal — Quotient raised a TypeError on it and the request
    // became a 500.
    const { txnId, price } = await makeTransaction();

    const response = await server.app.inject({
      method: "POST",
      url: `/premium_success?txnId=${txnId}`,
      payload: encode(makeForm(txnId, price.toFixed(2))),
      headers: { "content-type": "application/x-www-form-urlencoded" },
    });

    expect(response.statusCode).toBe(403);
    expect((await findTransaction(txnId))?.status).toBe("pending");
    expect(await isEntitled(GUILD_ID, "scrim_slots")).toBe(false);
  });

  it("refuses a callback from an origin that is not PayU", async () => {
    const { txnId, price } = await makeTransaction();

    const response = await server.app.inject({
      method: "POST",
      url: `/premium_success?txnId=${txnId}`,
      payload: encode(makeForm(txnId, price.toFixed(2))),
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        origin: "https://payu.evil.example",
      },
    });

    expect(response.statusCode).toBe(403);
    expect((await findTransaction(txnId))?.status).toBe("pending");
  });

  it("accepts a callback from PayU's own origin", async () => {
    const { txnId, price } = await makeTransaction();

    const response = await server.app.inject({
      method: "POST",
      url: `/premium_success?txnId=${txnId}`,
      payload: encode(makeForm(txnId, price.toFixed(2))),
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        origin: "https://secure.payu.in",
      },
    });

    expect(response.statusCode).toBe(200);
  });

  it("accepts a callback signed with the other field layout", async () => {
    const { txnId, price } = await makeTransaction();

    const response = await server.app.inject({
      method: "POST",
      url: `/premium_success?txnId=${txnId}`,
      payload: encode(makeForm(txnId, price.toFixed(2), {}, "compact")),
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        origin: "https://secure.payu.in",
      },
    });

    expect(response.statusCode).toBe(200);
    expect((await findTransaction(txnId))?.status).toBe("paid");
  });

  it("refuses a callback that did not succeed", async () => {
    const { txnId, price } = await makeTransaction();

    const response = await server.app.inject({
      method: "POST",
      url: `/premium_success?txnId=${txnId}`,
      payload: encode(
        makeForm(txnId, price.toFixed(2), { status: "failure" }),
      ),
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        origin: "https://secure.payu.in",
      },
    });

    expect(response.statusCode).toBe(400);
    expect((await findTransaction(txnId))?.status).toBe("pending");
  });

  it("refuses a callback that names a different transaction", async () => {
    const { txnId, price } = await makeTransaction();

    const response = await server.app.inject({
      method: "POST",
      url: `/premium_success?txnId=${txnId}`,
      payload: encode(
        makeForm("premium-server-somebody-else", price.toFixed(2)),
      ),
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        origin: "https://secure.payu.in",
      },
    });

    expect(response.statusCode).toBe(400);
    expect((await findTransaction(txnId))?.status).toBe("pending");
  });

  it("refuses a callback with a tampered amount", async () => {
    const { txnId, price } = await makeTransaction();

    const form = makeForm(txnId, price.toFixed(2));
    form.amount = "1.00";

    const response = await server.app.inject({
      method: "POST",
      url: `/premium_success?txnId=${txnId}`,
      payload: encode(form),
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        origin: "https://secure.payu.in",
      },
    });

    expect(response.statusCode).toBe(400);
    expect((await findTransaction(txnId))?.status).toBe("pending");
    expect(await isEntitled(GUILD_ID, "scrim_slots")).toBe(false);
  });

  it("refuses a callback with a tampered email", async () => {
    const { txnId, price } = await makeTransaction();

    const form = makeForm(txnId, price.toFixed(2));
    form.email = "attacker@example.com";

    const response = await server.app.inject({
      method: "POST",
      url: `/premium_success?txnId=${txnId}`,
      payload: encode(form),
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        origin: "https://secure.payu.in",
      },
    });

    expect(response.statusCode).toBe(400);
    expect((await findTransaction(txnId))?.status).toBe("pending");
  });

  it("refuses a callback signed with the wrong key", async () => {
    const { txnId, price } = await makeTransaction();

    const form = makeForm(txnId, price.toFixed(2));

    form.hash = payuResponseHash(
      { key: "wrong-key", salt: CREDENTIALS.salt },
      {
        txnId,
        amount: form.amount,
        productInfo: form.productinfo,
        firstName: form.firstname,
        email: form.email,
        status: form.status,
      },
    );

    const response = await server.app.inject({
      method: "POST",
      url: `/premium_success?txnId=${txnId}`,
      payload: encode(form),
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        origin: "https://secure.payu.in",
      },
    });

    expect(response.statusCode).toBe(400);
    expect((await findTransaction(txnId))?.status).toBe("pending");
  });

  it("refuses a callback whose transaction is not ours", async () => {
    const response = await server.app.inject({
      method: "POST",
      url: "/premium_success?txnId=premium-server-unknown",
      payload: encode(makeForm("premium-server-unknown", "29.00")),
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        origin: "https://secure.payu.in",
      },
    });

    expect(response.statusCode).toBe(404);
  });

  it("grants the subscription through the webhook as well", async () => {
    const { txnId, price } = await makeTransaction();

    const response = await server.app.inject({
      method: "POST",
      url: "/payu/webhook",
      payload: encode(makeForm(txnId, price.toFixed(2))),
      headers: { "content-type": "application/x-www-form-urlencoded" },
    });

    expect(response.statusCode).toBe(200);
    expect((await findTransaction(txnId))?.status).toBe("paid");
    expect(await isEntitled(GUILD_ID, "scrim_slots")).toBe(true);
  });

  it("grants once, however many times the webhook fires", async () => {
    const { txnId, price } = await makeTransaction();

    const form = makeForm(txnId, price.toFixed(2));

    await server.app.inject({
      method: "POST",
      url: "/payu/webhook",
      payload: encode(form),
      headers: { "content-type": "application/x-www-form-urlencoded" },
    });

    const second = await server.app.inject({
      method: "POST",
      url: "/payu/webhook",
      payload: encode(form),
      headers: { "content-type": "application/x-www-form-urlencoded" },
    });

    expect(second.statusCode).toBe(200);
    expect(second.json()).toMatchObject({ success: true, outcome: "already_paid" });
  });

  it("records a failed payment, and the transaction can be retried", async () => {
    const { txnId } = await makeTransaction();

    const response = await server.app.inject({
      method: "POST",
      url: `/premium_failed?txnId=${txnId}`,
      payload: encode({ txnid: txnId, status: "failure" }),
      headers: { "content-type": "application/x-www-form-urlencoded" },
    });

    expect(response.statusCode).toBe(200);
    expect((await findTransaction(txnId))?.status).toBe("failed");

    // The payment page still renders for a failed transaction, so the
    // buyer can try again.
    const page = await server.app.inject({
      method: "GET",
      url: `/getpremium?txnId=${txnId}`,
    });

    expect(page.statusCode).toBe(200);
  });

  it("refuses to render the payment page for a paid transaction", async () => {
    const { txnId, price } = await makeTransaction();

    await server.app.inject({
      method: "POST",
      url: `/premium_success?txnId=${txnId}`,
      payload: encode(makeForm(txnId, price.toFixed(2))),
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        origin: "https://secure.payu.in",
      },
    });

    const page = await server.app.inject({
      method: "GET",
      url: `/getpremium?txnId=${txnId}`,
    });

    expect(page.statusCode).toBe(409);
  });
});
