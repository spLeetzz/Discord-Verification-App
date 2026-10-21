/**
 * The look of the screenshot-verification panels.
 *
 * The panel is a *message*, so what it looks like is a contract of its
 * own: a moderator reads the embed to see what is set, and reads the
 * buttons to see what they can do. The rules the shared design language
 * (`core/ui.ts`) sets out are therefore worth a test, because nothing
 * else would notice them being broken:
 *
 *  - **Five action rows.** Discord gives a message five of them and a
 *    select menu has one to itself, so the four pickers take four and
 *    the buttons share the last.
 *  - **One coloured button per panel.** Green creates, red destroys,
 *    and everything else is grey.
 *  - **A footer on every panel.** The description says what the panel
 *    is; the footer says what to do next.
 *  - **A value that is not set reads as not set.**
 *
 * The other half of the panel — which id a button carries and which
 * handler answers it — is covered by `ssmod.test.ts`.
 */

import { describe, expect, it, vi } from "vitest";
import { ButtonStyle } from "discord.js";
import type { EmbedBuilder } from "discord.js";
import type { SsConfig } from "../types.js";

const mocks = vi.hoisted(() => ({
  service: {
    assertSsConfigAllowance: vi.fn(),
    assertScreenshotTypeAllowed: vi.fn(),
    assertSuccessMessageAllowed: vi.fn(),
    createSsConfig: vi.fn(),
    deleteSsConfig: vi.fn(),
    findSsConfig: vi.fn(),
    listSsConfigs: vi.fn(),
    updateSsConfig: vi.fn(),
  },
}));

vi.mock("../service.js", () => mocks.service);

const ssmod = await import("./ssmod.js");

/* ------------------------------------------------------------------ *
 * The fixtures
 * ------------------------------------------------------------------ */

/** A setup, as the panel shows it. */
const SETUP: SsConfig = {
  id: "config-1",
  guildId: "guild-1",
  channelId: "channel-1",
  roleId: "role-1",
  requiredSs: 2,
  channelName: "Team Phoenix",
  channelLink: "https://example.com/team-phoenix",
  keywords: ["Team Phoenix"],
  duplicateThreshold: 7,
  allowSame: false,
  ssType: "youtube",
  successMessage: null,
};

/* ------------------------------------------------------------------ *
 * The rendered panel
 * ------------------------------------------------------------------ */

/** A component, as Discord's payload carries it. */
interface Rendered {
  readonly type: number;
  readonly custom_id?: string;
  readonly style?: number;
  readonly label?: string;
  readonly disabled?: boolean;
  readonly placeholder?: string;
  readonly required?: boolean;
  readonly title?: string;
  readonly components?: readonly Rendered[];
}

/** A panel, as this file reads it. */
interface Panel {
  readonly embeds: readonly EmbedBuilder[];
  readonly components: readonly { toJSON(): unknown }[];
}

/** The rows of a panel. */
function rowsOf(panel: Panel): Rendered[] {
  return panel.components.map((row) => row.toJSON() as Rendered);
}

/** The buttons of a panel, in the order they are shown. */
function buttonsOf(panel: Panel): Rendered[] {
  return rowsOf(panel).flatMap((row) => row.components ?? []);
}

/** The embed of a panel, as Discord's payload carries it. */
function embedOf(panel: Panel): {
  readonly title?: string;
  readonly description?: string;
  readonly fields?: readonly { name: string; value: string }[];
  readonly footer?: { readonly text: string };
} {
  const embed = panel.embeds[0];

  if (!embed) throw new Error("the panel has no embed");

  return embed.toJSON() as unknown as {
    readonly title?: string;
    readonly description?: string;
    readonly fields?: readonly { name: string; value: string }[];
    readonly footer?: { readonly text: string };
  };
}

/** The value of a field of a panel's embed. */
function fieldOf(panel: Panel, name: string): string {
  const field = embedOf(panel).fields?.find((entry) => entry.name === name);

  if (!field) throw new Error(`the panel has no field called "${name}"`);

  return field.value;
}

/** The wizard's panel, with the draft the tests use. */
function wizardPanel(draft?: Partial<ReturnType<typeof ssmod.emptySsDraft>>) {
  return ssmod.buildSsPanel({
    kind: "setup",
    token: "token-1",
    draft: { ...ssmod.emptySsDraft(), ...draft },
  });
}

/** The editor's panel. */
function editorPanel(): Panel {
  return ssmod.buildSsPanel({
    kind: "edit",
    configId: SETUP.id,
    config: SETUP,
  });
}

/* ------------------------------------------------------------------ *
 * The rows
 * ------------------------------------------------------------------ */

