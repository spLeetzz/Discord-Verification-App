# Premium

The premium system: entitlements, gates, the free-tier allowances, the
purchase path and the payment server.

It replaces Quotient's `Guild.is_premium` boolean and its unverified
payment callback. Both of those were broken in ways that mattered — the
boolean deleted a guild's configuration when the subscription lapsed, and
the callback granted unlimited premium to anyone who could reach the HTTP
port.

---

## The public interface

Everything another engineer needs is exported from
`modules/premium/index.ts`.

### `assertEntitled(guildId, feature): Promise<void>`

**The gate. One helper, one place (D15).**

```ts
import { assertEntitled, PremiumFeature } from "../modules/premium/index.js";

// Before the state changes — always.
await assertEntitled(guildId, PremiumFeature.scrimSlots);
slots.push(...);
```

- It **throws** a `PremiumRequiredError`, which is a `DenialError` from
  `utils/errors.ts` (via `core/errors.ts`). The dispatcher shows the
  message; it is not a crash.
- The message names the feature and the upgrade path (`/premium`).
- **Call it before the state it guards changes.** The check is free and
  the mutation is not; a mutation that happens first cannot be undone by
  a refusal. Quotient's screenshot-type gate assigned the premium type
  *before* checking and a later refresh persisted it — that class of bug
  is impossible with one helper called first.
- Nothing else in the codebase may read `guild_entitlements` directly.
  This module owns the table.

### `buildPremiumGateEmbed(reason)` / `buildPremiumGate(reason)`

**The way a gate refuses (D29).**

```ts
import { buildPremiumGate, gateReason } from "../modules/premium/index.js";

const gate = buildPremiumGate(gateReason(PremiumFeature.idpTransfer));

await interaction.editReply({
  embeds: [gate.embed],
  components: gate.components,
});
```

- `buildPremiumGateEmbed(reason)` returns the embed.
- `buildPremiumGate(reason)` returns the embed **and** the one upgrade
  button, so a gate cannot show a refusal without a way forward.
- The button's custom id is `premium:buy`. There is no second one.
- Quotient had four different refusal presentations and a silently
  disabled button. Both are gone.

### `entitlementLookup`

The adapter `core/guards.ts` expects, for the guards that return a
refusal *string* rather than throwing:

```ts
import { Guards } from "../core/guards.js";
import { entitlementLookup, PremiumFeature } from "../modules/premium/index.js";

const guard = Guards.premium(PremiumFeature.scrimSlots, entitlementLookup);
```

It reads through the same code path as `assertEntitled`, so there is one
implementation of the expiry rule.

### `FREE_TIER` and `freeTierLimit(key)`

The free-tier allowances (D45), in `modules/premium/limits.ts`.

```ts
import { FREE_TIER, freeTierLimit } from "../modules/premium/index.js";

FREE_TIER.scrims;        // 3
freeTierLimit("tourneys"); // 1
freeTierLimit("snipes");   // null — unlimited
```

**Never hard-code `3` or `1`.** A gate for a thing with no entry in
`FREE_TIER` is unlimited.

### `startPremiumServer(options)` / `stopPremiumServer()`

The payment server (D42). It runs **in the bot's own process**.

```ts
import { createDiscordNotifier, startPremiumServer } from "../modules/premium/index.js";

await startPremiumServer({
  publicUrl: "https://premium.example.com",
  notify: createDiscordNotifier(client),
});
```

`main.ts` belongs to the manager; this module never touches it.

### `registerPremiumInteractions(options)`

The button, select and modal handlers (D18, D43).

```ts
import { registerPremiumInteractions } from "../modules/premium/index.js";

const premium = registerPremiumInteractions({ publicUrl });
```

Two shapes come back, because there are two callers:

```ts
// By hand — each one answers `true` when the interaction was ours.
if (await premium.handleButton(interaction)) return;
if (await premium.handleSelectMenu(interaction)) return;
if (await premium.handleModal(interaction)) return;
```

```ts
// Into a component router — one line per kind.
registerButton("premium:buy", premium.buttonHandler);
registerSelect("premium:plan", premium.selectHandler);
registerModal("premium:email", premium.modalHandler);
```

The router-shaped handlers narrow the interaction themselves, so
registering them for the whole `premium` prefix is safe too.

