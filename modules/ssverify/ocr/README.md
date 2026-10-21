# OCR and image hashing

Everything the screenshot-verification feature needs to look at a picture:
the text in it, and the two perceptual hashes the duplicate check compares.

This replaces two things Quotient had. Its OCR was an external service
(`POST {FASTAPI_URL}/ocr`) that is not in Quotient's repository, cannot be
run, and cannot be pointed at. Its duplicate check leaned on the
Python-only `imagehash` library. Both are replaced here: the service by the
provider interface below, `imagehash` by `hash.ts`.

Nothing in here imports from `core/` or `db/`. The module stands alone.

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

`analyze` takes a `Buffer` of image data or a `string`. For the local
provider a string is a file path; for the remote one it is a publicly
reachable URL, because that service fetches the image itself.

`text` is normalised: lowercased, with spaces and newlines removed. That is
Quotient's `ImageResponse.lower_text`, the form every rule in Quotient's
`SSVerify` compared against, so no consumer has to normalise it again. Use
`rawText` when a rule needs the text exactly as it came out of the engine —
Quotient's YouTube rule looked for the literal string `"SUBSCRIBE "`,
trailing space included, which the normalisation removes.

`createOcrProvider()` builds the right one:

```ts
const provider = createOcrProvider();
// no OCR_PROVIDER_URL  -> LocalOcrProvider, no key, no network
// OCR_PROVIDER_URL set -> HttpOcrProvider, the Quotient-compatible service
```

