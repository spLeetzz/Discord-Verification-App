/**
 * The local OCR provider: `tesseract.js` for the text, `sharp` for the
 * hashes.
 *
 * This is the provider the port actually runs. It needs no API key, makes no
 * network call to a third party and works offline once the Tesseract
 * language model is on disk.
 */

import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import Tesseract from "tesseract.js";
import type { Worker } from "tesseract.js";

import { computeHashes } from "./hash.js";
import { SerialQueue } from "./queue.js";
import { normaliseText } from "./text.js";
import type { OcrProvider, OcrResult } from "./index.js";

/**
 * Pulls the text out of an image.
 *
 * The real implementation is Tesseract; the tests inject their own so they
 * never need the language model.
 */
export type TextExtractor = (image: Buffer | string) => Promise<string>;

export interface LocalOcrProviderOptions {
  /** Language handed to Tesseract. Defaults to "eng". */
  lang?: string;
  /**
   * How long to wait for the Tesseract worker before giving up, in
   * milliseconds. The first worker downloads the language model, so this
   * has to cover that download. Defaults to 60 seconds.
   */
  workerTimeoutMs?: number;
  /**
   * How long to wait before trying to create the worker again after a
   * failure, in milliseconds. Without this a broken download would be
   * retried on every single submission. Defaults to 60 seconds.
   */
  workerRetryCooldownMs?: number;
  /**
   * Where the downloaded language model is cached. Defaults to
   * ".cache/tesseract" below the working directory.
   */
  cachePath?: string;
  /**
   * Called when the text extraction fails.
   *
   * The provider then answers with empty text. That is deliberately
   * fail-closed: every rule that checks the text rejects a screenshot whose
   * text is empty, so a broken OCR rejects a screenshot instead of waving it
   * through. The `any_ss` type has no rules at all, so a caller that wants
   * to be certain refuses the screenshot itself — see `isOcrDisabled()` in
   * `disabled.ts`.
   */
  onError?: (error: Error) => void;
  /** Replaces Tesseract. Used by the tests. */
  extractText?: TextExtractor;
}

const DEFAULT_LANG = "eng";
const DEFAULT_WORKER_TIMEOUT_MS = 60_000;
const DEFAULT_WORKER_RETRY_COOLDOWN_MS = 60_000;
const DEFAULT_CACHE_PATH = resolve(".cache", "tesseract");

export class LocalOcrProvider implements OcrProvider {
  readonly name = "local";

  private readonly lang: string;
  private readonly workerTimeoutMs: number;
  private readonly workerRetryCooldownMs: number;
  private readonly cachePath: string;
  private readonly onError: ((error: Error) => void) | undefined;
  private readonly injectedExtractor: TextExtractor | undefined;

  private readonly queue = new SerialQueue();

  private worker: Worker | null = null;
  private workerPromise: Promise<Worker | null> | null = null;
  private retryAfter = 0;
  private disposed = false;

  constructor(options: LocalOcrProviderOptions = {}) {
    this.lang = options.lang ?? DEFAULT_LANG;
    this.workerTimeoutMs = options.workerTimeoutMs ?? DEFAULT_WORKER_TIMEOUT_MS;
    this.workerRetryCooldownMs =
      options.workerRetryCooldownMs ?? DEFAULT_WORKER_RETRY_COOLDOWN_MS;
    this.cachePath = options.cachePath ?? DEFAULT_CACHE_PATH;
    this.onError = options.onError;
    this.injectedExtractor = options.extractText;
  }

  /**
   * Extracts the text and both hashes of one image.
   *
   * The calls are serialised per provider: Quotient held one lock around its
   * OCR call, and a single Tesseract worker can only recognise one image at
   * a time anyway.
   */
  async analyze(image: Buffer | string): Promise<OcrResult> {
    return this.queue.run(async () => {
      const { dhash, phash } = await computeHashes(image);
      const rawText = await this.extractText(image);

      return {
        text: normaliseText(rawText),
        dhash,
        phash,
        rawText,
      };
    });
  }

  /**
   * Terminates the Tesseract worker, if one was ever started.
   */
  async shutdown(): Promise<void> {
    this.disposed = true;

    const worker = this.worker;
    this.worker = null;
    this.workerPromise = null;

    if (worker) {
      await worker.terminate();
    }
  }

  /**
   * Starts the Tesseract worker if it is not running yet.
   *
   * Worth calling once at boot: the first worker downloads the language
   * model, and doing that lazily means the first screenshot of the day waits
   * for the download.
   */
  async warmup(): Promise<void> {
    await this.getWorker();
  }

  private async extractText(image: Buffer | string): Promise<string> {
    try {
      if (this.injectedExtractor) {
        return await this.injectedExtractor(image);
      }

      const worker = await this.getWorker();

      if (!worker) {
        return "";
      }

      const { data } = await worker.recognize(image);
      return data.text;
    } catch (error) {
      this.reportError(error);
      return "";
    }
  }

  private getWorker(): Promise<Worker | null> {
    if (this.workerPromise) {
      return this.workerPromise;
    }

    if (Date.now() < this.retryAfter) {
      return Promise.resolve(null);
    }

    this.workerPromise = this.createWorker().catch((error: unknown) => {
      this.workerPromise = null;
      this.retryAfter = Date.now() + this.workerRetryCooldownMs;
      this.reportError(error);
      return null;
    });

    return this.workerPromise;
  }

  private async createWorker(): Promise<Worker> {
    await mkdir(this.cachePath, { recursive: true });

    const creation = Tesseract.createWorker(this.lang, Tesseract.OEM.LSTM_ONLY, {
      cachePath: this.cachePath,
      // Without an error handler Tesseract throws inside its message
      // callback, which takes the whole process down.
      errorHandler: (error: unknown) => {
        this.reportError(error);
      },
    });

    // The worker promise can reject long after we stopped caring about it.
    creation.catch(() => undefined);

    let worker: Worker;

    try {
      worker = await withTimeout(
        creation,
        this.workerTimeoutMs,
        `Tesseract did not start within ${this.workerTimeoutMs}ms. The language model could not be downloaded.`,
      );
    } catch (error) {
      // The worker may still turn up after the timeout. Terminate it rather
      // than leaving it running unused.
      void creation
        .then((late) => late.terminate())
        .catch(() => undefined);
      throw error;
    }

    if (this.disposed) {
      await worker.terminate();
      throw new Error("The local OCR provider was shut down while starting.");
    }

    this.worker = worker;
    return worker;
  }

  private reportError(error: unknown): void {
    const normalised =
      error instanceof Error ? error : new Error(String(error));

    if (this.onError) {
      this.onError(normalised);
      return;
    }

    console.warn(`[ocr] local OCR failed: ${normalised.message}`);
  }
}

/**
 * Rejects when `promise` takes longer than `ms` to settle.
 */
async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  message: string,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;

  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });

  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}
