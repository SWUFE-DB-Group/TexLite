// Deliberately imports only Node builtins: the same file runs as compiled JS in
// npm installs and with Node 24's native TypeScript support in development.
import fs from "node:fs";
import { spawn } from "node:child_process";
import { constants } from "node:os";

const [recordFile, executionId] = process.argv.slice(2);
const launch = JSON.parse(process.env.TEXLITE_AGENT_LAUNCH ?? "null") as {
  executable: string; args: string[]; windowsVerbatimArguments?: boolean;
} | null;
delete process.env.TEXLITE_AGENT_LAUNCH;
if (!recordFile || !executionId || !launch) throw new Error("Missing agent launch context");

// Keep the identifiable group leader alive until TexLite reaps the whole group,
// even if the service dies or the CLI exits before its workers do.
process.on("SIGTERM", () => undefined);
process.on("SIGINT", () => undefined);
if (process.platform !== "win32") process.on("SIGHUP", () => undefined);

const deadline = Date.now() + 10_000;
while (true) {
  let record: { executionId: string; pid: number | null; identity: string | null };
  try { record = JSON.parse(fs.readFileSync(recordFile, "utf8")); }
  catch { process.exit(1); }
  if (record.executionId !== executionId) process.exit(1);
  if (record.pid === process.pid && record.identity) break;
  if (Date.now() >= deadline) process.exit(1);
  await new Promise<void>((resolve) => setTimeout(resolve, 25));
}

// This interval only keeps the launcher available for verified tree cleanup;
// it imposes no time limit on the user's task.
setInterval(() => undefined, 60_000);
const resultFile = `${recordFile}.${executionId}.exit`;
let reported = false;
function report(exitCode: number): void {
  if (reported) return;
  reported = true;
  const temporary = `${resultFile}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify({ executionId, exitCode }), { mode: 0o600 });
  fs.renameSync(temporary, resultFile);
}
try {
  const child = spawn(launch.executable, launch.args, {
    stdio: "inherit", shell: false, windowsVerbatimArguments: launch.windowsVerbatimArguments
  });
  child.on("error", (error) => { console.error(error.message); report(1); });
  child.on("exit", (code, signal) => report(code ?? (128 + (signal ? constants.signals[signal] ?? 0 : 0))));
} catch (error) { console.error(error instanceof Error ? error.message : error); report(1); }
