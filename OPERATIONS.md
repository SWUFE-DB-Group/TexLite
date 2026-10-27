# Operating TexLite

This guide covers installation, configuration, service operation, and backups.
For the product's intended use and editor comparison, start with the
[README](README.md). For implementation details and trade-offs, see
[DESIGN.md](DESIGN.md).

## Requirements

- Node.js 24 or newer and npm
- `latexmk`
- At least one configured engine: `pdflatex`, `xelatex`, or `lualatex`
- `git` only when a project owner uses the optional Git/GitHub integration

Check a host before initialization:

~~~bash
texlite requirements

# Equivalent individual checks:
node --version
npm --version
latexmk --version
xelatex --version
# Optional tools:
git --version
texcount -version
harper-cli --version
harper-ls --version
~~~

`texlite init` and `texlite start` validate Node.js, `latexmk`, and every
engine named in `latex.allowedEngines`. `texlite requirements` can be run
before initialization: it checks only the default commands on `PATH`, without
reading a configuration file or any TexLite data. It requires Node.js and
`latexmk`, and requires at least one of the three supported LaTeX engines.
`texlite doctor` presents the configured deployment checks and optional host
tools in a table with their requirement level, installation state, and
detected version. Missing optional tools never stop the editor:
Git enables GitHub backup, TeXcount enables document statistics, and
`harper-cli` enables spelling and grammar diagnostics. `harper-ls` is shown
for host diagnosis and external editor integrations; TexLite itself invokes
`harper-cli`.

Formatting does not require a host binary. The browser uses bundled `tex-fmt`
WASM for `.tex`, `.cls`, and `.sty`, and browser-side `bibtex-tidy` for `.bib`.

### Optional writing checks

TexLite does not bundle Harper. To enable its spelling and grammar diagnostics,
install a Harper distribution that provides `harper-cli` (the same host package
normally also provides `harper-ls`) and make it available on the TexLite service
`PATH`:

~~~bash
harper-cli --version
~~~

The command is optional: if it is absent or temporarily fails, TexLite remains
usable and the browser's native English spellchecker is enabled instead. Native
browser spellchecking does not provide Harper grammar diagnostics or suggested
replacements.

## Install and initialize

### Global npm installation

The published package provides the `texlite` executable. Configuration and
project data are outside the global npm installation:

~~~bash
npm install --global texlite
texlite init
texlite start
texlite status
~~~

Open <http://127.0.0.1:3000>. `init` creates the configuration if absent,
validates the environment, initializes storage, and creates the first
administrator. The server will not start without an active administrator.

The normal lifecycle commands can be run from any directory:

~~~bash
texlite stop
texlite restart
texlite logs
~~~

For a clean upgrade, restart after npm has installed the new version:

~~~bash
npm update --global texlite
texlite restart
~~~

Direct upgrades are supported from TexLite 0.2.0 onward. Back up the data
directory before upgrading; database migrations run automatically at startup.
Compilation output layouts from before 0.2.0 are no longer read. If an old
project has no PDF preview after upgrading, compile it again. This change does
not remove source files, comments, or project snapshots.

Uninstalling the package does not remove configuration or data:

~~~bash
npm uninstall --global texlite
~~~

### Update reminders

TexLite checks the official npm registry's `latest` release in the background
once every 24 hours. Only administrators see a dismissible reminder on the
dashboard, with instructions for npm or Docker. Closing it hides that release
for that administrator, across browsers and restarts, until a newer version is
published. Checks time out after five seconds; offline failures keep the cached
result and retry after one hour. No project data or credentials are sent.

Set `"updates": { "enabled": false }` in `texlite.config.json` and restart to
disable both outbound checks and reminders. Existing configurations enable the
feature by default without requiring a new entry.

For Docker, run these commands from the TexLite-Docker checkout:

~~~bash
git pull --ff-only
./scripts/compose.sh pull
./scripts/compose.sh up -d
~~~

The first command updates the launcher. The next two download the image and
recreate the container as needed, preserving mounted data. There is no need to
stop it before pulling. Docker images may be published after the npm release;
the reminder reports the npm version, not a verified Docker image version.

### Source installation

~~~bash
npm ci
cp texlite.config.example.json texlite.config.json
export TEXLITE_CONFIG="$PWD/texlite.config.json"
# Edit texlite.config.json if needed.
npm run init
npm run build
npm start
~~~

For non-interactive initialization, supply these environment variables only to
the initialization command:

~~~bash
TEXLITE_INIT_USERNAME=admin \
TEXLITE_INIT_DISPLAY_NAME=Administrator \
TEXLITE_INIT_PASSWORD='use-a-password-of-at-least-8-characters' \
npm run init
~~~

Avoid putting a password into shell history on a shared host.

## Command reference

| Command | Purpose |
| --- | --- |
| `texlite init` | Create configuration and the initial administrator. |
| `texlite serve` | Run in the foreground; suitable for debugging, Docker, or systemd. |
| `texlite start` / `stop` / `restart` | Manage the bundled-PM2 service. |
| `texlite status` | Show a colored, systemctl-style status view; add `--json` for scripts. |
| `texlite logs` | Stream PM2-managed logs. |
| `texlite requirements` | Check default host commands on `PATH` without loading TexLite configuration or data. |
| `texlite doctor` | Show configuration/application checks and a table of required and optional host software. Add `--json` for scripts. |
| `texlite config` | Print effective configuration and paths without changing them. |

`start`, `stop`, `restart`, `status`, and `logs` use the PM2 runtime bundled
with the global npm package—no separate global PM2 install is necessary.
Managed startup waits for the HTTP health endpoint, and `restart` recreates the
managed process so it uses paths from the newly installed npm version.

Managed logs are stored under the configured `storage.dataDir`, in
`logs/stdout.log` and `logs/stderr.log`. TexLite checks at startup and every
minute, rotating files at 10 MiB and retaining three uncompressed backups per
stream (`.1` is newest). No PM2 module or host logrotate configuration is needed.
Rotation uses asynchronous copy/truncate; a small number of concurrent log
messages may be lost, and the size can exceed the threshold between checks.
Checks run inside the server, so they do not run while it is stopped or unable
to start. Foreground `serve` output is still managed by its caller.

After upgrading, run `texlite restart` to switch an existing PM2 process to
these fixed paths. Already-running `texlite start` is a no-op. Old numbered
logs in `~/.pm2/logs` and PM2's own daemon log are not deleted or rotated by
TexLite; other PM2 applications are unaffected.

For a source checkout, `ecosystem.config.cjs` and the `npm run pm2:*` scripts
remain available. Run exactly one forked instance: cluster mode and multiple
TexLite processes sharing one data directory are unsupported because
collaboration state, the compile queue, SQLite, and project files are local to
one process.

## Configuration

`texlite init` writes a minimal configuration, not a copy of all defaults.
Accepting the default site name and leaving optional inputs empty can produce
`{}`. Custom site/contact inputs and explicitly supplied initialization
overrides (`TEXLITE_HOST`, `TEXLITE_PORT`, `TEXLITE_BASE_PATH`, and
`TEXLITE_DATA_DIR`) are saved; other environment variables remain runtime
overrides. Omitted options use the current defaults, including after upgrades.
Use `texlite config` to inspect effective values and the example JSON as a
reference when adding overrides. Existing configuration files are left intact;
to adopt a new default, remove the corresponding explicit setting yourself.

### Where configuration and data live

Configuration path precedence:

1. `--config PATH` passed to `texlite`;
2. `TEXLITE_CONFIG`;
3. `$XDG_CONFIG_HOME/texlite/texlite.config.json`;
4. `~/.config/texlite/texlite.config.json`.

Relative paths are resolved from the configuration file. The default data
directory is `$XDG_DATA_HOME/texlite`, or `~/.local/share/texlite` when
`XDG_DATA_HOME` is unset. Set `storage.dataDir` or `TEXLITE_DATA_DIR` to move
it. The data directory contains the SQLite database, project sources, compiled
output, history objects, and Git-token encryption key.

Use [texlite.config.example.json](texlite.config.example.json) as a complete
starting point. It omits `storage.dataDir`, so copied configurations retain the
XDG data-directory default. A source checkout may set `.texlite` explicitly in
its ignored local configuration when repository-local development data is
preferred.

### Important settings and effective defaults

