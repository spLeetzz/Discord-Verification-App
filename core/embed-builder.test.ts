/**
 * The embed designer, and the owner of the draft.
 *
 * The select that drives the designer carries the draft's token, and the
 * token is in the message — so the message is in a channel other people
 * can read, and the token is not a secret. The draft remembers who
 * started it, and that is what stops somebody else from driving it.
 *
 * The designer is wired by core: the `embeds` prefix is registered with
 * the router, and the flow tests drive it through the router, the way a
 * real press arrives.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { logger } from "../utils/logger.js";
import {
  EmbedDesigner,
  registerEmbedDesignerInteractions,
} from "./embed-builder.js";
import type { EmbedTemplate } from "./embed-builder.js";
import {
  fakeButton,
  fakeInteraction,
  fakeModal,
  fakeSelect,
} from "./interaction.fake.js";
import { clearRegistry, dispatch, registeredPrefixes } from "./router.js";

/** A draft that is never touched. */
function designer(): EmbedDesigner {
  return new EmbedDesigner();
}

/**
 * A designer the router answers for.
 *
 * The registration is idempotent, so registering a second designer under
 * the same prefix is not a duplicate: the router's handlers stay, and
 * the newest designer answers.
 */
function registeredDesigner(): EmbedDesigner {
  const embeds = designer();

  registerEmbedDesignerInteractions(embeds);

  return embeds;
}

/**
 * The title of the embed a panel was re-rendered with.
 */
function panelTitle(payload: unknown): string | undefined {
  const embeds =
    (
      payload as {
        embeds?: readonly { toJSON: () => { title?: string } }[];
      }
    ).embeds ?? [];

  return embeds[0]?.toJSON().title;
}

/**
 * The custom ids of the components a panel carries.
 */
function panelCustomIds(payload: unknown): string[] {
  const rows =
    (
      payload as {
        components?: readonly {
          toJSON: () => { components?: readonly { custom_id?: string }[] };
        }[];
      }
    ).components ?? [];

  const ids: string[] = [];

  for (const row of rows) {
    for (const component of row.toJSON().components ?? []) {
      if (component.custom_id) ids.push(component.custom_id);
    }
  }

  return ids;
}

beforeEach(() => {
  // The registry is emptied so the designer's registration is the only
  // one under test, and the designer is registered again.
  clearRegistry();
  registerEmbedDesignerInteractions(designer());
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the draft's owner", () => {
  it("knows who started the draft", () => {
    const embeds = designer();
    const token = embeds.start({ title: "Rules" }, "owner-1");

    expect(embeds.ownerOf(token)).toBe("owner-1");
    expect(embeds.isOwner(token, "owner-1")).toBe(true);
    expect(embeds.isOwner(token, "someone-else")).toBe(false);
  });

  it("knows nobody owns a token the store has forgotten", () => {
    const embeds = designer();

    // A token that was never issued — or one whose draft has expired —
    // is nobody's draft.
    expect(embeds.ownerOf("not-a-token")).toBeUndefined();
    expect(embeds.isOwner("not-a-token", "owner-1")).toBe(false);
  });

  it("keeps the owner when the draft is edited", () => {
    const embeds = designer();
    const token = embeds.start({ title: "Rules" }, "owner-1");

    const next = embeds.apply("main", token, {
      title: "House rules",
      description: "Be nice.",
    });

    expect(next?.title).toBe("House rules");
    expect(embeds.ownerOf(token)).toBe("owner-1");
    expect(embeds.read(token)?.description).toBe("Be nice.");
  });
});

describe("the owner's check", () => {
  it("lets the owner through", async () => {
    const embeds = designer();
    const token = embeds.start({ title: "Rules" }, "owner-1");
    const { interaction, reply } = fakeInteraction({ userId: "owner-1" });

    const allowed = await embeds.guardOwner(interaction, token);

    expect(allowed).toBe(true);
    expect(reply).not.toHaveBeenCalled();
  });

  it("refuses a member who does not own the draft", async () => {
    // The case the check exists for: the token is in the message, so
    // anybody in the channel can press the select that carries it.
    const embeds = designer();
    const token = embeds.start({ title: "Rules" }, "owner-1");
    const { interaction, reply } = fakeInteraction({
      userId: "someone-else",
    });

    const allowed = await embeds.guardOwner(interaction, token);

    expect(allowed).toBe(false);
    expect(reply).toHaveBeenCalledTimes(1);
  });

  it("refuses a draft that is gone", async () => {
    const embeds = designer();
    const { interaction, reply } = fakeInteraction({ userId: "owner-1" });

    const allowed = await embeds.guardOwner(interaction, "not-a-token");

    expect(allowed).toBe(false);
    expect(reply).toHaveBeenCalledTimes(1);
  });
});

