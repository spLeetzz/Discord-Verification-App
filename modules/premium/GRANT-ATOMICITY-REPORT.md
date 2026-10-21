# The premium grant is atomic — and the failure route is verified

The security audit confirmed the signature verification, the amount check,
the replay behaviour, the cross-guild scoping and the fact that no secret
is logged or persisted. It found one real money-losing bug:

> **MEDIUM — the premium grant is not atomic.** `markTransactionPaid` ran
> and committed, then the seven entitlement upserts and the two summary
> updates ran as separate statements. A process killed in between left a
> buyer who had paid with nothing, and the replay path could not repair
> it, because the transaction was already `paid`.

This is the report on that fix, and on the failure route the audit asked
about.

---

## 1. How the transaction is structured now

**One transaction, one lock order, one commit.**

```
activatePremium(purchase)
└── withLockedTransaction(txnId, fn)          modules/premium/repo.ts
    ├── BEGIN
    ├── SELECT … FOR UPDATE premium_transactions    ← the lock that makes
    │                                                  two callbacks safe
    ├── INSERT guild_settings  ON CONFLICT DO NOTHING
    ├── INSERT user_settings   ON CONFLICT DO NOTHING
    ├── SELECT … FOR UPDATE guild_settings           ← two purchases for
    │                                                  one guild cannot both
    │                                                  extend one expiry
    ├── UPDATE premium_transactions → paid           (conditional UPDATE)
    ├── 7 × INSERT/UPSERT guild_entitlements
    ├── UPDATE guild_settings
    ├── UPDATE user_settings
    └── COMMIT
```

`withLockedTransaction` now hands the transaction handle to its callback,
so every statement in the grant runs on the same connection. The repo
layer grew one optional parameter — `executor: DbExecutor = db` — on the
statements the grant uses (`upsertEntitlement`, `setGuildPremium`,
`setUserPremium`, `markTransactionPaid`, `ensureGuildSettings`,
`ensureUserSettings`, `getGuildSettings`, `listEntitlements`). The same
function still runs on the pool when it is called without one.

**Why the guild's row is locked too.** The grant reads
`guild_settings.premium_expires_at` and extends it. Two purchases for the
same guild would otherwise both read the same expiry and both extend it,
and one subscription would be lost. The lock is taken *after* the
transaction row and every writer takes the locks in the same order, so two
of them cannot deadlock.

**The notification stays outside the transaction.** `activatePremium`
returns after the commit; the server notifies after that, and a notifier
that throws is logged and swallowed. The purchase stands. That is the
opposite of the old failure mode, where a failed DM could not undo a
purchase but a failed *grant* could leave one half-written.

---

## 2. The `already_paid` branch is no longer a dead end

A callback for a transaction that is already `paid` now **checks** that
the grant is whole, and puts it back together when it is not. The
outcome is a new `"repaired"`, and the buyer is told about it.

**The check.** The grant is incomplete when

- some feature has no entitlement row, **or**
- the guild's summary row has no subscription expiry, **or**
- the guild's subscription ends before the expiry the grant wrote.

