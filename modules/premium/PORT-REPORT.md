# Premium — port report

**Area:** premium (entitlements, gates, purchase path, payment server).
**Owns:** `modules/premium/`, `commands/premium/`. Nothing else was touched.

---

## 1. The public API another engineer can rely on

Everything is exported from `modules/premium/index.ts`.

### The gate

```ts
assertEntitled(guildId: string, feature: PremiumFeature): Promise<void>
```

- **Throws** a `PremiumRequiredError` — which extends `TypedDenialError` →
  `DenialError` from `utils/errors.ts`. `instanceof DenialError` still
  works, so the dispatcher shows the message instead of reporting a
  crash. No parallel hierarchy was created.
- The message names the feature (both the human label and the entitlement
  key) and the upgrade path (`/premium`).
- **Call it before the state it guards changes.** The check is a single
  indexed row read; the mutation is not free, and a mutation that
  happens first cannot be undone by a refusal.
- Nothing else may read `guild_entitlements` directly. This module owns
  the table.

```ts
isEntitled(guildId, feature): Promise<boolean>
getEntitlementRecord(guildId, feature): Promise<EntitlementRecord | null>
listEntitlementRecords(guildId): Promise<EntitlementRecord[]>
isEntitlementActive(row, now?): boolean      // the expiry rule, in one place
entitlementLookup                              // the adapter core/guards.ts wants
```

`entitlementLookup` exists because `core/guards.ts` was written before
this module landed and wants a boolean-shaped interface
(`premiumGuard(feature, lookup)`). It reads through the same code path as
`assertEntitled`, so there is still exactly one implementation of the
expiry rule.

```ts
Guards.premium(PremiumFeature.scrimSlots, entitlementLookup)
```

### The gate presentation

```ts
buildPremiumGateEmbed(reason: string): EmbedBuilder
buildPremiumGate(reason: string): PremiumGate      // embed + the button
buildPremiumBuyButton(label?): ButtonBuilder
buildPremiumBuyRow(label?): ActionRowBuilder<ButtonBuilder>
gateReason(feature: PremiumFeature): string
```

One presentation, one button, one custom id: `premium:buy`.
`buildPremiumGate` returns the embed **and** the button together, so a
gate cannot show a refusal without a way forward. Quotient's silently
disabled button is banned.

### The free-tier allowances (D45)

```ts
FREE_TIER.scrims            // 3
freeTierLimit("tourneys")   // 1
freeTierLimit("snipes")     // null — unlimited
buildPerkLines()            // the perk list, generated from FREE_TIER
```

One config object, in `modules/premium/limits.ts`. The gates read it and
the perk list is generated from it, so the table and the code cannot
disagree. **Never hard-code `3` or `1`.**

### The purchase path

```ts
verifyPayuCallback(payload, expectation): PayuVerification
payuRequestHash(credentials, input, layout?): string
payuResponseHash(credentials, input, layout?): string
payuResponseHashCandidates(credentials, input): readonly string[]
payuFieldLayoutShape(layout): string
amountsEqual(a, b): boolean
formatAmount(rupees): string
isPayuOrigin(origin): boolean
isSuccessfulStatus(status): boolean

activatePremium(purchase: VerifiedPurchase): Promise<ActivationResult>
failPremium({ txnId, raw }): Promise<PremiumTransactionStatus | "unknown_transaction">
retryPremium(txnId): Promise<PremiumTransactionStatus | null>
canTransition(current, transition): boolean
nextStatus(current, transition): PremiumTransactionStatus | null
```

### The payment server (D42)

```ts
startPremiumServer(options?): Promise<PremiumServerHandle>
stopPremiumServer(): Promise<void>
readPayuCredentials(env?): PayuCredentials | null
```

### The Discord side

```ts
registerPremiumInteractions({ publicUrl? }): PremiumInteractionHandlers
createDiscordNotifier(client): PremiumNotifier
stopPremiumInteractions(): void
```

The handlers come in two shapes, because there are two callers:

```ts
// by hand — each answers `true` when the interaction was ours
await premium.handleButton(interaction);
await premium.handleSelectMenu(interaction);
await premium.handleModal(interaction);

// into a component router — one line per kind
registerButton("premium:buy", premium.buttonHandler);
registerSelect("premium:plan", premium.selectHandler);
registerModal("premium:email", premium.modalHandler);
```

### The commands

| Command | Adapter | Definition |
|---|---|---|
| `/premium` | `commands/premium/premium.ts` | `modules/premium/commands/index.ts` |
| `/premium-status` | `commands/premium/premium-status.ts` | `modules/premium/commands/index.ts` |

