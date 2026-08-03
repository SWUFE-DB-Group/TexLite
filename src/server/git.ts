import fs from "node:fs";
import path from "node:path";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import type { Config } from "./config.js";
import type { DatabaseConnection, ProjectRow, UserRow } from "./db.js";
import { sourceRoot } from "./files.js";

const MAX_COMMAND_OUTPUT = 8 * 1024 * 1024;
const MAX_DIFF_OUTPUT = 1024 * 1024;

interface GitSettingsRow {
  project_id: string;
  token_ciphertext: string | null;
  github_login: string | null;
  remote_url: string | null;
  repository_name: string | null;
  repository_html_url: string | null;
  default_branch: string;
  created_at: string;
  updated_at: string;
}

export interface GitCommit {
  sha: string;
  shortSha: string;
  authorName: string;
  authorEmail: string;
  authoredAt: string;
  message: string;
}

export interface ProjectGitStatus {
  initialized: boolean;
  tokenConfigured: boolean;
  githubLogin: string | null;
  remoteUrl: string | null;
  repositoryName: string | null;
  repositoryHtmlUrl: string | null;
  defaultBranch: string;
  branch: string | null;
  dirty: boolean;
  restorable: boolean;
  changedFiles: number;
  ahead: number;
  latestCommit: GitCommit | null;
}

interface CommandResult {
  stdout: string;
  stderr: string;
  code: number;
}

type GitHubFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export class ProjectGitService {
  private readonly locks = new Map<string, Promise<void>>();

  constructor(
    private readonly config: Config,
    private readonly db: DatabaseConnection,
    private readonly githubFetch: GitHubFetch = fetch
  ) {}

  async status(project: ProjectRow): Promise<ProjectGitStatus> {
    const settings = this.settings(project.id);
    const initialized = fs.existsSync(path.join(sourceRoot(this.config, project.id), ".git"));
    if (!initialized) return {
      initialized: false,
      tokenConfigured: Boolean(settings?.token_ciphertext),
      githubLogin: settings?.github_login ?? null,
      remoteUrl: settings?.remote_url ?? null,
      repositoryName: settings?.repository_name ?? null,
      repositoryHtmlUrl: settings?.repository_html_url ?? null,
      defaultBranch: settings?.default_branch ?? "main",
      branch: null,
      dirty: false,
      restorable: false,
      changedFiles: 0,
      ahead: 0,
      latestCommit: null
    };
    const root = sourceRoot(this.config, project.id);
    const porcelain = (await this.git(root, ["status", "--porcelain=v1"])).stdout.trim();
    const branchResult = await this.git(root, ["symbolic-ref", "--quiet", "--short", "HEAD"], [1]);
    const branch = branchResult.code === 0 ? branchResult.stdout.trim() : null;
    const remoteResult = await this.git(root, ["remote", "get-url", "origin"], [2]);
    const latestResult = await this.git(root, ["log", "-1", "--format=%H%x1f%h%x1f%an%x1f%ae%x1f%aI%x1f%s"], [128]);
    const aheadResult = await this.git(root, ["rev-list", "--count", "@{upstream}..HEAD"], [128]);
    return {
      initialized: true,
      tokenConfigured: Boolean(settings?.token_ciphertext),
      githubLogin: settings?.github_login ?? null,
      remoteUrl: settings?.remote_url ?? (remoteResult.code === 0 ? remoteResult.stdout.trim() : null),
      repositoryName: settings?.repository_name ?? null,
      repositoryHtmlUrl: settings?.repository_html_url ?? null,
      defaultBranch: settings?.default_branch ?? branch ?? "main",
      branch,
      dirty: Boolean(porcelain),
      restorable: porcelain.split("\n").some((line) => Boolean(line) && !line.startsWith("??")),
      changedFiles: porcelain ? porcelain.split("\n").length : 0,
      ahead: aheadResult.code === 0 ? Number.parseInt(aheadResult.stdout.trim(), 10) || 0 : 0,
      latestCommit: latestResult.code === 0 ? parseCommit(latestResult.stdout.trim()) : null
    };
  }

  async configureToken(project: ProjectRow, tokenInput: string): Promise<ProjectGitStatus> {
    const token = tokenInput.trim();
    if (token.length < 20 || token.length > 500) throw httpError(400, "GitHub token 格式不正确");
    return this.exclusive(project.id, async () => {
      const account = await this.githubRequest<{ login?: unknown }>(token, "/user", { method: "GET" });
      if (typeof account.login !== "string" || !account.login) throw httpError(502, "GitHub 没有返回有效的用户信息");
      await this.ensureRepository(project);
      const timestamp = new Date().toISOString();
      this.db.prepare(`INSERT INTO project_git_settings
        (project_id, token_ciphertext, github_login, default_branch, created_at, updated_at)
        VALUES (?, ?, ?, 'main', ?, ?)
        ON CONFLICT(project_id) DO UPDATE SET token_ciphertext = excluded.token_ciphertext,
          github_login = excluded.github_login, updated_at = excluded.updated_at`)
        .run(project.id, encryptToken(this.config, token), account.login, timestamp, timestamp);
      return this.status(project);
    });
  }

  async removeToken(project: ProjectRow): Promise<ProjectGitStatus> {
    return this.exclusive(project.id, async () => {
      this.db.prepare("UPDATE project_git_settings SET token_ciphertext = NULL, github_login = NULL, updated_at = ? WHERE project_id = ?")
        .run(new Date().toISOString(), project.id);
      return this.status(project);
    });
  }

  async createGitHubRepository(project: ProjectRow, name: string, isPrivate: boolean): Promise<ProjectGitStatus> {
    if (!/^[A-Za-z0-9._-]{1,100}$/.test(name)) throw httpError(400, "GitHub 仓库名称只能包含字母、数字、点、横线或下划线");
    return this.exclusive(project.id, async () => {
      const settings = this.requireTokenSettings(project.id);
      if (settings.remote_url) throw httpError(409, "该项目已经配置远程仓库");
      const token = decryptToken(this.config, settings.token_ciphertext!);
      const repository = await this.githubRequest<{
        name?: unknown; clone_url?: unknown; html_url?: unknown; default_branch?: unknown;
      }>(token, "/user/repos", {
        method: "POST",
        body: JSON.stringify({ name, private: isPrivate, auto_init: false, description: `Backup of ${project.name}` })
      });
      if (typeof repository.clone_url !== "string" || typeof repository.html_url !== "string") {
        throw httpError(502, "GitHub 没有返回有效的仓库地址");
      }
      await this.ensureRepository(project);
      const root = sourceRoot(this.config, project.id);
      const currentRemote = await this.git(root, ["remote", "get-url", "origin"], [2]);
      if (currentRemote.code === 0) await this.git(root, ["remote", "set-url", "origin", repository.clone_url]);
      else await this.git(root, ["remote", "add", "origin", repository.clone_url]);
      const defaultBranch = typeof repository.default_branch === "string" && repository.default_branch
        ? repository.default_branch : "main";
      this.db.prepare(`UPDATE project_git_settings SET remote_url = ?, repository_name = ?,
        repository_html_url = ?, default_branch = ?, updated_at = ? WHERE project_id = ?`)
        .run(repository.clone_url, typeof repository.name === "string" ? repository.name : name,
          repository.html_url, defaultBranch, new Date().toISOString(), project.id);
      return this.status(project);
    });
  }

  async commit(project: ProjectRow, owner: UserRow, messageInput: string): Promise<GitCommit> {
    const message = messageInput.trim();
    if (!message || message.length > 300) throw httpError(400, "提交说明不能为空且不能超过 300 个字符");
    return this.exclusive(project.id, async () => {
      const root = this.requireRepository(project.id);
      const branch = await this.git(root, ["symbolic-ref", "--quiet", "--short", "HEAD"], [1]);
      if (branch.code !== 0) throw httpError(409, "当前处于 detached HEAD，请先返回默认分支再提交");
      await this.git(root, ["add", "--all"]);
      const staged = await this.git(root, ["diff", "--cached", "--quiet"], [1]);
      if (staged.code === 0) throw httpError(409, "当前没有可以提交的修改");
      await this.git(root, [
        "-c", `user.name=${owner.username}`,
        "-c", `user.email=${owner.username}@texlite.com`,
        "-c", "commit.gpgSign=false",
        "-c", "core.hooksPath=/dev/null",
        "commit", "-m", message
      ]);
      const result = await this.git(root, ["log", "-1", "--format=%H%x1f%h%x1f%an%x1f%ae%x1f%aI%x1f%s"]);
      return parseCommit(result.stdout.trim());
    });
  }

  async push(project: ProjectRow): Promise<ProjectGitStatus> {
    return this.exclusive(project.id, async () => {
      const settings = this.requireTokenSettings(project.id);
      if (!settings.remote_url) throw httpError(409, "请先创建 GitHub 仓库");
      const root = this.requireRepository(project.id);
      const head = await this.git(root, ["rev-parse", "--verify", "HEAD"], [128]);
      if (head.code !== 0) throw httpError(409, "请先提交项目修改");
      const branchResult = await this.git(root, ["symbolic-ref", "--quiet", "--short", "HEAD"], [1]);
      if (branchResult.code !== 0) throw httpError(409, "当前处于 detached HEAD，请先返回默认分支再推送");
      const branch = branchResult.stdout.trim();
      if (!/^[A-Za-z0-9._/-]+$/.test(branch)) throw httpError(400, "本地分支名称无效");
      const token = decryptToken(this.config, settings.token_ciphertext!);
      await this.git(root, ["push", "--set-upstream", "origin", `HEAD:refs/heads/${branch}`], [], this.authEnvironment(token));
      return this.status(project);
    });
  }

  async history(project: ProjectRow): Promise<GitCommit[]> {
    const root = this.requireRepository(project.id);
    const result = await this.git(root, ["log", "--all", "-n", "100", "--format=%H%x1f%h%x1f%an%x1f%ae%x1f%aI%x1f%s"], [128]);
    if (result.code !== 0 || !result.stdout.trim()) return [];
    return result.stdout.trim().split("\n").map(parseCommit);
  }

  async diff(project: ProjectRow, revision?: string): Promise<{ title: string; diff: string; truncated: boolean }> {
    const root = this.requireRepository(project.id);
    let title = "Working tree";
    let output = "";
    if (revision) {
      const sha = validateRevision(revision);
      await this.verifyCommit(root, sha);
      title = sha;
      output = (await this.git(root, ["show", "--no-ext-diff", "--format=fuller", "--unified=3", sha, "--"])).stdout;
    } else {
      const hasHead = (await this.git(root, ["rev-parse", "--verify", "HEAD"], [128])).code === 0;
      if (hasHead) output = (await this.git(root, ["diff", "--no-ext-diff", "--unified=3", "HEAD", "--"])).stdout;
      const untracked = (await this.git(root, ["ls-files", "--others", "--exclude-standard", "-z"])).stdout
        .split("\0").filter(Boolean).slice(0, 100);
      for (const file of untracked) {
        const addition = await this.git(root, ["diff", "--no-index", "--", "/dev/null", file], [1]);
        output += `${output && !output.endsWith("\n") ? "\n" : ""}${addition.stdout}`;
        if (Buffer.byteLength(output, "utf8") > MAX_DIFF_OUTPUT) break;
      }
    }
    const bytes = Buffer.byteLength(output, "utf8");
    return {
      title,
      diff: bytes > MAX_DIFF_OUTPUT ? Buffer.from(output).subarray(0, MAX_DIFF_OUTPUT).toString("utf8") : output,
      truncated: bytes > MAX_DIFF_OUTPUT
    };
  }

  async checkout(project: ProjectRow, revisionInput: string | null, force: boolean): Promise<string> {
    return this.exclusive(project.id, async () => {
      const root = this.requireRepository(project.id);
      const settings = this.settings(project.id);
      const revision = revisionInput === null ? settings?.default_branch ?? "main" : validateRevision(revisionInput);
      const target = revisionInput === null ? revision : await this.verifyCommit(root, revision);
      if (force) {
        await this.git(root, ["reset", "--hard", "HEAD"]);
        await this.git(root, ["clean", "-fdx"]);
      }
      await this.git(root, ["-c", "core.hooksPath=/dev/null", "checkout", ...(revisionInput === null ? [] : ["--detach"]), ...(force ? ["--force"] : []), target]);
      return target;
    });
  }

  async discardChanges(project: ProjectRow): Promise<void> {
    return this.exclusive(project.id, async () => {
      const root = this.requireRepository(project.id);
      const head = await this.git(root, ["rev-parse", "--verify", "HEAD"], [128]);
      if (head.code !== 0) throw httpError(409, "该项目尚无可恢复的提交");
      await this.git(root, ["restore", "--source=HEAD", "--staged", "--worktree", "--", "."]);
    });
  }

  private async ensureRepository(project: ProjectRow): Promise<void> {
    const root = sourceRoot(this.config, project.id);
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    if (fs.existsSync(path.join(root, ".git"))) return;
    await this.git(root, ["init"]);
    await this.git(root, ["symbolic-ref", "HEAD", "refs/heads/main"]);
  }

  private requireRepository(projectId: string): string {
    const root = sourceRoot(this.config, projectId);
    if (!fs.existsSync(path.join(root, ".git"))) throw httpError(409, "该项目尚未初始化 Git");
    return root;
  }

  private settings(projectId: string): GitSettingsRow | undefined {
    return this.db.prepare("SELECT * FROM project_git_settings WHERE project_id = ?").get(projectId) as GitSettingsRow | undefined;
  }

  private requireTokenSettings(projectId: string): GitSettingsRow {
    const settings = this.settings(projectId);
    if (!settings?.token_ciphertext) throw httpError(409, "请先配置 GitHub token");
    return settings;
  }

  private async verifyCommit(root: string, revision: string): Promise<string> {
    const result = await this.git(root, ["rev-parse", "--verify", `${revision}^{commit}`], [128]);
    if (result.code !== 0) throw httpError(404, "Git 版本不存在");
    return result.stdout.trim();
  }

  private async githubRequest<T>(token: string, route: string, init: RequestInit): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.gitOperationTimeoutMs);
    try {
      const response = await this.githubFetch(`${this.config.githubApiBaseUrl}${route}`, {
        ...init,
        signal: controller.signal,
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${token}`,
          "X-GitHub-Api-Version": "2026-03-10",
          "User-Agent": "texLite",
          ...(init.body ? { "Content-Type": "application/json" } : {})
        }
      });
      const body = await response.json().catch(() => ({})) as { message?: unknown } & T;
      if (!response.ok) {
        const message = typeof body.message === "string" ? body.message : `HTTP ${response.status}`;
        throw httpError(response.status === 401 || response.status === 403 ? 400 : 502, `GitHub 请求失败：${message}`);
      }
      return body;
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") throw httpError(504, "GitHub 请求超时");
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  private authEnvironment(token: string): NodeJS.ProcessEnv {
    const helper = path.join(this.config.dataDir, "git-askpass.sh");
    if (!fs.existsSync(helper)) {
      fs.writeFileSync(helper, `#!/bin/sh\ncase "$1" in\n  *Username*) printf '%s\\n' 'x-access-token' ;;\n  *) printf '%s\\n' "$TEXLITE_GIT_TOKEN" ;;\nesac\n`, { mode: 0o700 });
    }
    return {
      ...process.env,
      GIT_ASKPASS: helper,
      GIT_ASKPASS_REQUIRE: "force",
      GIT_TERMINAL_PROMPT: "0",
      TEXLITE_GIT_TOKEN: token
    };
  }

  private git(cwd: string, args: string[], allowedCodes: number[] = [], env: NodeJS.ProcessEnv = process.env): Promise<CommandResult> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.config.git, args, { cwd, env, shell: false, stdio: ["ignore", "pipe", "pipe"] });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let size = 0;
      let timedOut = false;
      const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, this.config.gitOperationTimeoutMs);
      const collect = (target: Buffer[]) => (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_COMMAND_OUTPUT) child.kill("SIGKILL");
        else target.push(chunk);
      };
      child.stdout.on("data", collect(stdout));
      child.stderr.on("data", collect(stderr));
      child.once("error", (error) => { clearTimeout(timer); reject(httpError(500, `无法运行 Git：${error.message}`)); });
      child.once("close", (code) => {
        clearTimeout(timer);
        const result = { stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8"), code: code ?? -1 };
        if (timedOut) return reject(httpError(504, "Git 操作超时"));
        if (size > MAX_COMMAND_OUTPUT) return reject(httpError(413, "Git 输出过大"));
        if (result.code !== 0 && !allowedCodes.includes(result.code)) {
          const detail = (result.stderr || result.stdout).trim().slice(0, 2000) || `exit ${result.code}`;
          return reject(httpError(400, `Git 操作失败：${detail}`));
        }
        resolve(result);
      });
    });
  }

  private async exclusive<T>(projectId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(projectId) ?? Promise.resolve();
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const tail = previous.catch(() => undefined).then(() => gate);
    this.locks.set(projectId, tail);
    await previous.catch(() => undefined);
    try {
      return await operation();
    } finally {
      release();
      if (this.locks.get(projectId) === tail) this.locks.delete(projectId);
    }
  }
}

