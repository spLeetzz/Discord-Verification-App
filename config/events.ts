/**
 * Event configuration.
 *
 * Two flows live side by side:
 *
 *  - "sheet-lookup"     the original flow. The email is looked up in a
 *                       registration sheet BEFORE the ticket is created, and
 *                       /verify writes back to that same pre-existing row.
 *  - "direct-registration" the Free Fire flow. There is no registration sheet
 *                       to look up. The team registers through the modal and
 *                       a row is APPENDED to a sheet only once staff verify.
 *
 * Every event declares its own column headers, so the sheet layer never has
 * to hardcode a column name.
 */

// Loads .env before the config below reads any environment variable.
import "../utils/env.js";

/**
 * Shared BSSA banner. The Discord CDN link carries an expiry token, so it
 * will 404 eventually — swap it for a permanent asset URL when you have one.
 */
const BSSA_LOGO_URL =
  "https://media.discordapp.net/attachments/1495405063320113215/1495424946179145889/bssa_LOGO.png?ex=69e82cc2&is=69e6db42&hm=d7a05ea1f1657bbd9b1e18c0d52b308b7bca17105ff4e3ec70caf21bcdfe099f&=&format=webp&quality=lossless&width=1264&height=817";

export type EventMode = "sheet-lookup" | "direct-registration";

export type ModalFieldKind = "text" | "email" | "phone";

export interface ModalField {
  /** Custom id of the text input. Also the key in the submitted form. */
  id: string;
  label: string;
  placeholder: string;
  kind: ModalFieldKind;
  required: boolean;
  minLength?: number;
  maxLength?: number;
}

export interface EventColumns {
  teamName?: string;
  email: string;
  phone?: string;
  discordId?: string;
  timestamp?: string;
  /** Absent means "a row existing means the row is verified". */
  verified?: string;
  verifiedBy?: string;
  threadLink?: string;
}

export interface EventConfig {
  /** Disabled events are skipped at startup and are not read from their sheet. */
  enabled: boolean;
  mode: EventMode;
  /** Tab name inside the event's spreadsheet. */
  sheetName: string;
  /** Defaults to SPREADSHEET_ID when omitted. */
  spreadsheetId?: string;
  verificationChannelId: string;
  backupChannelId: string;
  roleId: string;
  isTeamEvent: boolean;
  displayName: string;
  description: string;
  /** Optional banner image for the embed. */
  imageUrl?: string;
  /**
   * Source image for the "here is what to send" example.
   *
   * Discord signs its CDN links with an expiry, so the bot downloads this
   * once and caches the bytes locally rather than linking to it directly.
   */
  requestExampleUrl?: string;
  /**
   * Sheet column headers. For direct-registration events the insertion order
   * of these keys is also the column order of an appended row.
   */
  columns: EventColumns;
  modalFields: ModalField[];
}

const REGISTRATION_MODAL_FIELDS: ModalField[] = [
  {
    id: "email",
    label: "Email used at registration",
    placeholder: "yourname@example.com",
    kind: "email",
    required: true,
  },
  {
    id: "name",
    label: "Your Full Name",
    placeholder: "ex. Rahul Sharma",
    kind: "text",
    required: true,
    minLength: 2,
    maxLength: 50,
  },
];

const TEAM_REGISTRATION_MODAL_FIELDS: ModalField[] = [
  {
    id: "name",
    label: "Team Name",
    placeholder: "e.g. Team Phoenix",
    kind: "text",
    required: true,
    minLength: 2,
    maxLength: 50,
  },
  {
    id: "email",
    label: "Email used at registration",
    placeholder: "yourname@example.com",
    kind: "email",
    required: true,
  },
  {
    id: "phone",
    label: "Phone number",
    placeholder: "10-digit mobile number",
    kind: "phone",
    required: true,
  },
];

