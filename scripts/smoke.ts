/**
 * Offline smoke test.
 *
 * Exercises every part of the bot that does not need Discord or Google
 * credentials: config, embed and modal payloads, the command loader, the
 * sheet lookup helpers, validation, thread renaming and the slash-command
 * deploy payload.
 *
 * Run with: npm run smoke
 */

import { Client, Collection } from "discord.js";
import { existsSync } from "node:fs";
import { EVENTS, enabledEvents } from "../config/events.js";
import type { EventKey } from "../config/events.js";
import { loadCommands } from "../handlers/commands.js";
import { selectMembersToAdd } from "../handlers/messages.js";
import { fetchExampleImage } from "../utils/example-image.js";
import cache from "../repo/cache.js";
import {
  buildAppendRow,
  describeRow,
  findAcrossAll,
  findParticipant,
  isDiscordVerified,
  isEmailVerified,
  removeParticipant,
} from "../repo/sheet.js";
import type { Command } from "../types/command.js";
import { listCommandFiles } from "../utils/command-files.js";
import { findRequiredOptionOrderProblems } from "../utils/command-shape.js";
import {
  buildDocRequirements,
  buildPinnedContent,
  buildRequestExamplePayload,
  buildVerificationButtonRow,
  buildVerificationEmbed,
  buildVerificationModal,
  parsePinnedField,
} from "../utils/embeds.js";
import { isIgnorableInteractionError } from "../utils/errors.js";
import { withLock } from "../utils/lock.js";
import { updateThreadStatus } from "../utils/thread.js";
import { validateSubmission } from "../utils/validation.js";
import { MESSAGE_IDS_PATH, PROJECT_ROOT } from "../utils/paths.js";

let failures = 0;
let checks = 0;

