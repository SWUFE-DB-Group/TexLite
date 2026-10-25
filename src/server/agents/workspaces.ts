import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { makeDiff } from "@sanity/diff-match-patch";
import { isTextContent } from "../../shared/fileTypes.js";
import type { Config } from "../config.js";
import type { DatabaseConnection, UserRow } from "../db.js";
import type { CollaborationService } from "../collaboration.js";
import { isCollaborativeTextFile, maxCollaborativeFileBytes } from "../collaboration.js";
import { assertNoSourceSymlinks, outputRoot, resolveSourcePath, sourceRoot } from "../files.js";
import { httpError } from "../http.js";
import type { ProjectMutationCoordinator } from "../projectMutations.js";
import { requireEditableProject, touchProject } from "../routes/projectShared.js";
import { reanchorFileComments } from "../anchors.js";
import { hashText, type EditHistorySegmentInput } from "../editHistory.js";

export function agentTaskRoot(config: Config, taskId: string): string {
  if (!/^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i.test(taskId)) throw httpError(404, "AGENT_SESSION_NOT_FOUND");
  return path.join(config.dataDir, "agent-tasks", taskId);
}

export interface AgentWorkspaceContext {
  config: Config;
  db: DatabaseConnection;
  collaboration: CollaborationService;
  projectMutations: ProjectMutationCoordinator;
  recordHistory: (projectId: string, userId: string | null, reason: "file", paths?: readonly string[]) => unknown;
  recordEdits: (projectId: string, edits: readonly EditHistorySegmentInput[]) => void;
}

/** Same package-relative template path in the source checkout and compiled npm installation. */
const agentInstructionsTemplate = new URL("../../../templates/agents/AGENTS.md", import.meta.url);

export async function ensureAgentInstructions(context: AgentWorkspaceContext, projectId: string, user: UserRow): Promise<void> {
  const { config, db, projectMutations, collaboration, recordHistory } = context;
  await projectMutations.runWrite(projectId, async () => {
    const target = resolveSourcePath(config, projectId, "AGENTS.md");
    try { await fs.promises.copyFile(agentInstructionsTemplate, target, fs.constants.COPYFILE_EXCL); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return;
      throw error;
    }
    collaboration.updateFile(projectId, "AGENTS.md", await fs.promises.readFile(target, "utf8"), user.id);
    touchProject(db, projectId, user.id);
    recordHistory(projectId, user.id, "file", ["AGENTS.md"]);
  }, { preflight: () => { requireEditableProject(db, projectId, user); } });
}

interface FileState { signature: string; text: string | null }
interface Change { from: number; to: number; insert: string }
const ignored = (name: string) => name === ".git" || name === ".texlite-agent-conflicts" || /\.(?:collaboration-\d+-[^.]+|agent-[^.]+)\.tmp$/.test(name);

function changes(before: string, after: string): Change[] {
  const result: Change[] = [];
  let offset = 0;
  let pending: Change | undefined;
  for (const [kind, text] of makeDiff(before, after, { checkLines: true, timeout: 1 })) {
    if (kind === 0) { if (pending) result.push(pending); pending = undefined; offset += text.length; }
    else {
      pending ??= { from: offset, to: offset, insert: "" };
      if (kind === -1) { offset += text.length; pending.to = offset; }
      else pending.insert += text;
    }
  }
  if (pending) result.push(pending);
  return result;
}

/** Conservative three-way merge: never fuzzy-apply overlapping replacements. */
export function mergeAgentText(base: string, editor: string, agent: string): string | null {
  if (base === editor || editor === agent) return agent;
  if (base === agent) return editor;
  const human = changes(base, editor);
  const external = changes(base, agent);
  const combined = [...human];
  for (const edit of external) {
    if (human.some((other) => edit.from === other.from && edit.to === other.to && edit.insert === other.insert)) continue;
    if (human.some((other) => Math.max(edit.from, other.from) < Math.min(edit.to, other.to)
      || (edit.from === edit.to && edit.from >= other.from && edit.from <= other.to)
      || (other.from === other.to && other.from >= edit.from && other.from <= edit.to))) return null;
    combined.push(edit);
  }
  let merged = base;
  for (const edit of combined.sort((a, b) => b.from - a.from)) merged = merged.slice(0, edit.from) + edit.insert + merged.slice(edit.to);
  return merged;
}

/** A running task observes the real source tree; it owns no project copies. */
export class AgentSourceSync {
  private readonly known = new Map<string, FileState>();
  private detach: (() => void) | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private pending: Promise<void> | undefined;
  private closed = false;
  private syncing = false;

  constructor(private readonly context: AgentWorkspaceContext, private readonly taskId: string,
    private readonly projectId: string, private readonly userId: string, private readonly onError: (error: unknown) => void) {}

