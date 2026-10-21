/**
 * The provider that is switched off.
 *
 * A deployment that does not use screenshot verification should not pay for
 * OCR. The local provider starts a Tesseract worker, which downloads a
 * language model of about 15MB on the first run, keeps a worker process
 * alive for the rest of the bot's life, and costs about two seconds per
 * screenshot.
 *
 * This provider costs nothing. It starts no worker, downloads no model and
 * makes no network call. It answers with **empty text**, and every rule
 * that looks at the text refuses an empty text — so a screenshot submitted
 * while OCR is off is rejected rather than waved through.
 *
 * ## The one hole, and how it is closed
 *
 * The empty text is not enough on its own for every setup. The `any_ss`
 * screenshot type has no rules at all, and a `loco` or `rooter` setup whose
 * channel name is empty has none that look at the text either. For those,
 * an empty text would be accepted.
 *
 * So the caller has to refuse the submission itself when OCR is off.
 * {@link isOcrDisabled} is the signal for that: it is the one thing the
 * caller has to check, and it works whatever provider it holds.
 */

import type { OcrProvider, OcrResult } from "./index.js";

/**
 * The name the switched-off provider reports.
 *
 * The name is what identifies a provider in the logs, and it is what
 * {@link isOcrDisabled} looks at.
 */
export const DISABLED_PROVIDER_NAME = "disabled";

/**
 * The hash the switched-off provider reports.
 *
 * No image was looked at, so there is no hash. Sixteen zero characters are
 * a well-formed 64-bit hash, so nothing downstream has to special-case it —
 * but it is the hash of nothing, and a caller that stores it stores a lie.
 * The caller is told to refuse the submission instead.
 */
const NO_HASH = "0000000000000000";

/**
 * The OCR provider for a deployment that does not use OCR.
 *
 * It answers with empty text, starts no worker and makes no network call.
 */
export class DisabledOcrProvider implements OcrProvider {
  readonly name = DISABLED_PROVIDER_NAME;

  /**
   * Answers with empty text.
   *
   * The image is not read at all: no decoding, no hashing, no recognition.
   * The result exists so the caller gets a well-formed answer rather than a
   * crash — and an empty text is what every text rule refuses.
   */
  async analyze(_image: Buffer | string): Promise<OcrResult> {
    return {
      text: "",
      dhash: NO_HASH,
      phash: NO_HASH,
      rawText: "",
    };
  }

  /**
   * Nothing to release.
   *
   * The provider holds no worker and no connection, so there is nothing to
   * terminate. The method exists so the caller can call it unconditionally.
   */
  async shutdown(): Promise<void> {
    // Intentionally empty.
  }
}

/**
 * Whether this provider is the switched-off one.
 *
 * The name is the signal rather than the class, so a caller that holds an
 * `OcrProvider` can ask the question without knowing which implementation
 * it has. Use it to refuse a screenshot outright — an empty text alone does
 * not refuse every setup.
 *
 * A missing provider counts as switched off: there is no OCR to run.
 */
export function isOcrDisabled(
  provider: OcrProvider | null | undefined,
): boolean {
  if (!provider) return true;

  return provider.name === DISABLED_PROVIDER_NAME;
}