const EVENT_DEFINITIONS = {
  BGMI: {
    enabled: false,
    mode: "sheet-lookup",
    sheetName: "BGMI",
    verificationChannelId: "1495404999709298689",
    backupChannelId: "1495405114943602848",
    roleId: "1495975013566644335",
    isTeamEvent: true,
    displayName: "BGMI Verification",
    description:
      "Click below to open a Team Verification ticket.\n\n- Only the Team Captain needs to open a ticket and share details for all players.\n- Make sure your Discord is updated to the latest version.",
    imageUrl: BSSA_LOGO_URL,
    columns: {
      email: "Email Address",
      verified: "Verified?",
      verifiedBy: "Verified by",
      discordId: "Discord ID Final",
      threadLink: "Thread Link",
    },
    modalFields: [
      REGISTRATION_MODAL_FIELDS[1]!,
      REGISTRATION_MODAL_FIELDS[0]!,
    ],
  },
  Chess: {
    enabled: false,
    mode: "sheet-lookup",
    sheetName: "Chess",
    verificationChannelId: "1495405009263792263",
    backupChannelId: "1495405116071874694",
    roleId: "1495975158211674253",
    isTeamEvent: false,
    displayName: "Chess Verification",
    description:
      "Click below to open a Player Verification ticket.\n\n- Make sure your Discord is updated to the latest version.",
    imageUrl: BSSA_LOGO_URL,
    columns: {
      email: "Email Address",
      verified: "Verified?",
      verifiedBy: "Verified by",
      discordId: "Discord ID Final",
      threadLink: "Thread Link",
    },
    modalFields: [
      REGISTRATION_MODAL_FIELDS[0]!,
      REGISTRATION_MODAL_FIELDS[1]!,
      {
        id: "chess_rating",
        label: "Chess.com Rating",
        placeholder: "Max rating in your most played mode",
        kind: "text",
        required: true,
      },
    ],
  },
  EFM: {
    enabled: false,
    mode: "sheet-lookup",
    sheetName: "EFM",
    verificationChannelId: "1495405021976596641",
    backupChannelId: "1495405123445199059",
    roleId: "1495975230336794735",
    isTeamEvent: false,
    displayName: "E-Football Mobile Verification",
    description:
      "Click below to open a Player Verification ticket.\n\n- Make sure your Discord is updated to the latest version.",
    imageUrl: BSSA_LOGO_URL,
    columns: {
      email: "Email Address",
      verified: "Verified?",
      verifiedBy: "Verified by",
      discordId: "Discord ID Final",
      threadLink: "Thread Link",
    },
    modalFields: REGISTRATION_MODAL_FIELDS,
  },
  FC26: {
    enabled: false,
    mode: "sheet-lookup",
    sheetName: "FC26",
    verificationChannelId: "1495405015395729460",
    backupChannelId: "1495405118852435968",
    roleId: "1495975479877046322",
    isTeamEvent: false,
    displayName: "FC 26 Verification",
    description:
      "Click below to open a Player Verification ticket.\n\n- Make sure your Discord is updated to the latest version.",
    imageUrl: BSSA_LOGO_URL,
    columns: {
      email: "Email Address",
      verified: "Verified?",
      verifiedBy: "Verified by",
      discordId: "Discord ID Final",
      threadLink: "Thread Link",
    },
    modalFields: REGISTRATION_MODAL_FIELDS,
  },
  SF6: {
    enabled: false,
    mode: "sheet-lookup",
    sheetName: "STREET FIGHTER 6",
    verificationChannelId: "1495405028087824465",
    backupChannelId: "1495405120069042196",
    roleId: "1495975719996489828",
    isTeamEvent: false,
    displayName: "Street Fighter 6 Verification",
    description:
      "Click below to open a Player Verification ticket.\n\n- Make sure your Discord is updated to the latest version.",
    imageUrl: BSSA_LOGO_URL,
    columns: {
      email: "Email Address",
      verified: "Verified?",
      verifiedBy: "Verified by",
      discordId: "Discord ID Final",
      threadLink: "Thread Link",
    },
    modalFields: REGISTRATION_MODAL_FIELDS,
  },
  FF: {
    enabled: true,
    mode: "direct-registration",
    sheetName: "Free Fire",
    spreadsheetId:
      process.env.FREE_FIRE_SPREADSHEET_ID ??
      "1K2M5oAcSew1jA_rDde8r2QcWZaYqpaknwqjma6XHEgU",
    verificationChannelId:
      process.env.FREE_FIRE_CHANNEL_ID ?? "1562022214486720652",
    backupChannelId:
      process.env.FREE_FIRE_BACKUP_CHANNEL_ID ?? "1562022333844164648",
    roleId: process.env.FREE_FIRE_ROLE_ID ?? "1562022168152510537",
    isTeamEvent: true,
    displayName: "Free Fire Verification",
    description: [
      "**How to register**",
      "1. Click Start Verification.",
      "2. Enter your team name, email, and phone number.",
      "3. Mention your 4 to 5 team members in the ticket.",
      "4. Post the IGN and UID of every player.",
      "5. Post a screenshot of each player account on gamerscult.in.",
      "",
      "A moderator checks your details and verifies.",
      "",
      "**Kaise register karein**",
      "1. Start Verification par click karein.",
      "2. Apna team name, email aur phone number daalein.",
      "3. Ticket me apne 4 se 5 team members ko mention karein.",
      "4. Har player ka IGN aur UID post karein.",
      "5. gamerscult.in par har player ka account screenshot post karein.",
      "",
      "Moderator aapki details check karta hai aur verify krta hai.",
    ].join("\n"),
    requestExampleUrl:
      "https://cdn.discordapp.com/attachments/1562022333844164648/1562029943830089809/sbhs.jpg?ex=6ad8813f&is=6ad72fbf&hm=e95e494b21851d2dadc0ef3e9e2200eeb102d49dc46accfbbda62775e3524138",
    columns: {
      teamName: "Team Name",
      email: "Email Address",
      phone: "Phone",
      discordId: "Discord ID",
      timestamp: "Timestamp",
      threadLink: "Thread Link",
    },
    modalFields: TEAM_REGISTRATION_MODAL_FIELDS,
  },
} satisfies Record<string, EventConfig>;

export type EventKey = keyof typeof EVENT_DEFINITIONS;

/**
 * The same definitions, widened to the full EventConfig shape. Without this
 * the compiler would keep each event's literal type, and optional fields
 * (imageUrl, spreadsheetId, columns.verified) would not exist on the events
 * that leave them out.
 */
export const EVENTS: Record<EventKey, EventConfig> = EVENT_DEFINITIONS;

/** Events that should post an embed and be read from their sheet. */
export function enabledEvents(): EventKey[] {
  return (Object.keys(EVENT_DEFINITIONS) as EventKey[]).filter(
    (key) => EVENTS[key].enabled,
  );
}

/** Quick lookup by verification channel ID (used by admin commands). */
export function getEventByChannelId(
  channelId: string,
): [EventKey, EventConfig] | undefined {
  const entry = Object.entries(EVENT_DEFINITIONS).find(
    ([, details]) => details.verificationChannelId === channelId,
  );

  return entry as [EventKey, EventConfig] | undefined;
}

export function isEventKey(value: string): value is EventKey {
  return Object.prototype.hasOwnProperty.call(EVENT_DEFINITIONS, value);
}
