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
 *  - **the decision whether the OCR runs at all**, made **once at boot**;
 *  - **`warmup()` at boot**, so the language model is downloaded at startup
 *    rather than on the first screenshot of the day;
 *  - **`shutdown()` on exit**, so the worker is terminated and the process
 *    can go.
 *
 * The OCR takes about two seconds per screenshot, so every caller has to
 * defer its interaction first.
 *
 * ## The decision
 *
 * A deployment that does not use screenshot verification should not pay for
 * OCR, so the provider can be **switched off**: no worker, no language
 * model download, no network call. The decision is made here, at boot, and
 * it is made **once**:
 *
 *  - `OCR_ENABLED` decides it when it is set — "true" or "1" forces it on,
 *    "false" or "0" forces it off, and anything else counts as unset;
 *  - when it is unset the decision is **automatic**: the OCR runs when there
 *    is at least one screenshot-verification setup.
 *
 * The decision belongs at boot for two reasons. It is the moment the
 * operator wants to know whether the OCR is on, and it keeps
 * {@link getOcrProvider} synchronous, which is what the call sites assume.
 *
 * The decision is made **before** the channel cache is loaded, because the
 * cache is what makes a screenshot-verification channel live — the answer
 * has to be there before the first screenshot can be processed.
 *
 * ## A broken OCR is not a switched-off one
 *
 * A provider that *fails* answers with an empty text, and most rule sets
 * refuse an empty text — but **not every one does**. `any_ss` has no rules
 * at all, and a `loco` or `rooter` setup whose channel name is empty has
 * none that look at the text either, so an empty text on its own would be
 * *accepted* there.
 *
 * That is why the submission itself is refused when the OCR is known to be
 * off (see `service.ts`), and why the disabled provider's zero hashes — the
 * hash of nothing — never reach the database.
 */

import { logger } from "../../utils/logger.js";
import {
  createOcrProvider,
  isOcrDisabled,
  ocrEnabledFromEnv,
} from "../ssverify/ocr/index.js";
import type { OcrProvider } from "../ssverify/ocr/index.js";
import * as repo from "./repo.js";

/**
 * A provider that can be started ahead of time.
 *
 * `warmup()` is on the local provider, not on the interface, because the
 * remote one has nothing to warm up.
 */
interface WarmableProvider {
  warmup?(): Promise<void>;
}

/**
 * The provider, once the decision has been made.
 *
 * `null` means the decision has not been made yet — which is a programming
 * error rather than a state the bot may sit in, because the decision is
 * made at boot.
 */
let provider: OcrProvider | null = null;

/**
 * The decision, once it has been made.
 *
 * Kept as the promise rather than a boolean, so two callers that arrive
 * together wait for the same decision instead of building two providers —
 * and only one of them would ever be shut down.
 */
let decision: Promise<boolean> | null = null;

/**
 * Decides whether the OCR runs, and builds the provider.
 *
 * The decision is made **once**, at boot, and it is:
 *
 *  - **forced on** by `OCR_ENABLED=true` or `OCR_ENABLED=1`, even when no
 *    setup exists;
 *  - **forced off** by `OCR_ENABLED=false` or `OCR_ENABLED=0`, even when a
 *    setup exists;
 *  - **automatic** when `OCR_ENABLED` is unset or says something that is
 *    not understood: the OCR runs when there is at least one
 *    screenshot-verification setup.
 *
 * A value that is not understood is **not a guess** — it counts as unset,
 * so a typo falls back to the automatic decision rather than quietly
 * switching the OCR off.
 *
 * The decision never throws. When the automatic check cannot be made — the
 * database is down at boot — the OCR is switched **off** and the reason is
 * logged: a screenshot that cannot be checked has to be refused, and the
 * bot has no way of knowing whether one was expected.
 *
 * Calling it twice keeps the first decision.
 *
 * @returns whether the OCR runs.
 */
export async function decideOcr(): Promise<boolean> {
  if (!decision) {
    const pending = makeDecision();

    // A decision that failed is not remembered: the next call may try
    // again.
    decision = pending.catch((error: unknown) => {
      decision = null;

      throw error;
    });
  }

  return decision;
}

/**
 * Makes the decision and builds the provider.
 */
async function makeDecision(): Promise<boolean> {
  const enabled = await resolveOcrEnabled();

  provider = createOcrProvider({ enabled });

  logger.info(
    enabled
      ? `[Identity] The OCR is on (${provider.name}).`
      : "[Identity] The OCR is off: no screenshot-verification setup exists, " +
          "or OCR_ENABLED says so. Screenshots will be refused.",
  );

  return enabled;
}

/**
 * The automatic half of the decision.
 *
 * The environment is read first, because it needs no I/O: a deployment that
 * says what it wants does not pay for a database round trip.
 */
async function resolveOcrEnabled(): Promise<boolean> {
  const forced = ocrEnabledFromEnv();

  if (forced !== undefined) return forced;

  try {
    return await repo.hasSsConfig();
  } catch (error) {
    logger.error(
      "[Identity] Could not read the screenshot-verification setups, so the " +
        "OCR is switched off. Screenshots will be refused until the bot " +
        "restarts.",
      error,
    );

    return false;
  }
}

/**
 * The provider.
 *
 * @throws when the boot decision has not been made yet. The provider is
 *         **not** built on first use any more: the decision has to be made
 *         before the first screenshot can be processed, and a provider
 *         built with the wrong setting would be the wrong provider for the
 *         whole run of the bot.
 */
export function getOcrProvider(): OcrProvider {
  if (!provider) {
    throw new Error(
      "the OCR provider has not been decided on yet: warmIdentity() has to " +
        "run before a screenshot can be processed",
    );
  }

  return provider;
}

/**
 * Can a screenshot be verified right now?
 *
 * `false` when the OCR is switched off, and `false` when the decision has
 * not been made yet: there is no OCR to run in either case, so a screenshot
 * must not be accepted.
 */
export function isOcrAvailable(): boolean {
  // A provider that has not been decided on yet is no provider at all, and
  // `isOcrDisabled` counts a missing provider as switched off — which is
  // exactly right here.
  return !isOcrDisabled(provider);
}

/**
 * Starts the provider ahead of time.
 *
 * Worth calling once at boot: the first Tesseract worker downloads the
 * language model, and doing that lazily means the first screenshot of the
 * day waits for the download.
 *
 * The switched-off provider has no `warmup()`, and neither has the remote
 * one, so the guard below skips both.
 *
 * A provider that cannot be started is not fatal — it answers with an
 * empty text. A broken OCR rejects a screenshot for most rule sets, but
 * not for every one of them, which is why the submission is refused
 * outright when the OCR is known to be **off** (see `service.ts`).
 */
export async function warmupOcr(): Promise<void> {
  // Nothing to warm up when the decision has not been made: there is no
  // provider yet, and the decision is what failed.
  if (!provider) return;

  const current = provider;

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