describe("the panel's rows", () => {
  it("fits every panel in Discord's five action rows", () => {
    const panels: Panel[] = [
      ssmod.buildSsListPanel([]),
      ssmod.buildSsListPanel([SETUP]),
      wizardPanel(),
      editorPanel(),
    ];

    for (const panel of panels) {
      expect(rowsOf(panel).length).toBeLessThanOrEqual(5);
    }
  });

  it("keeps every row within Discord's five buttons", () => {
    for (const row of rowsOf(wizardPanel())) {
      expect(row.components?.length ?? 0).toBeLessThanOrEqual(5);
    }
  });
});

/* ------------------------------------------------------------------ *
 * The colours
 * ------------------------------------------------------------------ */

describe("the panel's colours", () => {
  it("gives the list panel one green button and nothing else coloured", () => {
    const buttons = buttonsOf(ssmod.buildSsListPanel([SETUP]));

    expect(
      buttons.filter((button) => button.style === ButtonStyle.Success),
    ).toHaveLength(1);

    expect(
      buttons.filter((button) => button.style === ButtonStyle.Danger),
    ).toHaveLength(0);
  });

  it("gives the wizard one green button — the save — and nothing else coloured", () => {
    const buttons = buttonsOf(wizardPanel());

    expect(
      buttons.filter((button) => button.style === ButtonStyle.Success),
    ).toHaveLength(1);

    expect(
      buttons.filter((button) => button.style === ButtonStyle.Danger),
    ).toHaveLength(0);
  });

  it("gives the editor one red button — the delete — and nothing else coloured", () => {
    const buttons = buttonsOf(editorPanel());

    expect(
      buttons.filter((button) => button.style === ButtonStyle.Danger),
    ).toHaveLength(1);

    expect(
      buttons.filter((button) => button.style === ButtonStyle.Success),
    ).toHaveLength(0);
  });

  it("keeps the navigation grey", () => {
    for (const button of buttonsOf(wizardPanel())) {
      if (button.label === "Cancel") {
        expect(button.style).toBe(ButtonStyle.Secondary);
      }
    }

    for (const button of buttonsOf(editorPanel())) {
      if (button.label === "Close") {
        expect(button.style).toBe(ButtonStyle.Secondary);
      }
    }
  });

  it("does not write an emoji into a label", () => {
    const panels: Panel[] = [
      ssmod.buildSsListPanel([SETUP]),
      wizardPanel(),
      editorPanel(),
    ];

    for (const panel of panels) {
      for (const button of buttonsOf(panel)) {
        expect(button.label ?? "").not.toMatch(/\p{Extended_Pictographic}/u);
      }
    }
  });
});

/* ------------------------------------------------------------------ *
 * The labels
 * ------------------------------------------------------------------ */

describe("the panel's labels", () => {
  it("names the actions on the list panel", () => {
    const labels = buttonsOf(ssmod.buildSsListPanel([SETUP])).map(
      (button) => button.label,
    );

    expect(labels).toContain("Create setup");
    expect(labels).toContain("Edit YouTube");
    expect(labels).toContain("FAQ");
  });

  it("names the actions on the wizard", () => {
    const labels = buttonsOf(wizardPanel()).map((button) => button.label);

    expect(labels).toContain("Save setup");
    expect(labels).toContain("Edit page details");
    expect(labels).toContain("Allow same screenshot");
    expect(labels).toContain("Edit success message");
    expect(labels).toContain("Cancel");
  });

  it("names the actions on the editor", () => {
    const labels = buttonsOf(editorPanel()).map((button) => button.label);

    expect(labels).toContain("Edit page details");
    expect(labels).toContain("Allow same screenshot");
    expect(labels).toContain("Edit success message");
    expect(labels).toContain("Delete setup");
    expect(labels).toContain("Close");
  });

  it("keeps the save button out of the way until the draft is finished", () => {
    const save = buttonsOf(wizardPanel()).find(
      (button) => button.label === "Save setup",
    );

    expect(save?.disabled).toBe(true);

    const ready = buttonsOf(
      wizardPanel({
        channelId: "channel-1",
        roleId: "role-1",
        ssType: "youtube",
        channelName: "Team Phoenix",
      }),
    ).find((button) => button.label === "Save setup");

    expect(ready?.disabled).toBe(false);
  });
});

/* ------------------------------------------------------------------ *
 * The embed
 * ------------------------------------------------------------------ */

