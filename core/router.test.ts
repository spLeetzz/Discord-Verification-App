/**
 * The router's registration checks.
 *
 * This is where a feature quietly dies. A prefix that another prefix
 * shadows, or a prefix that is registered twice, and the handler behind
 * it never runs — with no error, and often with no log line either. The
 * type system cannot see it and neither can a test of the feature, which
 * is why five features were found by engineers reading wiring they
 * happened to be in.
 *
 * So the router says it out loud, and these tests are what hold it to
 * saying it.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ButtonInteraction, StringSelectMenuInteraction } from "discord.js";
import { logger } from "../utils/logger.js";
import { COLLECTOR_CUSTOM_ID_PREFIX } from "./custom-id.js";
import {
  clearRegistry,
  dispatch,
  registerButton,
  registerModal,
  registerSelect,
} from "./router.js";

/**
 * The error replies the router sent.
 *
 * The router refuses an id it does not own by replying to it, so the
 * reply is the thing the collector must not have. It is mocked at the
 * module boundary because a namespace import cannot be spied on.
 */
const replyErrorMock = vi.hoisted(() => vi.fn(async () => {}));

vi.mock("./context.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./context.js")>();

  return { ...actual, replyError: replyErrorMock };
});

/** The warnings the router wrote. */
const warnings: string[] = [];

/** The errors the router wrote. */
const errors: string[] = [];

/** A handler that does nothing. */
const noop = (): void => {};

/**
 * A button interaction, for the dispatch tests.
 *
 * The router reads the custom id and asks the interaction what it is, so
 * that is all this has to be.
 */
function fakeButton(customId: string): ButtonInteraction {
  return {
    customId,
    isButton: () => true,
    isAnySelectMenu: () => false,
    isModalSubmit: () => false,
  } as unknown as ButtonInteraction;
}

/**
 * A select-menu interaction, for the dispatch tests.
 */
function fakeSelect(customId: string): StringSelectMenuInteraction {
  return {
    customId,
    isButton: () => false,
    isAnySelectMenu: () => true,
    isModalSubmit: () => false,
  } as unknown as StringSelectMenuInteraction;
}

beforeEach(() => {
  warnings.length = 0;
  errors.length = 0;
  clearRegistry();

  vi.spyOn(logger, "warn").mockImplementation((...args: unknown[]) => {
    warnings.push(args.map((arg) => String(arg)).join(" "));
  });

  vi.spyOn(logger, "error").mockImplementation((...args: unknown[]) => {
    errors.push(args.map((arg) => String(arg)).join(" "));
  });

  replyErrorMock.mockClear();
});

afterEach(() => {
  vi.restoreAllMocks();
});


describe("a component a pending collector owns", () => {
  it("is not refused", async () => {
    // The bug: a select menu that is waiting for an answer is owned by
    // the collector, not by a module. The router used to refuse it as an
    // id nobody owned, which acknowledged the interaction out from under
    // the collector and told the user their button had expired.
    const handled = await dispatch(
      fakeSelect(`${COLLECTOR_CUSTOM_ID_PREFIX}:channel-select:abc123`),
    );

    expect(handled).toBe(true);
    expect(errors).toHaveLength(0);
    expect(replyErrorMock).not.toHaveBeenCalled();
  });

  it("is not refused when it is a button", async () => {
    const handled = await dispatch(
      fakeButton(`${COLLECTOR_CUSTOM_ID_PREFIX}:prompt:abc123:confirm`),
    );

    expect(handled).toBe(true);
    expect(errors).toHaveLength(0);
    expect(replyErrorMock).not.toHaveBeenCalled();
  });

  it("still refuses an id that is not a collector's", async () => {
    const handled = await dispatch(fakeSelect("somethingelse"));

    expect(handled).toBe(true);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("No select menu handler registered");
    expect(replyErrorMock).toHaveBeenCalledTimes(1);
  });
});