  async start(): Promise<void> {
    const { config, projectMutations, collaboration } = this.context;
    await projectMutations.runConsistentRead(this.projectId, async () => {
      assertNoSourceSymlinks(config, this.projectId);
      for (const relative of await this.files()) this.remember(relative);
      this.detach = collaboration.observeExternalSources(this.projectId, {
        beforeFlush: (paths) => this.sync(paths),
        written: (paths) => {
          if (this.syncing) return;
          // Ordinary browser/HTTP writes are not attributed to the agent.
          for (const relative of paths) {
            for (const old of this.known.keys()) if (old.startsWith(relative + "/")) this.known.delete(old);
            this.rememberTree(relative);
          }
        }
      });
    });
    this.schedule();
  }

  /** Stop polling only after the process tree is dead; reconcile its last writes first. */
  async close(): Promise<void> {
    this.closed = true;
    clearTimeout(this.timer);
    await this.pending;
    try { await this.scan(); }
    finally { this.detach?.(); }
  }

  private schedule(): void {
    if (this.closed) return;
    this.timer = setTimeout(() => {
      this.pending = this.scan().catch((error) => this.report(error)).finally(() => { this.pending = undefined; this.schedule(); });
    }, 750);
    this.timer.unref();
  }

  private async scan(): Promise<void> {
    const paths = await this.files();
    await this.context.projectMutations.runSnapshot(this.projectId, () => {
      this.sync([...new Set([...this.known.keys(), ...paths])]);
      this.context.projectMutations.flushProject(this.projectId);
    });
  }

