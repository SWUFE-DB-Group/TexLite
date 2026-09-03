import { describe, expect, it } from "vitest";
import { createSourceCursorStore } from "../src/client/workspace/sourceCursorStore";

function nextTask(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("source cursor store", () => {
  it("keeps the precise cursor without notifying React for same-line movement", async () => {
    const store = createSourceCursorStore();
    let notifications = 0;
    const unsubscribe = store.subscribe(() => { notifications += 1; });

    store.update(1, 8, 7);
    await nextTask();
    expect(store.getCursor()).toEqual({ line: 1, column: 8, offset: 7 });
    expect(store.getOutlineLine()).toBe(1);
    expect(notifications).toBe(0);

    store.update(4, 1, 42);
    await nextTask();
    expect(store.getOutlineLine()).toBe(4);
    expect(notifications).toBe(1);

    unsubscribe();
    store.dispose();
  });

  it("coalesces rapid cross-line movement to the latest outline line", async () => {
    const store = createSourceCursorStore();
    let notifications = 0;
    store.subscribe(() => { notifications += 1; });

    store.update(2, 1, 10);
    store.update(3, 1, 20);
    store.update(4, 1, 30);
    await nextTask();

    expect(store.getCursor()).toEqual({ line: 4, column: 1, offset: 30 });
    expect(store.getOutlineLine()).toBe(4);
    expect(notifications).toBe(1);

    store.dispose();
  });

  it("does not publish an intermediate line when the cursor returns before a frame", async () => {
    const store = createSourceCursorStore();
    let notifications = 0;
    store.subscribe(() => { notifications += 1; });

    store.update(2, 1, 10);
    store.update(1, 9, 8);
    await nextTask();

    expect(store.getCursor()).toEqual({ line: 1, column: 9, offset: 8 });
    expect(store.getOutlineLine()).toBe(1);
    expect(notifications).toBe(0);

    store.dispose();
  });

  it("resets the highlighted line immediately when a different file opens", async () => {
    const store = createSourceCursorStore();
    let notifications = 0;
    store.subscribe(() => { notifications += 1; });
    store.update(6, 2, 80);
    await nextTask();

    store.reset();
    expect(store.getCursor()).toEqual({ line: 1, column: 1, offset: 0 });
    expect(store.getOutlineLine()).toBe(1);
    expect(notifications).toBe(2);

    store.dispose();
  });
});
