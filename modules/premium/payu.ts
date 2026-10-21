/**
 * PayU signature verification.
 *
 * Quotient's `premium_success` callback **verified nothing PayU sent**. It
 * trusted `form["status"] == "success"` and an `Origin` header, both of
 * which the caller controls. Anyone who could reach the HTTP port could
 * grant themselves unlimited premium with one request.
 *
 * This module is the fix. PayU signs the fields it echoes back:
 *
 * ```
 * request  hash = sha512(key|txnid|amount|productinfo|firstname|email|udf1|…|udf5||||||salt)
 * response hash = sha512(salt|txnid|amount|productinfo|firstname|email|udf1|…|udf5||||||key)
 * ```
 *
 * The **salt and the key are swapped** between the two. A request hash
 * built the response way round is the classic way to get this wrong, so
 * the two are separate functions here and the test proves they differ.
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

/** How many user-defined fields PayU signs. */
const UDF_COUNT = 5;

/** A SHA-512 digest, hex encoded. */
const HEX_128 = /^[0-9a-f]{128}$/i;

/**
 * The fields the hash is built from, in order.
 *
 * `key`/`salt` first and last, and five empty fields between the user
 * fields and the trailing secret — that is the shape PayU documents, and
 * it is reproduced exactly rather than approximated.
 */
function hashFields(
  first: string,
  last: string,
  input: PayuHashInput,
): string {
  const udf: string[] = [];

  for (let index = 0; index < UDF_COUNT; index += 1) {
    udf.push(input.udf?.[index] ?? "");
  }

  const fields = [
    first,
    input.txnId,
    input.amount,
    input.productInfo,
    input.firstName,
    input.email,
    ...udf,
    "",
    "",
    "",
    "",
    "",
    last,
  ];

  return createHash("sha512").update(fields.join("|"), "utf8").digest("hex");
}

/**
 * The hash PayU expects on the **request** we send it.
 *
 * The key comes first and the salt last.
 */
export function payuRequestHash(
  credentials: PayuCredentials,
  input: PayuHashInput,
): string {
  return hashFields(credentials.key, credentials.salt, input);
}

/**
 * The hash PayU sends back on the **response**.
 *
 * The salt comes first and the key last — the opposite of the request.
 */
export function payuResponseHash(
  credentials: PayuCredentials,
  input: PayuHashInput,
): string {
  return hashFields(credentials.salt, credentials.key, input);
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
  readonly udf1?: string;
  readonly udf2?: string;
  readonly udf3?: string;
  readonly udf4?: string;
  readonly udf5?: string;
}

/** What we expect a callback to say. */
export interface PayuCallbackExpectation {
  /** The transaction id we issued. */
  readonly txnId: string;
  /** The price of the plan, as a decimal string. */
  readonly amount: string;
  /** The merchant credentials. */
  readonly credentials: PayuCredentials;
}

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
  | { readonly ok: false; readonly reason: string };

/**
 * Verifies a PayU callback.
 *
 * Three independent checks, in this order:
 *
 *  1. the transaction id is the one we issued;
 *  2. the signature matches the fields PayU sent (constant-time);
 *  3. the amount is the plan's price, compared as a decimal.
 *
 * A tampered amount, a tampered email or the wrong merchant key all fail
 * check 2, because the signature covers those fields.
 */
export function verifyPayuCallback(
  payload: PayuCallbackPayload,
  expected: PayuCallbackExpectation,
): PayuVerification {
  if (!payload.txnid || payload.txnid !== expected.txnId) {
    return {
      ok: false,
      reason: "The transaction id does not match the one we issued.",
    };
  }

  if (!HEX_128.test(payload.hash)) {
    return { ok: false, reason: "The callback carried no usable signature." };
  }

  const computed = payuResponseHash(expected.credentials, {
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
  });

  if (!constantTimeEquals(computed, payload.hash)) {
    return { ok: false, reason: "The callback signature did not verify." };
  }

  if (!amountsEqual(payload.amount, expected.amount)) {
    return {
      ok: false,
      reason: "The amount paid does not match the price of the plan.",
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
 * its signature verifies.
 */
export function isSuccessfulStatus(status: string | undefined): boolean {
  return (status ?? "").trim().toLowerCase() === "success";
}