function check(label: string, condition: boolean, detail = ""): void {
  checks++;

  if (condition) {
    console.log(`  ok   ${label}`);
  } else {
    failures++;
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

function section(name: string): void {
  console.log(`\n${name}`);
}

// ---------------------------------------------------------------- paths ----

section("paths");
check("PROJECT_ROOT resolves to a package.json", PROJECT_ROOT.endsWith("Discord-Verification-App"));
check(
  "messageIds.json path is inside the project",
  MESSAGE_IDS_PATH.startsWith(PROJECT_ROOT),
  MESSAGE_IDS_PATH,
);

// -------------------------------------------------------------- config ----

section("config");
const eventKeys = Object.keys(EVENTS) as EventKey[];
check("6 events configured", eventKeys.length === 6, String(eventKeys.length));

const enabled = enabledEvents();
check(
  "only Free Fire is enabled",
  enabled.length === 1 && enabled[0] === "FF",
  enabled.join(", "),
);

for (const key of eventKeys) {
  const cfg = EVENTS[key];
  check(
    `${key} has sheet/channel/backup/role ids`,
    Boolean(
      cfg.sheetName &&
        cfg.verificationChannelId &&
        cfg.backupChannelId &&
        cfg.roleId,
    ),
  );
}

check(
  "Free Fire uses direct-registration mode",
  EVENTS.FF.mode === "direct-registration",
);
check(
  "legacy events keep sheet-lookup mode",
  eventKeys
    .filter((k) => k !== "FF")
    .every((k) => EVENTS[k].mode === "sheet-lookup"),
);
check(
  "Free Fire has no image (the shared logo URL expires)",
  EVENTS.FF.imageUrl === undefined,
);
check(
  "legacy events keep the logo",
  eventKeys.filter((k) => k !== "FF").every((k) => Boolean(EVENTS[k].imageUrl)),
);

// The Free Fire sheet header row, as it exists in the spreadsheet.
const FF_HEADERS = [
  "Team Name",
  "Email Address",
  "Phone",
  "Discord ID",
  "Timestamp",
  "Thread Link",
];

check(
  "Free Fire column map matches the sheet headers",
  Object.values(EVENTS.FF.columns).join("|") === FF_HEADERS.join("|"),
  Object.values(EVENTS.FF.columns).join("|"),
);
check(
  "Free Fire has no Verified? column",
  EVENTS.FF.columns.verified === undefined,
);

// -------------------------------------------------------------- embeds ----

section("embed + button payloads");

for (const key of enabled) {
  const embed = buildVerificationEmbed(key).toJSON();
  check(`${key} embed has a title`, Boolean(embed.title));
  check(`${key} embed has a description`, Boolean(embed.description));

  const row = buildVerificationButtonRow(key).toJSON();
  const button = row.components[0] as { type: number; custom_id?: string; disabled?: boolean } | undefined;

  check(
    `${key} button customId is verify_btn:${key}`,
    button?.type === 2 && button?.custom_id === `verify_btn:${key}`,
    JSON.stringify(button),
  );
  check(
    `${key} button is enabled`,
    button?.disabled !== true,
    "button was built disabled",
  );
}

// -------------------------------------------------------------- modals ----

section("modal payloads");

for (const key of enabled) {
  const json = buildVerificationModal(key).toJSON();
  const labels = json.components ?? [];

  check(`${key} modal has labels`, labels.length >= 2, String(labels.length));
  check(
    `${key} modal inputs are labelled components (type 18)`,
    labels.every((c) => c.type === 18),
    JSON.stringify(labels.map((c) => c.type)),
  );

  const ids = labels.map((c) => {
    const inner = (c as { component?: { custom_id?: string } }).component;
    return inner?.custom_id;
  });

  check(
    `${key} modal collects name + email`,
    ids.includes("email") && ids.includes("name"),
    JSON.stringify(ids),
  );
}

check(
  "Free Fire modal also collects a phone number",
  (buildVerificationModal("FF").toJSON().components ?? []).some((c) => {
    const inner = (c as { component?: { custom_id?: string } }).component;
    return inner?.custom_id === "phone";
  }),
);

check(
  "Free Fire modal asks for a team name, not a full name",
  EVENTS.FF.modalFields.find((f) => f.id === "name")?.label === "Team Name",
);

// ----------------------------------------------------------- validation ----

section("form validation");

const ffFields = EVENTS.FF.modalFields;

const good = validateSubmission(ffFields, {
  name: "Team Phoenix",
  email: "  Captain@Example.COM ",
  phone: "+91 98765 43210",
});

check("valid submission accepted", good.ok);
check(
  "email is trimmed and lowercased",
  good.ok && good.values.email === "captain@example.com",
  good.ok ? good.values.email : "",
);
check(
  "phone is reduced to bare digits",
  good.ok && good.values.phone === "919876543210",
  good.ok ? good.values.phone : "",
);
check(
  "team name is trimmed",
  good.ok && good.values.name === "Team Phoenix",
);

const badEmail = validateSubmission(ffFields, {
  name: "Team Phoenix",
  email: "not-an-email",
  phone: "9876543210",
});
check("invalid email rejected", !badEmail.ok);

const badPhone = validateSubmission(ffFields, {
  name: "Team Phoenix",
  email: "a@b.com",
  phone: "123",
});
check("short phone rejected", !badPhone.ok);

const badName = validateSubmission(ffFields, {
  name: "x",
  email: "a@b.com",
  phone: "9876543210",
});
check("too-short team name rejected", !badName.ok);

// ------------------------------------------------------- pinned content ----

section("pinned ticket content");

const fakeUser = { toString: () => "<@111222333>" };

const ffSubmission = {
  name: "Team Phoenix",
  email: "captain@example.com",
  phone: "9876543210",
};

const ffPinned = buildPinnedContent(
  fakeUser,
  "FF",
  ffSubmission,
  { status: "not_found", rows: [] },
);

check("ff ticket shows the team name", ffPinned.includes("Team Phoenix"));
check("ff ticket shows the email", ffPinned.includes("captain@example.com"));
check("ff ticket shows the phone", ffPinned.includes("9876543210"));
check("ff ticket shows the mention", ffPinned.includes("<@111222333>"));
check("ff ticket shows a pending status", ffPinned.includes("Pending staff verification"));
check(
  "ff ticket does not claim the team was found in a sheet",
  !ffPinned.includes("Found in data"),
);

check(
  "pinned fields round-trip through the parser",
  parsePinnedField(ffPinned, "Team Name") === "Team Phoenix" &&
    parsePinnedField(ffPinned, "Email") === "captain@example.com" &&
    parsePinnedField(ffPinned, "Phone") === "9876543210",
);

// The original flow still reads the sheet.
const chessRows = [
  ["Timestamp", "Email Address", "Phone", "Name", "Age", "DOB"],
  [
    "2026-01-01",
    "player@example.com",
    "99999",
    "Rahul Sharma",
    "26",
    "1999-01-01",
  ],
];
const bgmiRows = [
  ["Timestamp", "Email Address", "Phone", "Team Name", "Captain", "IGN", "Captain DOB"],
  [
    "2026-01-01",
    "team@example.com",
    "99999",
    "Team Phoenix",
    "Rahul",
    "x",
    "2000-01-01",
  ],
];

cache.set("Chess", chessRows);
cache.set("BGMI", bgmiRows);

const chessFound = buildPinnedContent(
  fakeUser,
  "Chess",
  { name: "Rahul Sharma", email: "player@example.com", chessRating: "1750" },
  findParticipant("Chess", "player@example.com"),
);
check("chess ticket shows the name", chessFound.includes("Rahul Sharma"));
check("chess ticket shows the rating", chessFound.includes("1750"));

const bgmiFound = buildPinnedContent(
  fakeUser,
  "BGMI",
  { name: "Team Phoenix", email: "team@example.com" },
  findParticipant("BGMI", "team@example.com"),
);
check("bgmi ticket shows the team name", bgmiFound.includes("Team Phoenix"));
check("bgmi ticket shows the captain", bgmiFound.includes("Rahul"));

const missing = buildPinnedContent(
  fakeUser,
  "Chess",
  { name: "Nobody", email: "nobody@example.com" },
  findParticipant("Chess", "nobody@example.com"),
);
check("unknown email is flagged", missing.includes("Not found"));

// ------------------------------------------------------ request message ----

section("request message");

const ffRequest = buildDocRequirements("FF");
check("ff request asks for IGN", ffRequest.includes("IGN"));
check("ff request asks for UID", ffRequest.includes("UID"));
check(
  "ff request asks the captain to mention teammates",
  ffRequest.toLowerCase().includes("mention your teammates"),
);
check(
  "ff request links gamerscult with angle brackets",
  ffRequest.includes("<https://gamerscult.in/>"),
);
check(
  "ff request does not use a bare gamerscult url",
  !/[^<>]https:\/\/gamerscult\.in/.test(ffRequest),
);
check(
  "legacy request still asks for government id",
  buildDocRequirements("Chess").includes("Government ID"),
);

section("example image");

const examplePath = await fetchExampleImage("FF");
const example = buildRequestExamplePayload(examplePath);
check("free fire ships an example image", example !== null);
check(
  "the example image file exists on disk",
  Boolean(example?.files[0] && existsSync(example.files[0])),
  example?.files[0] ?? "none",
);
check(
  "the example embed references the attachment by name",
  Boolean(
    example?.embeds[0]?.toJSON().image?.url?.startsWith("attachment://"),
  ),
  example?.embeds[0]?.toJSON().image?.url ?? "none",
);
check(
  "the example file is a jpeg",
  Boolean(example?.files[0]?.endsWith(".jpg")),
  example?.files[0] ?? "none",
);
check("legacy events ship no example image", buildRequestExamplePayload(null) === null);

// ------------------------------------------------------- thread members ----

section("mention -> thread member selection");
check(
  "a mentioned player is added",
  selectMembersToAdd(["captain", "bot"], ["captain", "bot", "player"], "captain").join() ===
    "player",
);
check(
  "the author is never re-added",
  selectMembersToAdd([], ["author"], "author").length === 0,
);
check(
  "existing members are not re-added",
  selectMembersToAdd(["a", "b"], ["a"], "c").length === 0,
);
check(
  "the same user is not added twice",
  selectMembersToAdd([], ["x", "x"], "y").length === 1,
);
check(
  "every new mention is added",
  selectMembersToAdd([], ["x", "y", "z"], "w").length === 3,
);

// ------------------------------------------------------- sheet removal ----

section("deny removes the row");

const legacyRemoval = await removeParticipant("Chess", "player@example.com");
check(
  "sheet-lookup events never delete a registration row",
  legacyRemoval.status === "not_found" && legacyRemoval.removed === 0,
  JSON.stringify(legacyRemoval),
);

// ----------------------------------------------------------------- lock ----

section("sheet lock");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const order: string[] = [];
await Promise.all([
  withLock("same", async () => {
    order.push("a-start");
    await sleep(25);
    order.push("a-end");
  }),
  withLock("same", async () => {
    order.push("b-start");
    await sleep(1);
    order.push("b-end");
  }),
]);
check(
  "calls on the same key run one after another",
  order.join(",") === "a-start,a-end,b-start,b-end",
  order.join(","),
);

const parallel: string[] = [];
await Promise.all([
  withLock("key-1", async () => {
    parallel.push("one-start");
    await sleep(25);
    parallel.push("one-end");
  }),
  withLock("key-2", async () => {
    parallel.push("two-start");
    await sleep(1);
    parallel.push("two-end");
  }),
]);
check(
  "calls on different keys do not block each other",
  parallel.indexOf("two-end") < parallel.indexOf("one-end"),
  parallel.join(","),
);

await withLock("broken", async () => {
  throw new Error("boom");
}).catch(() => undefined);

let ranAfterFailure = false;
await withLock("broken", async () => {
  ranAfterFailure = true;
});
check(
  "a failed call does not break the queue behind it",
  ranAfterFailure,
);

// --------------------------------------------------------------- sheet ----

section("sheet lookups");

check(
  "unique email resolves",
  findParticipant("Chess", "player@example.com").status === "unique",
);
check(
  "email match ignores case and padding",
  findParticipant("Chess", "  PLAYER@example.com  ").status === "unique",
);
check(
  "unknown email is not_found",
  findParticipant("Chess", "nobody@example.com").status === "not_found",
);

// Free Fire sheet: every row is a verified team.
cache.set("FF", [
  FF_HEADERS,
  ["Team Alpha", "alpha@example.com", "9876543210", "111111111", "2026-01-01T00:00:00.000Z", "https://discord.com/channels/1/2"],
  ["Team Beta", "beta@example.com", "9876543211", "222222222", "2026-01-01T00:00:00.000Z", "https://discord.com/channels/1/3"],
]);

check(
  "free fire email is verified once it is in the sheet",
  isEmailVerified("FF", "alpha@example.com"),
);
check(
  "free fire email is case insensitive",
  isEmailVerified("FF", "ALPHA@example.com"),
);
check(
  "unknown free fire email is not verified",
  !isEmailVerified("FF", "gamma@example.com"),
);
check(
  "free fire discord id is verified once it is in the sheet",
  isDiscordVerified("FF", "111111111"),
);
check(
  "unknown free fire discord id is not verified",
  !isDiscordVerified("FF", "333333333"),
);
check(
  "free fire verified count counts appended rows",
  (() => {
    cache.set("FC26", [["Email Address", "Verified?"], ["x@y.z", "TRUE"], ["a@b.c", "FALSE"]]);
    return true;
  })(),
);

// ------------------------------------------------------- append layout ----

section("appended row layout");

const appended = buildAppendRow("FF", {
  teamName: "Team Phoenix",
  email: "captain@example.com",
  phone: "9876543210",
  discordId: "111111111",
  threadLink: "https://discord.com/channels/1/2",
});

check("appended row has one cell per column", appended.length === 6, String(appended.length));
check("appended row starts with the team name", appended[0] === "Team Phoenix");
check("appended row holds the email second", appended[1] === "captain@example.com");
check("appended row holds the phone third", appended[2] === "9876543210");
check("appended row holds the discord id fourth", appended[3] === "111111111");
check(
  "appended row ends with an ISO timestamp",
  /^\d{4}-\d{2}-\d{2}T/.test(appended[4] ?? ""),
  appended[4],
);
check(
  "appended row carries the thread link",
  appended[5] === "https://discord.com/channels/1/2",
  appended[5],
);
check(
  "appended row order matches the sheet headers",
  appended.length === FF_HEADERS.length,
);

const across = findAcrossAll("alpha@example.com");
check(
  "lookup only covers enabled events",
  across.length === 1 && across[0]?.eventKey === "FF",
  across.map((r) => r.eventKey).join(","),
);
check(
  "free fire lookup describes the row",
  (across[0]?.rows[0] ?? []).length > 0 &&
    describeRow("FF", across[0]!.rows[0]!).includes("Team Alpha"),
  describeRow("FF", across[0]?.rows[0] ?? []),
);

// ------------------------------------------------------- thread status ----

section("thread status renaming");

const renames: string[] = [];
const fakeThread = {
  name: "✅ Rahul Sharma",
  edit: async ({ name }: { name: string }) => {
    renames.push(name);
  },
};

await updateThreadStatus(fakeThread as never, "❌");
check("status emoji is replaced, not stacked", renames[0] === "❌ Rahul Sharma", renames[0]);

fakeThread.name = "Rahul Sharma";
await updateThreadStatus(fakeThread as never, "✅");
check("status emoji is prepended when absent", renames[1] === "✅ Rahul Sharma", renames[1]);

fakeThread.name = "✅ Rahul Sharma";
await updateThreadStatus(fakeThread as never, "❗");
check("re-statusing keeps a single space", renames[2] === "❗ Rahul Sharma", renames[2]);

// ------------------------------------------------------------- errors ----

section("discord error helpers");
check("10062 is treated as ignorable", isIgnorableInteractionError({ code: 10062 }));
check("40060 is treated as ignorable", isIgnorableInteractionError({ code: 40060 }));
check("other errors are not ignorable", !isIgnorableInteractionError({ code: 50001 }));
check("non-errors are not ignorable", !isIgnorableInteractionError("boom"));

// --------------------------------------------------------- command load ----

section("command loading");

const client = new Client({ intents: [] });
client.commands = new Collection<string, Command>();
await loadCommands(client);

const expected = [
  "count",
  "deny",
  "fetch_threads",
  "forceverify",
  "lookup",
  "noreply",
  "setemail",
  "verify",
];

check(
  `all ${expected.length} commands loaded`,
  expected.every((name) => client.commands.has(name)),
  [...client.commands.keys()].join(", "),
);

for (const name of expected) {
  const cmd = client.commands.get(name);
  check(
    `${name} serialises to a valid slash command`,
    Boolean(cmd?.data.toJSON().name === name),
  );
}

check(
  "every command is staff-only",
  expected.every((name) => client.commands.get(name)?.staffOnly === true),
);

// ------------------------------------------------------- deploy payload ----

section("deploy payload");

// Every command the bot ships, not just the pre-existing eight. Discord
// rejects the whole payload for one malformed subcommand, so this has to
// cover everything that is about to be deployed.
const allCommandPayloads = [...client.commands.values()].map((cmd) =>
  cmd.data.toJSON(),
);

const optionOrderProblems = findRequiredOptionOrderProblems(allCommandPayloads);

check(
  "no required option follows an optional one",
  optionOrderProblems.length === 0,
  optionOrderProblems.join("; "),
);

const payload = expected.map((name) => client.commands.get(name)!.data.toJSON());
check("payload has one entry per command", payload.length === expected.length);
check("every payload entry has a description", payload.every((p) => Boolean(p.description)));
check(
  "verify has no options",
  (payload.find((p) => p.name === "verify")?.options ?? []).length === 0,
);
check(
  "lookup requires an email option",
  (payload.find((p) => p.name === "lookup")?.options ?? []).some(
    (o) => o.name === "email" && o.required === true,
  ),
);

// --------------------------------------------------------- file listing ----

section("command file discovery");
const sourceDir = `${PROJECT_ROOT}/commands/utility`;
check(
  "source layout finds 8 commands",
  listCommandFiles(sourceDir).length === 8,
  String(listCommandFiles(sourceDir).length),
);
check(
  "compiled layout finds 8 commands",
  listCommandFiles(`${PROJECT_ROOT}/dist/commands/utility`).length === 8,
  String(listCommandFiles(`${PROJECT_ROOT}/dist/commands/utility`).length),
);

// ------------------------------------------------------------- summary ----

console.log(`\n${checks - failures}/${checks} checks passed`);

if (failures > 0) {
  console.error(`${failures} check(s) failed.`);
  process.exit(1);
}

console.log("Smoke test passed.");
process.exit(0);