describe("the designer's custom ids", () => {
  it("carries the draft's token in the select's custom id", () => {
    // The area has to be able to tell which draft a press is for, or it
    // cannot ask who owns it.
    const embeds = designer();
    const token = embeds.start({ title: "Rules" }, "owner-1");

    const customId = embeds.buildOptions(token).toJSON().custom_id;

    expect(customId).toContain(token);
  });

  it("carries the draft's token in the modal's custom id", () => {
    const embeds = designer();
    const token = embeds.start({ title: "Rules" }, "owner-1");

    const customId = embeds.buildModal("main", token).toJSON().custom_id;

    expect(customId).toContain(token);
  });
});

describe("the designer's registration", () => {
  it("registers the embeds prefix for the three kinds of component", () => {
    const registered = registeredPrefixes();

    expect(registered.selects).toContain("embeds");
    expect(registered.modals).toContain("embeds");
    expect(registered.buttons).toContain("embeds");
  });

  it("does not warn when it is registered again", () => {
    // A registration that fires twice is a duplicate, and the router
    // warns about duplicates. A warning on a normal path is a warning
    // nobody reads.
    const warnings: string[] = [];

    vi.spyOn(logger, "warn").mockImplementation((...args: unknown[]) => {
      warnings.push(args.map((arg) => String(arg)).join(" "));
    });

    const embeds = designer();

    registerEmbedDesignerInteractions(embeds);
    registerEmbedDesignerInteractions(embeds);

    expect(warnings).toEqual([]);
  });
});

describe("the designer's select", () => {
  it("opens the modal for the target that was chosen", async () => {
    const embeds = registeredDesigner();
    const token = embeds.start({ title: "Rules" }, "owner-1");

    const select = fakeSelect({
      customId: `embeds:options:${token}`,
      values: ["main"],
      userId: "owner-1",
    });

    await dispatch(select.interaction);

    expect(select.showModal).toHaveBeenCalledTimes(1);

    const modal = select.showModal.mock.calls[0]?.[0];

    expect(modal?.toJSON().custom_id).toBe(`embeds:main:${token}`);
  });

  it("refuses a member who does not own the draft", async () => {
    const embeds = registeredDesigner();
    const token = embeds.start({ title: "Rules" }, "owner-1");

    const select = fakeSelect({
      customId: `embeds:options:${token}`,
      values: ["main"],
      userId: "someone-else",
    });

    await dispatch(select.interaction);

    expect(select.showModal).not.toHaveBeenCalled();
    expect(select.reply).toHaveBeenCalledTimes(1);
  });

  it("refuses an option that is not one of the five targets", async () => {
    const embeds = registeredDesigner();
    const token = embeds.start({ title: "Rules" }, "owner-1");

    const select = fakeSelect({
      customId: `embeds:options:${token}`,
      values: ["nonsense"],
      userId: "owner-1",
    });

    await dispatch(select.interaction);

    expect(select.showModal).not.toHaveBeenCalled();
    expect(select.reply).toHaveBeenCalledTimes(1);
  });
});

describe("the designer's modal", () => {
  it("applies the change to the draft", async () => {
    const embeds = registeredDesigner();
    const token = embeds.start({ title: "Rules" }, "owner-1");

    const modal = fakeModal({
      customId: `embeds:main:${token}`,
      fields: { title: "House rules", description: "Be nice." },
      userId: "owner-1",
    });

    await dispatch(modal.interaction);

    expect(embeds.read(token)?.title).toBe("House rules");
    expect(embeds.read(token)?.description).toBe("Be nice.");
  });

  it("re-renders the panel with the edited template", async () => {
    const embeds = registeredDesigner();
    const { interaction, sent } = fakeInteraction({ userId: "owner-1" });

    const token = await embeds.open(interaction, {
      template: { title: "Rules" },
      ownerId: "owner-1",
      onSave: () => undefined,
    });

    const handle = sent[0]?.handle;

    const modal = fakeModal({
      customId: `embeds:main:${token}`,
      fields: { title: "House rules" },
      userId: "owner-1",
    });

    await dispatch(modal.interaction);

    // The acknowledgement comes first: Discord gives a modal submit
    // three seconds.
    expect(modal.deferUpdate).toHaveBeenCalledTimes(1);

    // The edit lands on the message that carries the panel.
    expect(handle?.edit).toHaveBeenCalledTimes(1);

    const payload = handle?.edit.mock.calls[0]?.[0];

    expect(panelTitle(payload)).toBe("House rules");
  });

  it("keeps the panel's components when it re-renders", async () => {
    const embeds = registeredDesigner();
    const { interaction, sent } = fakeInteraction({ userId: "owner-1" });

    const token = await embeds.open(interaction, {
      template: { title: "Rules" },
      ownerId: "owner-1",
      onSave: () => undefined,
    });

    const modal = fakeModal({
      customId: `embeds:main:${token}`,
      fields: { title: "House rules" },
      userId: "owner-1",
    });

    await dispatch(modal.interaction);

    const payload = sent[0]?.handle.edit.mock.calls[0]?.[0];

    expect(panelCustomIds(payload)).toEqual([
      `embeds:options:${token}`,
      `embeds:save:${token}`,
    ]);
  });

  it("resolves the deferral the dispatcher leaves behind", async () => {
    // The dispatcher defers every modal submit with an ephemeral reply
    // before it hands the interaction to the router. That placeholder
    // has to be resolved, or the member is left looking at a spinner.
    const embeds = registeredDesigner();
    const { interaction, sent } = fakeInteraction({ userId: "owner-1" });

    const token = await embeds.open(interaction, {
      template: { title: "Rules" },
      ownerId: "owner-1",
      onSave: () => undefined,
    });

    const modal = fakeModal({
      customId: `embeds:main:${token}`,
      fields: { title: "House rules" },
      userId: "owner-1",
      deferred: true,
    });

    await dispatch(modal.interaction);

    expect(modal.editReply).toHaveBeenCalledTimes(1);
    expect(modal.deferUpdate).not.toHaveBeenCalled();

    // The panel is re-rendered either way.
    expect(sent[0]?.handle.edit).toHaveBeenCalledTimes(1);
  });
});

