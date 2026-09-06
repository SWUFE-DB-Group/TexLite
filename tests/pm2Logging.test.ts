import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ProcessDescription, StartOptions } from "pm2";
import { expect, it, vi } from "vitest";
import type { Config } from "../src/server/config.js";
import { restartManaged, startManaged } from "../src/server/pm2.js";

const state = vi.hoisted(() => ({ options: [] as StartOptions[], processes: [] as ProcessDescription[], deleted: [] as unknown[] }));
vi.mock("pm2", () => ({ default: {
  connect: (done: () => void) => done(),
  disconnect: () => {},
  list: (done: (error: null, processes: ProcessDescription[]) => void) => done(null, state.processes),
  start: (options: StartOptions, done: (error: null, process: ProcessDescription) => void) => {
    state.options.push(options);
    done(null, { name: options.name });
  },
  delete: (id: unknown, done: () => void) => { state.deleted.push(id); done(); }
} }));

it("starts with configured fixed logs and migrates old log paths on restart", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "texlite-pm2-logs-"));
  try {
    const config = { configPath: path.join(root, "config.json"), dataDir: path.join(root, "data"), clientDir: path.join(root, "client") } as Config;
    const started = await startManaged(config);
    expect(state.options[0]).toMatchObject({
      output: path.join(config.dataDir, "logs", "stdout.log"),
      error: path.join(config.dataDir, "logs", "stderr.log"),
      merge_logs: true, env: { TEXLITE_MANAGED_LOGS: "1" }
    });
    expect(fs.statSync(path.join(config.dataDir, "logs")).isDirectory()).toBe(true);
    state.processes = [{ name: started.name, pm_id: 40, pm2_env: {
      env: { TEXLITE_CONFIG: config.configPath }, pm_out_log_path: "/old/texlite-out-40.log"
    } } as unknown as ProcessDescription];
    const relocated = { ...config, dataDir: path.join(root, "relocated") };
    await restartManaged(relocated);
    expect(state.deleted).toEqual([40]);
    expect(state.options[1]).toMatchObject({ output: path.join(relocated.dataDir, "logs", "stdout.log"), error: path.join(relocated.dataDir, "logs", "stderr.log") });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
