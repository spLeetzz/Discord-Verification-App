/**
 * The PayU signature verification — the security-critical code.
 *
 * Quotient's `premium_success` callback verified **nothing** PayU sent: it
 * trusted `form["status"] == "success"` and an `Origin` header, both
 * attacker-controlled. Anyone who could reach the HTTP port could grant
 * themselves unlimited premium. These tests are the proof that the
 * replacement actually verifies something.
 *
 * The hash vectors below are **known-answer tests**. They were computed
 * outside this code, with Python's `hashlib`, and the two marked "PayU's
 * own SDK" come from the test suite of `payu-india/payu-sdk-node` — so
 * they are not this implementation agreeing with itself. If the field
 * order, the number of pipes or the direction of the reversal ever
 * changes, these fail loudly.
 */

import { describe, expect, it } from "vitest";
import {
  amountsEqual,
  constantTimeEquals,
  formatAmount,
  isFailureStatus,
  isPayuOrigin,
  isSuccessfulStatus,
  parseAmount,
  PAYU_FIELD_LAYOUTS,
  payuFieldLayoutShape,
  payuRequestHash,
  payuResponseHash,
  payuResponseHashCandidates,
  verifyPayuCallback,
  verifyPayuFailureCallback,
} from "./payu.js";
import type {
  PayuCallbackPayload,
  PayuCredentials,
  PayuFieldLayout,
} from "./payu.js";

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

const STATUS = "success";

/* ------------------------------------------------------------------ *
 * The pinned vectors
 * ------------------------------------------------------------------ */

/**
 * The request hash, layout `"udf-with-blanks"`.
 *
 * Seventeen fields, eleven pipes after the email.
 */
const REQUEST_HASH_UDF_WITH_BLANKS =
  "163ccb6428a4f672c43d0c27e34b7761cc6fa7341dc98b2a9a22c1433bb9210cab56339e4c2ca44c108338dfd8e288b1653104354664292ccef12e224347e7f9";

/** The request hash, layout `"compact"`. Twelve fields. */
const REQUEST_HASH_COMPACT =
  "8b7572d3452ffbd48239befd8d5cf5cf8ccd7c2d3a4b6a288a3ddb428281f32a4861201d96eaf40b0f9de1281b542279e2f67d10393575b213aeaf66b402aeb3";

/**
 * The response hash, layout `"udf-with-blanks"`.
 *
 * Eighteen fields: the salt, the status, the request's fields in reverse
 * order, and the key.
 */
const RESPONSE_HASH_UDF_WITH_BLANKS =
  "b24834c0a5d187e1c2975004a0e9e7548db0bb47b71be113406c3d1602bfcff73ec1b22beed63429659e0ef781f7407d13a6358e0e4c76d828b709dc43b014e0";

/** The response hash, layout `"compact"`. Thirteen fields. */
const RESPONSE_HASH_COMPACT =
  "e83803397ef14c87e83fa0f5e3c31f90a6d477adf8041a203a5f939f2b79cf392c40bbdccbb9cccf52a4ba127c9cd32e0394def5e381cb2e6069663a616377d5";

/**
 * The hash Quotient's model produces: the request's fields with the salt
 * and the key swapped, and **no status inside the signature**.
 *
 * It is pinned here so the record shows what it is — and so the test
 * below can prove it is refused.
 */
const LEGACY_SWAPPED_HASH =
  "ac8aee8968fc0672aa79fc7a6418216983dfd2aa47d2764e8bca90cb2aff23a362aa7f7da7aa3077072d3d65ed59aea3c23b8b6294855160a7ab143840c478fc";

/**
 * PayU's **own** known-answer vectors, from the test suite of
 * `payu-india/payu-sdk-node` (`tests/payu/hasher.test.js`).
 *
 * These are the anchor: they come from PayU's own SDK, so a layout that
 * reproduces them is the layout PayU's gateway actually uses.
 */
const SDK_CREDENTIALS: PayuCredentials = {
  key: "bjg$121",
  salt: "vhgvs75",
};