**The repair's expiry.** `max(what the purchase bought on its own, what
the interrupted grant wrote, what the guild already holds)`:

- *what the purchase bought on its own* is `paid_at + duration_days`;
- *what the interrupted grant wrote* is read back from the entitlement
  rows — the grant wrote the same expiry to all seven of them, so any
  surviving row is the witness;
- *what the guild already holds* is the guild's current expiry.

The rule never hands out a second set of days: the expiry is never longer
than the guild's own subscription, and it is anchored on `paid_at`, so a
replayed webhook for a subscription that has already run out restores
nothing. The guild's and the user's summaries are only ever moved
**later** (`greatest`), and `made_premium_by` is only filled in when it is
empty — a repair never overwrites the name of whoever bought the
subscription that is actually running.

**The counter is recounted, not incremented.** `user_settings.premiums` is
a summary of the purchases and `premium_transactions` is the record of
them, so the repair sets the counter to `greatest(counter, the number of
paid transactions)`. A purchase is never counted twice, and a counter
that predates the transactions table is never lowered.

**One deliberate trade-off.** The repair re-applies the grant as a whole,
so a row an operator had switched off by hand would be switched back on.
Nothing in the codebase ever disables an entitlement — every write goes
through `upsertEntitlement` with `enabled: true` — so this can only
happen to a row somebody edited in the database.

**What the repair does not fix.** If the guild already held a *longer*
subscription than the diverged purchase bought, the guild's expiry
cannot tell us whether that purchase's grant landed, and the repair does
not fire. The buyer keeps the longer subscription and loses the extra
days. That is an under-grant in a legacy divergence, never an over-grant.

---

## 3. The failure route

### The answer

**The audit's premise is wrong, and the fix is stronger than the three
options on the table.** The browser redirect *is* signed.

The browser does not sign anything, and it does not have to. PayU
computes the response hash on its own servers and the hash travels with
the redirect, exactly as it does with the server-to-server webhook. The
status is inside the signature, so a failure callback is as unforgeable
as a successful one — and the server holds the salt, so the server can
check it. PayU's own documentation is explicit:

> "All callbacks POST data on merchant's callback URL." … "The merchant
> must verify the hash and then only mark a transaction as success/failure."

The difference between the two routes was never *signing*. It is that a
browser redirect can be triggered by a third-party page, and that the
gateway may also call the failure url from its own servers, where there
is no `Origin` at all. Both are handled by checking the origin **when
there is one**, not by requiring it.

### What the route does now

`/premium_failed` writes nothing until the callback has been verified. In
order:

1. the transaction id is ours (the body's, which is signed; the query
   string's is a hint and the two must agree);
2. the merchant key, when the callback carries one, is ours;
3. **the status is a failure** — present, and not `success`. A callback
   that says `success` is not a failure, and a callback that says nothing
   at all is not a failure either;
4. the `Origin`, when the request carried one, is PayU's (a foreign origin
   is a forgery: the browser that posted it was on somebody else's page);
5. the amount is the plan's price, compared as a decimal;
6. **the signature verifies**, in constant time, over every known layout.

Only then is the transaction marked `failed` — a conditional `UPDATE`, so
a `paid` transaction is never un-bought — and the raw payload stored.

### About the three options

- **Verify the key, the amount and the transaction id.** Done, but on its
  own it is worth very little: the merchant key and the amount are in the
  payment form the browser renders, so they are **public**. The only
  secret in a callback is the 128-bit transaction id, which is why the
  signature is the check that matters.
- **Require the status to be present and to be a failure.** Done. It is
  a routing rule rather than a security rule — once the signature
  verifies, the status is authenticated — but it stops a "success"
  callback from marking a failure and stops a request that omits the
  field from changing anything.
- **Leave it and document it.** No.

### The one soft spot

A callback with **no hash at all** is accepted only when it came from
PayU's origin — the one thing a third-party site cannot forge, because a
browser posting from another site carries that site's origin. A request
with no origin and no signature is refused. The reason for the soft spot
is that the route keeps working if the live gateway ever stops signing
its failure redirect; the cost is that someone who knows a transaction id
can still flip it to `failed` in that (hypothetical) world — which is
exactly the exposure the audit described, and no worse.

If the gateway does sign the failure callback — as its documentation says
it does — the soft spot is never reached, and the failure route is as
strong as the success route. The trade is deliberate: the worst case is a
transaction that stays `pending` instead of `failed`, and `pending` and
`failed` behave the same to the buyer (the payment page renders for both,
and a later success callback can still flip it to `paid`). The log says
`the callback carried no signature` if it ever happens.

---

## 4. The tests

| Test | What it proves |
|---|---|
| `purchase.test.ts` — *leaves nothing behind when the grant fails half-way through* | A trigger makes the **last** entitlement write fail, so six rows were written inside the transaction. The transaction is still `pending`, there are **no** entitlement rows, and the guild has no subscription — and the retry then grants the purchase properly. This is the test that proves the bug is fixed. |
| `purchase.test.ts` — *grants once when two callbacks arrive at the same time* | Two concurrent activations: one `activated`, one `already_paid`, seven entitlement rows (not fourteen), the subscription extended once, and `premiums = 1`. |
| `purchase.test.ts` — *grants nothing extra when a paid transaction is replayed* | The second callback does not extend the subscription and does not count the purchase twice. |
| `purchase.test.ts` — *puts back a purchase that was paid for but never granted* | The divergence is written straight into the database; the next callback repairs it, restores the subscription, and the purchase is counted once. |
| `purchase.test.ts` — *does not resurrect a subscription that has already run out* | A replayed webhook for a lapsed subscription changes nothing. |
| `server/server.test.ts` — *the failure redirect* | Seven cases: no signature, a bad signature, another transaction's signature, a tampered amount, a `success` status, a foreign origin, and a forged failure not overwriting the audit data — and a late failure not un-buying a paid subscription. |
| `server/server.test.ts` — *the notification* | The notifier sees the entitlement already in force (the commit happened first); a notifier that throws does not undo the purchase; a repaired purchase is still announced. |
| `payu.test.ts` — *the failure callback* | The unit-level checks: the transaction id, the merchant key, the status, the amount, the origin and the signature. |

`purchase.test.ts` is 21 tests, `server/server.test.ts` is 30 and
`payu.test.ts` is 60. The whole premium area is 161 tests in 8 files, and
`npm run typecheck` and `npm test` are green for the whole project.

---

## 5. The files

| File | What changed |
|---|---|
| `modules/premium/repo.ts` | `DbExecutor` and the optional executor on the statements the grant uses; `lockGuildSettings`; `restoreGuildPremium`; `restoreUserPremium`; `recountUserPremiums`; `withLockedTransaction` hands the transaction handle to its callback. |
| `modules/premium/purchase.ts` | `activatePremium` is one transaction; `grantPurchase`; `repairPaidTransaction`; the new `"repaired"` outcome. |
| `modules/premium/payu.ts` | `isFailureStatus`; `verifyPayuFailureCallback`. |
| `modules/premium/server/index.ts` | `/premium_failed` is verified (`completeFailure`); the notification fires for `"repaired"` as well as `"activated"`. |
| `modules/premium/index.ts` | The new exports. |
| `modules/premium/README.md`, `modules/premium/PORT-REPORT.md` | The atomicity, the repair and the failure route. |
