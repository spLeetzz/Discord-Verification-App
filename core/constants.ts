/**
 * Closed value sets the port inherits from Quotient.
 *
 * Quotient modelled these as Python `Enum` classes. In TypeScript the
 * equivalent is an `as const` object plus a union type derived from it: the
 * object gives readable literals at call sites (`Day.monday`), the union
 * gives the compiler a closed set to switch over exhaustively.
 *
 * The *values* are Quotient's own wire values, not the Python member names.
 * They are what the old database columns and the old message templates
 * contain, so keeping them means an imported config keeps working. Where
 * Quotient's value was a human sentence (`RegMsg`) it is kept verbatim too.
 */

/** Days of the week, as Quotient stored them. */
export const Day = {
  monday: "monday",
  tuesday: "tuesday",
  wednesday: "wednesday",
  thursday: "thursday",
  friday: "friday",
  saturday: "saturday",
  sunday: "sunday",
} as const;
export type Day = (typeof Day)[keyof typeof Day];

/** What an auto-clean job removes. */
export const AutocleanType = {
  channel: "channel",
  role: "role",
} as const;
export type AutocleanType = (typeof AutocleanType)[keyof typeof AutocleanType];

/** The screenshot verification flavours Quotient could check. */
export const SSType = {
  yt: "youtube",
  insta: "instagram",
  rooter: "rooter",
  loco: "loco",
  anyss: "Any SS",
  custom: "custom",
} as const;
export type SSType = (typeof SSType)[keyof typeof SSType];

/** The lifecycle events a scrim/tourney log records. */
export const EsportsLog = {
  open: "open",
  closed: "closed",
  success: "reg_success",
} as const;
export type EsportsLog = (typeof EsportsLog)[keyof typeof EsportsLog];

/** The roles a scrim/tourney can ping or auto-grant. */
export const EsportsRole = {
  ping: "ping_role",
  open: "open_role",
} as const;
export type EsportsRole = (typeof EsportsRole)[keyof typeof EsportsRole];

/** Why a registration was refused. */
export const RegDeny = {
  botmention: "mentioned bots",
  nomention: "insufficient mentions",
  banned: "banned",
  multiregister: "multiregister",
  noteamname: "no_team_name",
  reqperms: "lack_permissions",
  duplicate: "duplicate_name",
  bannedteammate: "banned_teammate",
  nolines: "no_lines",
  faketag: "fake_tag",
} as const;
export type RegDeny = (typeof RegDeny)[keyof typeof RegDeny];

/** The titles Quotient used for the open/close announcements. */
export const RegMsg = {
  sopen: "Scrim Registration Open",
  sclose: "Scrim Registration Close",
  topen: "Tourney Registration Open",
  tclose: "Tourney Registration Close",
} as const;
export type RegMsg = (typeof RegMsg)[keyof typeof RegMsg];

/** What a lockdown can freeze. */
export const LockType = {
  channel: "channel",
  guild: "guild",
  category: "category",
  maintenance: "maintenance",
} as const;
export type LockType = (typeof LockType)[keyof typeof LockType];

/** Whether a scrim ban was applied or lifted. */
export const ScrimBanType = {
  ban: "banned",
  unban: "unbanned",
} as const;
export type ScrimBanType = (typeof ScrimBanType)[keyof typeof ScrimBanType];

/**
 * The premium features a guild can hold an entitlement for.
 *
 * This is the closed union D15 asks for: every premium gate names one of
 * these, and the entitlement table's `feature` column holds exactly these
 * strings.
 */
export const PremiumFeature = {
  scrimSlots: "scrim_slots",
  slotReminders: "slot_reminders",
  idpTransfer: "idp_transfer",
  extraChannels: "extra_channels",
  screenshotTypes: "screenshot_types",
  successMessage: "success_message",
} as const;
export type PremiumFeature = (typeof PremiumFeature)[keyof typeof PremiumFeature];

/** The accent colour used for informational embeds. */
export const EMBED_COLOR = 0x00ffb3;

/** The colour used for refusals and other bad news. */
export const ERROR_COLOR = 0xff4e4a;