const SDK_INPUT = {
  txnId: "3123",
  amount: "1000",
  productInfo: "mobile",
  firstName: "Jacob",
  email: "test@payu.in",
} as const;

const SDK_REQUEST_HASH =
  "19d0822939b32b371847521c89aba3521de3a9bfeabeee5dab2d6f41962ff9fcdcee87067bb3a3de870acce488f9ff88a3511bb78c6143344a277b1b91ad38b8";

const SDK_RESPONSE_HASH =
  "687c82156a84271a7a6c63d0e8774d5ac567d9b894a334a47d72e47b72392a5167a1b2add5b253490b70731d9eb3e3a3b7225e0c5f26829befafbbee71977c4c";

describe("modules/premium/payu — the field layouts", () => {
  it("knows exactly two layouts", () => {
    expect(PAYU_FIELD_LAYOUTS).toEqual(["udf-with-blanks", "compact"]);
  });

  it("describes each layout in one line", () => {
    expect(payuFieldLayoutShape("udf-with-blanks")).toBe(
      "key|txnid|amount|productinfo|firstname|email|udf1|udf2|udf3|udf4|udf5|(empty)|(empty)|(empty)|(empty)|(empty)|salt",
    );

    expect(payuFieldLayoutShape("compact")).toBe(
      "key|txnid|amount|productinfo|firstname|email|udf1|udf2|udf3|udf4|udf5|salt",
    );
  });
});

describe("modules/premium/payu — the request hash", () => {
  it("builds the request hash the way PayU's SDK does", () => {
    // The layout Quotient used: seventeen fields, eleven pipes after the
    // email. This is the one PayU's own SDK produces.
    expect(
      payuRequestHash(CREDENTIALS, INPUT, "udf-with-blanks"),
    ).toBe(REQUEST_HASH_UDF_WITH_BLANKS);
  });

  it("builds the compact request hash too", () => {
    // The form several third-party guides publish: the same fields with
    // the five empty slots removed.
    expect(payuRequestHash(CREDENTIALS, INPUT, "compact")).toBe(
      REQUEST_HASH_COMPACT,
    );
  });

  it("reproduces PayU's own SDK known-answer vector", () => {
    expect(
      payuRequestHash(SDK_CREDENTIALS, SDK_INPUT, "udf-with-blanks"),
    ).toBe(SDK_REQUEST_HASH);
  });

  it("signs the user-defined fields when they are used", () => {
    const withUdf = payuRequestHash(
      CREDENTIALS,
      { ...INPUT, udf: ["one", "two", "three", "four", "five"] },
      "udf-with-blanks",
    );

    expect(withUdf).not.toBe(REQUEST_HASH_UDF_WITH_BLANKS);
    expect(withUdf).toHaveLength(128);
  });

  it("treats missing user-defined fields as empty ones", () => {
    for (const layout of PAYU_FIELD_LAYOUTS) {
      expect(payuRequestHash(CREDENTIALS, INPUT, layout)).toBe(
        payuRequestHash(CREDENTIALS, { ...INPUT, udf: ["", "", "", "", ""] }, layout),
      );
    }
  });
});

