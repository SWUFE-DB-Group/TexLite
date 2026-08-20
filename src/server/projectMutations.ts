import type { CollaborationSaveReceipt, CollaborationService } from "./collaboration.js";
import { SourceFlushError } from "./http.js";

interface ProjectQueue {
  tail: Promise<void>;
  release: () => void;
}

interface CompileState {
  active: number;
  exclusions: number;
  idleWaiters: Array<() => void>;
  startWaiters: Array<() => void>;
}

interface CompileExclusion {
  waitForIdle: () => Promise<void>;
  release: () => void;
}

interface ProjectMutationOptions {
  /**
   * Revalidate permissions and other request preconditions after waiting for
   * the project queue. This callback must stay synchronous so no Yjs update
   * can interleave between validation, the final flush, and maintenance.
   */
  preflight?: () => void;
  /** Skip the final room flush when the source tree is about to be deleted. */
  flush?: boolean;
}

type ProjectReadOptions = Pick<ProjectMutationOptions, "preflight">;

/**
 * Serializes operations that replace or move a project's source tree.
 *
 * Ordinary Yjs edits remain concurrent. An exclusive operation first flushes
 * the current room, blocks new updates, and resets the collaboration epoch on
 * completion so clients cannot replay edits made against the replaced tree.
 */
export class ProjectMutationCoordinator {
  private readonly queues = new Map<string, ProjectQueue>();
  /**
   * Compilation is deliberately not represented by the ordinary project
   * queue.  A compile runs from an immutable snapshot and may take minutes;
   * keeping it in `queues` would make reads and ordinary edits wait for
   * latexmk.  The separate state below only prevents source-tree replacement
   * and compile-cache cleanup from racing an active compile.
   */
  private readonly compileStates = new Map<string, CompileState>();

  constructor(private readonly collaboration: CollaborationService) {}

  /**
   * Flush the live collaborative room and require a durable result.  A null
   * receipt means that no room is currently loaded, so the source directory
   * is already authoritative for this request.
   */
  flushProject(projectId: string): CollaborationSaveReceipt | null {
    return this.requireSuccessfulFlush(this.collaboration.flushProject(projectId));
  }

  async runExclusive<T>(
    projectId: string,
    reason: string,
    operation: () => Promise<T> | T,
    options: ProjectMutationOptions = {}
  ): Promise<T> {
    const exclusion = this.beginCompileExclusion(projectId);
    try {
      // Do not reserve the ordinary queue until active compilations have
      // drained.  Otherwise a compile waiting for a short snapshot lock could
      // deadlock behind this exclusive operation.
      await exclusion.waitForIdle();
      const reservation = this.reserve(projectId);
      const { previous, tail, release } = reservation;
      await previous;
      try {
        await this.collaboration.waitForReady?.(projectId);
        options.preflight?.();
        // This call is synchronous. No WebSocket event can interleave between
        // the final flush and the maintenance flag being installed.
        if (options.flush !== false) this.flushProject(projectId);
        this.collaboration.beginMaintenance(projectId, reason);
        try {
          return await operation();
        } finally {
          this.collaboration.endMaintenance(projectId);
        }
      } finally {
        release();
        if (this.queues.get(projectId)?.tail === tail) this.queues.delete(projectId);
      }
    } finally {
      exclusion.release();
    }
  }

  /**
   * Run a long-lived compiler job without occupying the source mutation
   * queue. The callback must use an immutable compile snapshot for all source
   * reads. Exclusive source-tree operations and compile-cache cleanup wait for
   * this callback to finish, while ordinary reads and edits continue.
   */
  async runCompile<T>(projectId: string, operation: () => Promise<T> | T): Promise<T> {
    const release = await this.acquireCompile(projectId);
    try {
      return await operation();
    } finally {
      release();
    }
  }

  /**
   * Serialize an operation that removes or replaces compiler state without
   * disconnecting collaborators. This is used by compile-cache/artifact
   * cleanup, which must not run alongside latexmk but does not need the full
   * maintenance mode used by Git checkout or history restore.
   */
  async runCompileExclusive<T>(
    projectId: string,
    operation: () => Promise<T> | T,
    options: ProjectReadOptions = {}
  ): Promise<T> {
    const exclusion = this.beginCompileExclusion(projectId);
    try {
      await exclusion.waitForIdle();
      return await this.runQueued(projectId, operation, options);
    } finally {
      exclusion.release();
    }
  }

  /** Reserve a project operation after queued mutations without flushing. */
  async runSnapshot<T>(
    projectId: string,
    operation: () => Promise<T> | T,
    options: ProjectReadOptions = {}
  ): Promise<T> {
    return this.runQueued(projectId, operation, options);
  }

