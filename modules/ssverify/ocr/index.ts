/**
 * OCR and image hashing for the screenshot-verification feature.
 *
 * Everything the feature needs to look at a picture: the text in it, and
 * the two perceptual hashes the duplicate check compares.
 *
 * ## There is no local engine
 *
 * Quotient called an external OCR service that is not in its repository and
 * leaned on the Python-only `imagehash` library for the duplicate check.
 * The service is the only engine there is: the bot talks to a
 * Quotient-compatible service and does the OCR and the hashing there.
 *
 * There is **no local fallback**. A deployment that does not configure a
 * service has no OCR at all, and the provider it gets is the
 * {@link DisabledOcrProvider} — which refuses every screenshot rather than
 * waving one through. That is the fail-closed behaviour the screenshot
 * verification area implements.
 *
 * ## The providers
 *
 *  - {@link HttpOcrProvider} — the remote service. Used when
 *    `OCR_PROVIDER_URL` is set.
 *  - {@link DisabledOcrProvider} — the provider for a deployment that has
 *    no service, and for a deployment that switches the OCR off.
 *
 * The hashes come from the service as well, so `hash.ts` holds the
 * comparison and nothing else: a Hamming distance over a 64-bit hash.
 */

import { DisabledOcrProvider } from "./disabled.js";
import { HttpOcrProvider } from "./http.js";
import type { HttpOcrProviderOptions } from "./http.js";

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
   * A `Buffer` is image data; a `string` is a publicly reachable image URL,
   * which is what the remote service needs — it fetches the image itself.
   */
  analyze(image: Buffer | string): Promise<OcrResult>;
  /**
   * Releases the resources the provider holds, such as the requests that
   * are on the wire.
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
   * text, makes no network call and refuses every screenshot. `true` builds
   * the provider the deployment would have got anyway — which is the
   * remote one when `OCR_PROVIDER_URL` is set, and the switched-off one
   * when it is not.
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
  /** Options for the remote provider. */
  remote?: RemoteOcrProviderOptions;
}

/**
 * The options of the remote provider, as the factory takes them.
 *
 * The URL is optional here: the factory reads it from `OCR_PROVIDER_URL`,
 * and only a caller that wants to point the provider somewhere else has to
 * pass one.
 */
export type RemoteOcrProviderOptions = Omit<
  HttpOcrProviderOptions,
  "url"
> & {
  url?: string;
};

/**
 * Builds the OCR provider the bot should use.
 *
 * `OCR_PROVIDER_URL` selects the Quotient-compatible remote service. When
 * it is absent there is **no engine to fall back on**, so the provider is
 * the switched-off one: every screenshot is refused, and nothing is stored.
 *
 * With `enabled: false` none of that is looked at: the provider is the
 * switched-off one, so there is no network call at all.
 */
export function createOcrProvider(
  options: CreateOcrProviderOptions = {},
): OcrProvider {
  // The switch is read before anything else, so an installation that does
  // not use screenshot verification never touches the service at all.
  if (options.enabled === false) {
    return new DisabledOcrProvider();
  }

  const env = options.env ?? process.env;
  const url = env.OCR_PROVIDER_URL?.trim();

  // No service, no engine. The feature is there, and it refuses.
  if (!url) {
    return new DisabledOcrProvider();
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

/**
 * What one analysis produced.
 *
 * A discriminated union, because "the screenshot was read" and "the
 * screenshot could not be read" are two different answers, and only one of
 * them carries a result.
 */
export type OcrAnalysis =
  | {
      /** The screenshot could be read. */
      readonly ok: true;
      /** What the provider made of it. */
      readonly result: OcrResult;
    }
  | {
      /** The screenshot could not be read. */
      readonly ok: false;
      /** Why not, in words. */
      readonly reason: string;
    };

/**
 * Analyses one image and answers with a decision rather than an exception.
 *
 * A provider that cannot do its job — the service is down, it answered
 * with rubbish, it sent a hash nobody can compare — is a screenshot that
 * cannot be verified. It has to be **refused**, and a refusal is a
 * decision, not a crash: the caller gets an answer it can turn into a
 * message, and nothing is stored.
 *
 * @param provider the provider to ask.
 * @param image    the image URL the service can fetch.
 */
export async function analyzeImage(
  provider: OcrProvider,
  image: Buffer | string,
): Promise<OcrAnalysis> {
  try {
    const result = await provider.analyze(image);

    return { ok: true, result };
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

export { HttpOcrProvider } from "./http.js";
export {
  DisabledOcrProvider,
  DISABLED_PROVIDER_NAME,
  isOcrDisabled,
} from "./disabled.js";
export { normaliseText } from "./text.js";
export {
  compareHashes,
  hashToHex,
  hexToHash,
  hammingDistance,
  isHashHex,
  isPerceptualDuplicate,
  DEFAULT_DUPLICATE_THRESHOLD,
  HASH_HEX_LENGTH,
  UnusableHashError,
} from "./hash.js";
export type { HashComparison } from "./hash.js";
export type { HttpOcrProviderOptions } from "./http.js";