describe("modules/premium/payu — the response hash", () => {
  it("builds the response hash the way PayU's SDK does", () => {
    // The salt, the status, then the request's fields in reverse order,
    // and the key. Eighteen fields.
    expect(
      payuResponseHash(
        CREDENTIALS,
        { ...INPUT, status: STATUS },
        "udf-with-blanks",
      ),
    ).toBe(RESPONSE_HASH_UDF_WITH_BLANKS);
  });

  it("builds the compact response hash too", () => {
    expect(
      payuResponseHash(CREDENTIALS, { ...INPUT, status: STATUS }, "compact"),
    ).toBe(RESPONSE_HASH_COMPACT);
  });

  it("reproduces PayU's own SDK known-answer vector", () => {
    expect(
      payuResponseHash(
        SDK_CREDENTIALS,
        { ...SDK_INPUT, status: STATUS },
        "udf-with-blanks",
      ),
    ).toBe(SDK_RESPONSE_HASH);
  });

  it("signs the status, so the outcome cannot be changed afterwards", () => {
    // This is the whole reason the response hash is not the request hash
    // with the salt and the key swapped: the status is *inside* the
    // signature, so a failed payment cannot be replayed as a success.
    const success = payuResponseHash(
      CREDENTIALS,
      { ...INPUT, status: "success" },
      "udf-with-blanks",
    );

    const failure = payuResponseHash(
      CREDENTIALS,
      { ...INPUT, status: "failure" },
      "udf-with-blanks",
    );

    expect(success).not.toBe(failure);
  });

  it("produces different hashes for the request and the response", () => {
    // The salt and the key are at opposite ends, so a request hash is
    // not a valid response hash: a replay of the request form cannot be
    // used as a callback.
    for (const layout of PAYU_FIELD_LAYOUTS) {
      expect(payuRequestHash(CREDENTIALS, INPUT, layout)).not.toBe(
        payuResponseHash(CREDENTIALS, { ...INPUT, status: STATUS }, layout),
      );
    }
  });

  it("offers one candidate per layout", () => {
    const candidates = payuResponseHashCandidates(CREDENTIALS, {
      ...INPUT,
      status: STATUS,
    });

    expect(candidates).toHaveLength(PAYU_FIELD_LAYOUTS.length);
    expect(candidates).toContain(RESPONSE_HASH_UDF_WITH_BLANKS);
    expect(candidates).toContain(RESPONSE_HASH_COMPACT);
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
    expect(isPayuOrigin("https://payu.in")).toBe(true);
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
  const expectation = {
    txnId: INPUT.txnId,
    amount: INPUT.amount,
    credentials: CREDENTIALS,
    source: "webhook" as const,
  };

  /** A callback signed with the given layout. */
  function signedWith(
    layout: PayuFieldLayout,
    overrides: Partial<PayuCallbackPayload> = {},
  ): PayuCallbackPayload {
    const payload: PayuCallbackPayload = {
      txnid: INPUT.txnId,
      amount: INPUT.amount,
      productinfo: INPUT.productInfo,
      firstname: INPUT.firstName,
      email: INPUT.email,
      status: STATUS,
      hash: "",
      ...overrides,
    };

    return {
      ...payload,
      hash: payuResponseHash(
        CREDENTIALS,
        {
          txnId: payload.txnid,
          amount: payload.amount,
          productInfo: payload.productinfo,
          firstName: payload.firstname,
          email: payload.email,
          status: payload.status,
        },
        layout,
      ),
    };
  }

  /**
   * A genuine callback with fields changed **after** it was signed.
   *
   * This is what an attacker can produce: they cannot re-sign, so the
   * signature no longer matches.
   */
  function tampered(
    overrides: Partial<PayuCallbackPayload>,
    layout: PayuFieldLayout = "udf-with-blanks",
  ): PayuCallbackPayload {
    return { ...signedWith(layout), ...overrides };
  }

  it("accepts a genuine callback", () => {
    const result = verifyPayuCallback(
      signedWith("udf-with-blanks"),
      expectation,
    );

    expect(result.ok).toBe(true);

    if (result.ok) {
      expect(result.amount).toBe("1000.00");
      expect(result.email).toBe(INPUT.email);
      expect(result.firstName).toBe(INPUT.firstName);
      expect(result.status).toBe(STATUS);
    }
  });

  it("accepts a callback signed with either layout", () => {
    for (const layout of PAYU_FIELD_LAYOUTS) {
      const result = verifyPayuCallback(signedWith(layout), expectation);

      expect(result.ok).toBe(true);
    }
  });

  it("rejects a transaction id that is not ours", () => {
    const result = verifyPayuCallback(
      signedWith("udf-with-blanks", { txnid: "ORD999999999999" }),
      expectation,
    );

    expect(result.ok).toBe(false);

    if (!result.ok) expect(result.code).toBe("unknown_transaction");
  });

  it("rejects a tampered amount", () => {
    // The amount is signed, so changing it breaks the signature — and
    // the amount check would refuse it as well.
    const result = verifyPayuCallback(
      tampered({ amount: "1.00" }),
      expectation,
    );

    expect(result.ok).toBe(false);

    if (!result.ok) expect(result.code).toBe("bad_signature");
  });

  it("rejects a tampered email", () => {
    const result = verifyPayuCallback(
      tampered({ email: "attacker@example.com" }),
      expectation,
    );

    expect(result.ok).toBe(false);
  });

  it("rejects a tampered name", () => {
    const result = verifyPayuCallback(
      tampered({ firstname: "Somebody Else" }),
      expectation,
    );

    expect(result.ok).toBe(false);
  });

  it("rejects a wrong merchant key", () => {
    const result = verifyPayuCallback(signedWith("udf-with-blanks"), {
      ...expectation,
      credentials: { key: "wrong-key", salt: CREDENTIALS.salt },
    });

    expect(result.ok).toBe(false);
  });

  it("rejects a wrong merchant salt", () => {
    const result = verifyPayuCallback(signedWith("udf-with-blanks"), {
      ...expectation,
      credentials: { key: CREDENTIALS.key, salt: "wrong-salt" },
    });

    expect(result.ok).toBe(false);
  });

  it("rejects a callback signed for another merchant", () => {
    const result = verifyPayuCallback(
      signedWith("udf-with-blanks", { key: "somebody-else" }),
      expectation,
    );

    expect(result.ok).toBe(false);

    if (!result.ok) expect(result.code).toBe("wrong_merchant");
  });

  it("accepts a callback that names our merchant", () => {
    const result = verifyPayuCallback(
      signedWith("udf-with-blanks", { key: CREDENTIALS.key }),
      expectation,
    );

    expect(result.ok).toBe(true);
  });

  it("rejects a hash that is not a hash", () => {
    const result = verifyPayuCallback(
      { ...signedWith("udf-with-blanks"), hash: "not-a-hash" },
      expectation,
    );

    expect(result.ok).toBe(false);

    if (!result.ok) expect(result.code).toBe("no_signature");
  });

  it("rejects a request hash used as a response hash", () => {
    // The request hash and the response hash differ in where the key and
    // the salt sit, and the response one covers the status. Using the
    // wrong one is the classic mistake.
    for (const layout of PAYU_FIELD_LAYOUTS) {
      const result = verifyPayuCallback(
        {
          ...signedWith(layout),
          hash: payuRequestHash(CREDENTIALS, INPUT, layout),
        },
        expectation,
      );

      expect(result.ok).toBe(false);
    }
  });

  it("rejects Quotient's swapped form, because it does not sign the status", () => {
    // The form Quotient assumed — the request's fields with the salt and
    // the key swapped — is refused on purpose. It does not cover the
    // status, so a buyer could take the signed callback of a *failed*
    // payment, change the status to "success" and replay it. The
    // signature would still verify.
    const result = verifyPayuCallback(
      {
        ...signedWith("udf-with-blanks"),
        hash: LEGACY_SWAPPED_HASH,
      },
      expectation,
    );

    expect(result.ok).toBe(false);

    if (!result.ok) expect(result.code).toBe("bad_signature");
  });

  it("rejects a failed payment replayed as a successful one", () => {
    // The signature covers the status, so the replay does not verify.
    const failure = signedWith("udf-with-blanks", { status: "failure" });

    const result = verifyPayuCallback(
      { ...failure, status: STATUS },
      expectation,
    );

    expect(result.ok).toBe(false);
  });

  it("rejects an amount that is not the plan's price", () => {
    // A genuinely signed callback for the wrong price: the signature is
    // good, the amount is not.
    const result = verifyPayuCallback(
      signedWith("udf-with-blanks", { amount: "2000.00" }),
      expectation,
    );

    expect(result.ok).toBe(false);

    if (!result.ok) expect(result.code).toBe("wrong_amount");
  });

  it("rejects a forged callback whose amount was changed", () => {
    // The attack: take a genuine callback, change the amount, and post
    // it back. The signature was made over the original amount, so it
    // does not verify — and the amount check would refuse it anyway.
    const genuine = signedWith("udf-with-blanks");

    const result = verifyPayuCallback(
      { ...genuine, amount: "1.00" },
      expectation,
    );

    expect(result.ok).toBe(false);
  });
  it("accepts an amount the gateway wrote differently", () => {
    // "29" and "29.00" are the same money. The gateway is free to send
    // either, and the signature is computed over whatever it sent.
    const result = verifyPayuCallback(
      signedWith("udf-with-blanks", { amount: "1000" }),
      { ...expectation, amount: "1000.00" },
    );

    expect(result.ok).toBe(true);
  });

  it("rejects a payment that did not succeed", () => {
    const result = verifyPayuCallback(
      signedWith("udf-with-blanks", { status: "failure" }),
      expectation,
    );

    expect(result.ok).toBe(false);

    if (!result.ok) expect(result.code).toBe("not_successful");
  });
});

describe("modules/premium/payu — the origin of a callback", () => {
  const expectation = {
    txnId: INPUT.txnId,
    amount: INPUT.amount,
    credentials: CREDENTIALS,
    source: "browser" as const,
  };

  const payload: PayuCallbackPayload = {
    txnid: INPUT.txnId,
    amount: INPUT.amount,
    productinfo: INPUT.productInfo,
    firstname: INPUT.firstName,
    email: INPUT.email,
    status: STATUS,
    hash: RESPONSE_HASH_UDF_WITH_BLANKS,
  };

  it("accepts a callback from PayU's own origin", () => {
    const result = verifyPayuCallback(payload, {
      ...expectation,
      origin: "https://secure.payu.in",
    });

    expect(result.ok).toBe(true);
  });

  it("rejects a missing origin, cleanly", () => {
    // Not a crash: Quotient's `"payu" in None` raised a TypeError that
    // became a 500.
    const result = verifyPayuCallback(payload, {
      ...expectation,
      origin: undefined,
    });

    expect(result.ok).toBe(false);

    if (!result.ok) expect(result.code).toBe("wrong_origin");
  });

  it("rejects a foreign origin", () => {
    const result = verifyPayuCallback(payload, {
      ...expectation,
      origin: "https://payu.evil.example",
    });

    expect(result.ok).toBe(false);

    if (!result.ok) expect(result.code).toBe("wrong_origin");
  });

  it("does not ask a webhook for an origin", () => {
    // A server-to-server call carries no `Origin` at all.
    const result = verifyPayuCallback(payload, {
      ...expectation,
      source: "webhook",
      origin: undefined,
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

  it("recognises a payment that did not go through", () => {
    // PayU documents three outcomes — `success`, `failure` and
    // `pending` — and says to treat the last two as failed.
    expect(isFailureStatus("failure")).toBe(true);
    expect(isFailureStatus("pending")).toBe(true);
    expect(isFailureStatus("FAILURE")).toBe(true);
    expect(isFailureStatus(" failure ")).toBe(true);
  });

  it("does not call a success or a silence a failure", () => {
    expect(isFailureStatus("success")).toBe(false);
    expect(isFailureStatus("SUCCESS")).toBe(false);
    expect(isFailureStatus("")).toBe(false);
    expect(isFailureStatus(undefined)).toBe(false);
  });
});

describe("modules/premium/payu — the failure callback", () => {
  const expectation = {
    txnId: INPUT.txnId,
    amount: INPUT.amount,
    credentials: CREDENTIALS,
  };

  /**
   * A failure callback the gateway would send: the same fields as a
   * successful one, with the status inside the signature.
   */
  function makeFailurePayload(
    overrides: Partial<PayuCallbackPayload> = {},
  ): PayuCallbackPayload {
    const status = overrides.status ?? "failure";

    return {
      txnid: INPUT.txnId,
      amount: INPUT.amount,
      productinfo: INPUT.productInfo,
      firstname: INPUT.firstName,
      email: INPUT.email,
      status,
      hash: payuResponseHash(CREDENTIALS, {
        txnId: INPUT.txnId,
        amount: INPUT.amount,
        productInfo: INPUT.productInfo,
        firstName: INPUT.firstName,
        email: INPUT.email,
        status,
      }),
      ...overrides,
    };
  }

  it("accepts a signed failure callback", () => {
    const result = verifyPayuFailureCallback(makeFailurePayload(), expectation);

    expect(result.ok).toBe(true);

    if (result.ok) {
      expect(result.status).toBe("failure");
      expect(result.signed).toBe(true);
    }
  });

  it("refuses a callback for another transaction", () => {
    const result = verifyPayuFailureCallback(
      makeFailurePayload({ txnid: "somebody-elses" }),
      expectation,
    );

    expect(result.ok).toBe(false);

    if (!result.ok) expect(result.code).toBe("unknown_transaction");
  });

  it("refuses a callback signed for another merchant", () => {
    const result = verifyPayuFailureCallback(
      makeFailurePayload({ key: "somebody-elses" }),
      expectation,
    );

    expect(result.ok).toBe(false);

    if (!result.ok) expect(result.code).toBe("wrong_merchant");
  });

  it("refuses a callback that reports a success", () => {
    const result = verifyPayuFailureCallback(
      makeFailurePayload({ status: "success" }),
      expectation,
    );

    expect(result.ok).toBe(false);

    if (!result.ok) expect(result.code).toBe("not_a_failure");
  });

  it("refuses a callback with no status at all", () => {
    const result = verifyPayuFailureCallback(
      makeFailurePayload({ status: "" }),
      expectation,
    );

    expect(result.ok).toBe(false);

    if (!result.ok) expect(result.code).toBe("not_a_failure");
  });

  it("refuses a callback with the wrong amount", () => {
    const result = verifyPayuFailureCallback(
      makeFailurePayload({ amount: "1.00" }),
      expectation,
    );

    expect(result.ok).toBe(false);

    if (!result.ok) expect(result.code).toBe("wrong_amount");
  });

  it("refuses a callback whose signature does not verify", () => {
    const result = verifyPayuFailureCallback(
      makeFailurePayload({ hash: "0".repeat(128) }),
      expectation,
    );

    expect(result.ok).toBe(false);

    if (!result.ok) expect(result.code).toBe("bad_signature");
  });

  it("refuses a callback from a foreign origin", () => {
    const result = verifyPayuFailureCallback(makeFailurePayload(), {
      ...expectation,
      origin: "https://payu.evil.example",
    });

    expect(result.ok).toBe(false);

    if (!result.ok) expect(result.code).toBe("wrong_origin");
  });

  it("takes an unsigned callback only from the gateway's own page", () => {
    // A browser posting from another site carries that site's origin,
    // not the gateway's — so an unsigned callback is only believable
    // when it came from the gateway.
    const payload = makeFailurePayload({ hash: "" });

    const foreign = verifyPayuFailureCallback(payload, {
      ...expectation,
      origin: "https://payu.evil.example",
    });

    expect(foreign.ok).toBe(false);

    if (!foreign.ok) expect(foreign.code).toBe("wrong_origin");

    const accepted = verifyPayuFailureCallback(payload, {
      ...expectation,
      origin: "https://secure.payu.in",
    });

    expect(accepted.ok).toBe(true);

    if (accepted.ok) expect(accepted.signed).toBe(false);
  });

  it("refuses an unsigned callback that came from nowhere", () => {
    const result = verifyPayuFailureCallback(makeFailurePayload({ hash: "" }), {
      ...expectation,
      origin: undefined,
    });

    expect(result.ok).toBe(false);

    if (!result.ok) expect(result.code).toBe("no_signature");
  });
});
