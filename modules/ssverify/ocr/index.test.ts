import { describe, expect, it, vi } from "vitest";

import {
  analyzeImage,
  createOcrProvider,
  DisabledOcrProvider,
  HttpOcrProvider,
  isOcrDisabled,
  ocrEnabledFromEnv,
} from "./index.js";

const SERVICE_URL = "https://example.com/ocr";

/**
 * The answer the remote service gives for one image.
 */
function serviceAnswer(): unknown {
  return [
    {
      url: "https://example.com/screenshot.png",
      dhash: "9c63949032868431",
      phash: "c0c0bf3f3bf0f090",
      text: "Some Channel Name\n",
    },
  ];
}

describe("createOcrProvider without a service", () => {
  it("returns the disabled provider", () => {
    // There is no local engine, so a deployment without a service has no
    // OCR at all.
    const provider = createOcrProvider({ enabled: true, env: {} });

    expect(provider).toBeInstanceOf(DisabledOcrProvider);
    expect(provider.name).toBe("disabled");
  });

  it("answers with empty text", async () => {
    const provider = createOcrProvider({ env: {} });

    const result = await provider.analyze(Buffer.from("not an image"));

    expect(result.text).toBe("");
  });

  it("makes no network call", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchImpl);

    const provider = createOcrProvider({ env: {} });

    await provider.analyze(Buffer.from("not an image"));

    expect(fetchImpl).not.toHaveBeenCalled();

    vi.unstubAllGlobals();
  });

  it("is the disabled provider when the switch is not given either", () => {
    const provider = createOcrProvider({ env: {} });

    expect(provider.name).toBe("disabled");
    expect(isOcrDisabled(provider)).toBe(true);
  });

  it("ignores a service url that is only whitespace", () => {
    const provider = createOcrProvider({ env: { OCR_PROVIDER_URL: "   " } });

    expect(provider.name).toBe("disabled");
  });
});

describe("createOcrProvider with a service", () => {
  it("returns the remote provider", () => {
    const provider = createOcrProvider({
      enabled: true,
      env: { OCR_PROVIDER_URL: SERVICE_URL },
    });

    expect(provider).toBeInstanceOf(HttpOcrProvider);
    expect(provider.name).toBe("http");
  });

  it("is the remote provider when the switch is not given", () => {
    const provider = createOcrProvider({
      env: { OCR_PROVIDER_URL: SERVICE_URL },
    });

    expect(provider.name).toBe("http");
  });

  it("posts the image url to the service", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      new Response(JSON.stringify(serviceAnswer()), { status: 200 }),
    );

    const provider = createOcrProvider({
      env: { OCR_PROVIDER_URL: SERVICE_URL },
      remote: { fetchImpl },
    });

    await provider.analyze("https://example.com/screenshot.png");

    expect(fetchImpl).toHaveBeenCalledTimes(1);

    const [url, init] = fetchImpl.mock.calls[0] ?? [];
    expect(url).toBe(SERVICE_URL);
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual([
      { url: "https://example.com/screenshot.png" },
    ]);
  });

  it("sends the api key the environment holds", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      new Response(JSON.stringify(serviceAnswer()), { status: 200 }),
    );

    const provider = createOcrProvider({
      env: { OCR_PROVIDER_URL: SERVICE_URL, OCR_PROVIDER_KEY: "secret" },
      remote: { fetchImpl },
    });

    await provider.analyze("https://example.com/screenshot.png");

    const [, init] = fetchImpl.mock.calls[0] ?? [];
    const headers = init?.headers as Record<string, string> | undefined;

    expect(headers?.["authorization"]).toBe("secret");
  });
});

describe("createOcrProvider with the switch off", () => {
  it("returns the disabled provider", () => {
    const provider = createOcrProvider({ enabled: false, env: {} });

    expect(provider).toBeInstanceOf(DisabledOcrProvider);
    expect(provider.name).toBe("disabled");
  });

  it("makes no network call", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchImpl);

    const provider = createOcrProvider({ enabled: false, env: {} });

    await provider.analyze(Buffer.from("not an image"));

    expect(fetchImpl).not.toHaveBeenCalled();

    vi.unstubAllGlobals();
  });

  it("is the disabled provider even when a service is configured", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchImpl);

    const provider = createOcrProvider({
      enabled: false,
      env: { OCR_PROVIDER_URL: SERVICE_URL },
    });

    expect(provider.name).toBe("disabled");

    await provider.analyze(Buffer.from("not an image"));

    expect(fetchImpl).not.toHaveBeenCalled();

    vi.unstubAllGlobals();
  });
});

