import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { claudeAdapter } from "../src/server/agents/adapters/claude.js";
import type { AgentAdapterContext } from "../src/server/agents/adapters/types.js";

let root: string;
let host: string;
let context: AgentAdapterContext;
const otherId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

function write(relative: string, value = "fixture") {
  const filename = path.join(host, relative);
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  fs.writeFileSync(filename, value);
  return filename;
}
function transcript(id = context.taskId, project = "paper") { return write(`projects/${project}/${id}.jsonl`, "{}"); }

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "texlite-claude-host-"));
  host = path.join(root, "host");
  fs.mkdirSync(host);
  vi.stubEnv("CLAUDE_CONFIG_DIR", host);
  context = { taskId: "11111111-2222-4333-8444-555555555555", nativeSessionId: null,
    executable: "claude", stateDirectory: path.join(root, "task", "state"), workingDirectory: path.join(root, "paper"), features: new Set() };
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  fs.rmSync(root, { recursive: true, force: true });
});

describe("Claude host configuration and owned conversations", () => {
  it("inherits gateway, model, cloud authentication and network settings on start and resume without persisting credentials", async () => {
    const environment: Record<string, string> = {
      ANTHROPIC_BASE_URL: "https://gateway.example.invalid/anthropic",
      ANTHROPIC_AUTH_TOKEN: "fixture gateway token",
      ANTHROPIC_API_KEY: "fixture api key",
      ANTHROPIC_CUSTOM_HEADERS: "X-Gateway: fixture\nX-Team: writers",
      ANTHROPIC_MODEL: "gateway-model",
      ANTHROPIC_DEFAULT_OPUS_MODEL: "gateway-opus",
      ANTHROPIC_DEFAULT_SONNET_MODEL: "gateway-sonnet",
      ANTHROPIC_DEFAULT_HAIKU_MODEL: "gateway-haiku",
      CLAUDE_CODE_OAUTH_TOKEN: "fixture oauth token",
      CLAUDE_CODE_SUBAGENT_MODEL: "gateway-subagent",
      CLAUDE_CODE_SUBAGENT_MODEL_FORCE: "1",
      CLAUDE_CODE_EFFORT_LEVEL: "high",
      CLAUDE_CODE_AUTO_COMPACT_WINDOW: "200000",
      CLAUDE_CODE_AUTOCOMPACT_PCT_OVERRIDE: "80",
      CLAUDE_CODE_MAX_OUTPUT_TOKENS: "16000",
      CLAUDE_CODE_ALWAYS_ENABLE_EFFORT: "1",
      CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING: "1",
      CLAUDE_CODE_DISABLE_1M_CONTEXT: "1",
      CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: "1",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      CLAUDE_CODE_USE_BEDROCK: "0",
      CLAUDE_CODE_USE_VERTEX: "0",
      CLAUDE_CODE_USE_FOUNDRY: "0",
      CLAUDE_CODE_USE_ANTHROPIC_AWS: "0",
      CLAUDE_CODE_SKIP_BEDROCK_AUTH: "1",
      CLAUDE_CODE_SKIP_VERTEX_AUTH: "1",
      CLAUDE_CODE_SKIP_FOUNDRY_AUTH: "1",
      CLAUDE_CODE_SKIP_ANTHROPIC_AWS_AUTH: "1",
      CLAUDE_CODE_SKIP_MANTLE_AUTH: "1",
      AWS_PROFILE: "writers",
      AWS_REGION: "us-east-1",
      AWS_ACCESS_KEY_ID: "fixture access key",
      AWS_SECRET_ACCESS_KEY: "fixture secret key",
      AWS_SESSION_TOKEN: "fixture aws token",
      AWS_BEARER_TOKEN_BEDROCK: "fixture bedrock token",
      AWS_SHARED_CREDENTIALS_FILE: path.join(root, "aws-credentials"),
      AZURE_TENANT_ID: "fixture tenant",
      AZURE_CLIENT_ID: "fixture client",
      AZURE_CLIENT_SECRET: "fixture azure secret",
      GOOGLE_APPLICATION_CREDENTIALS: path.join(root, "google-credentials.json"),
      CLOUD_ML_REGION: "us-central1",
      GCLOUD_PROJECT: "writers-project",
      VERTEX_REGION_CLAUDE_3_5_HAIKU: "us-east5",
      API_TIMEOUT_MS: "1200000",
      MAX_THINKING_TOKENS: "8000",
      CLAUDE_CODE_API_KEY_HELPER_TTL_MS: "300000",
      CLAUDE_CODE_AWS_CHAIN_RESOLVE_TIMEOUT_MS: "90000",
      CLAUDE_CODE_CERT_STORE: "system",
      CLAUDE_CODE_CLIENT_CERT: path.join(root, "client.crt"),
      CLAUDE_CODE_CLIENT_KEY: path.join(root, "client.key"),
      CLAUDE_CODE_CLIENT_KEY_PASSPHRASE: "fixture certificate passphrase",
      HTTPS_PROXY: "http://proxy.example.invalid:8080",
      NO_PROXY: "localhost,127.0.0.1",
      NODE_EXTRA_CA_CERTS: path.join(root, "ca.crt")
    };
    for (const [name, value] of Object.entries(environment)) vi.stubEnv(name, value);
    await claudeAdapter.prepare(context);
    transcript();
    const resumed = { ...context, nativeSessionId: context.taskId };
    await claudeAdapter.prepare(resumed);
    expect(claudeAdapter.start(context).env).toMatchObject(environment);
    expect(claudeAdapter.resume(resumed).env).toMatchObject(environment);
    expect(JSON.parse(fs.readFileSync(path.join(context.stateDirectory, "claude-session.json"), "utf8")))
      .toEqual({ configDirectory: host, defaultHome: null, sessionId: context.taskId });
  });

  it("reads the current service environment for each launch, preserving empty values without caching old settings", async () => {
    vi.stubEnv("ANTHROPIC_BASE_URL", "https://first.example.invalid");
    vi.stubEnv("CLAUDE_CODE_EFFORT_LEVEL", "high");
    vi.stubEnv("CLAUDE_CODE_SUBAGENT_MODEL", "first-model");
    await claudeAdapter.prepare(context);
    const first = claudeAdapter.start(context);
    vi.stubEnv("ANTHROPIC_BASE_URL", "https://second.example.invalid");
    vi.stubEnv("CLAUDE_CODE_EFFORT_LEVEL", "");
    vi.stubEnv("CLAUDE_CODE_SUBAGENT_MODEL", undefined);
    const next = claudeAdapter.resume({ ...context, nativeSessionId: context.taskId });
    expect(first.env).toMatchObject({ ANTHROPIC_BASE_URL: "https://first.example.invalid",
      CLAUDE_CODE_EFFORT_LEVEL: "high", CLAUDE_CODE_SUBAGENT_MODEL: "first-model" });
    expect(next.env).toMatchObject({ ANTHROPIC_BASE_URL: "https://second.example.invalid", CLAUDE_CODE_EFFORT_LEVEL: "" });
    expect(next.env).not.toHaveProperty("CLAUDE_CODE_SUBAGENT_MODEL");
  });

  it("does not inherit unrelated service secrets or another Claude session's runtime and history controls", async () => {
    const excluded = ["TEXLITE_SECRET", "DATABASE_URL", "NODE_OPTIONS", "CLAUDECODE", "CLAUDE_CODE_SESSION_ID",
      "CLAUDE_CODE_CHILD_SESSION", "CLAUDE_CODE_REMOTE_SESSION_ID", "CLAUDE_CODE_BRIDGE_SESSION_ID",
      "CLAUDE_CODE_TASK_LIST_ID", "CLAUDE_CODE_SKIP_PROMPT_HISTORY"];
    for (const name of excluded) vi.stubEnv(name, "unrelated-host-value");
    await claudeAdapter.prepare(context);
    const start = claudeAdapter.start(context);
    const resume = claudeAdapter.resume({ ...context, nativeSessionId: context.taskId });
    for (const name of excluded) {
      expect(start.env).not.toHaveProperty(name);
      expect(resume.env).not.toHaveProperty(name);
    }
    expect(start.args).toEqual(["--session-id", context.taskId]);
    expect(resume.args).toEqual(["--resume", context.taskId]);
  });

  it("uses host onboarding, credentials, settings and plugins without copying them", async () => {
    const state = write(".claude.json", JSON.stringify({ hasCompletedOnboarding: true }));
    const settings = write("settings.json", JSON.stringify({ theme: "dark", model: "host-model" }));
    const credentials = write(".credentials.json", "host fixture credentials");
    const plugin = write("plugins/fixture/config.json");
    const before = [state, settings, credentials, plugin].map((filename) => fs.readFileSync(filename, "utf8"));
    vi.stubEnv("XDG_CACHE_HOME", path.join(root, "cache"));
    await claudeAdapter.prepare(context);
    const launch = claudeAdapter.start(context);
    expect(launch.env.CLAUDE_CONFIG_DIR).toBe(host);
    expect(launch.env.XDG_CACHE_HOME).toBe(path.join(root, "cache"));
    expect(launch.args).toEqual(["--session-id", context.taskId]);
    expect(fs.existsSync(path.join(context.stateDirectory, "claude"))).toBe(false);
    expect([state, settings, credentials, plugin].map((filename) => fs.readFileSync(filename, "utf8"))).toEqual(before);
    const other = { ...context, taskId: otherId, stateDirectory: path.join(root, "other", "state") };
    await claudeAdapter.prepare(other);
    expect(claudeAdapter.start(other).env.CLAUDE_CONFIG_DIR).toBe(host);
    expect(claudeAdapter.start(other).args).toEqual(["--session-id", otherId]);
  });

  it("keeps CLAUDE_CONFIG_DIR unset for native default-home onboarding discovery", async () => {
    vi.stubEnv("CLAUDE_CONFIG_DIR", undefined);
    const home = path.join(root, "home");
    fs.mkdirSync(home);
    vi.spyOn(os, "homedir").mockReturnValue(home);
    const state = path.join(home, ".claude.json");
    fs.writeFileSync(state, JSON.stringify({ hasCompletedOnboarding: true, theme: "dark" }));
    await claudeAdapter.prepare(context);
    vi.mocked(os.homedir).mockReturnValue(path.join(root, "different-home"));
    vi.stubEnv("CLAUDE_CONFIG_DIR", path.join(root, "different-config"));
    const launch = claudeAdapter.start(context);
    expect(launch.env.CLAUDE_CONFIG_DIR).toBeUndefined();
    expect(launch.env.HOME).toBe(home);
    if (process.platform === "win32") expect(launch.env.USERPROFILE).toBe(home);
    expect(JSON.parse(fs.readFileSync(state, "utf8"))).toEqual({ hasCompletedOnboarding: true, theme: "dark" });
    expect(fs.existsSync(path.join(home, ".claude", ".claude.json"))).toBe(false);
  });

  it("pins a registered conversation across configuration changes and ignores unrelated sessions", async () => {
    transcript(otherId);
    await claudeAdapter.prepare(context);
    expect(await claudeAdapter.findNativeSession(context)).toEqual({ status: "empty" });
    transcript();
    vi.stubEnv("CLAUDE_CONFIG_DIR", path.join(root, "new-host"));
    const resumed = { ...context, nativeSessionId: context.taskId };
    await claudeAdapter.prepare(resumed);
    expect(claudeAdapter.resume(resumed)).toMatchObject({ args: ["--resume", context.taskId], env: { CLAUDE_CONFIG_DIR: host } });
    expect(await claudeAdapter.findNativeSession(resumed)).toEqual({ status: "found", id: context.taskId });
    await expect(claudeAdapter.prepare({ ...resumed, nativeSessionId: otherId })).rejects.toMatchObject({ code: "AGENT_NO_CONTEXT" });
    expect(() => claudeAdapter.resume({ ...resumed, nativeSessionId: otherId })).toThrow();
  });

  it("refuses to claim a pre-existing host conversation with the task's ID", async () => {
    const existing = transcript();
    await expect(claudeAdapter.prepare(context)).rejects.toMatchObject({ code: "AGENT_CONTEXT_CHECK_FAILED" });
    expect(fs.existsSync(path.join(context.stateDirectory, "claude-session.json"))).toBe(false);
    await expect(claudeAdapter.cleanup(context)).rejects.toMatchObject({ code: "AGENT_CLEANUP_FAILED" });
    expect(fs.readFileSync(existing, "utf8")).toBe("{}");
  });

  it("does not recreate a saved conversation deleted outside TexLite", async () => {
    await claudeAdapter.prepare(context);
    const saved = transcript();
    fs.unlinkSync(saved);
    await expect(claudeAdapter.prepare({ ...context, nativeSessionId: context.taskId })).rejects.toMatchObject({ code: "AGENT_NO_CONTEXT" });
    expect(fs.existsSync(saved)).toBe(false);
    await claudeAdapter.cleanup(context);
  });

  it("deletes only registered session files, preserving other conversations and global state", async () => {
    const another = { ...context, taskId: otherId, stateDirectory: path.join(root, "other", "state") };
    await claudeAdapter.prepare(context);
    await claudeAdapter.prepare(another);
    const owned = [transcript(), transcript(context.taskId, "another-project"),
      write(`projects/paper/${context.taskId}/subagents/agent.jsonl`),
      write(`projects/paper/${context.taskId}.orphaned-123-test.jsonl`),
      write(`projects/paper/${context.taskId}.jsonl.superseded-123`),
      ...["file-history", "session-env", "tasks", "image-cache"].map((directory) => write(`${directory}/${context.taskId}/data`)),
      write(`debug/${context.taskId}.txt`)];
    const preserved = [transcript(otherId), write("settings.json"), write(".credentials.json"), write(".claude.json"),
      write("history.jsonl"), write("plugins/config.json"), write("projects/paper/memory/MEMORY.md"),
      write(`projects/paper/${context.taskId}.jsonl.bak`), write(`file-history/${otherId}/data`)];
    await claudeAdapter.cleanup({ ...context, nativeSessionId: context.taskId });
    await claudeAdapter.cleanup({ ...context, nativeSessionId: context.taskId });
    expect(owned.map((filename) => fs.existsSync(filename))).toEqual(owned.map(() => false));
    expect(preserved.map((filename) => fs.existsSync(filename))).toEqual(preserved.map(() => true));
    expect(await claudeAdapter.findNativeSession(another)).toEqual({ status: "found", id: otherId });
    expect(await claudeAdapter.findNativeSession(context)).toEqual({ status: "empty" });
  });

  it("fails cleanup on an unreadable or ambiguous store instead of reporting success", async () => {
    await claudeAdapter.prepare(context);
    write("projects", "not a transcript directory");
    expect(await claudeAdapter.findNativeSession(context)).toEqual({ status: "unknown" });
    await expect(claudeAdapter.cleanup(context)).rejects.toThrow();
    expect(fs.existsSync(path.join(context.stateDirectory, "claude-session.json"))).toBe(true);
  });

  it("supports host transcript directories linked to another storage location", async () => {
    const storage = path.join(root, "storage");
    const paper = path.join(root, "paper-transcripts");
    fs.mkdirSync(storage);
    fs.mkdirSync(paper);
    const type = process.platform === "win32" ? "junction" : "dir";
    fs.symlinkSync(storage, path.join(host, "projects"), type);
    fs.symlinkSync(paper, path.join(storage, "paper"), type);
    await claudeAdapter.prepare(context);
    const owned = path.join(paper, `${context.taskId}.jsonl`);
    const unrelated = path.join(paper, `${otherId}.jsonl`);
    fs.writeFileSync(owned, "{}");
    fs.writeFileSync(unrelated, "native conversation");
    expect(await claudeAdapter.findNativeSession(context)).toEqual({ status: "found", id: context.taskId });
    await claudeAdapter.cleanup(context);
    expect(fs.existsSync(owned)).toBe(false);
    expect(fs.readFileSync(unrelated, "utf8")).toBe("native conversation");
    expect(fs.existsSync(path.join(storage, "paper"))).toBe(true);
  });

  it("does not fall back to a different host when the ownership binding is damaged", async () => {
    await claudeAdapter.prepare(context);
    const saved = transcript();
    fs.writeFileSync(path.join(context.stateDirectory, "claude-session.json"), "{}");
    expect(() => claudeAdapter.start(context)).toThrow();
    expect(await claudeAdapter.findNativeSession(context)).toEqual({ status: "unknown" });
    await expect(claudeAdapter.cleanup(context)).rejects.toThrow();
    expect(fs.existsSync(saved)).toBe(true);
    fs.unlinkSync(path.join(context.stateDirectory, "claude-session.json"));
    await expect(claudeAdapter.cleanup({ ...context, nativeSessionId: context.taskId })).rejects.toMatchObject({ code: "AGENT_CLEANUP_FAILED" });
    expect(fs.existsSync(saved)).toBe(true);
  });

  it("does not import an old private conversation into shared host state", async () => {
    const old = path.join(context.stateDirectory, "claude", "projects", "paper", `${context.taskId}.jsonl`);
    fs.mkdirSync(path.dirname(old), { recursive: true });
    fs.writeFileSync(old, "old private conversation");
    await expect(claudeAdapter.prepare({ ...context, nativeSessionId: context.taskId })).rejects.toMatchObject({ code: "AGENT_NO_CONTEXT" });
    expect(await claudeAdapter.findNativeSession(context)).toEqual({ status: "unknown" });
    await expect(claudeAdapter.cleanup(context)).rejects.toMatchObject({ code: "AGENT_CLEANUP_FAILED" });
    expect(fs.existsSync(path.join(host, "projects"))).toBe(false);
  });
});
