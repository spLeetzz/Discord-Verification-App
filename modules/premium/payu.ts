/**
 * PayU signature verification.
 *
 * Quotient's `premium_success` callback **verified nothing PayU sent**. It
 * trusted `form["status"] == "success"` and an `Origin` header, both of
 * which the caller controls. Anyone who could reach the HTTP port could
 * grant themselves unlimited premium with one request.
 *
 * This module is the fix. PayU signs the fields it echoes back.
 *
 * ## The two strings
 *
 * The **request** hash — the one we send to PayU — is over the fields in
 * the order they are sent:
 *
 * ```
 * sha512(key|txnid|amount|productinfo|firstname|email|udf1|udf2|udf3|udf4|udf5||||||salt)
 * ```
 *
 * Seventeen fields, and **eleven pipes after the email**. That is the
 * form PayU's own SDK builds, and it is reproduced exactly.
 *
 * The **response** hash — the one PayU sends back — is over the same
 * fields **in reverse order, with the status added**:
 *
 * ```
 * sha512(salt|status||||||udf5|udf4|udf3|udf2|udf1|email|firstname|productinfo|amount|txnid|key)
 * ```
 *
 * Eighteen fields. The salt comes first and the key last, so a request
 * hash is never a valid response hash; and `status` is *inside* the
 * signature, so a failed payment cannot be replayed as a successful one.
 *
 * Quotient assumed the response was the request with the salt and the key
 * swapped (`salt|txnid|amount|…|key`). PayU does not sign it that way —
 * it reverses the fields. The test pins both forms against PayU's own
 * SDK known-answer vectors.
 *
 * The comparison is constant-time: `timingSafeEqual` over the two SHA-512
 * digests, so the function does not leak how much of the hash matched.
 */

import { createHash, timingSafeEqual } from "node:crypto";

/** The merchant credentials PayU signs with. */
export interface PayuCredentials {
  /** The merchant key. */
  readonly key: string;
  /** The merchant salt. */
  readonly salt: string;
}

/** The fields a PayU hash is computed over. */
export interface PayuHashInput {
  /** The transaction id we issued. */
  readonly txnId: string;
  /** The amount, as the exact decimal string that was sent. */
  readonly amount: string;
  /** The product description. */
  readonly productInfo: string;
  /** The buyer's name. */
  readonly firstName: string;
  /** The buyer's email. */
  readonly email: string;
  /** The five user-defined fields. Empty when they were not used. */
  readonly udf?: readonly string[];
}

/**
 * The fields a **response** hash is computed over.
 *
 * The request fields plus the status: PayU signs the status, so the
 * callback cannot have its outcome changed after the fact.
 */
export interface PayuResponseInput extends PayuHashInput {
  /** The status PayU reported, exactly as it sent it. */
  readonly status: string;
}

/* ------------------------------------------------------------------ *
 * The field layout
 * ------------------------------------------------------------------ */

/**
 * The layouts a PayU hash can be computed over.
 *
 * The layout names the **field list** — which fields, and how many empty
 * slots sit between the user-defined fields and the secret. The direction
 * (request or response) is a separate thing: it decides the order and
 * where the two secrets go.
 *
 *  - `"udf-with-blanks"` — the five user-defined fields, then **five
 *    empty slots**, then the secret. Seventeen fields, eleven pipes after
 *    the email. This is the form PayU's own SDK builds, and the one we
 *    send.
 *  - `"compact"` — the same list with the five empty slots removed.
 *    Twelve fields, six pipes after the email. Several third-party guides
 *    publish this form; PayU's SDK does not produce it, so it is not the
 *    default. It is kept because it is a real, published shape of the
 *    same field list, and because a change to either one is then a
 *    one-line edit here.
 *
 * The empty slots are not decoration: PayU's hash string always carries
 * them, and a hash over a different number of fields is a different hash.
 */
export const PAYU_FIELD_LAYOUTS = ["udf-with-blanks", "compact"] as const;

