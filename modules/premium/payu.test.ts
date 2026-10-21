/**
 * The PayU signature verification — the security-critical code.
 *
 * Quotient's `premium_success` callback verified **nothing** PayU sent: it
 * trusted `form["status"] == "success"` and an `Origin` header, both
 * attacker-controlled. Anyone who could reach the HTTP port could grant
 * themselves unlimited premium. These tests are the proof that the
 * replacement actually verifies something.
 *
 * The hash vectors below were computed independently (Python's
 * `hashlib`), not by this code, so they are a known-answer test: if the
 * field order or the number of pipes changes, they fail.
 */

import { describe, expect, it } from "vitest";
import {
  amountsEqual,
  constantTimeEquals,
  formatAmount,
  isPayuOrigin,
  isSuccessfulStatus,
  parseAmount,
  payuRequestHash,
  payuResponseHash,
  verifyPayuCallback,
} from "./payu.js";
import type { PayuCallbackPayload, PayuCredentials } from "./payu.js";

const CREDENTIALS: PayuCredentials = {
  key: "gtMP0Xrl6",
  salt: "1wPayLO7nm",
};

const INPUT = {
  txnId: "ORD201608170001",
  amount: "1000.00",
  productInfo: "sample product",
  firstName: "Gaurav",
  email: "gauravkumar@example.com",
} as const;

/** The request hash, computed outside this code. */
const REQUEST_HASH =
  "163ccb6428a4f672c43d0c27e34b7761cc6fa7341dc98b2a9a22c1433bb9210cab56339e4c2ca44c108338dfd8e288b1653104354664292ccef12e224347e7f9";

/** The response hash, computed outside this code. */
const RESPONSE_HASH =
  "ac8aee8968fc0672aa79fc7a6418216983dfd2aa47d2764e8bca90cb2aff23a362aa7f7da7aa3077072d3d65ed59aea3c23b8b6294855160a7ab143840c478fc";

describe("modules/premium/payu — the hash", () => {
  it("builds the request hash the way PayU documents it", () => {
    expect(payuRequestHash(CREDENTIALS, INPUT)).toBe(REQUEST_HASH);
  });

  it("builds the response hash with the salt and the key swapped", () => {
    expect(payuResponseHash(CREDENTIALS, INPUT)).toBe(RESPONSE_HASH);
  });

  it("produces different hashes for the request and the response", () => {
    // The whole point of the swap: a request hash is not a valid
    // response hash, so a replay of the request form cannot be used as a
    // callback.
    expect(payuRequestHash(CREDENTIALS, INPUT)).not.toBe(
      payuResponseHash(CREDENTIALS, INPUT),
    );
  });

  it("signs the user-defined fields when they are used", () => {
    const withUdf = payuResponseHash(CREDENTIALS, {
      ...INPUT,
      udf: ["one", "two", "three", "four", "five"],
    });

    expect(withUdf).not.toBe(RESPONSE_HASH);
    expect(withUdf).toHaveLength(128);
  });

  it("treats missing user-defined fields as empty ones", () => {
    expect(payuRequestHash(CREDENTIALS, INPUT)).toBe(
      payuRequestHash(CREDENTIALS, { ...INPUT, udf: ["", "", "", "", ""] }),
    );
  });
});

describe("modules/premium/payu — the constant-time comparison", () => {
  it("accepts identical strings", () => {
    expect(constantTimeEquals("abc", "abc")).toBe(true);
  });

  it("rejects different strings", () => {
    expect(constantTimeEquals("abc", "abd")).toBe(false);
  });

  it("rejects a string of a different length without throwing", () => {
    expect(constantTimeEquals("abc", "abcdef")).toBe(false);
  });
});

describe("modules/premium/payu — the amounts", () => {
  it("formats a rupee amount as a decimal string", () => {
    expect(formatAmount(29)).toBe("29.00");
    expect(formatAmount(4999)).toBe("4999.00");
    expect(formatAmount(0)).toBe("0.00");
  });

  it("compares 29 and 29.00 as the same amount", () => {
    expect(amountsEqual("29", "29.00")).toBe(true);
    expect(amountsEqual("29.00", "29")).toBe(true);
    expect(amountsEqual("29.0", "29.000")).toBe(true);
  });

  it("refuses a different amount", () => {
    expect(amountsEqual("29", "30")).toBe(false);
    expect(amountsEqual("29.00", "29.01")).toBe(false);
    expect(amountsEqual("29", "290")).toBe(false);
  });

  it("refuses text that is not a number", () => {
    expect(amountsEqual("29", "twenty nine")).toBe(false);
    expect(amountsEqual("29", "")).toBe(false);
    expect(amountsEqual("", "")).toBe(false);
  });

  it("handles the shapes a gateway might send", () => {
    expect(parseAmount(".5")?.fraction).toBe("5");
    expect(parseAmount("29.")?.integer).toBe("29");
    expect(parseAmount("+29")?.negative).toBe(false);
    expect(parseAmount("-29")?.negative).toBe(true);
    expect(parseAmount("not a number")).toBeNull();
  });
});

