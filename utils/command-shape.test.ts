import { describe, expect, it } from "vitest";
import {
  assertCommandShape,
  findRequiredOptionOrderProblems,
} from "./command-shape.js";

describe("command payload shape", () => {
  it("finds a required option that follows an optional one", () => {
    const problems = findRequiredOptionOrderProblems([
      {
        name: "tag",
        options: [
          {
            name: "transfer",
            type: 1,
            options: [
              { name: "name", required: false },
              { name: "member", required: true },
            ],
          },
        ],
      },
    ]);

    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("/tag transfer");
    expect(problems[0]).toContain("member");
  });

  it("accepts required options that come first", () => {
    expect(
      findRequiredOptionOrderProblems([
        {
          name: "tag",
          options: [
            {
              name: "transfer",
              type: 1,
              options: [
                { name: "name", required: true },
                { name: "member", required: true },
              ],
            },
          ],
        },
      ]),
    ).toEqual([]);
  });

  it("accepts a subcommand whose options are all optional", () => {
    expect(
      findRequiredOptionOrderProblems([
        {
          name: "tag",
          options: [
            {
              name: "search",
              type: 1,
              options: [
                { name: "text", required: false },
                { name: "limit", required: false },
              ],
            },
          ],
        },
      ]),
    ).toEqual([]);
  });

  it("checks a command's own options as well as its subcommands", () => {
    const problems = findRequiredOptionOrderProblems([
      {
        name: "thing",
        options: [
          { name: "optional", required: false },
          { name: "needed", required: true },
        ],
      },
    ]);

    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("/thing");
  });

  it("throws with every problem named", () => {
    expect(() =>
      assertCommandShape([
        {
          name: "one",
          options: [
            {
              name: "sub",
              type: 1,
              options: [
                { name: "a", required: false },
                { name: "b", required: true },
              ],
            },
          ],
        },
        {
          name: "two",
          options: [
            { name: "c", required: false },
            { name: "d", required: true },
          ],
        },
      ]),
    ).toThrow(/one sub/);
  });
});