/** One of the known field layouts. */
export type PayuFieldLayout = (typeof PAYU_FIELD_LAYOUTS)[number];

/**
 * The layout used when the caller does not choose one.
 *
 * `"udf-with-blanks"`, because that is the form PayU's SDK produces.
 */
export const DEFAULT_PAYU_FIELD_LAYOUT: PayuFieldLayout = "udf-with-blanks";

/**
 * How many empty slots each layout puts between the user-defined fields
 * and the secret.
 *
 * This is the whole difference between the two layouts, and it is here,
 * in one table, instead of five bare `""` entries in an array.
 */
const LAYOUT_BLANK_SLOTS: Record<PayuFieldLayout, number> = {
  "udf-with-blanks": 5,
  compact: 0,
};

/**
 * The field list of a layout, written out.
 *
 * For the humans and for the error messages: it is what the layout
 * actually is, in one line.
 */
export function payuFieldLayoutShape(layout: PayuFieldLayout): string {
  const blanks = LAYOUT_BLANK_SLOTS[layout];

  return [
    "key",
    "txnid",
    "amount",
    "productinfo",
    "firstname",
    "email",
    "udf1",
    "udf2",
    "udf3",
    "udf4",
    "udf5",
    ...Array.from({ length: blanks }, () => "(empty)"),
    "salt",
  ].join("|");
}

/* ------------------------------------------------------------------ *
 * The hash
 * ------------------------------------------------------------------ */

/** How many user-defined fields PayU signs. */
const UDF_COUNT = 5;

/** A SHA-512 digest, hex encoded. */
const HEX_128 = /^[0-9a-f]{128}$/i;

/**
 * The fields a request hash is built from, in order.
 *
 * The key leads and the salt closes the string, and the layout decides
 * how many empty slots sit between the user-defined fields and the salt.
 */
function requestFields(
  credentials: PayuCredentials,
  input: PayuHashInput,
  layout: PayuFieldLayout,
): string[] {
  const udf: string[] = [];

  for (let index = 0; index < UDF_COUNT; index += 1) {
    udf.push(input.udf?.[index] ?? "");
  }

  const blanks: string[] = [];

  for (let index = 0; index < LAYOUT_BLANK_SLOTS[layout]; index += 1) {
    blanks.push("");
  }

  return [
    credentials.key,
    input.txnId,
    input.amount,
    input.productInfo,
    input.firstName,
    input.email,
    ...udf,
    ...blanks,
    credentials.salt,
  ];
}

/**
 * The hash PayU expects on the **request** we send it.
 *
 * The key comes first and the salt last.
 */
export function payuRequestHash(
  credentials: PayuCredentials,
  input: PayuHashInput,
  layout: PayuFieldLayout = DEFAULT_PAYU_FIELD_LAYOUT,
): string {
  return sha512(requestFields(credentials, input, layout).join("|"));
}

/**
 * The hash PayU sends back on the **response**.
 *
 * PayU takes the request's fields **in reverse order**, puts the salt
 * first and the key last, and puts the **status** in the second
 * position:
 *
 * ```
 * salt|status||||||udf5|udf4|udf3|udf2|udf1|email|firstname|productinfo|amount|txnid|key
 * ```
 *
 * Two things follow from that, and both matter:
 *
 *  - the salt and the key are at opposite ends, so a request hash is
 *    never a valid response hash;
 *  - the status is inside the signature, so a callback cannot have its
 *    outcome changed after the fact. A form that says "failure" cannot
 *    be replayed as "success".
 */
export function payuResponseHash(
  credentials: PayuCredentials,
  input: PayuResponseInput,
  layout: PayuFieldLayout = DEFAULT_PAYU_FIELD_LAYOUT,
): string {
  const fields = requestFields(credentials, input, layout);

  fields.reverse();

  // The salt leads the string, then the status, then the rest of the
  // request's fields in reverse, ending with the key. The salt is the
  // last field of the request list, so it is the first after the
  // reversal.
  const reversed = [credentials.salt, input.status, ...fields.slice(1)];

  return sha512(reversed.join("|"));
}