  /**
   * Serialize a project operation without entering maintenance mode.
   *
   * This is the common short lock for source-tree operations that must not
   * overlap another queued operation, but should not disconnect active
   * collaborators. Long-running compiler processes use `runCompile` instead;
   * they operate on immutable snapshots and do not occupy this queue.
   * The queue is deliberately held until the async operation settles (rather
   * than only until it starts), so filesystem work cannot race another queued
   * operation.
   */
  async runSerialized<T>(
    projectId: string,
    operation: () => Promise<T> | T,
    options: ProjectMutationOptions = {}
  ): Promise<T> {
    return this.runQueued(projectId, async () => {
      if (options.flush !== false) this.flushProject(projectId);
      return operation();
    }, options);
  }

  /**
   * Run a source-tree read under a short snapshot barrier.
   *
   * Yjs edits continue in memory, but autosave and HTTP mutations cannot
   * change the source tree while the asynchronous scan/archive is running.
   * The deferred edits are flushed when the barrier is released.
   */
  async runConsistentRead<T>(
    projectId: string,
    operation: () => Promise<T> | T,
    options: ProjectReadOptions = {}
  ): Promise<T> {
    return this.runQueued(projectId, async () => {
      this.flushProject(projectId);
      let barrierStarted = false;
      try {
        this.collaboration.beginSnapshotBarrier(projectId);
        barrierStarted = true;
        return await operation();
      } finally {
        if (barrierStarted) this.requireSuccessfulFlush(this.collaboration.endSnapshotBarrier(projectId));
      }
    }, options);
  }

  /**
   * Serialize an ordinary filesystem write with compile snapshots without
   * interrupting active collaborators. The operation flushes the current Yjs
   * room first, so an HTTP file operation never overwrites a newer draft.
   */
  async runWrite<T>(
    projectId: string,
    operation: () => Promise<T> | T,
    options: Pick<ProjectMutationOptions, "preflight"> = {}
  ): Promise<T> {
    return this.runSerialized(projectId, operation, options);
  }

  private async runQueued<T>(
    projectId: string,
    operation: () => Promise<T> | T,
    options: ProjectReadOptions
  ): Promise<T> {
    const { previous, tail, release } = this.reserve(projectId);
    await previous;
    try {
      await this.collaboration.waitForReady?.(projectId);
      options.preflight?.();
      return await operation();
    } finally {
      release();
      if (this.queues.get(projectId)?.tail === tail) this.queues.delete(projectId);
    }
  }

  private requireSuccessfulFlush(receipt: CollaborationSaveReceipt | null): CollaborationSaveReceipt | null {
    if (receipt && !receipt.ok) throw new SourceFlushError(receipt.failedPaths ?? []);
    return receipt;
  }

  private reserve(projectId: string): { previous: Promise<void>; tail: Promise<void>; release: () => void } {
    const previous = this.queues.get(projectId)?.tail ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const tail = previous.then(() => gate);
    this.queues.set(projectId, { tail, release });
    return { previous, tail, release };
  }

  private stateFor(projectId: string): CompileState {
    const existing = this.compileStates.get(projectId);
    if (existing) return existing;
    const state: CompileState = { active: 0, exclusions: 0, idleWaiters: [], startWaiters: [] };
    this.compileStates.set(projectId, state);
    return state;
  }

  private beginCompileExclusion(projectId: string): CompileExclusion {
    const state = this.stateFor(projectId);
    state.exclusions += 1;
    let released = false;
    return {
      waitForIdle: () => state.active === 0
        ? Promise.resolve()
        : new Promise<void>((resolve) => state.idleWaiters.push(resolve)),
      release: () => {
        if (released) return;
        released = true;
        state.exclusions = Math.max(0, state.exclusions - 1);
        if (state.exclusions === 0) {
          const waiters = state.startWaiters.splice(0);
          for (const resolve of waiters) resolve();
        }
        this.cleanupCompileState(projectId, state);
      }
    };
  }

  private async acquireCompile(projectId: string): Promise<() => void> {
    const state = this.stateFor(projectId);
    while (state.exclusions > 0) {
      await new Promise<void>((resolve) => state.startWaiters.push(resolve));
    }
    state.active += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      state.active = Math.max(0, state.active - 1);
      if (state.active === 0) {
        const waiters = state.idleWaiters.splice(0);
        for (const resolve of waiters) resolve();
      }
      this.cleanupCompileState(projectId, state);
    };
  }

  private cleanupCompileState(projectId: string, state: CompileState): void {
    if (state.active === 0 && state.exclusions === 0 && state.idleWaiters.length === 0 && state.startWaiters.length === 0) {
      if (this.compileStates.get(projectId) === state) this.compileStates.delete(projectId);
    }
  }
}
