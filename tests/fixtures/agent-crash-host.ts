import path from "node:path";
import { loadAgentPty } from "../../src/server/agents/terminal.js";

const root = process.argv[2];
const spawn = await loadAgentPty();
if (!spawn) throw new Error("PTY unavailable");
const pty = await spawn(process.execPath, ["-e", `
  const fs = require("node:fs");
  const child = require("node:child_process").spawn(process.execPath, ["-e", 'process.on("SIGTERM",()=>{}); process.on("SIGHUP",()=>{}); setInterval(()=>{},1000)'], {stdio:"ignore"});
  fs.writeFileSync("pids.json", JSON.stringify({cli:process.pid,child:child.pid}));
  process.on("SIGTERM",()=>{}); process.on("SIGHUP",()=>{});
  process.stdout.write("CRASH_TEST_READY\\n");
  setInterval(()=>{},1000);
`], { name: "xterm-256color", cwd: root, env: { ...process.env as Record<string, string>, TERM: "xterm-256color" }, cols: 80, rows: 24,
  executionFile: path.join(root, "execution.json") });
pty.onData((data) => { if (data.includes("CRASH_TEST_READY")) process.send?.({ ready: true, pid: pty.pid }); });
setInterval(() => undefined, 60_000);
