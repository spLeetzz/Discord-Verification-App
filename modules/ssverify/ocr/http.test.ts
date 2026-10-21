import { describe, expect, it, vi } from "vitest";

import { UnusableHashError } from "./hash.js";
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

/**
 * A provider whose service always answers the same way.
 */
function providerAnswering(answer: unknown): HttpOcrProvider {
  const fetchImpl = vi.fn<typeof fetch>(
    async () => new Response(JSON.stringify(answer), { status: 200 }),
  );

  return new HttpOcrProvider({ url: SERVICE_URL, fetchImpl });
}

describe("HttpOcrProvider", () => {
  it("posts the image url to the service", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (_input, _init) =>
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
    const fetchImpl = vi.fn<typeof fetch>(async (_input, _init) =>
      new Response(JSON.stringify(serviceAnswer()), { status: 200 }),
    );

    const provider = new HttpOcrProvider({
      url: SERVICE_URL,
      apiKey: "secret",
      fetchImpl,
    });

    await provider.analyze("https://example.com/screenshot.png");

    const [, init] = fetchImpl.mock.calls[0] ?? [];
    // `RequestInit["headers"]` is a union of `Headers`, a list of pairs and
    // a record, and only the record can be read with a string key. The
    // provider always sends a plain record of header names to values, so the
    // cast names that shape instead of widening the check to `any`.
    const headers = init?.headers as Record<string, string> | undefined;

    expect(headers?.["authorization"]).toBe("secret");
    expect(headers?.["content-type"]).toBe("application/json");
  });

  it("sends no api key when there is none", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (_input, _init) =>
      new Response(JSON.stringify(serviceAnswer()), { status: 200 }),
    );

    const provider = new HttpOcrProvider({ url: SERVICE_URL, fetchImpl });

    await provider.analyze("https://example.com/screenshot.png");

    const [, init] = fetchImpl.mock.calls[0] ?? [];
    // The same cast as above: the provider sends a plain record of headers.
    const headers = init?.headers as Record<string, string> | undefined;

    expect(headers?.["authorization"]).toBeUndefined();
  });

  it("returns the hashes and the normalised text", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
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
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      new Response(JSON.stringify(serviceAnswer()), { status: 200 }),
    );

    const provider = new HttpOcrProvider({ url: SERVICE_URL, fetchImpl });

    await expect(provider.analyze(Buffer.from("not an image"))).rejects.toThrow(
      /publicly reachable image URL/,
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("reports a service that answers with an error", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response("nope", { status: 503 }));

    const provider = new HttpOcrProvider({ url: SERVICE_URL, fetchImpl });

    await expect(provider.analyze("https://example.com/screenshot.png")).rejects.toThrow(
      /HTTP 503/,
    );
  });

  it("reports a service that cannot be reached", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => {
      throw new Error("connection refused");
    });

    const provider = new HttpOcrProvider({ url: SERVICE_URL, fetchImpl });

    await expect(provider.analyze("https://example.com/screenshot.png")).rejects.toThrow(
      /could not be reached/,
    );
  });

  it("refuses an answer that is not an array of results", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      new Response(JSON.stringify({ dhash: "abc" }), { status: 200 }),
    );

    const provider = new HttpOcrProvider({ url: SERVICE_URL, fetchImpl });

    await expect(provider.analyze("https://example.com/screenshot.png")).rejects.toThrow(
      /array of results/,
    );
  });

  it("refuses an answer without a usable hash", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
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

  it("refuses a hash of the wrong length with an error that names the hash", async () => {
    // The judgement call: a service that answers with a hash of a
    // different length must not crash the duplicate check. The provider
    // refuses the result, and the error says which hash was broken.
    const provider = providerAnswering(
      serviceAnswer({ dhash: "9c6394903286843" }),
    );

    await expect(
      provider.analyze("https://example.com/screenshot.png"),
    ).rejects.toThrow(UnusableHashError);

    await expect(
      provider.analyze("https://example.com/screenshot.png"),
    ).rejects.toThrow(/9c6394903286843/);
  });

  it("refuses a hash that is not hex with an error that names the hash", async () => {
    const provider = providerAnswering(
      serviceAnswer({ phash: "zzzzzzzzzzzzzzzz" }),
    );

    await expect(
      provider.analyze("https://example.com/screenshot.png"),
    ).rejects.toThrow(UnusableHashError);

    await expect(
      provider.analyze("https://example.com/screenshot.png"),
    ).rejects.toThrow(/zzzzzzzzzzzzzzzz/);
  });

  it("refuses an answer without text", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      new Response(JSON.stringify(serviceAnswer({ text: 42 })), { status: 200 }),
    );

    const provider = new HttpOcrProvider({ url: SERVICE_URL, fetchImpl });

    await expect(provider.analyze("https://example.com/screenshot.png")).rejects.toThrow(
      /without text/,
    );
  });

  it("brings a hash the service answered in upper case down to lower case", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
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

describe("the lifecycle of the provider", () => {
  it("ends the requests that are on the wire when it is shut down", async () => {
    const fetchImpl = vi.fn<typeof fetch>(
      (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(new Error("aborted"));
          });
        }),
    );

    const provider = new HttpOcrProvider({ url: SERVICE_URL, fetchImpl });

    const pending = provider.analyze("https://example.com/screenshot.png");

    // Let the request reach the wire before the provider is shut down.
    await new Promise((resolve) => setTimeout(resolve, 5));

    await provider.shutdown();

    await expect(pending).rejects.toThrow(/could not be reached/);
  });

  it("refuses to work after it was shut down", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      new Response(JSON.stringify(serviceAnswer()), { status: 200 }),
    );

    const provider = new HttpOcrProvider({ url: SERVICE_URL, fetchImpl });

    await provider.shutdown();

    await expect(
      provider.analyze("https://example.com/screenshot.png"),
    ).rejects.toThrow(/shut down/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
