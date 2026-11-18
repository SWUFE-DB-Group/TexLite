import assert from "node:assert/strict";
import { execFileSync, fork } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repository = fileURLToPath(new URL("..", import.meta.url));
const npmCli = process.env.npm_execpath;
assert.ok(npmCli, "Run this script with npm run test:package-smoke");
const windows = process.platform === "win32";
const host = "127.0.0.1";
const username = "smoke-admin";
const password = "local-package-smoke-password";

function run(executable, args, options) {
  return execFileSync(executable, args, {
    encoding: "utf8", stdio: ["ignore", "pipe", "inherit"], timeout: 30_000, ...options
  }).trim();
}

async function choosePort() {
  const listener = net.createServer().listen(0, host);
  await once(listener, "listening");
  const { port } = listener.address();
  await new Promise((resolve, reject) => listener.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function exerciseServer(cli, root, env, dataDir, port) {
  const child = fork(cli, ["serve"], { cwd: root, env, stdio: ["ignore", "inherit", "inherit", "ipc"] });
  const exited = once(child, "exit");
  try {
    const [message] = await Promise.race([
      once(child, "message", { signal: AbortSignal.timeout(25_000) }),
      exited.then(([code]) => { throw new Error("Installed server exited before readiness: " + code); })
    ]);
    assert.equal(message, "ready");
    const address = "http://" + host + ":" + port;
    const fetchLocal = (url, options) => fetch(address + url, { signal: AbortSignal.timeout(5_000), ...options });
    const health = await fetchLocal("/api/health");
    assert.equal(health.status, 200);
    assert.equal((await health.json()).pid, child.pid);
    const site = await fetchLocal("/api/config");
    assert.equal(site.status, 200);
    assert.deepEqual((await site.json()).allowedEngines, ["xelatex"]);
    const page = await fetchLocal("/");
    assert.equal(page.status, 200);
    assert.match(await page.text(), /<div id="root">/);
    const login = await fetchLocal("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password })
    });
    assert.equal(login.status, 200);
    assert.equal((await login.json()).user.username, username);

    const stopped = once(child, "exit", { signal: AbortSignal.timeout(15_000) });
    if (windows) child.send("shutdown");
    else child.kill("SIGTERM");
    assert.deepEqual(await stopped, [0, null]);
    assert.equal(fs.existsSync(path.join(dataDir, ".texlite.lock")), false, "Clean shutdown must release the data directory lock");
  } finally {
    if (child.pid && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await exited.catch(() => undefined);
  }
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), "TexLite npm smoke "));
try {
  const prefix = path.join(root, "prefix");
  const npm = (args, cwd) => run(process.execPath, [npmCli, ...args], { cwd, timeout: 240_000 });
  const [packed] = JSON.parse(npm(["pack", "--ignore-scripts", "--json", "--pack-destination", root], repository));
  const installed = npm([
    "install", "--global", "--prefix", prefix, "--omit=dev", "--prefer-offline", "--no-audit", "--no-fund",
    path.join(root, packed.filename)
  ], root);
  if (installed) console.log(installed);
  const shim = windows ? path.join(prefix, "texlite.cmd") : path.join(prefix, "bin", "texlite");
  const version = windows
    ? run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "& $env:TEXLITE_SMOKE_BIN --version; exit $LASTEXITCODE"],
      { cwd: root, env: { ...process.env, TEXLITE_SMOKE_BIN: shim } })
    : run(shim, ["--version"], { cwd: root });
  assert.equal(version, packed.version);
  const packageDirectory = path.join(prefix, ...(windows ? [] : ["lib"]), "node_modules", "texlite");
  const manifest = JSON.parse(fs.readFileSync(path.join(packageDirectory, "package.json"), "utf8"));
  const cli = path.join(packageDirectory, manifest.bin.texlite);

  const tools = path.join(root, "version fixtures");
  fs.mkdirSync(tools);
  // Test initial setup with the built-in allowlist, then narrow it below.
  // These fixtures only implement version checks; no TeX runs.
  for (const name of ["latexmk", "pdflatex", "xelatex", "lualatex"]) {
    const target = path.join(tools, name + (windows ? ".exe" : ""));
    if (windows) fs.copyFileSync(process.execPath, target);
    else fs.symlinkSync(process.execPath, target);
  }
  const dataDir = path.join(root, "data");
  const configPath = path.join(root, "config", "texlite.json");
  const port = await choosePort();
  const env = {
    ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(?:TEXLITE_.*|PATH|NODE_PATH)$/i.test(key))),
    PATH: tools,
    TEXLITE_CONFIG: configPath,
    TEXLITE_DATA_DIR: dataDir,
    TEXLITE_HOST: host,
    TEXLITE_PORT: String(port),
    TEXLITE_INIT_USERNAME: username,
    TEXLITE_INIT_PASSWORD: password
  };
  const cliOutput = (args) => run(process.execPath, [cli, ...args], { cwd: root, env });
  assert.equal(JSON.parse(cliOutput(["requirements", "--json"])).ok, true);
  cliOutput(["init"]);
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  // The installed but unlisted engines must not appear in the server config.
  // Keep the smoke test offline once the tarball has been installed.
  fs.writeFileSync(configPath, JSON.stringify({
    ...config, latex: { allowedEngines: ["xelatex"] }, updates: { enabled: false }
  }));
  await exerciseServer(cli, root, env, dataDir, port);
  console.log("Installed TexLite passed requirements, init, health, login and clean shutdown.");
} finally {
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}