describe("the panel's embed", () => {
  it("gives every panel a footer that says what to do next", () => {
    const panels: Panel[] = [
      ssmod.buildSsListPanel([]),
      ssmod.buildSsListPanel([SETUP]),
      wizardPanel(),
      editorPanel(),
    ];

    for (const panel of panels) {
      const footer = embedOf(panel).footer?.text;

      expect(footer).toBeTruthy();
      expect(footer?.length).toBeGreaterThan(0);
    }
  });

  it("makes a value that is not set read as not set", () => {
    const panel = wizardPanel();

    expect(fieldOf(panel, "Channel")).toBe("_Not set_");
    expect(fieldOf(panel, "Role")).toBe("_Not set_");
    expect(fieldOf(panel, "Screenshot type")).toBe("_Not set_");
    expect(fieldOf(panel, "Page name")).toBe("_Not set_");
    expect(fieldOf(panel, "Page link")).toBe("_Not set_");
    expect(fieldOf(panel, "Keywords")).toBe("_Not set_");
    expect(fieldOf(panel, "Success message")).toBe("_Not set_");
  });

  it("shows a value that is set as it is", () => {
    const panel = editorPanel();

    expect(fieldOf(panel, "Channel")).toBe("<#channel-1>");
    expect(fieldOf(panel, "Role")).toBe("<@&role-1>");
    expect(fieldOf(panel, "Required screenshots")).toBe("`2`");
    expect(fieldOf(panel, "Screenshot type")).toBe("`YouTube`");
    expect(fieldOf(panel, "Keywords")).toBe("`Team Phoenix`");
    expect(fieldOf(panel, "Duplicate threshold")).toBe("`7`");
  });

  it("shows the threshold a setup falls back to when it has none", () => {
    const panel = ssmod.buildSsPanel({
      kind: "edit",
      configId: SETUP.id,
      config: { ...SETUP, duplicateThreshold: null },
    });

    expect(fieldOf(panel, "Duplicate threshold")).toBe("`7` (default)");
  });

  it("names what the wizard is still missing", () => {
    const footer = embedOf(wizardPanel()).footer?.text;

    expect(footer).toContain("channel");
    expect(footer).toContain("role");
    expect(footer).toContain("type");
    expect(footer).toContain("page name");
  });

  it("says what to do once everything is set", () => {
    const footer = embedOf(
      wizardPanel({
        channelId: "channel-1",
        roleId: "role-1",
        ssType: "youtube",
        channelName: "Team Phoenix",
      }),
    ).footer?.text;

    expect(footer).toContain("Save setup");
    expect(footer).not.toContain("Still to set");
  });

  it("says what to do in the empty state", () => {
    const panel = ssmod.buildSsListPanel([]);

    expect(embedOf(panel).description).toContain("Create setup");
    expect(buttonsOf(panel)).toHaveLength(2);
  });
});

/* ------------------------------------------------------------------ *
 * The modals
 * ------------------------------------------------------------------ */

describe("the modals", () => {
  /** One field of a modal, as Discord's payload carries it. */
  interface ModalInput {
    readonly custom_id?: string;
    readonly label?: string;
    readonly placeholder?: string;
    readonly required?: boolean;
  }

  /** The fields of a modal, as Discord's payload carries them. */
  function inputsOf(modal: {
    readonly components?: readonly unknown[];
  }): ModalInput[] {
    const inputs: ModalInput[] = [];

    for (const component of modal.components ?? []) {
      const row = component as { readonly components?: readonly ModalInput[] };

      for (const input of row.components ?? []) inputs.push(input);
    }

    return inputs;
  }

  it("names the action in the title", () => {
    const details = ssmod
      .buildPageDetailsModal("edit", "config-1", {
        channelName: "Team Phoenix",
        channelLink: "",
      })
      .toJSON();

    const message = ssmod
      .buildSuccessMessageModal("wizard", "token-1", null)
      .toJSON();

    expect(details.title).toBe("Edit page details");
    expect(message.title).toBe("Edit success message");
  });

  it("gives every field a label, an example and a required flag", () => {
    const modal = ssmod
      .buildPageDetailsModal("edit", "config-1", {
        channelName: "Team Phoenix",
        channelLink: "",
      })
      .toJSON();

    const inputs = inputsOf(modal);

    expect(inputs).toHaveLength(2);

    for (const input of inputs) {
      expect(input.label).toBeTruthy();
      expect(input.placeholder).toBeTruthy();
      expect(typeof input.required).toBe("boolean");
    }

    // The name is what the setup cannot do without; the link is not.
    expect(inputs[0]?.required).toBe(true);
    expect(inputs[1]?.required).toBe(false);
  });

  it("keeps the field ids the handler reads", () => {
    const details = ssmod
      .buildPageDetailsModal("edit", "config-1", {
        channelName: "Team Phoenix",
        channelLink: "",
      })
      .toJSON();

    const message = ssmod
      .buildSuccessMessageModal("wizard", "token-1", null)
      .toJSON();

    expect(inputsOf(details).map((input) => input.custom_id)).toEqual([
      "name",
      "link",
    ]);

    expect(inputsOf(message).map((input) => input.custom_id)).toEqual([
      "message",
    ]);
  });
});