function parseCommit(line: string): GitCommit {
  const [sha = "", shortSha = "", authorName = "", authorEmail = "", authoredAt = "", ...message] = line.split("\x1f");
  return { sha, shortSha, authorName, authorEmail, authoredAt, message: message.join("\x1f") };
}

function validateRevision(value: string): string {
  const revision = value.trim();
  if (!/^[a-f0-9]{7,40}$/i.test(revision)) throw httpError(400, "Git 版本格式不正确");
  return revision;
}

function tokenKey(config: Config): Buffer {
  const target = path.join(config.dataDir, "git-token.key");
  if (!fs.existsSync(target)) {
    fs.mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
    try { fs.writeFileSync(target, randomBytes(32), { flag: "wx", mode: 0o600 }); }
    catch (error) { if (!fs.existsSync(target)) throw error; }
  }
  const key = fs.readFileSync(target);
  if (key.length !== 32) throw httpError(500, "Git token 加密密钥无效");
  return key;
}

function encryptToken(config: Config, token: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", tokenKey(config), iv);
  const encrypted = Buffer.concat([cipher.update(token, "utf8"), cipher.final()]);
  return ["v1", iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), encrypted.toString("base64url")].join(".");
}

function decryptToken(config: Config, encoded: string): string {
  const [version, ivText, tagText, encryptedText] = encoded.split(".");
  if (version !== "v1" || !ivText || !tagText || !encryptedText) throw httpError(500, "GitHub token 无法解密");
  try {
    const decipher = createDecipheriv("aes-256-gcm", tokenKey(config), Buffer.from(ivText, "base64url"));
    decipher.setAuthTag(Buffer.from(tagText, "base64url"));
    return Buffer.concat([decipher.update(Buffer.from(encryptedText, "base64url")), decipher.final()]).toString("utf8");
  } catch {
    throw httpError(500, "GitHub token 无法解密");
  }
}

function httpError(statusCode: number, message: string): Error & { statusCode: number } {
  return Object.assign(new Error(message), { statusCode });
}
