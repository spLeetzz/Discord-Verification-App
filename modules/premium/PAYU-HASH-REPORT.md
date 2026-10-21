# PayU hash layout and callback verification — follow-up report

**Area:** premium (the payment server and the PayU signature).
**Files:** `modules/premium/payu.ts`, `modules/premium/env.ts`,
`modules/premium/server/index.ts`, and their tests.
**Status:** the work is done. One release blocker is left, and it is
tracked in §6.

---

## 1. The headline

The risk I was sent to close is real — and it turned out to be the
smaller half of it.

**The request layout: Quotient was right.** PayU's own SDK builds the
seventeen-field form, with eleven pipes after the email. The
twelve-field "compact" form is not what PayU produces; it is what
several third-party guides publish.

**The response layout: Quotient — and my previous implementation — were
wrong.** PayU does not sign the response by swapping the salt and the
key. It signs the request's fields **in reverse order, with the status
added**:

```
salt|status||||||udf5|udf4|udf3|udf2|udf1|email|firstname|productinfo|amount|txnid|key
```

Under the old code every genuine callback would have been refused. That
is fail-closed, so it was not a hole — but the checkout would never have
granted anybody anything, and the symptom ("the signature does not
verify") reads like a gateway problem rather than a format mismatch.

**Where the evidence comes from.** PayU publishes an SDK
(`payu-india/payu-sdk-node`) that ships known-answer vectors in its own
test suite. This port reproduces both of them exactly, and they are
pinned in `payu.test.ts`:

- the request vector, `19d08229…`, matches the seventeen-field form;
- the response vector, `687c8215…`, matches the reversed form with the
  status in it.

Those are PayU's constants, not mine. The documentation agrees
(`docs.payu.in/docs/hashing-request-and-response` and
`/docs/working-with-response-after-a-customer-checkout`, four languages
of sample code each).

---

## 2. The final layout definitions

One list, one type, in `modules/premium/payu.ts`:

```ts
export const PAYU_FIELD_LAYOUTS = ["udf-with-blanks", "compact"] as const;
export type PayuFieldLayout = (typeof PAYU_FIELD_LAYOUTS)[number];

export const DEFAULT_PAYU_FIELD_LAYOUT: PayuFieldLayout = "udf-with-blanks";
```

| Layout | Fields | The request string | What it is |
|---|---|---|---|
| `"udf-with-blanks"` | 17 | `key\|txnid\|amount\|productinfo\|firstname\|email\|udf1…udf5\|\|\|\|\|\|salt` | PayU's own form, per its SDK and its docs. **The one we send.** |
| `"compact"` | 12 | `key\|txnid\|amount\|productinfo\|firstname\|email\|udf1…udf5\|salt` | The form several third-party guides publish. Not what PayU's SDK produces; kept as a named, pinned, harmless variant. |

The difference between them is **five empty slots**, and it lives in one
table instead of five bare `""` entries in an array:

```ts
const LAYOUT_BLANK_SLOTS: Record<PayuFieldLayout, number> = {
  "udf-with-blanks": 5,
  compact: 0,
};
```

`payuFieldLayoutShape(layout)` prints the layout in one line, so the
format is visible in a log line as well as in the code.

**The two directions are separate functions, and neither is
interchangeable with the other:**

```ts
payuRequestHash(credentials, input, layout?)   // key … salt
payuResponseHash(credentials, input, layout?)   // salt|status|…|key
payuResponseHashCandidates(credentials, input)  // one per layout
```

The response input carries the status; the request input does not, and
the request hash never signs it.

---

## 3. The verification order, and why it is that order

`verifyPayuCallback` runs six checks, in this order:

| # | Check | Why it is here |
|---|---|---|
| 1 | **The transaction id is ours** | The cheapest and most selective check. A callback for somebody else's transaction is refused before anything is hashed. The server has already looked the id up in the database (404 if it is not there). |
| 2 | **The merchant key is ours**, when the callback carries one | The signature covers the key anyway; this catches a stranger's callback before any work. |
| 3 | **The status is `success`** | A refusal only — it can never grant anything, so its position is about the message, not the safety. The status is *inside* the signature, so it cannot have been changed after the fact. |
| 4 | **The origin is PayU's** (browser redirects only) | Free to check, and it stops a cross-origin request before the hash is computed. The hostname is compared against a suffix list, so `https://payu.evil.example` does not pass. A missing header is a clean refusal, not an exception. The server-to-server webhook has no `Origin` at all and is not asked for one. |
| 5 | **The signature verifies**, in constant time | The cryptographic check. It is after the cheap ones so a junk request never reaches the hash. Every candidate is evaluated, even after one matches, so `some` cannot leak which layout the gateway used. |
| 6 | **The amount is the plan's price** | Last, and deliberately: it is the check that catches a gateway echoing a stale amount, and it only makes sense once the signature has proved the other fields are the gateway's. It is exact (`BigInt` on the scaled value), so `"29"` and `"29.00"` are equal and `"29.0"` and `"29.00"` are not. |

**Nothing is written before all six have passed.** The grant
(`activatePremium`) is the only thing that changes state, and it runs
afterwards.

A callback that fails any one of them cannot grant entitlement. The
specific case the brief asked about — *the hash matched but the amount
was tampered with* — is impossible unless the hash was computed over the
tampered amount, and check 6 refuses it anyway.

---

## 4. The security argument for accepting two layouts

This is the comment as it stands in `payu.ts`:

> **Why more than one is safe.** Both layouts are computed over the same
> signed fields with the same secret, so an attacker who cannot produce
> one cannot produce the other: the set of forgeable messages is
> identical, and accepting a second encoding of the same signature
> broadens compatibility without broadening what an attacker can do.

**One thing that argument does *not* cover, and I want it on the record.**
It holds for two layouts of the *same* field list, because they sign
the same fields. It does **not** hold for Quotient's swapped form,
which does not sign the status at all. Under that form a buyer could
take the signed callback of a *failed* payment, change `status` to
`success` and replay it — the signature would still verify, and the
subscription would be granted for nothing. The swapped form is therefore
**refused on purpose**, and there is a test that says so
(`rejects Quotient's swapped form, because it does not sign the status`).

If the live gateway ever turns out to use the swapped form, adding it
back is a one-line change — but it has to come with an answer for the
status-replay hole, not on its own.

---

## 5. The pinned hash vectors

All of them are in `modules/premium/payu.test.ts` as literals, computed
outside this code with Python's `hashlib`. The input is fixed:

```
key=gtMP0Xrl6  salt=1wPayLO7nm
txnid=ORD201608170001  amount=1000.00
productinfo=sample product  firstname=Gaurav  email=gauravkumar@example.com
status=success
```

| Vector | Value |
|---|---|
| request, `"udf-with-blanks"` | `163ccb6428a4f672c43d0c27e34b7761cc6fa7341dc98b2a9a22c1433bb9210cab56339e4c2ca44c108338dfd8e288b1653104354664292ccef12e224347e7f9` |
| request, `"compact"` | `8b7572d3452ffbd48239befd8d5cf5cf8ccd7c2d3a4b6a288a3ddb428281f32a4861201d96eaf40b0f9de1281b542279e2f67d10393575b213aeaf66b402aeb3` |
| response, `"udf-with-blanks"` | `b24834c0a5d187e1c2975004a0e9e7548db0bb47b71be113406c3d1602bfcff73ec1b22beed63429659e0ef781f7407d13a6358e0e4c76d828b709dc43b014e0` |
| response, `"compact"` | `e83803397ef14c87e83fa0f5e3c31f90a6d477adf8041a203a5f939f2b79cf392c40bbdccbb9cccf52a4ba127c9cd32e0394def5e381cb2e6069663a616377d5` |
| Quotient's swapped form (refused) | `ac8aee8968fc0672aa79fc7a6418216983dfd2aa47d2764e8bca90cb2aff23a362aa7f7da7aa3077072d3d65ed59aea3c23b8b6294855160a7ab143840c478fc` |

**PayU's own SDK vectors** (`payu-india/payu-sdk-node`,
`tests/payu/hasher.test.js`), reproduced exactly:

