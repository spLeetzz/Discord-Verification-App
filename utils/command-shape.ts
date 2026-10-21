/**
 * Command payload shape checks.
 *
 * Discord rejects a whole command payload for one malformed subcommand, and
 * the error names an index rather than a command. These checks exist so a
 * shape problem is caught while the payload is being built, with a message
 * that names the command, instead of by a 400 from the API.
 */

/** The parts of a command payload this module looks at. */
export interface CommandShape {
  name: string;
  options?: {
    name: string;
    type?: number;
    required?: boolean;
    options?: { name: string; required?: boolean }[];
  }[];
}

/** Discord's option type for a subcommand. */
const SUBCOMMAND_TYPE = 1;

/**
 * Finds subcommands whose required options follow an optional one.
 *
 * Discord requires every required option to come before any optional one,
 * and rejects the entire payload when it does not. A subcommand with
 * `name` (optional) then `member` (required) is rejected with
 * `APPLICATION_COMMAND_OPTIONS_REQUIRED_INVALID` — naming an index, not a
 * command, which is why this is worth catching locally.
 */
export function findRequiredOptionOrderProblems(
  commands: readonly CommandShape[],
): string[] {
  const problems: string[] = [];

  for (const command of commands) {
    for (const sub of command.options ?? []) {
      if (!sub.options) continue;

      let seenOptional = false;

      for (const option of sub.options) {
        if (option.required !== true) {
          seenOptional = true;
        } else if (seenOptional) {
          problems.push(
            `/${command.name} ${sub.name}: the required option "${option.name}" comes after an optional one`,
          );
        }
      }
    }

    let seenOptional = false;

    for (const option of command.options ?? []) {
      if (option.type === SUBCOMMAND_TYPE) continue;

      if (option.required !== true) {
        seenOptional = true;
      } else if (seenOptional) {
        problems.push(
          `/${command.name}: the required option "${option.name}" comes after an optional one`,
        );
      }
    }
  }

  return problems;
}

/**
 * Fails loudly, and with the whole list, rather than one problem per
 * deploy attempt.
 */
export function assertCommandShape(commands: readonly CommandShape[]): void {
  const problems = findRequiredOptionOrderProblems(commands);

  if (!problems.length) return;

  throw new Error(
    `The command payload is malformed and Discord would reject all of it:\n${problems
      .map((problem) => `  - ${problem}`)
      .join("\n")}\n\nEvery required option must come before any optional one.`,
  );
}
