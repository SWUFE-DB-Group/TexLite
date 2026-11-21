import { randomUUID } from "node:crypto";
import type WebSocket from "ws";
import { httpError } from "./http.js";
import { drawioPdfPath } from "../shared/drawio.js";

export const DRAWIO_LOCK_TTL_MS = 60_000;
export const DRAWIO_LOCK_PING_MS = 20_000;
interface Lease {
  projectId: string; path: string; userId: string; name: string; token: string;
  socket: WebSocket; expiresAt: number; timer: NodeJS.Timeout; valid: () => boolean;
}

const containsPath = (root: string, file: string) => file === root || file.startsWith(`${root}/`);

/** Runtime-only ownership: a token is valid only while its exact socket owns the lease. */
export class DrawioLocks {
  private readonly leases = new Map<string, Lease>();
  private closed = false;
  constructor(private readonly platform: NodeJS.Platform = process.platform) {}
  private pathIdentity(path: string): string {
    const normalized = path.replace(/\/+$/, "");
    return this.platform === "win32" ? normalized.toLowerCase() : normalized;
  }
  private key(projectId: string, path: string): string { return JSON.stringify([projectId, this.pathIdentity(path)]); }
  private containsPath(root: string, file: string): boolean {
    return containsPath(this.pathIdentity(root), this.pathIdentity(file));
  }
  private active(projectId: string, path: string): Lease | undefined {
    const lease = this.leases.get(this.key(projectId, path));
    if (lease && (lease.expiresAt <= Date.now() || lease.socket.readyState !== 1 || !lease.valid())) {
      this.release(lease); return undefined;
    }
    return lease;
  }

  acquire(projectId: string, path: string, userId: string, name: string, socket: WebSocket, valid: () => boolean, revision = ""): void {
    if (this.closed || !valid()) { socket.close(1008, "Access denied"); return; }
    if (socket.readyState !== 1) return;
    const existing = this.active(projectId, path);
    if (existing) {
      socket.send(JSON.stringify({ type: "busy", name: existing.name })); socket.close(1000); return;
    }
    const token = randomUUID();
    const lease: Lease = { projectId, path, userId, name, token, socket, valid, expiresAt: Date.now() + DRAWIO_LOCK_TTL_MS,
      timer: setInterval(() => {
        if (this.active(projectId, path) !== lease) return;
        try { socket.ping(); } catch { this.release(lease); }
      }, DRAWIO_LOCK_PING_MS) };
    lease.timer.unref();
    this.leases.set(this.key(projectId, path), lease);
    socket.on("pong", () => {
      // A late pong cannot resurrect an expired/replaced lease.
      if (this.active(projectId, path) === lease) lease.expiresAt = Date.now() + DRAWIO_LOCK_TTL_MS;
    });
    socket.on("message", (data) => {
      if (data.toString() === "release") this.release(lease);
    });
    socket.on("close", () => this.release(lease));
    socket.on("error", () => this.release(lease));
    socket.send(JSON.stringify({ type: "acquired", token, revision }));
  }

  assertOwned(projectId: string, path: string, token: unknown, userId: string): void {
    const lease = this.active(projectId, path);
    if (!lease || lease.userId !== userId || lease.token !== token) throw httpError(409, "DRAWIO_LOCK_LOST");
  }

  private *matching(projectId: string, paths: readonly string[]) {
    for (const candidate of this.leases.values()) {
      if (candidate.projectId !== projectId) continue;
      const lease = this.active(projectId, candidate.path);
      if (lease && paths.some((path) => this.containsPath(path, lease.path) || this.containsPath(path, drawioPdfPath(lease.path)))) yield lease;
    }
  }

  assertUnlocked(projectId: string, paths: readonly string[]): void {
    for (const lease of this.matching(projectId, paths)) {
      throw httpError(409, "DRAWIO_LOCKED", { name: lease.name });
    }
  }

  /** The owning editor may delete its source, but not another lease or just its exported PDF. */
  prepareDelete(projectId: string, path: string, userId: string, token: unknown): () => void {
    let removedLease: Lease | undefined;
    for (const lease of this.matching(projectId, [path])) {
      if (lease.userId !== userId || lease.token !== token || !this.containsPath(path, lease.path)) {
        throw httpError(409, "DRAWIO_LOCKED", { name: lease.name });
      }
      removedLease = lease;
    }
    if (token !== undefined && !removedLease) throw httpError(409, "DRAWIO_LOCK_LOST");
    // Run only after the filesystem deletion succeeds, inside the same mutation.
    return () => { if (removedLease) this.release(removedLease); };
  }

  revokeProject(projectId: string): void {
    for (const lease of [...this.leases.values()]) if (lease.projectId === projectId) this.release(lease);
  }
  close(): void {
    this.closed = true;
    for (const lease of [...this.leases.values()]) this.release(lease);
  }
  private release(lease: Lease): void {
    const key = this.key(lease.projectId, lease.path);
    if (this.leases.get(key) !== lease) return;
    this.leases.delete(key); clearInterval(lease.timer);
    // terminate avoids a dead peer keeping the close handshake alive forever.
    if (lease.socket.readyState !== 3) lease.socket.terminate();
  }
}