/**
 * Every response hash a genuine callback could carry — one per layout.
 *
 * **Why more than one is safe.** Both layouts are computed over the same
 * signed fields with the same secret, so an attacker who cannot produce
 * one cannot produce the other: the set of forgeable messages is
 * identical, and accepting a second encoding of the same signature
 * broadens compatibility without broadening what an attacker can do.
 *
 * Do not "tighten" this back to a single layout without reading
 * `modules/premium/PAYU-HASH-REPORT.md` — the checkout stops working if
 * PayU's live gateway uses the other form.
 */
export function payuResponseHashCandidates(
  credentials: PayuCredentials,
  input: PayuResponseInput,
): readonly string[] {
  return PAYU_FIELD_LAYOUTS.map((layout) =>
    payuResponseHash(credentials, input, layout),
  );
}

/** The SHA-512 digest of a string, hex encoded. */
function sha512(value: string): string {
  return createHash("sha512").update(value, "utf8").digest("hex");
}

/**
 * Compares two strings without leaking how much of them matched.
 *
 * Both sides are hashed first, so the buffers handed to `timingSafeEqual`
 * are always the same length and the comparison cannot throw on a
 * malformed input.
 */
export function constantTimeEquals(left: string, right: string): boolean {
  const a = createHash("sha512").update(left, "utf8").digest();
  const b = createHash("sha512").update(right, "utf8").digest();

  return timingSafeEqual(a, b);
}

/* ------------------------------------------------------------------ *
 * Amounts
 * ------------------------------------------------------------------ */

/** A decimal number, split into its parts. */
interface Decimal {
  readonly negative: boolean;
  /** The integer part, without leading zeros. */
  readonly integer: string;
  /** The fractional part, as written. */
  readonly fraction: string;
}

const DECIMAL_PATTERN = /^([+-]?)(\d*)(?:\.(\d*))?$/;

/**
 * Formats a rupee amount the way the payment gateway expects it.
 *
 * The gateway wants a decimal string — "29.00", not "29" and not `29`.
 * The **same string** goes into the form and into the hash, because the
 * hash is computed over the bytes the gateway received.
 */
export function formatAmount(rupees: number): string {
  return rupees.toFixed(2);
}

/**
 * Parses a decimal string.
 *
 * @returns the parts, or `null` when the text is not a number.
 */
export function parseAmount(value: string): Decimal | null {
  const match = DECIMAL_PATTERN.exec(value.trim());

  if (!match) return null;

  const sign = match[1] ?? "";
  const integer = match[2] ?? "";
  const fraction = match[3] ?? "";

  if (integer === "" && fraction === "") return null;

  return {
    negative: sign === "-",
    integer: integer === "" ? "0" : integer.replace(/^0+(?=\d)/, ""),
    fraction,
  };
}

/**
 * Compares two amounts numerically.
 *
 * "29" and "29.00" are the same amount, and the gateway is free to send
 * either. A string comparison would refuse a real payment over a missing
 * zero, so the comparison is done on the value, in exact arithmetic.
 */
export function amountsEqual(left: string, right: string): boolean {
  const a = parseAmount(left);
  const b = parseAmount(right);

  if (!a || !b) return false;

  const scale = Math.max(a.fraction.length, b.fraction.length);

  return scaled(a, scale) === scaled(b, scale);
}

/**
 * The value of a decimal, scaled to `scale` fractional digits.
 *
 * `BigInt` keeps the comparison exact — a price is never a float here.
 */
function scaled(value: Decimal, scale: number): bigint {
  const magnitude = BigInt(
    `${value.integer}${value.fraction.padEnd(scale, "0")}`,
  );

  return value.negative ? -magnitude : magnitude;
}

/* ------------------------------------------------------------------ *
 * The origin header
 * ------------------------------------------------------------------ */

