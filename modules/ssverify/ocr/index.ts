/**
 * OCR and image hashing for the screenshot-verification feature.
 *
 * Quotient called an external OCR service that is not in its repository and
 * leaned on the Python-only `imagehash` library for the duplicate check.
 * Both are replaced here: the service by the provider interface below, and
 * `imagehash` by the hashing code in `hash.ts`.
 *
 * The local provider is the default. The feature has to work with no
 * configuration at all, so a remote service is opt-in.
 */

import { HttpOcrProvider } from "./http.js";
import type { HttpOcrProviderOptions } from "./http.js";
import { LocalOcrProvider } from "./local.js";
import type { LocalOcrProviderOptions } from "./local.js";

export interface OcrResult {
  /**
   * Extracted text, lowercased and whitespace-stripped for comparison.
   *
   * This is Quotient's `ImageResponse.lower_text`: the same normalisation
   * every rule in `SSVerify` compared against.
   */
  text: string;
  /** 64-bit perceptual hash as 16 lowercase hex characters. */
  dhash: string;
  /** 64-bit perceptual hash as 16 lowercase hex characters. */
  phash: string;
  /**
   * The text as the OCR engine produced it, before normalisation.
   *
   * Optional, and only present when the provider has it. Quotient's rules
   * need it in one place: the YouTube rule looks for the literal string
   * `"SUBSCRIBE "`, trailing space included, which normalisation removes.
   */
  rawText?: string;
}

export interface OcrProvider {
  /** Identifies the provider in logs and in the configuration UI. */
  readonly name: string;
  /**
   * Extracts the text and the two perceptual hashes of one image.
   *
   * A `Buffer` is image data; a `string` is a file path for the local
   * provider and an image URL for the remote one.
   */
  analyze(image: Buffer | string): Promise<OcrResult>;
  /**
   * Releases the resources the provider holds, such as the Tesseract worker.
   *
   * Optional — a provider that holds nothing does not implement it. Call it
   * when the bot shuts down.
   */
  shutdown?(): Promise<void>;
}

export interface CreateOcrProviderOptions {
  /**
   * Environment to read the configuration from. Defaults to `process.env`.
   */
  env?: Record<string, string | undefined>;
  /** Options for the local provider. */
  local?: LocalOcrProviderOptions;
  /** Options for the remote provider. */
  remote?: HttpOcrProviderOptions;
}

/**
 * Builds the OCR provider the bot should use.
 *
 * `OCR_PROVIDER_URL` selects the Quotient-compatible remote service; when it
 * is absent the local provider is used, which needs no API key, no network
 * and no configuration.
 */
export function createOcrProvider(
  options: CreateOcrProviderOptions = {},
): OcrProvider {
  const env = options.env ?? process.env;
  const url = env.OCR_PROVIDER_URL?.trim();

  if (!url) {
    return new LocalOcrProvider(options.local);
  }

  const remote = options.remote;

  return new HttpOcrProvider({
    ...(remote ?? {}),
    url: remote?.url ?? url,
    apiKey: remote?.apiKey ?? env.OCR_PROVIDER_KEY,
  });
}

export { LocalOcrProvider } from "./local.js";
export { HttpOcrProvider } from "./http.js";
export { normaliseText } from "./text.js";
export {
  computeDhash,
  computeHashes,
  computePhash,
  hashToHex,
  hexToHash,
  hammingDistance,
  isPerceptualDuplicate,
  DEFAULT_DUPLICATE_THRESHOLD,
  HASH_HEX_LENGTH,
} from "./hash.js";
export type { ImageHashes } from "./hash.js";
export type { HttpOcrProviderOptions } from "./http.js";
export type {
  LocalOcrProviderOptions,
  TextExtractor,
} from "./local.js";