| Setting | Default | Notes |
| --- | --- | --- |
| `siteName` | `TexLite` | Site title. |
| `adminEmail` | empty | Optional administrator contact address. |
| `server.host` / `server.port` | `127.0.0.1` / `3000` | Keep localhost unless the deployment is separately secured. |
| `server.basePath` | `/` | Public URL mount point, such as `/texlite` or `/tools/texlite`. |
| `storage.dataDir` | XDG data directory | Stores all persistent project data. |
| `clientDir` | Installed package's `dist/client` | Normally changed only for development or a custom deployment. |
| `sessionDays` | `14` | Login-session lifetime. |
| `uploads.maxFileSizeMB` | `50` MB | Limit for uploads, ZIP entries, and attachments. |
| `pdf.loadingStrategy` / `pdf.rangeThresholdMB` | `auto` / `2` MB | Uses full transfer through the threshold and allows PDF.js byte-range requests above it. Explicitly configured thresholds are preserved. |
| `history.maxVersions` / `history.maxStorageMB` | `0` (unlimited) / `128` MiB | Per-project ordinary-version count (`0` = unlimited) and soft limit for deduplicated files plus snapshot metadata. Protected snapshots may exceed the limit; shared SQLite overhead is excluded. |
| `editHistory.maxStorageMB` / `editHistory.maxSegments` | `64` MiB / `20000` | Independent per-project payload and segment-count caps for author-attributed selection edits. Retains the newest records within both limits and never consumes snapshot storage. Both settings are optional; existing explicit limits are preserved. |
| `latex.latexmk` | `latexmk` | Host command. |
| `latex.defaultEngine` | `xelatex` | Must appear in the allowed list. |
| `updates.enabled` | `true` | Background release checks and administrator dashboard reminders. Set to `false` for offline deployments. |
| `latex.allowedEngines` | `pdflatex`, `xelatex`, `lualatex` | Engines available in the UI. |
| `latex.extraArgs` | `[]` | Additional configured compiler arguments. |
| `latex.compileTimeoutSeconds` | `600` | Per-job time limit. |
| `latex.maxCompileJobs` | `10` | Global concurrent LaTeX-process limit. |
| `latex.allowProjectLatexmkrc` | `true` | Allows project owners to opt into an existing project `latexmkrc`; the per-project selection starts off. Edit the file in the project editor. |
| `git.binary` / `git.operationTimeoutSeconds` | `git` / `120` seconds | Used only by optional Git integration. |
| `git.githubApiBaseUrl` | `https://api.github.com` | GitHub REST API endpoint. |

The current environment-variable overrides are:

~~~text
TEXLITE_CONFIG
XDG_CONFIG_HOME                 XDG_DATA_HOME
TEXLITE_SITE_NAME               TEXLITE_ADMIN_EMAIL
TEXLITE_HOST                    TEXLITE_PORT
TEXLITE_BASE_PATH
TEXLITE_DATA_DIR                TEXLITE_CLIENT_DIR
TEXLITE_SESSION_DAYS            TEXLITE_MAX_UPLOAD_SIZE_MB
TEXLITE_PDF_LOADING_STRATEGY    TEXLITE_PDF_RANGE_THRESHOLD_MB
TEXLITE_HISTORY_MAX_VERSIONS    TEXLITE_HISTORY_MAX_STORAGE_MB
TEXLITE_EDIT_HISTORY_MAX_STORAGE_MB   TEXLITE_EDIT_HISTORY_MAX_SEGMENTS
TEXLITE_LATEXMK                 TEXLITE_DEFAULT_ENGINE
TEXLITE_COMPILE_TIMEOUT         TEXLITE_MAX_COMPILE_JOBS
TEXLITE_GIT                     TEXLITE_GIT_TIMEOUT
TEXLITE_GITHUB_API_URL
~~~

Configuration is validated before TexLite opens the database or binds the HTTP
listener. Invalid JSON types, paths, limits, URLs, engine lists, timeout/queue
values, and cross-field combinations stop startup with a setting-specific,
actionable error. Explicit invalid values are never silently replaced with a
default. `texlite init` applies the same validation.

Accepted limits are: port `1–65535`, sessions `1–3650` days, upload size
`1–2048` MB, history count `0–50000` (`0` = unlimited), snapshot history size `16–102400` MB,
edit-history size `4–102400` MB and count `1–100000`, PDF range
threshold `1–2048` MB, compile timeout `1–3600` seconds, compile jobs `1–32`,
and Git timeout `1–3600` seconds.

### Reverse proxy subpath

Set `server.basePath` when TexLite shares one origin with other services:

~~~json
{
  "server": {
    "host": "127.0.0.1",
    "port": 3000,
    "basePath": "/texlite"
  }
}
~~~

