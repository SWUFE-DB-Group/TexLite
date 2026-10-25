import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { AgentAdapterContext, AgentLaunch } from "./types.js";

export const executeAgentCommand = promisify(execFile);
export const noAgentFeatures = async (): Promise<ReadonlySet<string>> => new Set();

export function hostAgentEnvironment(): Record<string, string> {
  const env: Record<string, string> = {};
  const names = /^(?:PATH|HOME|USER|USERNAME|USERPROFILE|SHELL|COMSPEC|SystemRoot|SYSTEMROOT|WINDIR|APPDATA|LOCALAPPDATA|TEMP|TMP|TMPDIR|LANG|LC_.*|COLORTERM|XDG_.*|https?_proxy|HTTPS?_PROXY|ALL_PROXY|all_proxy|NO_PROXY|no_proxy|SSL_CERT_FILE|SSL_CERT_DIR|NODE_EXTRA_CA_CERTS|SSH_AUTH_SOCK|OPENAI_.*|ANTHROPIC_.*|GOOGLE_.*|GEMINI_.*|OPENCODE_CONFIG(?:_DIR|_CONTENT)?|CODEX_API_KEY|CLAUDE_CODE_OAUTH_TOKEN|CLAUDE_CODE_USE_BEDROCK|CLAUDE_CODE_USE_VERTEX)$/;
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined && names.test(key)) env[key] = value;
  env.TERM = "xterm-256color";
  return env;
}

export function agentLaunch(context: AgentAdapterContext, args: string[], overrides: Record<string, string> = {}): AgentLaunch {
  return { executable: context.executable, args, env: { ...hostAgentEnvironment(),
    // Development data may itself live below the TexLite checkout. Keep Git
    // discovery from treating that ancestor repository as the paper's repo.
    GIT_CEILING_DIRECTORIES: path.dirname(context.workingDirectory),
    TEXLITE_PROJECT_CONTEXT: path.join(context.stateDirectory, "project-context.json"),
    TEXLITE_COMPILE_LOG: path.join(context.stateDirectory, "compile.log"), ...overrides } };
}

/** Copy an explicit credential/config file; never share native conversation history. */
export async function copyAgentSetting(source: string, target: string): Promise<void> {
  try {
    if (fs.existsSync(target)) return;
    await fs.promises.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    await fs.promises.copyFile(source, target);
    await fs.promises.chmod(target, 0o600);
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
}

export async function transcriptIds(root: string): Promise<Set<string>> {
  const ids = new Set<string>();
  const visit = async (directory: string): Promise<void> => {
    let entries: fs.Dirent[];
    try { entries = await fs.promises.readdir(directory, { withFileTypes: true }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) await visit(path.join(directory, entry.name));
      else {
        const match = entry.name.match(/([a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12})\.jsonl$/i);
        if (match) ids.add(match[1]);
      }
    }
  };
  await visit(root);
  return ids;
}
