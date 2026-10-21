/**
 * The command surface.
 *
 * A command that does not serialise is a command that never appears: the
 * loader pushes `data.toJSON()` to Discord, and a builder that throws
 * takes the whole deployment down. These tests serialise the three
 * commands of this area and check that the adapter files under
 * `commands/esports/` are the ones the loader picks up.
 */

import { describe, expect, it } from "vitest";
import { fileURLToPath, pathToFileURL } from "node:url";
import { listCommandFiles, isCommand } from "../../utils/command-files.js";
import {
  easyTagCommand,
  ssVerifyCommand,
  tagCheckCommand,
} from "./commands/index.js";

/** The category folder the esports commands live in. */
const categoryPath = fileURLToPath(
  new URL("../../commands/esports/", import.meta.url),
);

/** The names of the three commands of this area. */
const IDENTITY_COMMANDS = ["tagcheck", "easytag", "ssverify"] as const;

/**
 * The subcommand names of a serialised command.
 */
function subcommandNames(command: {
  toJSON(): {
    options?: readonly { readonly type: number; readonly name: string }[];
  };
}): string[] {
  const json = command.toJSON();

  return (json.options ?? [])
    .filter((option) => option.type === 1)
    .map((option) => option.name);
}

describe("the three commands", () => {
  it("serialise with a name and a description", () => {
    for (const command of [tagCheckCommand, easyTagCommand, ssVerifyCommand]) {
      const json = command.data.toJSON();

      expect(json.name).toBeTruthy();
      expect(json.description).toBeTruthy();
    }
  });

  it("carry the names the guild already knows", () => {
    expect(tagCheckCommand.data.toJSON().name).toBe("tagcheck");
    expect(easyTagCommand.data.toJSON().name).toBe("easytag");
    expect(ssVerifyCommand.data.toJSON().name).toBe("ssverify");
  });

  it("serialise the tag-check subcommands", () => {
    expect(subcommandNames(tagCheckCommand.data)).toEqual([
      "set",
      "config",
      "remove",
      "autodelete",
    ]);
  });

  it("serialise the easy-tag subcommands", () => {
    expect(subcommandNames(easyTagCommand.data)).toEqual([
      "set",
      "remove",
      "config",
      "autodelete",
    ]);
  });

  it("serialise the screenshot-verification command without subcommands", () => {
    expect(subcommandNames(ssVerifyCommand.data)).toEqual([]);
  });

  it("have an execute function", () => {
    for (const command of [tagCheckCommand, easyTagCommand, ssVerifyCommand]) {
      expect(typeof command.execute).toBe("function");
    }
  });
});

describe("the screenshot-verification command", () => {
  it("answers ephemerally", () => {
    // The panel is a moderator's control panel: its buttons delete a
    // server's verification setup, repoint the channel the bot reads and
    // change the role the bot grants. It does not belong in the channel.
    expect(ssVerifyCommand.ephemeral).toBe(true);
  });
});

describe("the adapter files", () => {
  it("are found by the loader", () => {
    const files = listCommandFiles(categoryPath);

    for (const name of IDENTITY_COMMANDS) {
      const found = files.some((file) =>
        file.endsWith(`${name}.ts`) || file.endsWith(`${name}.js`),
      );

      expect(found, `commands/esports/ is missing an adapter for ${name}`).toBe(
        true,
      );
    }
  });

  it("register a command each", async () => {
    // The loader reads one command out of every file: the default export.
    // A file with three commands in it would register one of them and
    // lose the other two, which is why the area has one file per command.
    const files = listCommandFiles(categoryPath);

    const registered = new Map<string, string>();

    for (const file of files) {
      const module = (await import(pathToFileURL(file).href)) as {
        default?: unknown;
      };

      if (!isCommand(module.default)) continue;

      const name = module.default.data.name;

      expect(registered.has(name), `${name} is registered twice`).toBe(false);

      registered.set(name, file);
    }

    for (const name of IDENTITY_COMMANDS) {
      expect(registered.has(name), `${name} does not register`).toBe(true);
    }
  });

  it("register the three commands of this area exactly once each", async () => {
    const files = listCommandFiles(categoryPath);

    const names: string[] = [];

    for (const file of files) {
      const module = (await import(pathToFileURL(file).href)) as {
        default?: unknown;
      };

      if (!isCommand(module.default)) continue;

      names.push(module.default.data.name);
    }

    for (const name of IDENTITY_COMMANDS) {
      const count = names.filter((entry) => entry === name).length;

      expect(count, `${name} is registered ${count} times`).toBe(1);
    }
  });
});
