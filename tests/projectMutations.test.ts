import { describe, expect, it } from "vitest";
import { ProjectMutationCoordinator } from "../src/server/projectMutations.js";

describe("project mutation coordination", () => {
  it("serializes exclusive operations and resets the collaboration epoch", async () => {
    const events: string[] = [];
    const collaboration = {
      flushProject: (projectId: string) => { events.push(`flush:${projectId}`); return null; },
      beginMaintenance: (projectId: string, reason: string) => events.push(`begin:${projectId}:${reason}`),
      endMaintenance: (projectId: string) => events.push(`end:${projectId}`)
    } as never;
    const coordinator = new ProjectMutationCoordinator(collaboration);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const first = coordinator.runExclusive("project-1", "restore", async () => {
      events.push("first:start");
      await gate;
      events.push("first:end");
      return "first";
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const second = coordinator.runExclusive("project-1", "checkout", () => {
      events.push("second:run");
      return "second";
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(events).toEqual(["flush:project-1", "begin:project-1:restore", "first:start"]);
    release();
    await expect(first).resolves.toBe("first");
    await expect(second).resolves.toBe("second");
    expect(events).toEqual([
      "flush:project-1", "begin:project-1:restore", "first:start", "first:end", "end:project-1",
      "flush:project-1", "begin:project-1:checkout", "second:run", "end:project-1"
    ]);
  });

  it("keeps a snapshot reservation ahead of a later exclusive mutation", async () => {
    const events: string[] = [];
    const collaboration = {
      flushProject: () => { events.push("flush"); return null; },
      beginMaintenance: () => events.push("begin"),
      endMaintenance: () => events.push("end")
    } as never;
    const coordinator = new ProjectMutationCoordinator(collaboration);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const snapshot = coordinator.runSnapshot("project-1", async () => {
      events.push("snapshot:start");
      await gate;
      events.push("snapshot:end");
      return "snapshot";
    });
    const mutation = coordinator.runExclusive("project-1", "replace", () => {
      events.push("mutation:run");
      return "mutation";
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(events).toEqual(["snapshot:start"]);
    release();
    await expect(snapshot).resolves.toBe("snapshot");
    await expect(mutation).resolves.toBe("mutation");
    expect(events).toEqual(["snapshot:start", "snapshot:end", "flush", "begin", "mutation:run", "end"]);
  });

  it("serializes ordinary writes without entering maintenance mode", async () => {
    const events: string[] = [];
    const collaboration = {
      flushProject: () => { events.push("flush"); return null; }
    } as never;
    const coordinator = new ProjectMutationCoordinator(collaboration);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const write = coordinator.runWrite("project-1", async () => {
      events.push("write:start");
      await gate;
      events.push("write:end");
    });
    const snapshot = coordinator.runSnapshot("project-1", () => {
      events.push("snapshot");
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(events).toEqual(["flush", "write:start"]);
    release();
    await expect(write).resolves.toBeUndefined();
    await expect(snapshot).resolves.toBeUndefined();
    expect(events).toEqual(["flush", "write:start", "write:end", "snapshot"]);
  });

  it("rejects a stale exclusive request before flushing or disconnecting collaborators", async () => {
    const events: string[] = [];
    const collaboration = {
      flushProject: () => { events.push("flush"); return null; },
      beginMaintenance: () => events.push("begin"),
      endMaintenance: () => events.push("end")
    } as never;
    const coordinator = new ProjectMutationCoordinator(collaboration);
    const stale = coordinator.runExclusive("project-1", "move", () => {
      events.push("operation");
    }, { preflight: () => {
      events.push("preflight");
      throw new Error("path disappeared");
    } });

    await expect(stale).rejects.toThrow("path disappeared");
    expect(events).toEqual(["preflight"]);

    await expect(coordinator.runExclusive("project-1", "delete", () => {
      events.push("next");
    })).resolves.toBeUndefined();
    expect(events).toEqual(["preflight", "flush", "begin", "next", "end"]);
  });

  it("can delete a source tree without flushing the room first", async () => {
    const events: string[] = [];
    const collaboration = {
      flushProject: () => { events.push("flush"); return null; },
      beginMaintenance: () => events.push("begin"),
      endMaintenance: () => events.push("end")
    } as never;
    const coordinator = new ProjectMutationCoordinator(collaboration);

    await coordinator.runExclusive("project-1", "delete", () => {
      events.push("delete");
    }, { flush: false });

    expect(events).toEqual(["begin", "delete", "end"]);
  });

  it("keeps the shared project queue through an ordinary asynchronous operation", async () => {
    const events: string[] = [];
    const collaboration = {
      flushProject: () => { events.push("flush"); return null; }
    } as never;
    const coordinator = new ProjectMutationCoordinator(collaboration);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const compile = coordinator.runSerialized("project-1", async () => {
      events.push("compile:start");
      await gate;
      events.push("compile:end");
    }, { flush: false });
    const git = coordinator.runSerialized("project-1", () => { events.push("git"); }, { flush: false });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(events).toEqual(["compile:start"]);
    release();
    await expect(compile).resolves.toBeUndefined();
    await expect(git).resolves.toBeUndefined();
    expect(events).toEqual(["compile:start", "compile:end", "git"]);
  });

  it("does not hold the project queue while latexmk runs", async () => {
    const events: string[] = [];
    const collaboration = {
      flushProject: () => { events.push("flush"); return null; }
    } as never;
    const coordinator = new ProjectMutationCoordinator(collaboration);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const compile = coordinator.runCompile("project-1", async () => {
      events.push("compile:start");
      await gate;
      events.push("compile:end");
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const read = coordinator.runSnapshot("project-1", () => { events.push("read"); });
    await expect(read).resolves.toBeUndefined();
    expect(events).toEqual(["compile:start", "read"]);
    release();
    await expect(compile).resolves.toBeUndefined();
    expect(events).toEqual(["compile:start", "read", "compile:end"]);
  });

  it("waits for an active compile before replacing the source tree", async () => {
    const events: string[] = [];
    const collaboration = {
      flushProject: () => { events.push("flush"); return null; },
      beginMaintenance: () => events.push("begin"),
      endMaintenance: () => events.push("end")
    } as never;
    const coordinator = new ProjectMutationCoordinator(collaboration);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const compile = coordinator.runCompile("project-1", async () => {
      events.push("compile:start");
      await gate;
      events.push("compile:end");
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const mutation = coordinator.runExclusive("project-1", "checkout", () => {
      events.push("checkout");
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(events).toEqual(["compile:start"]);
    release();
    await expect(compile).resolves.toBeUndefined();
    await expect(mutation).resolves.toBeUndefined();
    expect(events).toEqual(["compile:start", "compile:end", "flush", "begin", "checkout", "end"]);
  });

  it("flushes and protects a consistent read until its asynchronous scan completes", async () => {
    const events: string[] = [];
    const collaboration = {
      flushProject: () => { events.push("flush"); return null; },
      beginSnapshotBarrier: () => events.push("barrier:begin"),
      endSnapshotBarrier: () => { events.push("barrier:end"); return null; }
    } as never;
    const coordinator = new ProjectMutationCoordinator(collaboration);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const read = coordinator.runConsistentRead("project-1", async () => {
      events.push("read:start");
      await gate;
      events.push("read:end");
      return "snapshot";
    });
    const write = coordinator.runWrite("project-1", () => { events.push("write"); });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(events).toEqual(["flush", "barrier:begin", "read:start"]);
    release();
    await expect(read).resolves.toBe("snapshot");
    await expect(write).resolves.toBeUndefined();
    expect(events).toEqual(["flush", "barrier:begin", "read:start", "read:end", "barrier:end", "flush", "write"]);
  });

  it("stops an exclusive mutation when the collaborative flush is not durable", async () => {
    const events: string[] = [];
    const collaboration = {
      flushProject: () => {
        events.push("flush");
        return { revision: 4, persistedAt: "2026-08-20T00:00:00.000Z", ok: false, failedPaths: ["main.tex"] };
      },
      beginMaintenance: () => events.push("begin"),
      endMaintenance: () => events.push("end")
    } as never;
    const coordinator = new ProjectMutationCoordinator(collaboration);

    await expect(coordinator.runExclusive("project-1", "checkout", () => {
      events.push("operation");
    })).rejects.toMatchObject({
      statusCode: 409,
      code: "SOURCE_FLUSH_FAILED",
      failedPaths: ["main.tex"]
    });
    expect(events).toEqual(["flush"]);
  });

  it("stops an ordinary write when the collaborative flush is not durable", async () => {
    let operationRan = false;
    const collaboration = {
      flushProject: () => ({
        revision: 7,
        persistedAt: "2026-08-20T00:00:00.000Z",
        ok: false,
        failedPaths: ["chapters/intro.tex", "refs.bib"]
      })
    } as never;
    const coordinator = new ProjectMutationCoordinator(collaboration);

    await expect(coordinator.runSerialized("project-1", () => {
      operationRan = true;
    })).rejects.toMatchObject({
      statusCode: 409,
      code: "SOURCE_FLUSH_FAILED",
      failedPaths: ["chapters/intro.tex", "refs.bib"]
    });
    expect(operationRan).toBe(false);
  });

  it("does not start a consistent read when its initial flush fails", async () => {
    const events: string[] = [];
    const collaboration = {
      flushProject: () => {
        events.push("flush");
        return { revision: 2, persistedAt: "2026-08-20T00:00:00.000Z", ok: false, failedPaths: ["main.tex"] };
      },
      beginSnapshotBarrier: () => events.push("barrier:begin"),
      endSnapshotBarrier: () => { events.push("barrier:end"); return null; }
    } as never;
    const coordinator = new ProjectMutationCoordinator(collaboration);

    await expect(coordinator.runConsistentRead("project-1", () => {
      events.push("read");
      return "snapshot";
    })).rejects.toMatchObject({ code: "SOURCE_FLUSH_FAILED", failedPaths: ["main.tex"] });
    expect(events).toEqual(["flush"]);
  });

  it("reports a failed deferred flush when a consistent read releases its barrier", async () => {
    const events: string[] = [];
    const collaboration = {
      flushProject: () => { events.push("flush"); return null; },
      beginSnapshotBarrier: () => events.push("barrier:begin"),
      endSnapshotBarrier: () => {
        events.push("barrier:end");
        return { revision: 9, persistedAt: "2026-08-20T00:00:00.000Z", ok: false, failedPaths: ["main.tex"] };
      }
    } as never;
    const coordinator = new ProjectMutationCoordinator(collaboration);

    await expect(coordinator.runConsistentRead("project-1", () => {
      events.push("read");
      return "snapshot";
    })).rejects.toMatchObject({ code: "SOURCE_FLUSH_FAILED", failedPaths: ["main.tex"] });
    expect(events).toEqual(["flush", "barrier:begin", "read", "barrier:end"]);
  });
});