```
key=bjg$121  salt=vhgvs75
txnid=3123  amount=1000  productinfo=mobile
firstname=Jacob  email=test@payu.in  status=success
```

| Vector | Value |
|---|---|
| request | `19d0822939b32b371847521c89aba3521de3a9bfeabeee5dab2d6f41962ff9fcdcee87067bb3a3de870acce488f9ff88a3511bb78c6143344a277b1b91ad38b8` |
| response | `687c82156a84271a7a6c63d0e8774d5ac567d9b894a334a47d72e47b72392a5167a1b2add5b253490b70731d9eb3e3a3b7225e0c5f26829befafbbee71977c4c` |

The other pinned properties: the request and the response differ for
**every** layout; a request hash is never accepted as a response hash;
the status changes the response hash; the swapped form is refused.

---

## 6. The release blocker — what still has to be confirmed

**The checkout must not be enabled until these are answered against the
live merchant account.** The code follows PayU's published SDK and
documentation, but the account's own configuration is the authority, and
three of these can only be answered by making one real test payment.

1. **The response hash form, on the live gateway.** Everything above says
   the reversed form with the status in it. Confirm it with one test
   payment: capture the raw callback, take its `hash`, and compare it
   against the two candidates. If it matches neither, the layout table in
   `modules/premium/payu.ts` needs one more entry — **and** the answer
   has to say whether the status is inside the signature, because that
   decides whether a failure can be replayed as a success.

2. **The `Origin` header on the browser redirect.** The redirect is now
   refused unless it carries a PayU origin, and a missing header is a
   refusal rather than a pass. If PayU's checkout page does not send an
   `Origin` (or sends one from a host that is not `*.payu.in` /
   `*.payu.com`), the buyer sees a 403 on the success page. **The
   webhook still grants the purchase**, so this degrades the experience
   rather than the revenue — but only if the webhook is configured (see
   5). Watch for the origin in the logs of the first test payment.