The browser URL is then `https://example.com/texlite/`, project links use
`/texlite/project/...`, and API, PDF, asset, and collaboration WebSocket URLs
all use the same prefix. The npm package contains one path-independent frontend
build; changing `basePath` does not require rebuilding TexLite.

The reverse proxy must preserve the prefix when forwarding requests. For
Nginx, omitting a URI from `proxy_pass` keeps `/texlite` intact:

~~~nginx
location = /texlite {
    proxy_pass http://127.0.0.1:3000;
    proxy_set_header Host $http_host;
    proxy_set_header X-Forwarded-Proto $scheme;
}

location ^~ /texlite/ {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Host $http_host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
}
~~~

For Caddy, use a path matcher with `reverse_proxy`; do not use `handle_path`,
because `handle_path` strips the matched prefix:

~~~caddyfile
@texlite path /texlite /texlite/*
handle @texlite {
    reverse_proxy 127.0.0.1:3000
}
~~~

Valid base paths start with `/`, contain URL-safe path segments, and have no
query, fragment, `.` or `..` segment. A trailing slash in configuration is
accepted and normalized. Restart TexLite after changing this setting.

Before every compile TexLite passes `-norc` to `latexmk`. A `.latexmkrc` or
`latexmkrc` found in a ZIP upload, Git checkout, or project file tree is ignored
until the owner enables it in Project Settings. TexLite then passes that file
with `-r`. The setting appears only when an rc file exists; the file is edited
in the project editor, not in settings. For an unconfigured project, a root
`latexmkrc` is preferred over a root `.latexmkrc` when both exist; an existing
selection is preserved. Removing an active rc file disables it. A `latexmkrc`
is executable Perl configuration; it may override the selected engine and
other compiler options, and collaborators who can edit the file can change
subsequent builds. Keep the server-level option off when project editors are
not trusted.

TexLite never runs `tlmgr` or installs TeX packages. Updating the host TeX
distribution changes the environment used by subsequent compiles.

## Development and verification

Run the API/server watcher and Vite in separate terminals. Development uses a
dedicated `.texlite-dev/` directory in this repository and port `3001`, so it
does not reuse or lock the normal user configuration, database, or port `3000`:

~~~bash
npm run dev:init   # once: create the development config and administrator
npm run dev        # API/server: http://127.0.0.1:3001
npm run dev:web   # Vite UI:    http://127.0.0.1:5173
~~~

To test a configured `server.basePath`, edit `.texlite-dev/texlite.config.json`
and restart both terminals. Vite reads this development configuration, serves
the matching prefix, and proxies the prefixed API and WebSocket endpoints:

~~~bash
npm run dev       # API/server, for example http://127.0.0.1:3001/texlite/
npm run dev:web   # Vite UI, for example http://127.0.0.1:5173/texlite/
~~~

Vite proxies API requests to the server. Validate a production-style build
with:

~~~bash
npm run typecheck
npm test
npm run build
npm start
~~~

## External agent terminals

No agents are allowed by default. Administrators open **Coding Agent CLI** from the
dashboard to select allowed agents and refresh executable detection. There is no
separate global switch. Deselecting an agent stops its active executions while
preserving task context and cleanup access; other allowed agents are unaffected.
Supported launch commands are `codex`, `opencode`, and `claude` on the
TexLite service account's `PATH`. Detection reports installation/version, not
authentication or provider quota. A PM2/systemd service may have a different
`PATH` from an interactive login shell.

The management screen is a normal page. Administrators can filter all projects'
tasks by project, user, agent, execution state, or failed cleanup,
with 50 entries per page. They can end/delete individual or selected tasks;
administrative access does not grant access to other users' terminal streams or
private project files. Other users get a personal task list from **Agent tasks**.

Users with project write access can open **Terminal** in the workspace toolbar.
Select an allowed installed agent and click **Start task** to create and launch
it in one action. The task name is optional; an omitted name receives six random
characters from uppercase/lowercase ASCII letters, digits and `-`. If launch
fails, the same task stays selected for retry.
Multiple tasks may use the same agent in the same project. The resizable terminal
sits below the editor. Browser tabs attach to the same running task; one tab
controls input, and another can take control. Hiding the panel, leaving a project,
disconnecting a browser, or archiving a project does not stop executions.
Agent tasks have no archive state: end an execution to free its process, or
delete a task to remove its saved conversation.

Use the terminal heading's maximize/restore button to fill the editor column's
height and return to the previous split. Dragging the separator can also collapse
the source editor. Maximizing keeps the editor and terminal mounted; it does not
restart the task or clear terminal output. Closing and reopening returns to a
split view.

Agents execute directly in the project's source directory. Only one task may
execute per project, across all users and agents (including different tasks of
the same user). Other projects are independent. An execution retains the claim
through startup, termination, and final file synchronization. Hiding a terminal or archiving a project
does not release it. Stop the active task before starting another one.
This is a source-consistency and attribution rule, not a CLI limitation or a
provider quota control. Waiting for input still counts as an active execution;
the terminal shows a reminder to use **End execution** when finished. Hiding the
terminal is deliberately separate and keeps the task running.

Pending collaboration edits are saved before launch. While the CLI runs, file
changes are synchronized into Yjs, comment anchors, edit history and snapshots,
attributed to the task owner. Autosave checks for external edits before writing;
non-overlapping human and agent changes are merged. Conflicting agent versions
are saved under `.texlite-agent-conflicts/<task-id>/` in the project, the human
draft is preserved, and execution ends with a warning. Review those files manually.
Source-tree replacement (Git checkout/restore, snapshot restore or project
deletion) ends execution and synchronizes its last writes first.

Task-specific CLI state stays under `dataDir/agent-tasks/<task-id>/state/`.
`TEXLITE_PROJECT_CONTEXT` names a JSON file containing the source directory,
configured main file, output directory and last compile result.
`TEXLITE_COMPILE_LOG` names its log file; it is refreshed after compilation through
TexLite. Ask the agent to read these paths when diagnosing a compile failure.
There is no separate source copy or review/apply step.

Before an agent starts, TexLite copies its fixed English `AGENTS.md` template
into the project source root if the file is missing. It defines the agent as a
LaTeX and academic-writing assistant for this manuscript: writing, references,
typesetting, compilation diagnostics and directly related supporting scripts
are in scope; unrelated tasks and host administration should be refused before
using tools. It also covers research integrity, live collaboration, the
source/output layout and how to find compilation logs and results.
Existing instructions (even an empty file) are never overwritten. Edit the
project's copy normally to customize it; upgrades do not rewrite that file.
To adopt an updated template in an existing project, review and merge the new
guidance into its `AGENTS.md`, preserving project-specific conventions, then
start a new conversation. Running or resumed conversations are not guaranteed
to reload updated instructions.

TexLite keeps the CLIs' native project-instruction loading and does not create
a separate `CLAUDE.md` or change their settings. See the official instructions
for [Codex](https://developers.openai.com/codex/guides/agents-md/),
[OpenCode](https://opencode.ai/docs/rules/) and
[Claude Code](https://code.claude.com/docs/en/memory#agents-md).
Claude Code's native `AGENTS.md` support requires a supported version and enabled
project-instruction loading; a project `CLAUDE.md` can take precedence depending
on the user's CLI settings. These instructions guide model behavior, not enforce
an OS sandbox or guarantee refusal. The trusted-user deployment model is unchanged.

**End execution** releases processes while preserving task files/context.
**Delete task** ends execution, cleans its native conversation/state and removes
only task-owned state, never project files. A failed cleanup stays visible
for retry. Apart from the per-project writer claim, there are no execution-count limits, idle expiry, task timeouts, token
budgets, or billing controls. A server restart interrupts executions; it does not
automatically restart them. Exact-context continuation depends on the adapter
being able to identify a saved native session. Starting a CLI without sending a
message may leave no conversation to resume. If the adapter confirms that its
task context has no conversation and no session ID has been saved, the same task can be
started again. Failed or ambiguous checks require a retry, not an automatic
new conversation. Once a native session ID is saved, later launches resume that
exact conversation; a failure never resets its state. Use **+** for a separate
conversation instead.

Executions started by current versions keep an `execution.json` recovery lease
under their task directory. After an abnormal shutdown, TexLite verifies the
launcher's execution marker and OS creation identity and reaps the old process
tree before permitting another task in that project. It never kills a process
solely because a saved PID matches. The task and native conversation remain
available for explicit continuation; source files left on disk are preserved
and included in project snapshots.

If recovery cannot verify or stop an execution, its task remains visible as
stopping with a recovery error, and the project stays reserved. Owners or
administrators can retry **End execution**. If instructed, stop the task's
processes on the host first, then retry; do not delete its recovery file to
bypass the reservation. Deletion and source-tree replacement also require
successful recovery. This does not manage host sessions started outside TexLite
or deliberately detached processes. Stop active tasks before upgrading from a
version that did not write recovery leases; those older processes cannot be
identified retrospectively.

| Agent | Native state and continuation | Cleanup |
| --- | --- | --- |
| Codex | Task-specific `CODEX_HOME`; resume an identified transcript UUID. Use `--no-daemon` when advertised by the installed CLI. | Prefer detected native `delete --force`; remove the task-owned state directory afterward. |
| OpenCode | New V2 tasks share the host database, sign-ins and native history. Bind a separate session ID per task and use `--standalone` to own the execution process tree. Existing private conversations keep their original state. | Delete only the task's registered native session, verify deletion, then remove its task directory. Never remove the shared database or host credentials. |
| Claude Code | Share the service account's native configuration, credentials and initialization state; start with a task UUID and resume that exact ID. | Remove only the registered session's transcripts and session-scoped files; keep host settings and unrelated conversations. |

All agents inherit the TexLite service account's `XDG_CACHE_HOME`. If unset,
the CLI uses its own default cache location. This lets model catalogs and
downloaded dependencies be reused without merging task conversations. It does
not share the mixed state/cache files inside task-specific native homes.
Different projects and native terminals may use the cache concurrently; clearing
or updating shared caches can affect all of them. Task deletion never clears the
host cache. Existing per-task cache directories are left untouched on startup
and are removed with their task on deletion. No new cache configuration is needed.

OpenCode 2 resolves the host database using `opencode debug paths db`, including
custom `OPENCODE_DB` settings. Its path and a task-specific session ID are recorded
in `agent-tasks/<task-id>/state/opencode-session.json`; no database migration or
credential copying is needed. An older task with an empty private database moves
to this layout on its next start. An existing private conversation is kept in
place to avoid losing history; use `/connect` there if needed, or create a new
task to use shared host authentication. TexLite's task pages/API show and manage
only its own registered tasks. OpenCode's native history picker inside the
terminal can also show host conversations; those are not imported into TexLite.

Claude tasks directly reuse the service account's configuration and sign-in,
including model settings, plugins and completed onboarding. Without a custom
`CLAUDE_CONFIG_DIR`, TexLite leaves that variable unset so Claude still finds its
native `~/.claude.json`; an explicitly configured directory is reused as-is.
The configuration location and task UUID are registered in
`agent-tasks/<task-id>/state/claude-session.json` before launching, so later
environment changes cannot redirect a saved conversation or its cleanup.
TexLite never imports the host's other conversations into its task list.
Deletion does not rewrite shared prompt history, settings, plugins or global
caches, and never uses project-wide `claude purge`.
Old isolated Claude tasks are not migrated; remove them before upgrading and
create new tasks to use the shared configuration.

On the first start, Codex and legacy isolated OpenCode tasks copy selected host credential/configuration
files if available; they do not copy host conversation history. Credentials
subsequently refreshed within a task are preserved. Keychain/credential formats
vary by CLI version, so an individual task may require login. Provider environment
variables supported by the adapters are passed through. CLI authentication stays
in the native terminal; TexLite does not provide an account or model. Agents may
use the same server account quota and send project contents to their providers.

Agent terminals are not OS sandboxes. Enable these terminals only for trusted writers
who may use server-side tools with the TexLite service account's permissions.
In Docker, install commands and configure credentials **inside the container**;
host executables are not automatically available there.

`node-pty` is an optional production dependency. If its native module cannot be
installed or loaded, ordinary TexLite operation remains available and the tool
page reports terminal support unavailable. Reinstall optional dependencies for
the server's Node/platform and restart before retrying. The browser's terminal
renderer is bundled and loaded only when a terminal is opened. Linux PTY I/O and
termination are covered by a local, deterministic test agent without any model
calls; platform/native-agent login behavior should also be checked when deploying.

## Backup and security

Back up the entire configured data directory, including `texlite.db`, its WAL
files, `git-token.key`, and `projects/`. Restoring saved GitHub tokens requires
the same encryption key. For an online copy of SQLite, include WAL files or use
a SQLite-aware backup method.

TexLite is designed for trusted users on localhost. Shell escape is disabled by
default and compile jobs have timeouts and concurrency limits, but LaTeX itself
is not a security boundary. Before exposing it to an untrusted network, add an
isolated compiler sandbox plus appropriate authentication and network controls.