/**
 * The hosts a PayU redirect may come from.
 *
 * A suffix, not a substring: Quotient checked `"payu" in origin`, which
 * passes for `https://payu.evil.example` as well as for the real thing.
 */
export const PAYU_ORIGIN_SUFFIXES = [".payu.in", ".payu.com"] as const;

/**
 * Is this `Origin` header a PayU one?
 *
 * @param origin the header value. `undefined` and `null` are allowed and
 *               answer `false` — Quotient's `request.headers.get("origin")`
 *               returned `None` for a missing header and `"payu" in None`
 *               raised a `TypeError` that became a 500.
 */
export function isPayuOrigin(origin: string | undefined | null): boolean {
  if (!origin) return false;

  let url: URL;

  try {
    url = new URL(origin);
  } catch {
    return false;
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") return false;

  const host = url.hostname.toLowerCase();

  return PAYU_ORIGIN_SUFFIXES.some(
    (suffix) => host === suffix.slice(1) || host.endsWith(suffix),
  );
}

/* ------------------------------------------------------------------ *
 * The callback
 * ------------------------------------------------------------------ */

/** The fields PayU posts back. */
export interface PayuCallbackPayload {
  readonly txnid: string;
  readonly amount: string;
  readonly productinfo: string;
  readonly firstname: string;
  readonly email: string;
  readonly status: string;
  readonly hash: string;
  /** The merchant key PayU echoes. Checked when it is there. */
  readonly key?: string;
  readonly udf1?: string;
  readonly udf2?: string;
  readonly udf3?: string;
  readonly udf4?: string;
  readonly udf5?: string;
}

/**
 * Where a callback came from.
 *
 *  - `"browser"` — the gateway redirected the buyer's browser to our
 *    success URL. The request carries an `Origin`, and it has to be
 *    PayU's.
 *  - `"webhook"` — the gateway posted to us from its own servers. There
 *    is no `Origin` in a server-to-server call, and asking for one would
 *    refuse every webhook. The signature is what carries the trust here.
 */
export type PayuCallbackSource = "browser" | "webhook";

/** What we expect a callback to say. */
export interface PayuCallbackExpectation {
  /** The transaction id we issued. */
  readonly txnId: string;
  /** The price of the plan, as a decimal string. */
  readonly amount: string;
  /** The merchant credentials. */
  readonly credentials: PayuCredentials;
  /** Where the callback came from. */
  readonly source: PayuCallbackSource;
  /**
   * The request's `Origin` header, when it had one.
   *
   * `undefined` for a request that carried none.
   */
  readonly origin?: string | undefined;
}

/**
 * Why a callback was refused.
 *
 * A machine-readable code next to the human-readable reason, so the
 * server can answer with the right status code (a foreign origin is a
 * `403`, everything else is a `400`) without matching on the wording.
 */
export type PayuRejection =
  /** The transaction id is not the one we issued. */
  | "unknown_transaction"
  /** The callback was signed for a different merchant. */
  | "wrong_merchant"
  /** The gateway did not report a successful payment. */
  | "not_successful"
  /** The request did not come from the gateway's origin. */
  | "wrong_origin"
  /** The callback carried no usable signature. */
  | "no_signature"
  /** The signature did not verify. */
  | "bad_signature"
  /** The amount is not the price of the plan. */
  | "wrong_amount";

/** The outcome of verifying a callback. */
export type PayuVerification =
  | {
      readonly ok: true;
      /** The amount PayU reported, exactly as it sent it. */
      readonly amount: string;
      /** The email PayU reported — the buyer's real address. */
      readonly email: string;
      /** The name PayU reported. */
      readonly firstName: string;
      /** The status PayU reported. */
      readonly status: string;
    }
  | {
      readonly ok: false;
      /** What went wrong, in words a buyer can read. */
      readonly reason: string;
      /** What went wrong, in a form code can act on. */
      readonly code: PayuRejection;
    };

/**
 * Verifies a PayU callback.
 *
 * Six checks, in this order:
 *
 *  1. **the transaction id is ours** — the one we issued, and (in the
 *     server) the one that exists in the database;
 *  2. **the merchant key is ours**, when the callback carries one;
 *  3. **the status is `success`** — the gateway says the payment went
 *     through;
 *  4. **the origin is PayU's** — for a browser redirect. The hostname
 *     is checked against a suffix list, and a missing header is a
 *     refusal, not an exception;
 *  5. **the signature verifies**, in constant time, against the response
 *     hash of every known layout;
 *  6. **the amount is the plan's price**, compared as a decimal.
 *
 * The order is cheapest-and-most-selective first, and the two checks that
 * grant the purchase — the signature and the amount — are last, so
 * nothing is written before they have both passed.
 *
 * A tampered amount, a tampered email or the wrong merchant key all fail
 * check 5, because the signature covers those fields. The amount is
 * checked again in check 6 anyway: a mismatch in a signed field is
 * impossible unless the signature also matched, but the check is
 * independent on purpose, and it catches a gateway that echoes a stale
 * amount.
 */
export function verifyPayuCallback(
  payload: PayuCallbackPayload,
  expectation: PayuCallbackExpectation,
): PayuVerification {
  if (!payload.txnid || payload.txnid !== expectation.txnId) {
    return {
      ok: false,
      reason: "The transaction id does not match the one we issued.",
      code: "unknown_transaction",
    };
  }

  // The signature covers the key too, so this only catches a callback
  // for somebody else's merchant account before any work is done.
  if (payload.key && payload.key !== expectation.credentials.key) {
    return {
      ok: false,
      reason: "The callback was signed for a different merchant.",
      code: "wrong_merchant",
    };
  }

  if (!isSuccessfulStatus(payload.status)) {
    return {
      ok: false,
      reason: "The gateway did not report a successful payment.",
      code: "not_successful",
    };
  }

  if (expectation.source === "browser" && !isPayuOrigin(expectation.origin)) {
    return {
      ok: false,
      reason: "The request did not come from the payment gateway.",
      code: "wrong_origin",
    };
  }

  if (!HEX_128.test(payload.hash)) {
    return {
      ok: false,
      reason: "The callback carried no usable signature.",
      code: "no_signature",
    };
  }

  const candidates = payuResponseHashCandidates(expectation.credentials, {
    txnId: payload.txnid,
    amount: payload.amount,
    productInfo: payload.productinfo,
    firstName: payload.firstname,
    email: payload.email,
    udf: [
      payload.udf1 ?? "",
      payload.udf2 ?? "",
      payload.udf3 ?? "",
      payload.udf4 ?? "",
      payload.udf5 ?? "",
    ],
    // The status is signed exactly as PayU sent it — not the normalised
    // one — because the hash is over the bytes that came in.
    status: payload.status,
  });

  // Every candidate is checked, even after one matches: `some` would
  // stop at the first hit and leak which layout the gateway used.
  let verified = false;

  for (const candidate of candidates) {
    if (constantTimeEquals(candidate, payload.hash)) verified = true;
  }

  if (!verified) {
    return {
      ok: false,
      reason: "The callback signature did not verify.",
      code: "bad_signature",
    };
  }

  if (!amountsEqual(payload.amount, expectation.amount)) {
    return {
      ok: false,
      reason: "The amount paid does not match the price of the plan.",
      code: "wrong_amount",
    };
  }

  return {
    ok: true,
    amount: payload.amount,
    email: payload.email,
    firstName: payload.firstname,
    status: payload.status,
  };
}

/**
 * Did PayU report a successful payment?
 *
 * The status is checked separately from the signature: a webhook that
 * carries a "failure" status must not grant a subscription even though
 * its signature verifies. The signature also *covers* the status, so a
 * callback cannot have its outcome changed after the fact.
 */
export function isSuccessfulStatus(status: string | undefined): boolean {
  return (status ?? "").trim().toLowerCase() === "success";
}
