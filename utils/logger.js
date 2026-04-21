import { appendFile } from "fs/promises";
import { resolve } from "path";
import { inspect } from "node:util";


const LOG_PATH = resolve("./bot.log");
const FLUSH_INTERVAL = 5000; // 5 seconds
const buffer = [];



function fmt(level, ...args) {
  const timestamp = new Date().toLocaleString("en-US", {
    timeZone: "Asia/Kolkata",
    hour12: false,
  });
  const message = args

    .map((arg) => {
      if (arg instanceof Error) {
        return `${arg.message}\n${arg.stack}`;
      }
      return typeof arg === "object"
        ? inspect(arg, { depth: 2, colors: false })
        : String(arg);
    })
    .join(" ");

  return `[${timestamp}] [${level}] ${message}`;
}


/**
 * Flushes the current log buffer to the log file.
 */
export async function flushLogs() {
  if (buffer.length === 0) return;

  const chunk = buffer.splice(0, buffer.length).join("\n") + "\n";
  try {
    await appendFile(LOG_PATH, chunk);
  } catch (err) {
    process.stderr.write(`Failed to write to log file: ${err.message}\n`);
  }
}

// Set up periodic flushing
const flushTimer = setInterval(flushLogs, FLUSH_INTERVAL);
flushTimer.unref(); // Don't keep the process alive just for the timer

export const logger = {
  info: (...args) => {
    const line = fmt("INFO", ...args);
    console.log(line);
    buffer.push(line);
  },
  warn: (...args) => {
    const line = fmt("WARN", ...args);
    console.warn(line);
    buffer.push(line);
  },
  error: (...args) => {
    const line = fmt("ERROR", ...args);
    console.error(line);
    buffer.push(line);
  },
  debug: (...args) => {
    if (process.env.DEBUG) {
      const line = fmt("DEBUG", ...args);
      console.debug(line);
      buffer.push(line);
    }
  },
};