describe("analyzeImage", () => {
  it("answers with the result when the provider worked", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      new Response(JSON.stringify(serviceAnswer()), { status: 200 }),
    );

    const provider = createOcrProvider({
      env: { OCR_PROVIDER_URL: SERVICE_URL },
      remote: { fetchImpl },
    });

    const analysis = await analyzeImage(provider, "https://example.com/screenshot.png");

    expect(analysis.ok).toBe(true);

    if (!analysis.ok) return;

    expect(analysis.result.dhash).toBe("9c63949032868431");
    expect(analysis.result.text).toBe("somechannelname");
  });

  it("refuses a hash the service cannot be compared on", async () => {
    // The judgement call: a malformed hash is a hash that cannot verify
    // anything, so the screenshot is refused rather than crashing the
    // submission.
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      new Response(
        JSON.stringify([
          {
            url: "https://example.com/screenshot.png",
            dhash: "not-a-hash",
            phash: "c0c0bf3f3bf0f090",
            text: "Some Channel Name\n",
          },
        ]),
        { status: 200 },
      ),
    );

    const provider = createOcrProvider({
      env: { OCR_PROVIDER_URL: SERVICE_URL },
      remote: { fetchImpl },
    });

    const analysis = await analyzeImage(provider, "https://example.com/screenshot.png");

    expect(analysis.ok).toBe(false);

    if (analysis.ok) return;

    expect(analysis.reason).toMatch(/unusable dhash/);
  });

  it("refuses a service that cannot be reached", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => {
      throw new Error("connection refused");
    });

    const provider = createOcrProvider({
      env: { OCR_PROVIDER_URL: SERVICE_URL },
      remote: { fetchImpl },
    });

    const analysis = await analyzeImage(provider, "https://example.com/screenshot.png");

    expect(analysis.ok).toBe(false);

    if (analysis.ok) return;

    expect(analysis.reason).toMatch(/could not be reached/);
  });

  it("never throws, whatever the provider does", async () => {
    const provider = {
      name: "broken",
      analyze: async () => {
        throw new Error("the service fell over");
      },
    };

    const analysis = await analyzeImage(provider, "https://example.com/screenshot.png");

    expect(analysis.ok).toBe(false);
  });
});

describe("ocrEnabledFromEnv", () => {
  it("forces OCR on for \"true\"", () => {
    expect(ocrEnabledFromEnv({ OCR_ENABLED: "true" })).toBe(true);
  });

  it("forces OCR on for \"1\"", () => {
    expect(ocrEnabledFromEnv({ OCR_ENABLED: "1" })).toBe(true);
  });

  it("forces OCR off for \"false\"", () => {
    expect(ocrEnabledFromEnv({ OCR_ENABLED: "false" })).toBe(false);
  });

  it("forces OCR off for \"0\"", () => {
    expect(ocrEnabledFromEnv({ OCR_ENABLED: "0" })).toBe(false);
  });

  it("leaves the decision to the caller when it is not set", () => {
    expect(ocrEnabledFromEnv({})).toBeUndefined();
  });

  it("does not guess at a value it does not understand", () => {
    expect(ocrEnabledFromEnv({ OCR_ENABLED: "yes" })).toBeUndefined();
    expect(ocrEnabledFromEnv({ OCR_ENABLED: "" })).toBeUndefined();
    expect(ocrEnabledFromEnv({ OCR_ENABLED: "2" })).toBeUndefined();
    expect(ocrEnabledFromEnv({ OCR_ENABLED: "off" })).toBeUndefined();
  });

  it("ignores the case and the spaces around the value", () => {
    expect(ocrEnabledFromEnv({ OCR_ENABLED: " TRUE " })).toBe(true);
    expect(ocrEnabledFromEnv({ OCR_ENABLED: " False " })).toBe(false);
  });

  it("reads the process environment when it is given none", () => {
    const previous = process.env.OCR_ENABLED;

    try {
      process.env.OCR_ENABLED = "false";

      expect(ocrEnabledFromEnv()).toBe(false);
    } finally {
      if (previous === undefined) {
        delete process.env.OCR_ENABLED;
      } else {
        process.env.OCR_ENABLED = previous;
      }
    }
  });
});