Two helpers come with it: `ocrEnabledFromEnv()` reads the environment
half of the on/off decision, and `isOcrDisabled(provider)` says whether the
provider in hand is the switched-off one. Both are described under
[Switching OCR off](#switching-ocr-off).

## The providers

**`LocalOcrProvider`** is the default. `tesseract.js` reads the text and
`sharp` decodes the pixels. It needs no API key and no network once the
Tesseract language model is on disk. The model is downloaded on the first
run and cached in `.cache/tesseract` (override with `cachePath`).

The worker is created lazily and reused, so only the first screenshot pays
for the download. `warmup()` at boot moves that cost to startup. A worker
that cannot be started does not fail the screenshot: the text comes back
empty and the hashes are still computed — and every rule that checks the
text rejects an empty text, so a broken OCR rejects a screenshot rather than
waving it through. (The `any_ss` type has no rules at all; see
[Switching OCR off](#switching-ocr-off).)

Calls are serialised per provider. Quotient held one global lock around its
OCR call; here the lock belongs to the provider, so a second provider or a
second process is not slowed down by the first.

**`HttpOcrProvider`** talks to the Quotient-compatible service and is only
used when `OCR_PROVIDER_URL` is configured. It posts `[{"url": ...}]` with
an `authorization` header and reads back `{url, dhash, phash, text}`.

**`DisabledOcrProvider`** is the provider for a deployment that does not use
OCR at all. It is described under [Switching OCR off](#switching-ocr-off).

## Switching OCR off

A deployment that does not use screenshot verification should not pay for
OCR. The local provider starts a Tesseract worker, which downloads a
language model of about 15MB the first time it runs and keeps a worker
process for the rest of the bot's life, and every screenshot costs about two
seconds.

`createOcrProvider({ enabled: false })` returns the `DisabledOcrProvider`
instead. It **starts no worker, downloads no model and makes no network
call** — the image is not even decoded.

```ts
const provider = createOcrProvider({ enabled: false });

provider.name;                    // "disabled"
await provider.analyze(buffer);  // { text: "", dhash: "0000000000000000", ... }
```

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

### What it saves

- **No language model download.** The local provider fetches about 15MB of
  Tesseract model the first time it runs and caches it in `.cache/tesseract`.
  Off, there is no download and no cache directory.
- **No worker process.** The Tesseract worker is created lazily and kept
  for the life of the bot. Off, there is nothing to keep and nothing to
  terminate.
- **No two-second stalls.** Every screenshot costs about two seconds of
  recognition. Off, the answer comes back immediately.

### How the decision is made

Three ways:

1. **Forced on** — `OCR_ENABLED=true` or `OCR_ENABLED=1`. OCR runs whatever
   the database says. This is what a deployment that uses screenshot
   verification sets, and it is also the right answer for a deployment with
   `OCR_PROVIDER_URL` set: that deployment *is* using OCR.
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

### Adding a third provider

Implement `OcrProvider` and return it. The interface is two members:

```ts
class MyOcrProvider implements OcrProvider {
  readonly name = "mine";

  async analyze(image: Buffer | string): Promise<OcrResult> {
    return { text: "whatever", dhash: "0000000000000000", phash: "0000000000000000" };
  }
}
```

Rules the implementation has to keep:

- `text` is normalised — call `normaliseText()` on whatever the engine
  returned, and put the untouched text in `rawText`.
- `dhash` and `phash` are 16 lower case hex characters. Use
  `computeHashes()` if the hashes are yours to compute, and
  `hashToHex(hexToHash(value))` to put a hash that came from somewhere else
  into the canonical form.
- The hashes must be computed by one implementation for all of them. A
  duplicate check compares a new hash with stored ones, and the distance
  only means something when both sides counted the same 64 bits the same
  way.

## The hashes

Both hashes are 64 bits, rendered as **16 lower case hex characters**,
zero padded: `0000000000000000` through `ffffffffffffffff`. A hash that is
not exactly 16 characters is rejected rather than truncated — a truncated
hash would compare as "a different picture", which is a bug that hides
itself.

**dHash** — the image is greyscaled, resized to 9x8, and every pixel is
compared with the one to its right. 64 comparisons, 64 bits.

**pHash** — the image is greyscaled, resized to 32x32, and the discrete
cosine transform is taken. The 8x8 corner of the low-frequency part is
compared against its own median. 64 coefficients, 64 bits.

### Why the threshold is 7

The duplicate check is a Hamming distance: the number of bits that differ
between the new hash and a stored one. A distance only means something for
a fixed number of bits, so the threshold of 7 is a statement about a **64-bit**
hash: two screenshots count as the same picture when at most 7 of their 64
bits differ.

That number is Quotient's, and it was calibrated against hashes produced by
the Python `imagehash` library. So this implementation reproduces
`imagehash` 4.x exactly:

- the dHash bit is set when the pixel on the **right** is brighter than the
  one on the left (`imagehash` computes `pixels[:, 1:] > pixels[:, :-1]`);
- the first comparison is the **most significant bit** of the 64-bit value,
  and the hash is written as 16 hex characters the way `imagehash` 4.x writes
  it (`imagehash` 3.x wrote the bits of every byte the other way round; the
  distance between two hashes is the same either way, only the stored text
  differs);
- the greyscale conversion, the resampling and the transform are the ones
  `imagehash` used, which means Pillow does the resampling. `resample.ts`
  is a port of Pillow's Lanczos resampler for that reason, and
  `hash.test.ts` pins the result against the reference values.

Both hashes are verified against `imagehash` 4.3.2 with Pillow 13 on a
corpus of images, and match bit for bit. That is what keeps the threshold
meaning what it meant: a resampler that drifts from Pillow's makes the
measured distance between two screenshots of the same thing larger than
the reference measures it. The reference measures 0 for the same
screenshot saved as a different JPEG and 4 for a slightly cropped one; a
resampler that drifts measures 0 and 11, and 11 is over the threshold.

**The threshold is a parameter, not a constant.** `isPerceptualDuplicate(a,
b, threshold)` takes it, and `DEFAULT_DUPLICATE_THRESHOLD` is 7. The
number only means something for a 64-bit hash, so it has to move with the
hash implementation rather than being baked into a comparison.

```ts
hammingDistance("0000000000000000", "000000000000007f"); // 7 -> duplicate
hammingDistance("0000000000000000", "00000000000000ff"); // 8 -> not a duplicate
```

## Known limitations

**The local OCR is not the remote service.** The text quality depends on
the Tesseract model that is on disk, and Tesseract and Quotient's service
read a screenshot differently. The same picture can come back with
different text — Tesseract mis-reads small or low-contrast text, and it
inserts line breaks of its own. Any rule that compares the text literally
(a channel name, a keyword) has to be tested against the text this provider
actually produces, not against the text the old service produced.

**The hashes are the compatible part.** They match `imagehash` bit for bit,
so the duplicate check behaves the way Quotient's did.

**The pHash of a blank image is not meaningful.** The median comparison
decides every bit, and for a uniform image all the coefficients but the
first are zero. This implementation drops the rounding errors out of the
transform so that the result is the same one the reference produces, but a
blank screenshot still has no perceptual structure to speak of.

**The resampling is not free.** Both hashes take about 30ms for a phone
screenshot, of which about 11ms is decoding the picture and about 17ms is
the JavaScript resampling. `sharp`'s own resampler does the same work in
about 11ms, but it is not compatible, and that is the trade this module
makes.

## The files

| File | What it holds |
| --- | --- |
| `index.ts` | `OcrProvider`, `OcrResult`, `createOcrProvider`, `ocrEnabledFromEnv` |
| `local.ts` | `LocalOcrProvider` — Tesseract and sharp |
| `http.ts` | `HttpOcrProvider` — the Quotient-compatible service |
| `disabled.ts` | `DisabledOcrProvider` — the provider that is switched off |
| `hash.ts` | `computeHashes`, `computeDhash`, `computePhash`, `hexToHash`, `hashToHex`, `hammingDistance`, `isPerceptualDuplicate` |
| `resample.ts` | Pillow-compatible Lanczos resampling |
| `text.ts` | `normaliseText` — Quotient's `lower_text` |
| `queue.ts` | `SerialQueue` — one analysis at a time per provider |

## Tests

```bash
npx vitest run modules/ssverify/ocr/
```

The tests never start Tesseract: the text extractor is injected, so the
suite does not depend on the language model being downloadable. The text
content is never asserted either, only that it is a string.

`disabled.test.ts` is the exception: it mocks `tesseract.js` so that the
worker factory can be watched, and asserts that the switched-off provider
never calls it, never calls `fetch`, and never creates the cache directory
the language model would be downloaded into. A control test starts a worker
on purpose, so that "no worker was started" is a fact about the provider and
not about a spy that never fires.
