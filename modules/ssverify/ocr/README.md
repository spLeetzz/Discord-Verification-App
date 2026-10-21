# OCR and image hashing

Everything the screenshot-verification feature needs to look at a picture:
the text in it, and the two perceptual hashes the duplicate check compares.

This replaces two things Quotient had. Its OCR was an external service
(`POST {FASTAPI_URL}/ocr`) that is not in Quotient's repository and cannot
be run. Its duplicate check leaned on the Python-only `imagehash` library.
The service is what this module talks to, and the duplicate check is a
Hamming distance over the hashes the service returns.

Nothing in here imports from `core/`, `db/` or `utils/`. The module stands
alone.

## There is no local engine

**The bot has no OCR of its own.** The service does the text recognition
*and* the hashing, and there is no local fallback behind it: no Tesseract
worker, no language model, no image library.

So a deployment that has no service configured has **no OCR at all**, and
the provider it gets is the `DisabledOcrProvider` — which refuses every
screenshot rather than waving one through. The feature still exists; it
just has nothing to do the work.

| Configuration | Provider | What happens |
| --- | --- | --- |
| `OCR_PROVIDER_URL` set | `HttpOcrProvider` | The screenshot is sent to the service, and the answer is checked against the rules. |
| `OCR_PROVIDER_URL` unset | `DisabledOcrProvider` | Every screenshot is refused. Nothing is stored. |
| `OCR_ENABLED=false` | `DisabledOcrProvider` | Every screenshot is refused. Nothing is stored. |

## The interface

```ts
interface OcrProvider {
  readonly name: string;
  analyze(image: Buffer | string): Promise<OcrResult>;
  shutdown?(): Promise<void>;
}

interface OcrResult {
  text: string;    // lowercased, whitespace stripped
  dhash: string;   // 16 hex characters, 64 bits
  phash: string;   // 16 hex characters, 64 bits
  rawText?: string; // the text as the engine produced it
}
```

`analyze` takes a `Buffer` of image data or a `string`. The remote service
fetches the image itself, so a `string` has to be a **publicly reachable
URL**; a `Buffer` is refused.

`text` is normalised: lowercased, with spaces and newlines removed. That is
Quotient's `ImageResponse.lower_text`, the form every rule in Quotient's
`SSVerify` compared against, so no consumer has to normalise it again. Use
`rawText` when a rule needs the text exactly as it came out of the engine —
Quotient's YouTube rule looked for the literal string `"SUBSCRIBE "`,
trailing space included, which the normalisation removes.

## The providers

**`HttpOcrProvider`** talks to the Quotient-compatible service. It posts
`[{"url": ...}]` with an `authorization` header and reads back
`{url, dhash, phash, text}`.

**`DisabledOcrProvider`** is the provider for a deployment that has no
service, or that switches the OCR off. It answers with empty text, makes no
network call and reads no image.

`createOcrProvider()` builds the right one:

```ts
const provider = createOcrProvider();
// OCR_PROVIDER_URL set -> HttpOcrProvider
// OCR_PROVIDER_URL unset -> DisabledOcrProvider
```

Two helpers come with it: `ocrEnabledFromEnv()` reads the environment half
of the on/off decision, and `isOcrDisabled(provider)` says whether the
provider in hand is the switched-off one.

## Switching OCR off

`createOcrProvider({ enabled: false })` returns the `DisabledOcrProvider`
instead, whatever the environment says. It **makes no network call** — the
image is not even read.

### What "off" means

**Empty text.** The disabled provider answers with empty text and never
reads the image. Every rule that checks the text refuses an empty text, so a
screenshot submitted while OCR is off is rejected rather than waved through.

**The one exception.** The `any_ss` screenshot type has no rules at all, and
a `loco` or `rooter` setup whose channel name is empty has none that look
at the text either. For those two, an empty text on its own would be
*accepted* — so the caller has to refuse the submission itself:

```ts
import { isOcrDisabled } from "../ssverify/ocr/index.js";

if (isOcrDisabled(getOcrProvider())) {
  // refuse the submission — do not store it
}
```

`isOcrDisabled()` looks at the provider's name, so it answers the question
whatever provider the caller holds.

The hashes of a disabled result are sixteen zero characters. No image was
looked at, so there is no hash — the caller must not store one.

### How the decision is made

Three ways:

1. **Forced on** — `OCR_ENABLED=true` or `OCR_ENABLED=1`. OCR runs whatever
   the database says.
2. **Forced off** — `OCR_ENABLED=false` or `OCR_ENABLED=0`. OCR does not run
   whatever the database says.
3. **Automatic** — `OCR_ENABLED` is not set. The caller decides, and the
   caller is the only one who can see the database: it checks whether any
   screenshot-verification setup exists. A guild that never configured one
   pays nothing.

A value that is none of those four — `yes`, `2`, an empty string — is **not
a guess**. It counts as unset, so a typo falls back to the automatic
decision instead of quietly switching OCR off.

`ocrEnabledFromEnv()` reads the environment half of that decision and
returns `true`, `false`, or `undefined` for "not set, you decide":

