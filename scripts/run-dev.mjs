import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const developmentRoot = path.join(repositoryRoot, ".texlite-dev");
const developmentEnvironment = {
  ...process.env,
  // Always override inherited deployment settings. Running the development
  // server must never attach to the user's normal configuration or database.
  TEXLITE_CONFIG: path.join(developmentRoot, "texlite.config.json"),
  TEXLITE_DATA_DIR: path.join(developmentRoot, "data"),
  TEXLITE_PORT: "3009",
  TEXLITE_DEV_SERVER_PORT: "3009"
};

const mode = process.argv[2] ?? "server";
const command = mode === "web"
  ? ["vite"]
  : mode === "init"
    ? ["tsx", "src/server/cli.ts", "init"]
    : ["tsx", "watch", "src/server/index.ts"];

const child = spawn(command[0], command.slice(1), {
  cwd: repositoryRoot,
  env: developmentEnvironment,
  stdio: "inherit",
  shell: process.platform === "win32"
});

process.once("SIGINT", () => child.kill("SIGINT"));
process.once("SIGTERM", () => child.kill("SIGTERM"));
child.once("exit", (code, signal) => {
  process.exitCode = signal ? 1 : code ?? 1;
});