describe("a prefix that shadows another one", () => {
  it("warns when the earlier prefix owns the new one", () => {
    registerButton("identity:ssmod", noop);
    registerButton("identity:ssmod:setup", noop);

    expect(warnings).toHaveLength(1);

    const warning = warnings[0] ?? "";

    expect(warning).toContain('area "identity"');
    expect(warning).toContain('"identity:ssmod"');
    expect(warning).toContain('"identity:ssmod:setup"');
    expect(warning).toContain("unreachable");
  });

  it("warns when the new prefix would own the earlier one", () => {
    registerButton("identity:ssmod:wizard", noop);
    registerButton("identity:ssmod", noop);

    expect(warnings).toHaveLength(1);

    const warning = warnings[0] ?? "";

    expect(warning).toContain('area "identity"');
    expect(warning).toContain('"identity:ssmod:wizard"');
    expect(warning).toContain('"identity:ssmod"');
    // The warning has to say which one wins, or it is just a complaint.
    expect(warning).toContain("wins");
  });

  it("names the kind of component it is about", () => {
    registerModal("identity:ssmod", noop);
    registerModal("identity:ssmod:setup", noop);

    expect(warnings[0] ?? "").toContain("modal");
  });

  it("says nothing for two prefixes that cannot shadow each other", () => {
    registerButton("identity:ssmod:wizard", noop);
    registerButton("identity:ssmod:setup", noop);

    expect(warnings).toEqual([]);
  });

  it("says nothing across kinds of component", () => {
    // A button prefix and a modal prefix are separate namespaces: the
    // router dispatches each kind on its own list.
    registerButton("identity:ssmod", noop);
    registerModal("identity:ssmod:setup", noop);
    registerSelect("identity:ssmod:setup", noop);

    expect(warnings).toEqual([]);
  });

  it("never reaches the shadowed prefix", async () => {
    const seen: string[] = [];

    registerButton("identity:ssmod", () => {
      seen.push("editor");
    });
    registerButton("identity:ssmod:setup", () => {
      seen.push("setup");
    });

    await dispatch(fakeButton("identity:ssmod:setup:42"));

    // The general prefix was registered first, so it takes the id. The
    // specific handler is the one that never runs.
    expect(seen).toEqual(["editor"]);
  });

  it("keeps the specific prefix when it is registered first", async () => {
    const seen: string[] = [];

    registerButton("identity:ssmod:wizard", () => {
      seen.push("wizard");
    });
    registerButton("identity:ssmod", () => {
      seen.push("editor");
    });

    await dispatch(fakeButton("identity:ssmod:wizard:save:token"));
    await dispatch(fakeButton("identity:ssmod:edit:42"));

    expect(seen).toEqual(["wizard", "editor"]);
  });
});

describe("a duplicate registration", () => {
  it("warns", () => {
    registerButton("tourneys", noop);
    registerButton("tourneys", noop);

    expect(warnings).toHaveLength(1);

    const warning = warnings[0] ?? "";

    expect(warning).toContain('"tourneys"');
    expect(warning).toContain('area "tourneys"');
    expect(warning).toContain("Duplicate");
  });

  it("keeps the last handler, as it always did", async () => {
    const seen: string[] = [];

    registerButton("tourneys", () => {
      seen.push("first");
    });
    registerButton("tourneys", () => {
      seen.push("second");
    });

    await dispatch(fakeButton("tourneys:claim:42"));

    expect(seen).toEqual(["second"]);
  });

  it("keeps the order stable, so a later registration cannot shadow one", async () => {
    const seen: string[] = [];

    registerButton("identity:ssmod:setup", () => {
      seen.push("setup");
    });
    registerButton("identity:ssmod", () => {
      seen.push("editor");
    });
    // A re-registration replaces the handler in place: it does not move to
    // the back of the list, where it would shadow the specific prefix.
    registerButton("identity:ssmod:setup", () => {
      seen.push("setup again");
    });

    await dispatch(fakeButton("identity:ssmod:setup:42"));

    expect(seen).toEqual(["setup again"]);
  });
});
