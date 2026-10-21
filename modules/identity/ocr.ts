/**
 * The OCR provider this area talks to.
 *
 * The provider itself lives in `modules/ssverify/ocr/` and is **not** ours
 * to change. This file only owns the lifecycle:
 *
 *  - **one provider for the whole bot**, so the calls stay serialised per
 *    provider and only one of them is ever shut down;
 *  - **the decision whether the OCR runs at all**, made **once at boot**;
 *  - **`shutdown()` on exit**, so the requests that are on the wire are
 *    aborted and the process can go.
 *
 * ## There is no local engine
 *
 * The provider is a **remote service**. It does the text recognition *and*
 * the hashing, and it fetches the image itself — so the image has to be a
 * publicly reachable URL, not a buffer. There is no Tesseract worker, no
 * language model and no image library behind it, and there is no local
 * fallback: a deployment that configures no service has no OCR at all.
 *
 * That is why the decision below is not the whole story. The provider that
 * comes back is the last word, and the area asks the **provider** whether
 * the OCR runs rather than the flag it passed in — see
 * {@link isOcrAvailable}.
 *
 * ## The decision
 *
 * A deployment that does not use screenshot verification should not pay for
 * OCR, so the provider can be **switched off**: no request, no service, no
 * answer but a refusal. The decision is made here, at boot, and it is made
 * **once**:
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
 * A provider that *fails* — the service is down, it answers with rubbish,
 * it sends a hash nobody can compare — is a screenshot that cannot be
 * verified. It has to be **refused**, and a refusal is a decision rather
 * than an exception: the member gets an answer and nothing is stored. That
 * is what {@link analyzeScreenshot} is for.
 *
 * That is also why the submission is refused when the OCR is known to be
 * off (see `service.ts`): most rule sets refuse an empty text, but **not
 * every one does**. `any_ss` has no rules at all, and a `loco` or `rooter`
 * setup whose channel name is empty has none that look at the text either,
 * so an empty text on its own would be *accepted* there.
 */

import { logger } from "../../utils/logger.js";
import {
  analyzeImage,
  createOcrProvider,
  isOcrDisabled,
  ocrEnabledFromEnv,
} from "../ssverify/ocr/index.js";
import type { OcrAnalysis, OcrProvider } from "../ssverify/ocr/index.js";
import * as repo from "./repo.js";

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
 * @returns whether the OCR **runs** — the effective state of the provider
 *          that was built, not the flag that was passed to it. A provider
 *          that was asked for and got the switched-off one (no service
 *          configured) does not run.
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

  // The provider is the last word. `createOcrProvider({ enabled: true })`
  // still hands back the switched-off provider when no service is
  // configured, so the flag that was passed in is **not** the state the
  // bot runs in. The log line below has to say what is actually true.
  const running = !isOcrDisabled(provider);

  if (running) {
    logger.info(`[Identity] The OCR is on (${provider.name}).`);
  } else {
    logger.info(
      `[Identity] The OCR is off (${provider.name}): ${
        enabled
          ? "no OCR service is configured (OCR_PROVIDER_URL is not set)"
          : "OCR_ENABLED says so, or no screenshot-verification setup exists " +
            "(or the setups could not be read)"
      }. Screenshots will be refused.`,
    );
  }

  return running;
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
 *
 * The question is asked of the **provider**, not of the flag the decision
 * passed in: a deployment that asked for the OCR and configured no service
 * has no OCR.
 */
export function isOcrAvailable(): boolean {
  // A provider that has not been decided on yet is no provider at all, and
  // `isOcrDisabled` counts a missing provider as switched off — which is
  // exactly right here.
  return !isOcrDisabled(provider);
}

/**
 * Analyses one screenshot and answers with a decision, never an exception.
 *
 * The image is a **publicly reachable URL**: the service fetches it
 * itself. A `Buffer` is refused by the remote provider, so a caller that
 * has the picture's bytes has nothing to hand over.
 *
 * A provider that cannot do its job — the service is down, it answered
 * with rubbish, it sent a hash nobody can compare — answers
 * `{ ok: false, reason }`. The caller turns that into a refusal: the
 * member gets an answer, and nothing is stored.
 */
export async function analyzeScreenshot(
  image: Buffer | string,
): Promise<OcrAnalysis> {
  // A provider that is not there is a screenshot that cannot be read, not
  // a crash: the boot decision has not been made (or the bot is on its way
  // out), and the member still gets an answer.
  if (!provider) {
    return {
      ok: false,
      reason:
        "the OCR provider has not been decided on yet: warmIdentity() has " +
        "to run before a screenshot can be processed",
    };
  }

  return analyzeImage(provider, image);
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
  // abort the same requests twice.
  provider = null;

  await current.shutdown?.();
}