**One thing the router has to know:** a modal can only be shown on an
interaction that has not been acknowledged, so the router must **not**
defer a select-menu interaction before handing it over. The premium
handlers acknowledge their own button and modal interactions, and they
check whether the interaction has already been acknowledged, so they are
safe either way.

### The commands

| Command | File | What it does |
|---|---|---|
| `/premium` | `commands/premium/premium.ts` | the perks and the upgrade button |
| `/premium-status` | `commands/premium/premium-status.ts` | the caller's subscription and the server's entitlements |

The definitions live in `modules/premium/commands/index.ts`; the files
under `commands/premium/` are one-line re-exports.

---

## The entitlement lifecycle

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

**The rules.**

1. **One row per (guild, feature).** The primary key is the pair.
2. **Expiry is evaluated at read time.** The rule is
   `enabled AND (expires_at IS NULL OR expires_at > now())`, implemented
   once, in `isEntitlementActive`. Nothing depends on a sweep having run.
   Quotient only cleared its flag when a timer fired, so a missed sweep
   left a lapsed subscriber with premium forever.
3. **An expired entitlement is inactive, not deleted.** The row stays and
   the guild's configuration is untouched. A lapsed subscription stops
   *selling*; it does not destroy what the customer set up. Buying again
   reactivates it.
4. **The check happens before the state mutation, always.**

**The features** (the closed union, from the schema's `CHECK` constraint):

| Feature | What it unlocks |
|---|---|
| `scrim_slots` | extra scrim slots |
| `slot_reminders` | slot reminders |
| `idp_transfer` | the IDP transfer |
| `extra_channels` | extra tag-check and easy-tag channels |
| `screenshot_types` | every screenshot verification type |
| `success_message` | a custom verification success message |

**The sources** (`guild_entitlements.source`): `premium` (bought),
`owner` (handed out), `manual` (a one-off override).

### How a purchase grants an entitlement

A purchase enables **every** feature for the guild, with one expiry:

- the base is the guild's current subscription expiry, or now if it has
  lapsed — so buying again before the period ends does not lose the days
  that were already paid for;
- the expiry is `base + plan.duration_days`;
- the rows are written for all six features, plus
  `guild_settings.premium_expires_at` and
  `user_settings.premium_expire_time` (the summary the status command
  reads).

`user_settings.is_premium` is a **display record, not a gate**. Nothing
in this codebase decides entitlement from it.

---

## The purchase flow

```
/premium  ──▶  premium:buy  ──▶  premium:plan:<token>  ──▶  premium:email:<token>
                  (button)          (select menu)            (modal)
                                                          │
                                                          ▼
                                          a pending transaction is created
                                                          │
   GET /getpremium?txnId=  ──▶  the self-submitting payment form
                                                          │
                                       the gateway redirects back
                                    ┌─────────────────────┴─────────────────────┐
                                    ▼                                           ▼
                    POST /premium_success?txnId=              POST /premium_failed?txnId=
                                    │                                           │
                                    ▼                                           ▼
                            verify, then activate                    mark it failed
                                    │                                  (retryable)
                                    ▼
                    POST /payu/webhook  ──▶  verify, then activate
```

### The steps

1. **`/premium`** shows the perks and the upgrade button. The perk list
   is generated from `FREE_TIER`, so it cannot advertise a limit the code
   does not enforce.
2. **`premium:buy`** shows the plan select. The select and the modal
   carry a **token**, not a record id (D18): there is no database row for
   a buyer who has not paid yet. The token also records who started the
   flow, so only that person can finish it.
3. **`premium:email:<token>`** asks for the buyer's **real** email. It
   becomes the transaction's email and the gateway's. Quotient sent
   `"abcd@gmail.com"` and put the Discord user id in the `firstname`
   field.
4. The transaction is created `pending`, with the plan **snapshotted**
   into `plan_snapshot` so the payment page still renders after the
   catalogue changes.
5. **`GET /getpremium?txnId=`** renders the payment form. The amount is
   a decimal string — `"29.00"`, not `"29"` — and the hash is computed
   over the very same string, because the gateway signs the bytes it
   received.
6. The gateway posts back to **`/premium_success`** (the browser
   redirect) and, in parallel, to **`/payu/webhook`** (server to
   server). Both verify, and both funnel into the same idempotent
   `activatePremium`.
7. The rows are written, **then** the buyer is told. Quotient dispatched
   the notification before the guild row was written, so the confirmation
   DM could show a stale expiry or crash on `None`.

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
  verified again before either transition, and a failure callback can
  never un-buy a subscription that already succeeded.
- Every write is a conditional `UPDATE`, so the state machine lives in
  the database and a replayed webhook updates zero rows.

---

## The security properties

**1. The PayU response signature is verified, in constant time.**

```
request  hash = sha512(key|txnid|amount|productinfo|firstname|email|udf1|…|udf5||||||salt)
response hash = sha512(salt|status||||||udf5|…|udf1|email|firstname|productinfo|amount|txnid|key)
```

The **response** is the request's fields **in reverse order**, with the
**status** added and the salt and the key at the two ends. Two things
follow, and both matter:

- the salt and the key are at opposite ends, so a request hash is never a
  valid response hash;
- the status is *inside* the signature, so a failed payment cannot be
  replayed as a successful one.

The comparison is `timingSafeEqual` over the two SHA-512 digests, so the
function does not leak how much of the hash matched and cannot throw on a
malformed input.

**2. The field layout is one named thing.**

`PAYU_FIELD_LAYOUTS` is `["udf-with-blanks", "compact"]`. The first is
the layout PayU's own SDK produces (seventeen fields, eleven pipes after
the email); the second is the twelve-field form several third-party
guides publish. A callback is accepted if it verifies under **any** known
layout. That is safe: both are computed over the same signed fields with
the same secret, so an attacker who cannot forge one cannot forge the
other. The pinned vectors live in `payu.test.ts` and include PayU's own
SDK known-answer vectors.