describe("the designer's save button", () => {
  it("hands the design to the area", async () => {
    const embeds = registeredDesigner();
    const saved: EmbedTemplate[] = [];

    const token = embeds.start({ title: "Rules" }, "owner-1", (template) => {
      saved.push(template);
    });

    const button = fakeButton({
      customId: `embeds:save:${token}`,
      userId: "owner-1",
    });

    await dispatch(button.interaction);

    expect(saved).toHaveLength(1);
    expect(saved[0]?.title).toBe("Rules");
  });

  it("refuses a member who does not own the draft", async () => {
    const embeds = registeredDesigner();
    const saved: EmbedTemplate[] = [];

    const token = embeds.start({ title: "Rules" }, "owner-1", (template) => {
      saved.push(template);
    });

    const button = fakeButton({
      customId: `embeds:save:${token}`,
      userId: "someone-else",
    });

    await dispatch(button.interaction);

    expect(saved).toEqual([]);
    expect(button.reply).toHaveBeenCalledTimes(1);
  });
});

describe("a draft that is gone", () => {
  it("answers the select without throwing", async () => {
    registeredDesigner();

    const select = fakeSelect({
      customId: "embeds:options:not-a-token",
      values: ["main"],
      userId: "owner-1",
    });

    await expect(dispatch(select.interaction)).resolves.toBe(true);

    expect(select.showModal).not.toHaveBeenCalled();
    expect(select.reply).toHaveBeenCalledTimes(1);
  });

  it("answers the modal without throwing", async () => {
    registeredDesigner();

    const modal = fakeModal({
      customId: "embeds:main:not-a-token",
      fields: { title: "House rules" },
      userId: "owner-1",
    });

    await expect(dispatch(modal.interaction)).resolves.toBe(true);

    expect(modal.reply).toHaveBeenCalledTimes(1);
  });

  it("answers the save button without throwing", async () => {
    registeredDesigner();

    const button = fakeButton({
      customId: "embeds:save:not-a-token",
      userId: "owner-1",
    });

    await expect(dispatch(button.interaction)).resolves.toBe(true);

    expect(button.reply).toHaveBeenCalledTimes(1);
  });
});

describe("the designer's panel", () => {
  it("shows the embed being edited, the select, and the save button", async () => {
    const embeds = registeredDesigner();
    const { interaction, sent } = fakeInteraction({ userId: "owner-1" });

    const token = await embeds.open(interaction, {
      template: { title: "Rules" },
      ownerId: "owner-1",
      onSave: () => undefined,
    });

    const payload = sent[0]?.payload;

    expect(panelTitle(payload)).toBe("Rules");
    expect(panelCustomIds(payload)).toEqual([
      `embeds:options:${token}`,
      `embeds:save:${token}`,
    ]);
  });

  it("has no save button when there is nothing to save", async () => {
    const embeds = registeredDesigner();

    // A draft made without a save action has no save button on its
    // panel: there would be nothing for the button to do.
    const token = embeds.start({ title: "Rules" }, "owner-1");
    const payload = embeds.buildPanel(token);

    expect(panelCustomIds(payload)).toEqual([`embeds:options:${token}`]);
  });
});
