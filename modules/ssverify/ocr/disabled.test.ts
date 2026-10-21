import { describe, expect, it, vi } from "vitest";

import { DisabledOcrProvider, DISABLED_PROVIDER_NAME, isOcrDisabled } from "./index.js";

describe("DisabledOcrProvider", () => {
  it("answers with empty text", async () => {
    const provider = new DisabledOcrProvider();

    const result = await provider.analyze(Buffer.from("not an image"));

    expect(result.text).toBe("");
    expect(result.rawText).toBe("");
  });

  it("reports itself as the disabled provider", () => {
    expect(new DisabledOcrProvider().name).toBe(DISABLED_PROVIDER_NAME);
    expect(DISABLED_PROVIDER_NAME).toBe("disabled");
  });

  it("makes no network call", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchImpl);

    const provider = new DisabledOcrProvider();

    await provider.analyze(Buffer.from("not an image"));

    expect(fetchImpl).not.toHaveBeenCalled();

    vi.unstubAllGlobals();
  });

  it("answers with the hash of nothing", async () => {
    // Nothing was looked at, so there is no hash. The caller is told to
    // refuse the submission instead of storing this.
    const provider = new DisabledOcrProvider();

    const result = await provider.analyze(Buffer.from("not an image"));

    expect(result.dhash).toBe("0000000000000000");
    expect(result.phash).toBe("0000000000000000");
  });

  it("can be shut down without having done anything", async () => {
    const provider = new DisabledOcrProvider();

    await expect(provider.shutdown()).resolves.toBeUndefined();
  });
});

describe("isOcrDisabled", () => {
  it("recognises the switched-off provider", () => {
    expect(isOcrDisabled(new DisabledOcrProvider())).toBe(true);
  });

  it("counts a missing provider as switched off", () => {
    expect(isOcrDisabled(null)).toBe(true);
    expect(isOcrDisabled(undefined)).toBe(true);
  });
});
