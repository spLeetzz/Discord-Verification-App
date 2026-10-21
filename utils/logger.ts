import { appendFile } from "node:fs/promises";
import { inspect } from "node:util";
import { LOG_PATH } from "./paths.js";

const FLUSH_INTERVAL = 5000; // 5 seconds
const buffer: string[] = [];

function fmt(level: string, ...args: unknown[]): string {
  const timestamp = new Date().toLocaleString("en-US", {
    timeZone: "Asia/Kolkata",
    hour12: false,
  });

  const message = args
    .map((arg) => {
      if (arg instanceof Error) {
        return `${arg.message}\n${arg.stack}`;
      }
      return typeof arg === "object" && arg !== null
        ? inspect(arg, { depth: 2, colors: false })
        : String(arg);
    })
    .join(" ");

  return `[${timestamp}] [${level}] ${message}`;
}

/**
 * Flushes the current log buffer to the log file.
 */
export async function flushLogs(): Promise<void> {
  if (buffer.length === 0) return;

  const chunk = `${buffer.splice(0, buffer.length).join("\n")}\n`;

  try {
    await appendFile(LOG_PATH, chunk);
  } catch (err) {
    process.stderr.write(
      `Failed to write to log file: ${err instanceof Error ? err.message : String(err)}\n`,
    );
  }
}

// Set up periodic flushing
const flushTimer = setInterval(flushLogs, FLUSH_INTERVAL);
flushTimer.unref(); // Don't keep the process alive just for the timer

export const logger = {
  info(...args: unknown[]): void {
    const line = fmt("INFO", ...args);
    console.log(line);
    buffer.push(line);
  },
  warn(...args: unknown[]): void {
    const line = fmt("WARN", ...args);
    console.warn(line);
    buffer.push(line);
  },
  error(...args: unknown[]): void {
    const line = fmt("ERROR", ...args);
    console.error(line);
    buffer.push(line);
  },
  debug(...args: unknown[]): void {
    if (process.env.DEBUG) {
      const line = fmt("DEBUG", ...args);
      console.debug(line);
      buffer.push(line);
    }
  },
};
