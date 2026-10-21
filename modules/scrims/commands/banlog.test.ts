import { describe, expect, it } from "vitest";

import { SCRIM_SUBCOMMANDS, scrimsCommand } from "./index.js";
import { banLogSubcommand } from "./banlog.js";

describe("the banlog subcommand", () => {
  it("is named banlog", () => {
    expect(banLogSubcommand.data.name).toBe("banlog");
  });

  it("takes an optional channel", () => {
    const options = banLogSubcommand.data.toJSON().options ?? [];
    const channel = options.find(
      (option) => "name" in option && option.name === "channel",
    );

    expect(channel).toBeDefined();
    expect(channel && "required" in channel ? channel.required : false).toBe(
      false,
    );
  });

  it("is part of the command group", () => {
    expect(
      SCRIM_SUBCOMMANDS.some((entry) => entry.data.name === "banlog"),
    ).toBe(true);

    const names = scrimsCommand.data
      .toJSON()
      .options?.map((option) => option.name);

    expect(names).toContain("banlog");
  });
});