```ts
import { createOcrProvider, ocrEnabledFromEnv } from "../ssverify/ocr/index.js";

const forced = ocrEnabledFromEnv();               // true | false | undefined
const enabled = forced ?? (await hasSsConfig());   // the caller's own check

const provider = createOcrProvider({ enabled });
```

The module does not read `OCR_ENABLED` on its own, and it does not import
from `db/`: it takes the decision as an argument, because only the caller
can see the database.

**The decision is not the last word.** `createOcrProvider({ enabled: true })`
still returns the disabled provider when no service is configured, so the
caller has to ask the provider it got rather than the flag it passed:

```ts
const provider = createOcrProvider({ enabled });
const ocrRuns = !isOcrDisabled(provider);
```

## A refusal is not a crash

A provider that cannot do its job — the service is down, it answered with
rubbish, it sent a hash nobody can compare — is a screenshot that **cannot
be verified**. It has to be refused, and a refusal is a decision rather than
an exception: the member gets an answer, and nothing is stored.

`analyzeImage()` is the call that makes that decision:

```ts
import { analyzeImage } from "../ssverify/ocr/index.js";

const analysis = await analyzeImage(provider, imageUrl);

if (!analysis.ok) {
  // refuse the screenshot, and say why
  logger.warn(`[Identity] The screenshot could not be verified: ${analysis.reason}`);
  return { accepted: 0, lines: [OCR_UNAVAILABLE_MESSAGE], verified: false };
}

const result = analysis.result;
```

It never throws. The reason says what went wrong.

## The hashes

Both hashes are 64 bits, rendered as **16 lower case hex characters**, zero
padded: `0000000000000000` through `ffffffffffffffff`. A hash that is not
exactly 16 characters is refused rather than truncated — a truncated hash
would compare as "a different picture", which is a bug that hides itself.

The service produces them, so this module does not read pixels. It holds
the comparison:

```ts
hammingDistance("0000000000000000", "000000000000007f"); // 7 -> duplicate
hammingDistance("0000000000000000", "00000000000000ff"); // 8 -> not a duplicate
```

### The threshold of 7

The duplicate check is a Hamming distance: the number of bits that differ
between the new hash and a stored one. A distance only means something for
a fixed number of bits, so the threshold of 7 is a statement about a
**64-bit** hash: two screenshots count as the same picture when at most 7 of
their 64 bits differ.

That number is Quotient's, and it was calibrated against the Python
`imagehash` library. The service has to produce hashes of the same shape —
64 bits, 16 hex characters — for the threshold to mean what it meant.

**The threshold is a parameter, not a constant.** `isPerceptualDuplicate(a,
b, threshold)` takes it, and `DEFAULT_DUPLICATE_THRESHOLD` is 7.

### A hash that cannot be compared

`hexToHash` and `hammingDistance` **throw** `UnusableHashError` on a hash
that is not sixteen hex characters. That is right for a parser, but a
service that changed its hash length would then crash the duplicate check
instead of being handled.

So there is a second way in, and it is the one a caller that must not crash
wants:

```ts
const comparison = compareHashes(a, b);

if (!comparison.ok) {
  // a hash we cannot compare is a hash that verifies nothing:
  // refuse the screenshot
  return { ok: false, reason: comparison.reason };
}

if (comparison.duplicate) {
  // the same picture
}
```

`compareHashes()` never throws. It answers "I cannot compare these" and
says why, and the caller refuses. A hash the service sent that cannot be
compared is a hash the screenshot cannot be verified with, and an
unverifiable screenshot must not be accepted.

## Known limitations

**The service is not in the repository.** It is not Quotient's, it is not
ours, and it is not configured by default. A deployment without one refuses
every screenshot.

**The service needs a public URL.** It fetches the image itself, so the
image cannot be a buffer. A caller that has the picture as a buffer — the
Discord attachment, say — has to give the service somewhere to fetch it
from.

**The hashes are the service's.** The duplicate check inherits the
threshold that was calibrated against `imagehash`, and the service has to
produce hashes of the same shape for it to mean anything. The two hashes
stored per submission have to come from one implementation: a database
mixing conventions compares two different things.

**The pHash of a blank image is not meaningful.** A blank screenshot has no
perceptual structure to speak of, whatever produced the hash.

## The files

| File | What it holds |
| --- | --- |
| `index.ts` | `OcrProvider`, `OcrResult`, `OcrAnalysis`, `createOcrProvider`, `analyzeImage`, `ocrEnabledFromEnv` |
| `http.ts` | `HttpOcrProvider` — the Quotient-compatible service |
| `disabled.ts` | `DisabledOcrProvider` — the provider that is switched off |
| `hash.ts` | `hexToHash`, `hashToHex`, `hammingDistance`, `isPerceptualDuplicate`, `compareHashes` |
| `text.ts` | `normaliseText` — Quotient's `lower_text` |
| `queue.ts` | `SerialQueue` — one analysis at a time per provider |

## Tests

```bash
npx vitest run modules/ssverify/ocr/
```

The tests never talk to a service: the `fetch` is replaced, so the suite
needs no network and no service. The answers the fake service gives are
the ones a real service gives, hashes included.