  private async files(): Promise<string[]> {
    const result: string[] = [];
    const visit = async (directory: string, prefix: string): Promise<void> => {
      let entries: fs.Dirent[];
      try {
        const stat = await fs.promises.lstat(directory);
        if (stat.isSymbolicLink() || !stat.isDirectory()) throw httpError(409, "SYMLINK_FORBIDDEN", { path: prefix || "." });
        entries = await fs.promises.readdir(directory, { withFileTypes: true });
      }
      catch (error) { if (prefix && (error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
      for (const entry of entries) {
        if (ignored(entry.name)) continue;
        const relative = prefix ? prefix + "/" + entry.name : entry.name;
        if (entry.isSymbolicLink() || (!entry.isDirectory() && !entry.isFile())) throw httpError(409, "SYMLINK_FORBIDDEN", { path: relative });
        if (entry.isDirectory()) await visit(path.join(directory, entry.name), relative);
        else result.push(relative);
      }
    };
    await visit(sourceRoot(this.context.config, this.projectId), "");
    return result;
  }

  private read(relative: string): FileState | null {
    const { config } = this.context;
    const filename = resolveSourcePath(config, this.projectId, relative);
    let stat: fs.Stats;
    try { stat = fs.lstatSync(filename); }
    catch (error) { if (["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) return null; throw error; }
    if (stat.isDirectory()) return null;
    if (!stat.isFile()) throw httpError(409, "SYMLINK_FORBIDDEN", { path: relative });
    const signature = [stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs].join(":");
    const previous = this.known.get(relative);
    if (previous?.signature === signature) return previous;
    const bytes = stat.size <= maxCollaborativeFileBytes(config) ? fs.readFileSync(filename) : null;
    return { signature, text: bytes && isTextContent(bytes) ? bytes.toString("utf8") : null };
  }

  private remember(relative: string): void {
    const state = this.read(relative);
    if (state) this.known.set(relative, state); else this.known.delete(relative);
  }

  private rememberTree(relative: string): void {
    const absolute = resolveSourcePath(this.context.config, this.projectId, relative);
    if (fs.existsSync(absolute) && fs.lstatSync(absolute).isDirectory()) {
      for (const entry of fs.readdirSync(absolute)) if (!ignored(entry)) this.rememberTree(relative + "/" + entry);
    } else this.remember(relative);
  }

  private sync(paths: readonly string[]): void {
    if (this.syncing) return;
    this.syncing = true;
    const { config, db, collaboration, recordEdits, recordHistory } = this.context;
    const changed: string[] = [];
    let conflict = false;
    try {
      for (const relative of paths) {
        if (relative.split("/").some(ignored)) continue;
        const before = this.known.get(relative);
        const after = this.read(relative);
        if (before?.signature === after?.signature || (!before && !after)) continue;
        if (before?.text === after?.text && before && after && after.text !== null) { this.known.set(relative, after); continue; }
        const live = collaboration.fileContent(this.projectId, relative);
        let next = after?.text ?? null;
        if (live !== null && before?.text !== null && before?.text !== undefined && live !== before.text) {
          const merged = next === null ? null : mergeAgentText(before.text, live, next);
          if (merged === null) {
            // Preserve the agent's version in an editable project file, never
            // silently discard either side of a simultaneous replacement.
            if (after) {
              const recovery = resolveSourcePath(config, this.projectId, ".texlite-agent-conflicts/" + this.taskId + "/" + relative);
              fs.mkdirSync(path.dirname(recovery), { recursive: true, mode: 0o700 });
              fs.copyFileSync(resolveSourcePath(config, this.projectId, relative), recovery);
            }
            this.write(relative, live);
            this.remember(relative);
            conflict = true;
            collaboration.invalidateSourceTree(this.projectId);
            continue;
          }
          next = merged;
        }
        if (next !== null) {
          if (next !== after?.text) this.write(relative, next);
          if (!collaboration.importExternalText(this.projectId, relative, next, this.userId)) {
            const previous = before?.text ?? "";
            reanchorFileComments(db, this.projectId, relative, previous, next);
            collaboration.updateFile(this.projectId, relative, next, this.userId);
            if (isCollaborativeTextFile(relative) && previous !== next) recordEdits(this.projectId, [externalEdit(relative, previous, next, this.userId)]);
          }
        } else {
          collaboration.removePath(this.projectId, relative);
          if (!after) {
            // Source deletion retains orphaned discussion instead of deleting it.
            reanchorFileComments(db, this.projectId, relative, before?.text ?? "", "");
            db.prepare("UPDATE projects SET latexmkrc = NULL WHERE id = ? AND latexmkrc = ?").run(this.projectId, relative);
          }
          collaboration.invalidateSourceTree(this.projectId, relative);
        }
        this.remember(relative);
        changed.push(relative);
      }
    } finally {
      this.syncing = false;
      if (changed.length) {
        touchProject(db, this.projectId, this.userId);
        recordHistory(this.projectId, this.userId, "file", changed);
        collaboration.signalComments(this.projectId);
      }
    }
    if (conflict) this.report(httpError(409, "AGENT_SYNC_CONFLICT"));
  }

  private report(error: unknown): void {
    this.closed = true;
    clearTimeout(this.timer);
    this.onError(error);
  }

  private write(relative: string, content: string): void {
    const target = resolveSourcePath(this.context.config, this.projectId, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    const temporary = target + ".agent-" + randomUUID() + ".tmp";
    try { fs.writeFileSync(temporary, content, { mode: 0o600 }); fs.renameSync(temporary, target); }
    finally { fs.rmSync(temporary, { force: true }); }
  }
}

/** Provide logs outside the source tree without introducing generated project files. */
export async function writeAgentProjectContext(context: AgentWorkspaceContext, taskId: string, projectId: string): Promise<void> {
  const { config, db } = context;
  const project = db.prepare("SELECT main_file FROM projects WHERE id = ?").get(projectId) as { main_file: string };
  const latest = db.prepare("SELECT id, status, log FROM compile_runs WHERE project_id = ? AND main_file = ? ORDER BY created_at DESC LIMIT 1")
    .get(projectId, project.main_file) as { id: string; status: string; log: string } | undefined;
  const state = path.join(agentTaskRoot(config, taskId), "state");
  await fs.promises.mkdir(state, { recursive: true, mode: 0o700 });
  await fs.promises.writeFile(path.join(state, "compile.log"), latest?.log ?? "No compilation has been recorded.\n", { mode: 0o600 });
  await fs.promises.writeFile(path.join(state, "project-context.json"), JSON.stringify({ sourceDirectory: sourceRoot(config, projectId),
    mainFile: project.main_file, outputDirectory: outputRoot(config, projectId),
    latestCompile: latest ? { runId: latest.id, status: latest.status } : null,
    compileLog: path.join(state, "compile.log") }, null, 2), { mode: 0o600 });
}

function externalEdit(filePath: string, before: string, after: string, authorId: string): EditHistorySegmentInput {
  const createdAt = new Date().toISOString();
  let shift = 0;
  const spans = changes(before, after).map((edit) => {
    const afterStart = edit.from + shift;
    shift += edit.insert.length - (edit.to - edit.from);
    return { beforeStart: edit.from, beforeEnd: edit.to, afterStart, afterEnd: afterStart + edit.insert.length,
      deletedLength: edit.to - edit.from, insertedLength: edit.insert.length, deletedPreview: before.slice(edit.from, edit.to).slice(0, 6000),
      insertedPreview: edit.insert.slice(0, 6000), truncated: edit.to - edit.from > 6000 || edit.insert.length > 6000 };
  });
  return { filePath, authorId, kind: "edit", beforeHash: hashText(before), afterHash: hashText(after), createdAt, updatedAt: createdAt,
    steps: [{ beforeHash: hashText(before), afterHash: hashText(after), createdAt, spans }] };
}
