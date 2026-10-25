import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const prompts = vi.hoisted(() => ({ answers: [] as string[], question: vi.fn() }));
vi.mock("node:readline/promises", async (importOriginal) => ({
  ...await importOriginal<typeof import("node:readline/promises")>(),
  createInterface: () => ({
    question: prompts.question.mockImplementation(async () => prompts.answers.shift() ?? ""),
    close: vi.fn()
  })
}));
vi.mock("../src/server/environment.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../src/server/environment.js")>(),
  assertEnvironment: vi.fn(async () => [])
}));

describe("CLI initialization configuration", () => {
  let root: string;
  let configPath: string;
  let ttyDescriptor: PropertyDescriptor | undefined;

  beforeEach(() => {
    // Runtime defaults are resolved at module load; import the CLI only after
    // installing isolated XDG paths, never touching the developer's database.
    vi.resetModules();
    root = fs.mkdtempSync(path.join(os.tmpdir(), "texlite-cli-init-"));
    configPath = path.join(root, "config", "texlite.config.json");
    for (const key of Object.keys(process.env)) {
      if (key.startsWith("TEXLITE_")) vi.stubEnv(key, undefined);
    }
    vi.stubEnv("XDG_CONFIG_HOME", path.join(root, "xdg-config"));
    vi.stubEnv("XDG_DATA_HOME", path.join(root, "xdg-data"));
    vi.stubEnv("TEXLITE_INIT_PASSWORD", "test initialization password");
    vi.stubEnv("TEXLITE_INIT_USERNAME", "admin");
    vi.stubEnv("TEXLITE_INIT_DISPLAY_NAME", "Administrator");
    ttyDescriptor = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
    Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true });
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    prompts.answers = [];
    prompts.question.mockClear();
  });

  afterEach(() => {
    if (ttyDescriptor) Object.defineProperty(process.stdin, "isTTY", ttyDescriptor);
    else Reflect.deleteProperty(process.stdin, "isTTY");
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    fs.rmSync(root, { recursive: true, force: true });
  });

  async function initialize() {
    const { main } = await import("../src/server/cli.js");
    await main(["init", "--config", configPath]);
    return JSON.parse(fs.readFileSync(configPath, "utf8"));
  }

  it("writes an empty object for default non-interactive initialization and creates the administrator", async () => {
    expect(await initialize()).toEqual({});
    const { loadConfig } = await import("../src/server/config.js");
    const { openDatabase } = await import("../src/server/db.js");
    const config = loadConfig(configPath);
    expect(config).toMatchObject({
      siteName: "TexLite", dataDir: path.join(root, "xdg-data", "texlite"),
      editHistoryMaxSegments: 20_000, editHistoryMaxStorageBytes: 64 * 1024 * 1024,
      historyMaxStorageBytes: 128 * 1024 * 1024
    });
    const db = openDatabase(config);
    try {
      expect(db.prepare("SELECT username, role FROM users").all()).toEqual([{ username: "admin", role: "admin" }]);
    } finally { db.close(); }
    if (process.platform !== "win32") expect(fs.statSync(configPath).mode & 0o777).toBe(0o600);
    expect(prompts.question).not.toHaveBeenCalled();
  });

  it.each([
    { answers: ["", ""], expected: {} },
    { answers: [" My Lab ", " admin@example.test "], expected: { siteName: "My Lab", adminEmail: "admin@example.test" } },
    { answers: ["TexLite", ""], expected: { siteName: "TexLite" } }
  ])("keeps only explicit interactive choices ($answers)", async ({ answers, expected }) => {
    Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
    prompts.answers = [...answers];
    expect(await initialize()).toEqual(expected);
    expect(prompts.question).toHaveBeenCalledTimes(2);
  });

  it("preserves explicit deployment values, including a port equal to the default", async () => {
    vi.stubEnv("TEXLITE_SITE_NAME", "Lab TeX");
    vi.stubEnv("TEXLITE_ADMIN_EMAIL", "admin@example.test");
    vi.stubEnv("TEXLITE_HOST", "0.0.0.0");
    vi.stubEnv("TEXLITE_PORT", "3000");
    vi.stubEnv("TEXLITE_BASE_PATH", "/tools/texlite/");
    vi.stubEnv("TEXLITE_DATA_DIR", "../custom-data");
    expect(await initialize()).toEqual({
      siteName: "Lab TeX", adminEmail: "admin@example.test",
      server: { host: "0.0.0.0", port: 3000, basePath: "/tools/texlite" },
      storage: { dataDir: "../custom-data" }
    });
    for (const key of ["TEXLITE_SITE_NAME", "TEXLITE_ADMIN_EMAIL", "TEXLITE_HOST", "TEXLITE_PORT", "TEXLITE_BASE_PATH", "TEXLITE_DATA_DIR"]) {
      vi.stubEnv(key, undefined);
    }
    const { loadConfig } = await import("../src/server/config.js");
    expect(loadConfig(configPath)).toMatchObject({
      siteName: "Lab TeX", host: "0.0.0.0", port: 3000, basePath: "/tools/texlite",
      dataDir: path.join(root, "custom-data"), editHistoryMaxSegments: 20_000
    });
  });

  it("retains other environment settings as runtime overrides without freezing them in JSON", async () => {
    vi.stubEnv("TEXLITE_EDIT_HISTORY_MAX_SEGMENTS", "8000");
    vi.stubEnv("TEXLITE_EDIT_HISTORY_MAX_STORAGE_MB", "48");
    expect(await initialize()).toEqual({});
    const { loadConfig } = await import("../src/server/config.js");
    expect(loadConfig(configPath).editHistoryMaxSegments).toBe(8000);
    vi.stubEnv("TEXLITE_EDIT_HISTORY_MAX_SEGMENTS", undefined);
    vi.stubEnv("TEXLITE_EDIT_HISTORY_MAX_STORAGE_MB", undefined);
    expect(loadConfig(configPath)).toMatchObject({ editHistoryMaxSegments: 20_000, editHistoryMaxStorageBytes: 64 * 1024 * 1024 });
  });

  it("writes a supplied port without copying default host, base path or storage settings", async () => {
    vi.stubEnv("TEXLITE_PORT", "3009");
    expect(await initialize()).toEqual({ server: { port: 3009 } });
  });

  it("does not rewrite an existing configuration or its explicitly pinned defaults", async () => {
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    const existing = '{\n  "siteName": "Existing",\n  "editHistory": { "maxStorageMB": 32 }\n}\n';
    fs.writeFileSync(configPath, existing);
    await initialize();
    expect(fs.readFileSync(configPath, "utf8")).toBe(existing);
    const { loadConfig } = await import("../src/server/config.js");
    expect(loadConfig(configPath)).toMatchObject({ editHistoryMaxStorageBytes: 32 * 1024 * 1024, editHistoryMaxSegments: 20_000 });
    await expect(initialize()).rejects.toThrow(/active administrator already exists/);
    expect(fs.readFileSync(configPath, "utf8")).toBe(existing);
  });

  it.each(["3009invalid", "", "70000"])("rejects an invalid explicit port (%j) without writing a configuration", async (port) => {
    vi.stubEnv("TEXLITE_PORT", port);
    await expect(initialize()).rejects.toThrow(/server\.port/);
    expect(fs.existsSync(configPath)).toBe(false);
  });
});