**3. The amount is checked, as a decimal.** `"29"` and `"29.00"` are the
same money and the gateway is free to send either; a string comparison
would refuse a real payment over a missing zero. The comparison is done
with `BigInt` on the scaled value, so it is exact.

**4. The transaction id must be ours.** The callback has to name a
transaction that exists in the database, and that has to be the one the
link said.

**5. The status has to be `success`,** and it has to be the status the
signature covers.

**6. The `Origin` header cannot crash the server, and a browser
callback has to have one.** Quotient's
`if not "payu" in request.headers.get("origin")` raised a `TypeError` on
a missing header, and `"payu" in origin` would also have passed for
`https://payu.evil.example`. Here the hostname is checked against a
suffix list (`.payu.in`, `.payu.com`), and a missing header is a clean
refusal rather than an exception. The server-to-server webhook has no
`Origin` at all and is not asked for one.

**7. The webhook is the trustworthy path; the redirect is untrusted until
it verifies.** Both are verified the same way and both are idempotent.

**8. The buyer's real email and display name are used**, not
`"abcd@gmail.com"` and the user id.

---

## The payment server

Fastify, in the bot's process, on the same connection pool as the bot.

| Route | What it is |
|---|---|
| `GET /` | health |
| `GET /getpremium?txnId=` | the payment page (a template literal, not a template engine) |
| `POST /premium_success?txnId=` | the gateway's success redirect |
| `POST /premium_failed?txnId=` | the gateway's failure redirect |
| `POST /payu/webhook` | the gateway's server-to-server call |

### Configuration

| Variable | Meaning | Required |
|---|---|---|
| `PREMIUM_PUBLIC_URL` | the address the buyer's browser and the gateway can reach | no — the checkout is disabled without it |
| `PREMIUM_PORT` | the port (default 8899) | no |
| `PREMIUM_SERVER_HOST` | the host (default `0.0.0.0`) | no |
| `PAYU_KEY` | the merchant key | no — the payment routes refuse with a 503 |
| `PAYU_SALT` | the merchant salt | no — the same |
| `PAYU_ACTION` | the gateway's form endpoint (default `https://secure.payu.in/_payment`) | no |

**Nothing here throws.** A guild that never sells premium does not have a
merchant key, and the bot still has to start. `readPremiumEnv` returns
`null` for everything that is not set, and `premiumEnvWarnings` says
what is missing; the server logs the warnings and the payment routes
answer `503` until the gateway is configured.

