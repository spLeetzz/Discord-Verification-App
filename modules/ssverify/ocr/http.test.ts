import { describe, expect, it, vi } from "vitest";

import { HttpOcrProvider } from "./http.js";

const SERVICE_URL = "https://example.com/ocr";

/**
 * A stand-in for the remote service.
 */
function serviceAnswer(overrides: Record<string, unknown> = {}): unknown {
  return [
    {
      url: "https://example.com/screenshot.png",
      dhash: "9c63949032868431",
      phash: "c0c0bf3f3bf0f090",
      text: "Some Channel Name\n",
      ...overrides,
    },
  ];
}

describe("HttpOcrProvider", () => {
  it("posts the image url to the service", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify(serviceAnswer()), { status: 200 }),
    );

    const provider = new HttpOcrProvider({ url: SERVICE_URL, fetchImpl });

    await provider.analyze("https://example.com/screenshot.png");

    expect(fetchImpl).toHaveBeenCalledTimes(1);

    const [url, init] = fetchImpl.mock.calls[0] ?? [];
    expect(url).toBe(SERVICE_URL);
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual([
      { url: "https://example.com/screenshot.png" },
    ]);
  });

  it("sends the api key the way the service expects it", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify(serviceAnswer()), { status: 200 }),
    );

    const provider = new HttpOcrProvider({
      url: SERVICE_URL,
      apiKey: "secret",
      fetchImpl,
    });

    await provider.analyze("https://example.com/screenshot.png");

    const [, init] = fetchImpl.mock.calls[0] ?? [];
    const headers = init?.headers as Record<string, string> | undefined;

    expect(headers?.["authorization"]).toBe("secret");
    expect(headers?.["content-type"]).toBe("application/json");
  });

  it("sends no api key when there is none", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify(serviceAnswer()), { status: 200 }),
    );

    const provider = new HttpOcrProvider({ url: SERVICE_URL, fetchImpl });

    await provider.analyze("https://example.com/screenshot.png");

    const [, init] = fetchImpl.mock.calls[0] ?? [];
    const headers = init?.headers as Record<string, string> | undefined;

    expect(headers?.["authorization"]).toBeUndefined();
  });

  it("returns the hashes and the normalised text", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify(serviceAnswer()), { status: 200 }),
    );

    const provider = new HttpOcrProvider({ url: SERVICE_URL, fetchImpl });

    const result = await provider.analyze("https://example.com/screenshot.png");

    expect(result.dhash).toBe("9c63949032868431");
    expect(result.phash).toBe("c0c0bf3f3bf0f090");
    expect(result.text).toBe("somechannelname");
    expect(result.rawText).toBe("Some Channel Name\n");
  });

  it("refuses binary data, because the service fetches the image itself", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify(serviceAnswer()), { status: 200 }),
    );

    const provider = new HttpOcrProvider({ url: SERVICE_URL, fetchImpl });

    await expect(provider.analyze(Buffer.from("not an image"))).rejects.toThrow(
      /publicly reachable image URL/,
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("reports a service that answers with an error", async () => {
    const fetchImpl = vi.fn(async () => new Response("nope", { status: 503 }));

    const provider = new HttpOcrProvider({ url: SERVICE_URL, fetchImpl });

    await expect(provider.analyze("https://example.com/screenshot.png")).rejects.toThrow(
      /HTTP 503/,
    );
  });

  it("reports a service that cannot be reached", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("connection refused");
    });

    const provider = new HttpOcrProvider({ url: SERVICE_URL, fetchImpl });

    await expect(provider.analyze("https://example.com/screenshot.png")).rejects.toThrow(
      /could not be reached/,
    );
  });

  it("refuses an answer that is not an array of results", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ dhash: "abc" }), { status: 200 }),
    );

    const provider = new HttpOcrProvider({ url: SERVICE_URL, fetchImpl });

    await expect(provider.analyze("https://example.com/screenshot.png")).rejects.toThrow(
      /array of results/,
    );
  });

  it("refuses an answer without a usable hash", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(
        JSON.stringify(serviceAnswer({ dhash: "not-a-hash" })),
        { status: 200 },
      ),
    );

    const provider = new HttpOcrProvider({ url: SERVICE_URL, fetchImpl });

    await expect(provider.analyze("https://example.com/screenshot.png")).rejects.toThrow(
      /unusable dhash/,
    );
  });

  it("refuses an answer without text", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify(serviceAnswer({ text: 42 })), { status: 200 }),
    );

    const provider = new HttpOcrProvider({ url: SERVICE_URL, fetchImpl });

    await expect(provider.analyze("https://example.com/screenshot.png")).rejects.toThrow(
      /without text/,
    );
  });

  it("brings a hash the service answered in upper case down to lower case", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(
        JSON.stringify(serviceAnswer({ dhash: "9C63949032868431" })),
        { status: 200 },
      ),
    );

    const provider = new HttpOcrProvider({ url: SERVICE_URL, fetchImpl });

    const result = await provider.analyze("https://example.com/screenshot.png");

    expect(result.dhash).toBe("9c63949032868431");
  });
});
