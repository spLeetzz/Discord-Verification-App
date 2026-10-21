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
 *
 * A deployment that does not use screenshot verification can switch OCR off
 * altogether: `createOcrProvider({ enabled: false })` then returns the
 * {@link DisabledOcrProvider}, which starts no worker, downloads no language
 * model and makes no network call. The decision is the caller's, because
 * only the caller can see whether a screenshot-verification setup exists —
 * `ocrEnabledFromEnv()` reads the environment half of that decision.
 */

import { DisabledOcrProvider } from "./disabled.js";
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
   * Whether OCR should run at all.
   *
   * `false` returns the {@link DisabledOcrProvider}: it answers with empty
   * text, starts no worker, downloads no language model and makes no network
   * call. `true` builds the provider the deployment would have got anyway.
   *
   * Defaults to `true`, so nothing that works today changes. The decision
   * belongs to the caller, because only the caller can see the database and
   * say whether screenshot verification is used at all — see
   * {@link ocrEnabledFromEnv} and `modules/identity/ocr.ts`.
   */
  enabled?: boolean;
  /**
   * Environment to read the configuration from. Defaults to `process.env`.
   */
  env?: NodeJS.ProcessEnv;
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
 *
 * With `enabled: false` none of that is looked at: the provider is the
 * switched-off one, so there is no worker, no language model download and no
 * network call.
 */
export function createOcrProvider(
  options: CreateOcrProviderOptions = {},
): OcrProvider {
  // The switch is read before anything else, so an installation that does
  // not use screenshot verification never touches Tesseract at all.
  if (options.enabled === false) {
    return new DisabledOcrProvider();
  }

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

/**
 * Whether OCR should run.
 *
 * `OCR_ENABLED` decides it when it is set: "true" or "1" forces it on,
 * "false" or "0" forces it off. When it is unset the decision is the
 * caller's — see `modules/identity/ocr.ts`, which checks whether any
 * screenshot-verification setup exists.
 *
 * A value that is neither of those is **not a guess**: it is treated as
 * unset, so a typo in the environment falls back to the automatic decision
 * rather than quietly switching OCR off.
 *
 * @returns `true` or `false` when the variable says so, `undefined` when it
 *          is unset or says something that is not understood.
 */
export function ocrEnabledFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): boolean | undefined {
  const value = env.OCR_ENABLED?.trim().toLowerCase();

  if (value === "true" || value === "1") return true;
  if (value === "false" || value === "0") return false;

  return undefined;
}

export { LocalOcrProvider } from "./local.js";
export { HttpOcrProvider } from "./http.js";
export {
  DisabledOcrProvider,
  DISABLED_PROVIDER_NAME,
  isOcrDisabled,
} from "./disabled.js";
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
