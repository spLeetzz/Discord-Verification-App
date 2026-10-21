/**
 * Emoji used in user-facing messages.
 *
 * Quotient's `utils/emote.py` points at its own emote server, so the
 * snowflake ids it used (`<:check:807913701151342592>`) render as literal
 * text in this guild. D36 therefore mandates plain Unicode emoji.
 *
 * Unicode emoji also work outside Discord (in a web dashboard, in a log
 * file, in a terminal), which the custom ids did not.
 */

export const emotes = {
  check: "✅",
  xmark: "❌",
  error: "❗",
  info: "ℹ️",
  trash: "🗑️",
  add: "➕",
  remove: "➖",
  edit: "📝",
  tools: "🛠️",
  bell: "🔔",
  loading: "⏳",
  eye: "👀",
  whiteCheckMark: "✅",
  heavyCheckMark: "✔️",
  redCircle: "🔴",
  greenCircle: "🟢",
  yellowCircle: "🟡",
  blueCircle: "🔵",
  one: "1️⃣",
  two: "2️⃣",
  three: "3️⃣",
  four: "4️⃣",
  five: "5️⃣",
  first: "⏮️",
  previous: "⏪",
  next: "⏩",
  last: "⏭️",
  stop: "⏹️",
  arrowLeft: "⬅️",
  arrowRight: "➡️",
  upArrow: "⬆️",
  downArrow: "⬇️",
} as const;

export type Emote = (typeof emotes)[keyof typeof emotes];
