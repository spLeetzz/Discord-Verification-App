/**
 * The OCR provider this area talks to.
 *
 * The provider itself lives in `modules/ssverify/ocr/` and is **not** ours
 * to change — it is the piece that is bit-exact with Python's `imagehash`
 * 4.3.2, which is what keeps the duplicate threshold of 7 meaning what it
 * meant. This file only owns the lifecycle:
 *
 *  - **one provider for the whole bot**, so the Tesseract worker is started
 *    once and the calls stay serialised per provider;
 *  - **`warmup()` at boot**, so the language model is downloaded at startup
 *    rather than on the first screenshot of the day;
 *  - **`shutdown()` on exit**, so the worker is terminated and the process
 *    can go.
 *
 * The OCR takes about two seconds per screenshot, so every caller has to
 * defer its interaction first.
 */

import { createOcrProvider } from "../ssverify/ocr/index.js";
import type { OcrProvider } from "../ssverify/ocr/index.js";

/**
 * A provider that can be started ahead of time.
 *
 * `warmup()` is on the local provider, not on the interface, because the
 * remote one has nothing to warm up.
 */
interface WarmableProvider {
  warmup?(): Promise<void>;
}

let provider: OcrProvider | null = null;

/**
 * The provider, built on first use.
 *
 * `OCR_PROVIDER_URL` selects the Quotient-compatible remote service; when
 * it is absent the local provider is used, which needs no key and no
 * network.
 */
export function getOcrProvider(): OcrProvider {
  if (!provider) {
    provider = createOcrProvider();
  }

  return provider;
}

/**
 * Starts the provider ahead of time.
 *
 * Worth calling once at boot: the first Tesseract worker downloads the
 * language model, and doing that lazily means the first screenshot of the
 * day waits for the download.
 *
 * A provider that cannot be started is not fatal — it answers with empty
 * text, and every text rule rejects an empty text, so a broken OCR rejects
 * a screenshot rather than waving it through.
 */
export async function warmupOcr(): Promise<void> {
  const current = getOcrProvider();

  const warmable = current as OcrProvider & WarmableProvider;

  if (typeof warmable.warmup !== "function") return;

  await warmable.warmup();
}

/**
 * Releases the provider's resources.
 *
 * Call it when the bot shuts down.
 */
export async function shutdownOcr(): Promise<void> {
  if (!provider) return;

  const current = provider;

  // The provider is dropped first, so a shutdown that runs twice does not
  // terminate the same worker twice.
  provider = null;

  await current.shutdown?.();
}
