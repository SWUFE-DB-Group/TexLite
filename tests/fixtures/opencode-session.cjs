// Deterministic CLI fixture: Node resolves this script as `session` from cwd.
// Use only task-owned fixture data; never call OpenCode or a model provider.
const fs = require("node:fs");

const filename = process.env.OPENCODE_DB;
const sessions = JSON.parse(fs.readFileSync(filename, "utf8"));
const [action, ...args] = process.argv.slice(2);
if (action === "list" && args.join(" ") === "--format json") {
  process.stdout.write(JSON.stringify(sessions));
} else if (action === "delete" && args.length === 1) {
  fs.writeFileSync(filename, JSON.stringify(sessions.filter((session) => session.id !== args[0])));
} else {
  throw new Error("Unexpected fixture command");
}