Without `PREMIUM_PUBLIC_URL` the server still starts and still answers
the health check, but the checkout is switched off: the Discord side
says "the premium checkout is not set up on this bot yet" rather than
sending the buyer to a link that goes nowhere.

### The form body parser

PayU posts `application/x-www-form-urlencoded`, and Fastify has no
parser for it out of the box. The parser is the `@fastify/formbody`
plugin, registered on the root instance — the plugin is a
`fastify-plugin`, so the parser it adds is visible to the routes below.
A parser registered inside an ordinary plugin would be encapsulated, and
the routes would never see it.

---

## The free-tier allowances (D45)

One configuration object, in `modules/premium/limits.ts`. The gates read
it and the perk list is generated from it, so the two cannot disagree.

```
scrims: 3   tourneys: 1   tagcheckChannels: 1   easytagChannels: 1
slotManagers: 1   ssverifyConfigs: 1   mediaPartners: 1   autopurgeChannels: 1
```

These are the limits the **code** enforces, not the ones Quotient's
`constants.perks` advertised. A gate for a thing with no entry is
unlimited.

---

## What deliberately does not ship (D40)

| Quotient | Why not |
|---|---|
| `money`, `claim_prime`, `vote`, `voteremind`, the Quo Coin economy | 120 coins bought 30 days of **real** premium with free in-app currency. Porting that is shipping a paywall bypass. `user_settings.money` may exist; nothing may spend it to grant entitlement. |
| the "Pro bot" perk | Quotient advertised a second bot application that does not exist in the source repository. The perk list now advertises the features premium actually unlocks. |
| the premium expiry sweep | Expiry is evaluated at read time. A sweep would be a second source of truth that can be missed. |
| the public premium-log webhook | It posts to an external URL this bot has no configuration for. The buyer is still told, by DM. |
| the premium role | There is no premium role in this guild's configuration. |
| deleting a guild's configuration on expiry | D15: a lapsed subscription stops selling; it does not destroy the customer's setup. |

---

## The error modes

| Situation | What happens |
|---|---|
| the guild does not hold the feature | `assertEntitled` throws a `PremiumRequiredError` (a `DenialError`) |
| the transaction is unknown | the payment routes answer 404 |
| the transaction is already paid | the payment page answers 409; a repeated callback answers "already paid" |
| the signature does not verify | 400, and the transaction stays `pending` |
| the amount is not the plan's price | 400, and the transaction stays `pending` |
| the status is not `success` | 400, and the transaction stays `pending` |
| the `Origin` is missing, or is not PayU's | 403 |
| the callback names a different transaction than the link | 400 |
| the gateway is not configured | 503 |
| the server does not know its own public address | 503 on the payment page; the checkout is off |
| the buyer's DMs are closed | the purchase stands; the error is logged |

---

## The tests

| File | What it proves |
|---|---|
| `payu.test.ts` | the pinned hash vectors for every layout, PayU's own SDK known-answer vectors, the request and the response differing for every layout, the status being inside the signature, and that a tampered amount, a tampered email, a tampered name, a wrong key, a wrong salt, a foreign origin, a missing origin, a non-`success` status and a request-hash-used-as-a-response-hash are all refused |
| `env.test.ts` | the environment reader: nothing throws, everything unset is `null`, and the warnings say what is missing |
| `entitlements.test.ts` | the gate: allowed, no expiry, expired without a sweep, disabled, unknown feature, and that an expired entitlement is not deleted |
| `purchase.test.ts` | the state machine, the retry, the idempotent grant, the extension of an existing subscription, and the real email and name |
| `server/server.test.ts` | the routes: the health check, the payment page and its request hash, a genuine callback, a missing `Origin`, a hostile `Origin`, the other field layout, the tampered forms, the webhook, the repeated webhook, the failure and the retry, and the already-paid page |
| `gate.test.ts` | one presentation, one button, and the reason naming the feature and the way out |
| `limits.test.ts` | the free-tier table, the generated perk list, and that the table and the copy in `core/premium.ts` have not drifted |

The database tests run against the local Postgres on `:5433`, like
`db/schema.test.ts`. They create rows with ids no real row can have and
delete them afterwards.
