// Deterministic CLI fixture: Node resolves this script as `session` from cwd.
// Use only task-owned fixture data; never call OpenCode or a model provider.
const fs = require("node:fs");
const path = require("node:path");

const filename = process.env.OPENCODE_DB;
const [action, ...args] = process.argv.slice(2);
if (path.basename(process.argv[1]) === "debug" && action === "paths" && args.join(" ") === "db") {
  process.stdout.write(filename + "\n");
} else if (action === "delete" && args.length === 2 && args[1] === "--standalone") {
  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync(filename);
  try { db.prepare("DELETE FROM session_v2 WHERE id = ?").run(args[0]); }
  finally { db.close(); }
} else if (action === "list" && args.join(" ") === "--format json") {
  const sessions = JSON.parse(fs.readFileSync(filename, "utf8"));
  process.stdout.write(JSON.stringify(sessions));
} else if (action === "delete" && args.length === 1) {
  const sessions = JSON.parse(fs.readFileSync(filename, "utf8"));
  fs.writeFileSync(filename, JSON.stringify(sessions.filter((session) => session.id !== args[0])));
} else {
  throw new Error("Unexpected fixture command");
}