`deploy.ts` scans `commands/<folder>/*.ts` one level deep, so both
commands are picked up with no change to it.

---

## 2. The entitlement lifecycle

```
                 purchase paid
   (no row) ──────────────────────────▶ enabled, expires_at = now + duration
        │                                        │
        │                                   time passes
        │                                        │
        │                                        ▼
        └──────────────────────────────▶ enabled, expires_at in the past
                                                 │
                                        (inactive — nothing is deleted)
```

1. **One row per (guild, feature).** The composite primary key *is* the
   invariant.
2. **Expiry is evaluated at read time.** The rule is
   `enabled AND (expires_at IS NULL OR expires_at > now())`, implemented
   once, in `isEntitlementActive`. Nothing depends on a sweep having run.
   Quotient only cleared its flag when a timer fired, so a missed sweep
   left a lapsed subscriber with premium forever.
3. **An expired entitlement is inactive, not deleted.** The row stays and
   the guild's configuration is untouched. Buying again reactivates it.
   (D15: a lapsed subscription stops *selling*; it does not destroy what
   the customer set up.)
4. **The check happens before the state mutation, always.**

**Features** (the closed union, read from the schema's `CHECK`):
`scrim_slots`, `slot_reminders`, `idp_transfer`, `extra_channels`,
`screenshot_types`, `success_message`.

**Sources:** `premium` (bought), `owner` (handed out), `manual`.

### What a purchase grants

All six features, with one expiry:

- the base is the guild's current subscription expiry, or now if it has
  lapsed — buying again before the period ends does not lose the days
  already paid for;
- the expiry is `base + plan.duration_days`;
- the six entitlement rows, `guild_settings.premium_expires_at` and
  `user_settings.premium_expire_time` are all written.

`user_settings.is_premium` is a **display record, not a gate**. Nothing
decides entitlement from it.

---

## 3. The purchase flow and its verification steps

```
/premium ──▶ premium:buy ──▶ premium:plan:<token> ──▶ premium:email:<token>
               (button)         (select menu)           (modal)
                                                     │
                                                     ▼
                                       a `pending` transaction, plan snapshotted
                                                     │
   GET /getpremium?txnId= ──▶ the self-submitting payment form
                                                     │
                              the gateway redirects back
                 ┌───────────────────────┴───────────────────────┐
                 ▼                                               ▼
   POST /premium_success?txnId=                   POST /premium_failed?txnId=
                 │                                               │
                 ▼                                               ▼
         verify, then activate                          mark it failed
                 │                                  (and it is retryable)
                 ▼
   POST /payu/webhook ──▶ verify, then activate (idempotent)
```

### The verification steps, in order

The callback is verified in `modules/premium/payu.ts`, in this order.
Nothing is written before every one of them has passed.

1. **The transaction id is ours.** The callback has to name the
   transaction the link named, and that transaction has to exist in the
   database. A callback for somebody else's transaction is refused before
   anything else happens.
2. **The merchant key is ours,** when the callback carries one. (The
   signature covers it anyway; this catches a stranger's callback early.)
3. **The status is `success`.** The gateway says the payment went
   through. The status is *inside* the signature, so it cannot have been
   changed after the fact.
4. **The origin is PayU's** — for the browser redirect. The hostname is
   checked against a suffix list (`.payu.in`, `.payu.com`) and a missing
   header is a clean refusal, not an exception. The server-to-server
   webhook has no `Origin` at all and is not asked for one.
5. **The signature verifies, in constant time.**
   `sha512(salt|status||||||udf5|udf4|udf3|udf2|udf1|email|firstname|productinfo|amount|txnid|key)`
   — the request's fields **in reverse order**, with the status added
   and the salt and the key at the two ends. The comparison is
   `timingSafeEqual` over the two SHA-512 digests, so it cannot throw on
   a malformed input and does not leak how much of the hash matched. A
   tampered amount, a tampered email, a tampered name, a wrong key, a
   wrong salt, a request hash used as a response hash and Quotient's
   swapped form are all refused.
6. **The amount is the plan's price, compared as a decimal.** `"29"` and
   `"29.00"` are the same money and the gateway is free to send either;
   a string comparison would refuse a real payment over a missing zero.
   The comparison is exact (`BigInt` on the scaled value), not a float.
7. **Then, and only then, the grant.** `activatePremium` is idempotent:
   the second call finds the transaction already `paid` and grants
   nothing.

### The field layout is one named thing

The number of pipes in a PayU hash string is the whole ball game, and it
is now a name rather than a magic `5`:

```ts
PAYU_FIELD_LAYOUTS = ["udf-with-blanks", "compact"] as const;
```

| Layout | Fields | The string |
|---|---|---|
| `"udf-with-blanks"` | 17 | `key\|txnid\|amount\|productinfo\|firstname\|email\|udf1…udf5\|\|\|\|\|\|salt` |
| `"compact"` | 12 | `key\|txnid\|amount\|productinfo\|firstname\|email\|udf1…udf5\|salt` |

`"udf-with-blanks"` is the default and the one we send: it is the form
PayU's own SDK builds, and it is what Quotient used. `"compact"` is the
form several third-party guides publish. A callback is accepted if it
verifies under **any** known layout.

The request hash and the response hash both take a layout, and they are
never interchangeable: the response is the request's fields **reversed**,
with the status added and the salt and the key at the two ends.

### The transaction state machine

```
  pending ──activate──▶ paid      (terminal)
     │
     └────fail──────▶ failed ──retry──▶ pending
                          │
                          └──activate──▶ paid
```

- `failed` is **retryable**. Quotient closed the transaction on failure,
  so a failed payment could never be retried.
- `failed → paid` exists because a buyer who cancels at the gateway and
  then pays the same transaction id has, in fact, paid. The signature is
  verified again first, and a failure callback can never un-buy a
  subscription that already succeeded.
- Every write is a conditional `UPDATE`, so the state machine lives in
  the database and a replayed webhook updates zero rows.

### The order of operations

**The rows are written, then the buyer is told.** Quotient dispatched the
purchase notification before the guild row was written, so the
confirmation DM could show a stale expiry or crash on `None`. The
notification is the caller's job, after `activatePremium` has returned,
and a failed DM never undoes the purchase.

### The buyer's details

The buyer's **real email** and **Discord display name** are used.
Quotient sent `"abcd@gmail.com"` and put the Discord user id in the
`firstname` field. The email is collected in a modal, because PayU signs
it and therefore needs it before the transaction is created.

---

## 4. What I deliberately did not port, and why

| Not ported | Why |
|---|---|
| `money`, `claim_prime`, `vote`, `voteremind`, the Quo Coin economy | 120 coins bought 30 days of **real** premium with free in-app currency. Porting that is shipping a paywall bypass (D40). `user_settings.money` may exist; nothing may spend it to grant entitlement, and nothing in this module touches it. |
| the "Pro bot" perk | Quotient advertised a second bot application that does not exist in the source repository (D40). The perk list now advertises the entitlements premium actually unlocks. |
| the premium expiry sweep | Expiry is evaluated at read time. A sweep would be a second source of truth that can be missed — and Quotient's was. |
| deleting the guild's configuration on expiry | D15: a lapsed subscription stops selling; it does not destroy the customer's setup. |
| the public purchase-log webhook | It posts to an external URL this bot has no configuration for. The buyer is still told, by DM. |
| the premium role grant | There is no premium role in this guild's configuration, and no env var for one. |
| the "expiry is ending soon" reminders | They need the `jobs` table and the scheduler (Area E's). The premium *expiry* itself needs no job, because it is evaluated at read time. |
| `User.made_premium` | Dropped by the schema (S4): write-only garbage that recorded the user's own id. |
| the "Pro bot" second application | Same as above. |

---

## 5. Decisions I made where the spec was silent

1. **A purchase grants all six features with one expiry**, rather than a
   per-plan feature list. The plan catalogue has no feature column, and
   the schema has no plan→feature mapping, so "premium" means "all of
   them" and the tier expiry lives in `guild_settings`.
2. **A renewal extends the current subscription** rather than replacing
   it (`base = max(now, current expiry)`). Quotient stacked the durations
   the same way.
3. **`failed → paid` is a legal transition.** A buyer who cancels at the
   gateway and then pays the same transaction id has paid. The signature
   is verified again first.
4. **A present, non-PayU `Origin` is refused; an absent one is allowed.**
   The webhook has no `Origin` at all, and the signature — not the
   header — is the authority.
5. **The amount is compared numerically**, not as a string, because the
   gateway may write "29" where we wrote "29.00".
6. **The phone number sent to the gateway is Quotient's placeholder
   (`"9999999999"`).** We collect the buyer's email, not their phone, and
   PayU's hosted page shows the number it was given. If the merchant
   account needs a real one, add a field to the checkout modal.
7. **The plan is looked up by its `code`**, not by its id. The code is
   the catalogue's natural key (the seed upserts on it), so a lookup by
   code survives a reseed. This is also why the tests do not say "the
   cheapest plan" — another test file inserts a temporary plan with a
   lower price.
8. **The free-tier config lives in `modules/premium/limits.ts`**, as the
   brief asked. `core/premium.ts` carries a second copy; see below.
9. **The perk list is generated from `FREE_TIER` *and* the feature
   union**, in that order: the entitlements are what premium unlocks, and
   the counts are what stop being limits.
10. **`/premium` is meant to be public and `/premium-status` ephemeral.**
    The dispatcher defers every command ephemerally today, so `/premium`
    is ephemeral until D43 lands. Both set the `ephemeral` flag on the
    command so the dispatcher picks it up as soon as it honours it.

---

## 6. Where the schema or the provider forced a design decision

| Constraint | Consequence |
|---|---|
| `premium_plans.price` is an **integer** | The amount on the wire is a decimal string (`"29.00"`), and the hash is computed over that exact string — the gateway signs the bytes it received. Hence the decimal comparison, and hence "29" and "29.00" must compare equal. |
| `premium_transactions.plan_id` is nullable with `ON DELETE SET NULL` | The receipt **and the payment page** read `plan_snapshot`, not the live plan row. A catalogue change cannot break a payment page that is already open. |
| `guild_entitlements` has **no `id`** | The composite primary key is the identity; there is no second, redundant one. |
| `feature` is `text` with a `CHECK` | The TS union is read from the schema's list (`ENTITLEMENT_FEATURES`) rather than written out twice, and a test proves the schema's list and the runtime union in `core/constants.ts` are the same set. |
| `premium_transactions.status` is `text` with a `CHECK` | The status is an explicit enum and every write is a conditional `UPDATE` whose `WHERE` clause *is* the state machine. `failed` is retryable because the enum has three states rather than two. |
| `duration_days` is an **integer** | The expiry is `base + days * 86_400_000`. No `INTERVAL`, no timezone maths. |
| `guild_settings.premium_expires_at` exists | It is the subscription *tier* summary, and it is the base a renewal extends. The per-feature gates never read it. |
| `user_settings` has `is_premium` / `premium_expire_time` / `premiums` | `/premium-status` can show the caller's own subscription. The column is written but is **not** a gate. |
| PayU signs `udf1…udf5` | The hash string has exactly seventeen fields and eleven pipes after the email, and the response hash is the request's fields **reversed**, with the status added. Both are pinned against PayU's own SDK known-answer vectors, so a change to the field order fails the test. |
| PayU redirects a **browser** | The redirect cannot be trusted until the signature verifies, which is why there is also a server-to-server webhook. Both funnel into one idempotent `activatePremium`. |
| PayU needs the email **before** the payment starts | The email is collected in a modal in the checkout, not scraped from the account. |

---

## 7. What the manager has to do (central changes)

1. **Call the payment server from `main.ts`.** I do not own that file.

   ```ts
   import { createDiscordNotifier, startPremiumServer, stopPremiumServer } from "./modules/premium/index.js";

   // on start
   await startPremiumServer({ notify: createDiscordNotifier(client) });

   // on shutdown
   await stopPremiumServer();
   ```

   `startPremiumServer` seeds the plan catalogue (Quotient never seeded
   its own, so every purchase screen was blank) and sets the public
   checkout URL.

2. **Wire the interactions into the router.** `core/router.ts` appeared
   while I was working, so the handlers come in its shape too:

   ```ts
   const premium = registerPremiumInteractions();

   registerButton("premium:buy", premium.buttonHandler);
   registerSelect("premium:plan", premium.selectHandler);
   registerModal("premium:email", premium.modalHandler);
   ```

   The router must **not** defer a select-menu interaction before handing
   it over — a modal can only be shown on an unacknowledged interaction.
   The premium handlers acknowledge their own button and modal
   interactions and check whether the interaction was already
   acknowledged, so they are safe either way.

3. **Environment variables.** These are in `.env` and `.env.example` now,
   and `modules/premium/env.ts` reads them. **None of them throws** — a
   guild that never sells premium does not have a merchant key, and the
   bot still has to start:

   | Variable | Meaning | Required |
   |---|---|---|
   | `PREMIUM_PUBLIC_URL` | the address the buyer's browser and the gateway can reach | no — the checkout is disabled without it |
   | `PREMIUM_PORT` | the port (default 8899) | no |
   | `PREMIUM_SERVER_HOST` | the host (default `0.0.0.0`) | no |
   | `PAYU_KEY` | the merchant key | no — the payment routes answer 503 without it and the bot still runs |
   | `PAYU_SALT` | the merchant salt | no — same |
   | `PAYU_ACTION` | the gateway's form endpoint (default `https://secure.payu.in/_payment`) | no |

   `startPremiumServer` no longer throws for a missing `PREMIUM_PUBLIC_URL`
   (it used to). It logs a warning, leaves the checkout switched off, and
   the Discord side says "the premium checkout is not set up on this bot
   yet" rather than sending the buyer to a link that goes nowhere.

4. **`@fastify/formbody` is installed**, so the local parser is gone:
   `modules/premium/server/formbody.ts` was deleted and the plugin is
   registered on the root instance with `await app.register(formbody)`.
   The plugin is a `fastify-plugin`, so the parser it adds is visible to
   the routes (a parser added inside an ordinary plugin would be
   encapsulated and the routes would never see it).

5. **Reconcile the two copies of `FREE_TIER`.** `core/premium.ts`
   declares one and `modules/premium/limits.ts` declares the other. The
   canonical one is `modules/premium/limits.ts` (as the brief asked), and
   `modules/premium/limits.test.ts` fails the moment they drift. The
   clean fix is to delete `FREE_TIER` and `freeTierLimit` from
   `core/premium.ts` — nothing in the codebase imports them (only the
   *types* are used, by `core/guards.ts`) — and have the other engineers
   import the limits from `modules/premium/limits.ts`.

6. **`types/command.ts` has no `guards` field yet** (D28 promises one).
   My gates are therefore called from module code, not from a command's
   guard list. When the field lands, a premium command can declare
   `guards: [Guards.premium(feature, entitlementLookup)]`.

7. **D43 is not implemented in the dispatcher.** `handlers/interactions.ts`
   still defers every command ephemerally, so `/premium` is ephemeral
   until the dispatcher honours `Command.ephemeral`. The command sets
   `ephemeral: false` and `/premium-status` sets `ephemeral: true`, so
   it will do the right thing the moment the dispatcher reads the flag.

8. **The PayU account has to be set up for the webhook.** The
   server-to-server call is the trustworthy path; it only arrives if
   `https://<PREMIUM_PUBLIC_URL>/payu/webhook` is configured as the
   webhook URL in the PayU dashboard.

---

## 8. The state of the repository

| | |
|---|---|
| `npm run typecheck` | **My files are clean** — zero errors in `modules/premium/` or `commands/premium/`. The repository as a whole does **not** typecheck right now, because of other areas in flight: `modules/identity/`, `modules/scrims/views/manager.test.ts`, `modules/ssverify/ocr/{http,local}.test.ts`. Not mine, not touched. |
| `npm test` | **My 8 test files, 133 tests, all pass.** The repository's suite is green as well — 37 files, 538 tests. |
| `npm run smoke` | Not re-run for this change; my two command files load and serialise correctly on their own. |
| `deploy.ts` | No change needed — it scans `commands/<folder>/*.ts` one level deep and picks up both premium commands. |

### The tests

| File | Tests | What it proves |
|---|---|---|
| `payu.test.ts` | 48 | the pinned hash vectors for every layout, PayU's **own SDK** known-answer vectors, the request and the response differing for every layout, the status being inside the signature, the constant-time comparison, the decimal amounts ("29" vs "29.00"), the origin check (missing, hostile, genuine), and that a tampered amount, email, name, a wrong key, a wrong salt, Quotient's swapped form, a non-`success` status, a missing origin and a request-hash-used-as-a-response-hash are all refused |
| `env.test.ts` | 12 | the environment reader: nothing throws, everything unset is `null`, the numbers are parsed strictly, and the warnings say what is missing |
| `entitlements.test.ts` | 14 | the gate: allowed, no expiry, expired without a sweep, disabled, unknown feature, the refusal's wording, that an expired entitlement is not deleted, and the expiry rule at the boundary second |
| `purchase.test.ts` | 16 | the state machine, the retry, the idempotent grant, the extension of an existing subscription, the real email and name, and that a late failure does not un-buy a subscription |
| `server/server.test.ts` | 19 | the routes: the health check, the payment page and its request hash, a genuine callback, a missing `Origin`, a hostile `Origin`, the other field layout, the tampered forms, the wrong key, the webhook, the repeated webhook, the failure and the retry, and the already-paid page |
| `gate.test.ts` | 7 | one presentation, one button, and the reason naming the feature and the way out |
| `limits.test.ts` | 11 | the free-tier table, the generated perk list, the "no Pro bot" promise, the feature union against the schema's `CHECK` list and the runtime union, and that the two copies of the table have not drifted |
| `views.test.ts` | 6 | the custom ids are namespaced and carry their token, the select offers one option per plan, the transaction id is unguessable, and the email check |

The database tests run against the local Postgres on `:5433`, like
`db/schema.test.ts`. They create rows with ids no real row can have and
delete them afterwards.
