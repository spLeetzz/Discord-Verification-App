# Release blockers

Things that cannot be settled from inside this repository. Each one needs a
live account, a live gateway, or a human decision. **None of them are
optional** — they are the difference between a checkout that works and one
that silently does not.

---

## B1. Confirm PayU's live response hash form

**Status:** our implementation is **verified against PayU's own SDK** and its
published known-answer vectors, independently re-verified by the manager
against `payu-india/payu-sdk-node`:

```
REQUEST
  SDK code reproduces PayU's vector : true
  ours [udf-with-blanks] == vector  : true
  ours [compact]        == vector  : false
RESPONSE
  SDK code reproduces PayU's vector : true
  ours candidate == PayU vector      : true
  ours would accept a genuine callback: true
```

So the **request** form is `key|txnid|amount|productinfo|firstname|email|udf1..udf5||||||salt`
(17 fields) and the **response** form reverses the request's fields with the
salt first, the key last, and the **status** second:
`salt|status|||||udf5|udf4|udf3|udf2|udf1|email|firstname|productinfo|amount|txnid|key`.

**What still has to happen:** one real test payment, capture the raw
callback, and compare its `hash` against our candidates. If it matches
neither, add a layout — and establish whether the status is inside the
signature, because the replay protection depends on it.

**A second layout is kept on purpose** (`compact`, the 12-field form that
third-party guides publish rather than PayU's SDK). Accepting a second
encoding of the same signature does not weaken anything: both are computed
over the same signed fields with the same secret, so the set of forgeable
messages is identical. **Do not "tighten" it back to one layout** without
reading `modules/premium/PAYU-HASH-REPORT.md`.

**The swapped salt/key form is refused on purpose.** It does not sign the
status, so a failed payment's callback could be replayed as a success. Adding
it back needs an answer for the replay hole, not just a one-liner.

## B2. The `Origin` header on the browser redirect

The callback now requires PayU's origin. If PayU's checkout page sends no
`Origin`, the buyer sees a 403 on the success page. **The webhook still
grants the purchase**, so this is a UX failure and not a money failure — but
it looks like a total failure to the buyer.

**Check the logs of the first test payment.**

## B3. The amount PayU echoes

A convenience fee or a discount makes the echoed `amount` differ from the
plan price, and every payment is refused. The amount is compared as an exact
decimal.

**Confirm what the gateway echoes.**

## B4. The form endpoint's API version

No `si_details` or `udf_params`, or the request hash changes and the
gateway rejects the form.

## B5. The webhook URL in the PayU dashboard

Must be the publicly reachable base URL — `PREMIUM_PUBLIC_URL` — plus the
webhook path. The server runs in the bot's process, so it needs a public
address and a reverse proxy in front of it.

## B6. The salt

PayU recommends "Merchant Salt (Version 2)". The old version-1 salt
produces a different hash. Use version 2.

---

## B7. A live Discord guild, and the command budget

The port adds roughly 60 top-level commands to the 8 that already exist.
**Discord allows 100 slash commands per guild.** The count must be checked
against the real guild before deployment, and the areas grouped under
subcommands if it is over.

The bot also currently ignores interactions from any guild but
`ALLOWED_GUILD_ID`. A tournament bot that only works in one guild is
probably not the product anyone wants — **decide whether that filter stays.**

## B8. The premium role, the HQ guild, and the external links

Quotient's premium flow grants a role in Quotient's own support guild and
links to `quotientbot.xyz`. **None of that ships.** The perk list is
generated from the entitlements the port actually has.

Decide what the premium role *is* here: a role in the target guild, granted
to a staff member, or nothing at all.

## B9. The free-tier limits, and what happens when they are exceeded

`FREE_TIER` is one config object and every gate reads it, so the perk list
and the code cannot disagree. The free tier is 3 scrims, 1 tournament, 1
tagcheck channel, 1 easytag channel, 1 slot manager, 1 ssverify config, 1
media partner, 1 auto-purge channel.

**Decide what happens when a free guild is over the limit.** The port
refuses the new one and leaves the existing alone. Quotient's behaviour on
premium expiry was to **delete** the surplus — which would delete
participants' registrations. That is not ported (D15), and it should stay
that way.

## B10. The OCR engine's accuracy against each verification rule

The duplicate check is bit-exact with Python's `imagehash`, so the threshold
of 7 means the same thing it did. But the **text** rules were calibrated
against Quotient's remote OCR service, and the port uses Tesseract locally.
"Contains" rules are reliable; equality rules are not — an icon reading as a
character between two words breaks an equality check a human would pass.

**Validate each rule against the real screenshots** this bot's users will
submit.
