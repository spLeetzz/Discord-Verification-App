import { describe, expect, it } from "vitest";

import { SerialQueue } from "./queue.js";

describe("SerialQueue", () => {
  it("runs the tasks one after the other", async () => {
    const queue = new SerialQueue();
    const order: string[] = [];

    await Promise.all([
      queue.run(async () => {
        order.push("first start");
        await new Promise((resolve) => setTimeout(resolve, 5));
        order.push("first end");
      }),
      queue.run(async () => {
        order.push("second start");
        order.push("second end");
      }),
    ]);

    expect(order).toEqual([
      "first start",
      "first end",
      "second start",
      "second end",
    ]);
  });

  it("keeps going after a task fails", async () => {
    const queue = new SerialQueue();

    const failed = queue.run(async () => {
      throw new Error("the task failed");
    });

    const followed = queue.run(async () => "still here");

    await expect(failed).rejects.toThrow("the task failed");
    await expect(followed).resolves.toBe("still here");
  });

  it("gives every task its own result", async () => {
    const queue = new SerialQueue();

    const results = await Promise.all([
      queue.run(async () => 1),
      queue.run(async () => 2),
      queue.run(async () => 3),
    ]);

    expect(results).toEqual([1, 2, 3]);
  });
});