3. **The amount PayU echoes.** The response's `amount` is compared to the
   plan price. If the merchant account has a convenience fee or a
   discount enabled, PayU may echo an `amount` that is not the price we
   sent, and every payment would be refused with "the amount paid does
   not match the price of the plan". The check is exact on purpose, so
   this has to be looked at rather than loosened.

4. **The gateway's form endpoint and its API version.** The request hash
   is the plain form, with no `si_details` and no `udf_params`. Those
   appear in the hash string for some `api_version` settings. Confirm
   the account is on the default `_payment` form.

5. **The webhook URL in the PayU dashboard.** It has to be
   `https://<PREMIUM_PUBLIC_URL>/payu/webhook`. Without it the only
   path to a grant is the browser redirect, which is the path with the
   origin question in it. PayU's docs say the webhook payload carries
   the same `hash`; the first live webhook should be checked against
   that.

6. **The salt.** PayU recommends "Merchant Salt (Version 2)". The
   algorithm is the same, but the value comes from the dashboard, and
   `PAYU_SALT` has to be that value.

**One line, if the answer to 1 is "not the reversed form":** add the
layout to `PAYU_FIELD_LAYOUTS` and to `LAYOUT_BLANK_SLOTS` — but read
§4 first, because a layout that does not sign the status re-opens the
replay hole.

---

## 7. The two small things

**`@fastify/formbody`.** The local parser is gone:
`modules/premium/server/formbody.ts` was deleted, and the plugin is
registered on the root instance with `await app.register(formbody)`. The
plugin is a `fastify-plugin`, so the parser it adds is visible to the
routes — a parser added inside an ordinary plugin would be encapsulated
and the routes would never see it. There was no reason to keep the local
one.

**The environment variables.** `modules/premium/env.ts` is new. It reads
`PAYU_KEY`, `PAYU_SALT`, `PREMIUM_PUBLIC_URL`, `PREMIUM_PORT`,
`PREMIUM_SERVER_HOST` and `PAYU_ACTION` through the repo's
`utils/env.ts` conventions (the module is imported for its side effect,
so `.env` is loaded from the project root however the bot was started).

**Nothing throws.** A guild that never sells premium does not have a
merchant key, and the bot still has to start, so every unset variable
comes back as `null` and `premiumEnvWarnings()` says what is missing.
Two behaviour changes worth knowing about:

- `startPremiumServer` **no longer throws** when `PREMIUM_PUBLIC_URL` is
  missing. It logs a warning, leaves the checkout switched off, and the
  Discord side says "the premium checkout is not set up on this bot yet"
  rather than sending the buyer to a link that goes nowhere.
- The port is read from `PREMIUM_PORT` (the name in `.env`), not
  `PREMIUM_SERVER_PORT` (the name in my earlier report). A port that is
  not a whole number is reported as invalid rather than silently
  truncated.

---

## 8. The state of the repository

| | |
|---|---|
| `npm run typecheck` | **My files are clean** — zero errors in `modules/premium/` or `commands/premium/`. The repository as a whole does **not** typecheck: 34 errors in `modules/identity/`, `modules/ssverify/ocr/`, `modules/scrims/` and `modules/community/`. Other areas, in flight, not touched. |
| `npm test` | **My 8 test files, 133 tests, all pass.** The whole repository's suite is green as well — 38 files, 548 tests. |

(The repository-wide numbers are a snapshot: the other areas are moving
while this work was in progress.)

| File | Tests | What it proves |
|---|---|---|
| `payu.test.ts` | 48 | the pinned vectors for every layout, PayU's own SDK vectors, request ≠ response for every layout, the status inside the signature, and that a wrong hash, a tampered amount, a tampered email, a tampered name, a wrong key, a wrong salt, a foreign merchant, a foreign origin, a missing origin, a non-`success` status, the swapped form and a request-hash-used-as-a-response-hash are all refused |
| `env.test.ts` | 12 | the environment reader: nothing throws, everything unset is `null`, the numbers are parsed strictly, the warnings say what is missing |
| `server/server.test.ts` | 19 | the routes: the health check, the payment page and its request hash, a genuine callback, a missing `Origin`, a hostile `Origin`, the other field layout, a non-`success` status, a transaction that disagrees with the link, the tampered forms, the wrong key, the webhook, the repeated webhook, the failure and the retry, the already-paid page |
| the other four | 48 | unchanged: the gate, the state machine, the free-tier table, the Discord views |

**Files I touched:** `modules/premium/payu.ts`,
`modules/premium/payu.test.ts`, `modules/premium/env.ts` (new),
`modules/premium/env.test.ts` (new), `modules/premium/server/index.ts`,
`modules/premium/server/server.test.ts`,
`modules/premium/server/formbody.ts` (deleted),
`modules/premium/index.ts`, `modules/premium/README.md`,
`modules/premium/PORT-REPORT.md`. Nothing outside `modules/premium/`.