describe("modules/premium/payu — the origin header", () => {
  it("accepts a PayU origin", () => {
    expect(isPayuOrigin("https://secure.payu.in")).toBe(true);
    expect(isPayuOrigin("https://pay.payu.in")).toBe(true);
    expect(isPayuOrigin("https://api.payu.com")).toBe(true);
  });

  it("does not crash when the header is missing", () => {
    // Quotient: `if not "payu" in request.headers.get("origin")` — a
    // missing header is `None`, and `"payu" in None` raises a TypeError
    // that became a 500.
    expect(isPayuOrigin(undefined)).toBe(false);
    expect(isPayuOrigin(null)).toBe(false);
    expect(isPayuOrigin("")).toBe(false);
  });

  it("rejects a host that merely contains the word", () => {
    // `"payu" in "https://payu.evil.example"` is true. It must not be.
    expect(isPayuOrigin("https://payu.evil.example")).toBe(false);
    expect(isPayuOrigin("https://evil.example/payu")).toBe(false);
    expect(isPayuOrigin("https://notpayu.in")).toBe(false);
    expect(isPayuOrigin("not a url")).toBe(false);
  });
});

describe("modules/premium/payu — the callback", () => {
  const goodPayload: PayuCallbackPayload = {
    txnid: INPUT.txnId,
    amount: INPUT.amount,
    productinfo: INPUT.productInfo,
    firstname: INPUT.firstName,
    email: INPUT.email,
    status: "success",
    hash: RESPONSE_HASH,
  };

  const expectation = {
    txnId: INPUT.txnId,
    amount: INPUT.amount,
    credentials: CREDENTIALS,
  };

  it("accepts a genuine callback", () => {
    const result = verifyPayuCallback(goodPayload, expectation);

    expect(result.ok).toBe(true);

    if (result.ok) {
      expect(result.amount).toBe("1000.00");
      expect(result.email).toBe(INPUT.email);
      expect(result.firstName).toBe(INPUT.firstName);
    }
  });

  it("rejects a transaction id that is not ours", () => {
    const result = verifyPayuCallback(
      { ...goodPayload, txnid: "ORD999999999999" },
      expectation,
    );

    expect(result.ok).toBe(false);
  });

  it("rejects a tampered amount", () => {
    // The amount is signed, so changing it breaks the signature — and
    // the amount check would refuse it as well.
    const result = verifyPayuCallback(
      { ...goodPayload, amount: "1.00" },
      expectation,
    );

    expect(result.ok).toBe(false);
  });

  it("rejects a tampered email", () => {
    const result = verifyPayuCallback(
      { ...goodPayload, email: "attacker@example.com" },
      expectation,
    );

    expect(result.ok).toBe(false);
  });

  it("rejects a tampered name", () => {
    const result = verifyPayuCallback(
      { ...goodPayload, firstname: "Somebody Else" },
      expectation,
    );

    expect(result.ok).toBe(false);
  });

  it("rejects a wrong merchant key", () => {
    const result = verifyPayuCallback(goodPayload, {
      ...expectation,
      credentials: { key: "wrong-key", salt: CREDENTIALS.salt },
    });

    expect(result.ok).toBe(false);
  });

  it("rejects a wrong merchant salt", () => {
    const result = verifyPayuCallback(goodPayload, {
      ...expectation,
      credentials: { key: CREDENTIALS.key, salt: "wrong-salt" },
    });

    expect(result.ok).toBe(false);
  });

  it("rejects a hash that is not a hash", () => {
    const result = verifyPayuCallback(
      { ...goodPayload, hash: "not-a-hash" },
      expectation,
    );

    expect(result.ok).toBe(false);
  });

  it("rejects a request hash used as a response hash", () => {
    // The request hash and the response hash differ only in where the key
    // and the salt sit. Using the wrong one is the classic mistake.
    const result = verifyPayuCallback(
      { ...goodPayload, hash: REQUEST_HASH },
      expectation,
    );

    expect(result.ok).toBe(false);
  });

  it("rejects an amount that is not the plan's price", () => {
    // A genuinely signed callback for the wrong price: the signature is
    // good, the amount is not.
    const amount = "2000.00";

    const payload: PayuCallbackPayload = {
      ...goodPayload,
      amount,
      hash: payuResponseHash(CREDENTIALS, { ...INPUT, amount }),
    };

    const result = verifyPayuCallback(payload, expectation);

    expect(result.ok).toBe(false);
  });

  it("accepts an amount the gateway wrote differently", () => {
    // "29" and "29.00" are the same money. The gateway is free to send
    // either, and the signature is computed over whatever it sent.
    const amount = "29";

    const payload: PayuCallbackPayload = {
      ...goodPayload,
      amount,
      hash: payuResponseHash(CREDENTIALS, {
        ...INPUT,
        txnId: "ORD201608170001",
        amount,
      }),
    };

    const result = verifyPayuCallback(payload, {
      ...expectation,
      amount: "29.00",
    });

    expect(result.ok).toBe(true);
  });
});

describe("modules/premium/payu — the status", () => {
  it("recognises a successful payment", () => {
    expect(isSuccessfulStatus("success")).toBe(true);
    expect(isSuccessfulStatus("SUCCESS")).toBe(true);
    expect(isSuccessfulStatus(" success ")).toBe(true);
  });

  it("refuses anything else", () => {
    expect(isSuccessfulStatus("failure")).toBe(false);
    expect(isSuccessfulStatus("pending")).toBe(false);
    expect(isSuccessfulStatus("")).toBe(false);
    expect(isSuccessfulStatus(undefined)).toBe(false);
  });
});
