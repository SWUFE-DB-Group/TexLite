# texLite

texLite is a lightweight, local-first web workspace for writing, compiling, previewing, and discussing LaTeX documents. It is intended for a small group of trusted users on one server. It uses the LaTeX installation already available on the host instead of shipping a LaTeX container, and keeps the rest of the stack deliberately small.

**Documentation:** English (this file) · [简体中文](README.zh-CN.md)

[![CI](https://github.com/SWUFE-DB-Group/TexLite/actions/workflows/ci.yml/badge.svg)](https://github.com/SWUFE-DB-Group/TexLite/actions/workflows/ci.yml)

![texLite preview](preview.png)

## Design goals

- Use the host's TeX Live/LaTeX installation so it can be updated independently.
- Avoid Redis, MongoDB, and a reverse proxy for the default localhost deployment.
- Keep projects and generated artifacts on the local filesystem.
- Use SQLite through better-sqlite3 for durable application data.
- Provide useful collaboration for a small number of active sessions without requiring a distributed deployment.

## Features

- Administrator initialization and user administration; public registration is disabled.
- Per-user permission to create projects (disabled by default for newly created users).
- Project, folder, file, and attachment management, including drag-and-drop uploads.
- ZIP project import with safe extraction and automatic main-document selection.
- List/grid project views, search, sorting by last modification or creation time, and private Finder-style color tags.
- Project rename, source ZIP download, deletion, owner and modification metadata.
- English and Chinese UI with browser-language detection and a language switcher.
- CodeMirror LaTeX editing with syntax highlighting, folding, completion, quick file opening, current-file and project-wide search/replace, a cross-file outline, and configurable appearance.
- Yjs CRDT collaboration with active-session avatars, remote cursors, acknowledged server saves, and a browser-local IndexedDB draft for reconnect recovery; the practical limit is about ten concurrent sessions per project.
- Automatic content-addressed project history with labels, file comparison, single-file restore, and full-project restore checkpoints.
- Source-range comments with replies, resolved state, user/time metadata, and anchor remapping after edits.
- Host-side latexmk compilation with pdflatex, xelatex, and lualatex options, project-level latexmkrc, serialized project jobs, persistent incremental caches, immutable published snapshots, retained PDFs, SyncTeX navigation, structured clickable diagnostics, and downloadable artifacts such as .bbl files.
- Project sharing with read-only or read/write access. Read-only users can still add and reply to comments.
- Owner-only local Git history and GitHub backup: commit, push, diff, checkout, and restore tracked changes.
- Optional PM2 process management for automatic restart, status, and logs.
- Administrator-only live system metrics for compile queues, collaboration sessions, event-loop delay, memory, and recent operation latency.

## Architecture

| Area | Implementation |
| --- | --- |
| Browser UI | React, Vite, CodeMirror, PDF.js |
| API and static server | Fastify, WebSocket |
| Collaboration | Yjs, y-websocket, y-codemirror.next |
| Database | SQLite via better-sqlite3 |
| Files | Local project directories under the configured data directory |
| Compilation | Host latexmk and a configured LaTeX engine |
| Git backup | Host git and the GitHub REST API |

texLite is designed as a single Node.js process. Do not run multiple application instances against the same SQLite database or project directory; the in-memory collaboration service and compile queue are intentionally single-instance.

## Requirements

- Node.js 24 or newer
- npm
- git (optional; required only for the project-owner Git/GitHub integration)
- latexmk
- At least one configured engine: pdflatex, xelatex, or lualatex

Check the host before initialization:

~~~bash
node --version
npm --version
latexmk --version
xelatex --version
# Optional, when Git/GitHub integration is needed:
git --version
~~~

npm run init and application startup check latexmk and every engine in latex.allowedEngines. Git is deliberately excluded from this core check, so a host without Git can initialize and run TexLite normally. When a project owner opens the Git panel or invokes a Git/GitHub operation, TexLite checks git.binary on demand and shows an actionable error if Git is unavailable.

## Quick start

### Global npm installation

The published package provides a `texlite` executable. It keeps configuration
and project data outside the global npm installation:

~~~bash
npm install --global texlite
texlite init
texlite start
texlite status
~~~

Open http://127.0.0.1:3000. The service can be stopped or restarted from any
working directory:

~~~bash
texlite stop
texlite restart
texlite logs
~~~

The default configuration is
`$XDG_CONFIG_HOME/texlite/texlite.config.json`, or
`~/.config/texlite/texlite.config.json` when `XDG_CONFIG_HOME` is not set. The
default data directory is `$XDG_DATA_HOME/texlite`, or
`~/.local/share/texlite`. Use `--config PATH` or `TEXLITE_CONFIG` to select a
different configuration file.

`texlite serve` runs the server in the foreground and is suitable for Docker,
systemd, and debugging. `start`, `status`, `stop`, `restart`, and `logs` use the
PM2 dependency bundled with the package.

For a clean upgrade:

~~~bash
npm update --global texlite
texlite restart
~~~

Uninstalling the npm package does not remove the configuration or project data:

~~~bash
npm uninstall --global texlite
~~~

### Repository/source installation

~~~bash
npm ci
cp texlite.config.example.json texlite.config.json
export TEXLITE_CONFIG="$PWD/texlite.config.json"
# Edit texlite.config.json if needed.
npm run init
npm run build
npm start
~~~

The default server binds to localhost and does not expose public registration.
The initialization command asks for the first administrator account; the server
refuses to start until at least one active administrator exists.

For a non-interactive initialization, set the following environment variables for that command only:

~~~bash
TEXLITE_INIT_USERNAME=admin \
TEXLITE_INIT_DISPLAY_NAME=Administrator \
TEXLITE_INIT_PASSWORD='use-a-password-of-at-least-8-characters' \
npm run init
~~~

Avoid putting the password in shell history on a shared machine.

## Development and verification

Run the API/server watcher and Vite in separate terminals:

~~~bash
npm run dev       # API and server at http://127.0.0.1:3000
npm run dev:web   # Vite UI at http://127.0.0.1:5173
~~~

Vite proxies /api requests to the server. Before a production-style run, use:

~~~bash
npm run typecheck
npm test
npm run build
npm start
~~~

## Configuration

Configuration path precedence is:

1. `--config PATH` passed to the `texlite` executable;
2. `TEXLITE_CONFIG`;
3. `$XDG_CONFIG_HOME/texlite/texlite.config.json`;
4. `~/.config/texlite/texlite.config.json`.

Relative paths in the configuration are resolved relative to that configuration
file. `storage.dataDir` defaults to `$XDG_DATA_HOME/texlite`, or
`~/.local/share/texlite`. Set `storage.dataDir` in the configuration, or use
`TEXLITE_DATA_DIR`, to choose another data directory. The production client
bundle defaults to the `dist/client` directory inside the installed package;
`TEXLITE_CLIENT_DIR` can override it for development or custom deployments.

The example configuration is intentionally complete:

~~~json
{
  "siteName": "TexLite",
  "adminEmail": "admin@example.com",
  "sessionDays": 14,
  "server": { "host": "127.0.0.1", "port": 3000 },
  "storage": { "dataDir": ".texlite" },
  "uploads": { "maxFileSizeMB": 50 },
  "history": { "maxVersions": 200, "maxStorageMB": 512 },
  "git": {
    "binary": "git",
    "operationTimeoutSeconds": 120,
    "githubApiBaseUrl": "https://api.github.com"
  },
  "latex": {
    "latexmk": "latexmk",
    "defaultEngine": "xelatex",
    "allowedEngines": ["pdflatex", "xelatex", "lualatex"],
    "extraArgs": [],
    "allowProjectLatexmkrc": true,
    "compileTimeoutSeconds": 600,
    "maxCompileJobs": 10
  }
}
~~~

The checked-in example uses `.texlite` as an explicit repository-development
path. A configuration generated by `texlite init` uses the XDG data directory
default described above instead.

Important settings:

- server.host and server.port: network bind address and port. Keep the host at 127.0.0.1 unless a separately secured deployment is intended.
- storage.dataDir: SQLite database, project sources, compile output, and the Git token encryption key.
- uploads.maxFileSizeMB: maximum size for a project upload, a ZIP entry, project files, and attachments. The default is 50 MB.
- history.maxVersions: maximum number of ordinary, unlabeled versions retained per project. Initial and labeled versions are protected.
- history.maxStorageMB: soft per-project limit for deduplicated history objects. The oldest ordinary versions are removed first; protected versions and the current internal baseline can exceed this limit.
- latex.defaultEngine, latex.allowedEngines, latex.extraArgs: compile choices available in the UI.
- latex.compileTimeoutSeconds: timeout for one compile job.
- latex.maxCompileJobs: global number of concurrent LaTeX processes. Jobs for the same project and root document are serialized; newer source versions supersede older queued requests. Different root documents use independent workspaces and may compile concurrently within this global limit.
- latex.allowProjectLatexmkrc: allow a project to supply a multi-line latexmkrc. A project rc file is executable Perl configuration and should only be enabled for trusted users.

### Effective defaults and startup validation

When a setting is omitted, texLite uses the following built-in defaults (the
generated example file may choose to show an explicit value such as an admin
email):

| Setting | Effective default |
| --- | --- |
| `siteName` | `TexLite` |
| `adminEmail` | empty |
| `server.host` / `server.port` | `127.0.0.1` / `3000` |
| `storage.dataDir` | `$XDG_DATA_HOME/texlite` or `~/.local/share/texlite` |
| `clientDir` | `dist/client` inside the installed package |
| `sessionDays` | `14` |
| `uploads.maxFileSizeMB` | `50` MB |
| `history.maxVersions` | `200` ordinary versions per project |
| `history.maxStorageMB` | `512` MB per project (soft limit) |
| `latex.latexmk` | `latexmk` |
| `latex.defaultEngine` | `xelatex` |
| `latex.allowedEngines` | `pdflatex`, `xelatex`, `lualatex` |
| `latex.extraArgs` | `[]` |
| `latex.allowProjectLatexmkrc` | `true` |
| `latex.compileTimeoutSeconds` | `600` seconds |
| `latex.maxCompileJobs` | `10` |
| `git.binary` / `git.operationTimeoutSeconds` | `git` / `120` seconds |
| `git.githubApiBaseUrl` | `https://api.github.com` |

Configuration is validated before environment checks, database opening, or
the HTTP listener starts. Explicit values are never silently replaced by a
default. The accepted ranges are: port `1–65535`, sessions `1–3650` days,
upload size `1–2048` MB, history versions `10–5000`, history storage
`16–102400` MB, compile timeout `1–3600` seconds, compile jobs `1–32`,
and Git timeout `1–3600` seconds. Engine names must be supported, unique, and
the allowed-engine list must include the selected default engine. Data and
project paths must not point at files (the data directory cannot be the
filesystem root); a missing data directory must have an existing writable
parent. The GitHub API endpoint must be an `http://` or `https://` URL.

Invalid JSON types, empty required strings, malformed integers (including
decimal or non-numeric environment overrides), unsupported engines, invalid
URLs, and unusable paths stop startup with the setting name, expected value,
and a remediation hint. The same validation runs during `npm run init`, so a
configuration can be checked before creating the first administrator.

Environment variables override the corresponding file values:

~~~text
TEXLITE_CONFIG
XDG_CONFIG_HOME                 XDG_DATA_HOME
TEXLITE_SITE_NAME             TEXLITE_ADMIN_EMAIL
TEXLITE_HOST                  TEXLITE_PORT
TEXLITE_DATA_DIR              TEXLITE_CLIENT_DIR
TEXLITE_SESSION_DAYS          TEXLITE_MAX_UPLOAD_SIZE_MB
TEXLITE_HISTORY_MAX_VERSIONS TEXLITE_HISTORY_MAX_STORAGE_MB
TEXLITE_LATEXMK               TEXLITE_DEFAULT_ENGINE
TEXLITE_COMPILE_TIMEOUT       TEXLITE_MAX_COMPILE_JOBS
TEXLITE_GIT                   TEXLITE_GIT_TIMEOUT
TEXLITE_GITHUB_API_URL
~~~

texLite does not run tlmgr or install missing packages. Updating TeX Live on the host changes the environment used by the next compile.

## Service management

For a global npm installation, the lifecycle commands use the bundled PM2
runtime. No separate global PM2 installation is needed:

~~~bash
texlite start
texlite status
texlite logs
texlite restart
texlite stop
~~~

`texlite doctor` validates configuration, paths, LaTeX, and the administrator;
add `--git` to check the optional Git integration. `texlite config` prints the
effective paths and values. `texlite serve` keeps the process in the foreground
and does not start PM2.

For repository deployments, `ecosystem.config.cjs` and the npm PM2 wrappers are
also available. It deliberately runs one forked instance (`instances: 1`);
cluster mode is not supported because collaboration state, the compile queue,
SQLite, and the project filesystem are local to one process.

~~~bash
npm install --global pm2
npm run build
pm2 start ecosystem.config.cjs
pm2 status
pm2 logs texlite
~~~

The repository wrappers are `npm run pm2:start`, `npm run pm2:restart`,
`npm run pm2:stop`, `npm run pm2:delete`, `npm run pm2:logs`, and
`npm run pm2:save`.

After deploying new code:

~~~bash
npm run build
pm2 restart texlite --update-env
~~~

To keep the process across reboots, run the command printed by pm2 startup, then save the process list:

~~~bash
pm2 save
~~~

Useful lifecycle commands are pm2 stop texlite, pm2 restart texlite, pm2 delete texlite, and pm2 monit.

## Collaboration and compilation model

The editor uses a Yjs CRDT document for concurrent editing. Each active browser session is shown in the project header, and remote cursor colors identify editors. The intended scale is up to roughly ten active sessions on one project. The save indicator changes to “saved” only after the server acknowledges durable source persistence. Unsynchronized updates are also retained in browser IndexedDB and replayed after a transient disconnect; a history restore or Git checkout rotates the collaboration epoch so an obsolete local draft cannot overwrite the restored tree. Deleting or moving a file rejects late edits from sessions that still held its old editor binding.

The main document saved in project settings is the default root. When a user opens another `.tex` file containing `\documentclass`, that file becomes the compile root for that browser session; opening an included fragment does not change the current root. Only the current root is compiled. Compile status, logs, retained PDF, artifacts, outline, and SyncTeX state are keyed by root document, so collaborators working on different roots do not see each other's compile notification or replace each other's PDF.

Compilation is isolated from editing:

1. The server captures an immutable source snapshot.
2. Changed files are synchronized into a persistent compile workspace keyed by project, root document, and compiler settings.
3. latexmk reuses its dependency database and auxiliary files; jobs for the same root remain serialized.
4. The resulting PDF, logs, SyncTeX, and other artifacts are copied into an immutable run bundle.
5. A successful bundle is published atomically as the latest retained result.

The mutable cache for one root is never used concurrently, while different roots have separate caches and published artifacts are never modified in place. A user can continue viewing the previous PDF while a new compile is running. latexmk handles the necessary repeated passes for BibTeX-based documents and avoids rerunning BibTeX when its inputs have not changed. Compile responses expose a Server-Timing header for snapshot, cache synchronization, latexmk, artifact-copy, and total request time. TexLite does not retain a browsable compile history: it keeps only the latest attempt state and, when needed, the last successful result currently published for each root document. Older database rows and immutable artifact bundles are removed automatically.

## History, navigation, and diagnostics

Automatic history records source/file operations, compiler-setting changes, Git operations, restores, and acknowledged collaborative saves. Collaborative saves use fixed two-minute version windows, so continuous editing still creates useful recovery points without recording every keystroke. TexLite retains the latest 200 ordinary versions by default, plus every labeled and initial version. File contents are stored as complete SHA-256-addressed objects: unchanged data is reused, while a changed file creates a new complete object. A 512 MB soft per-project limit removes the oldest ordinary versions first; protected versions and the current internal baseline may exceed it. Project owners can see history storage usage and delete one version or clear all history without changing current project files. Unreferenced objects are garbage-collected. History is useful for correcting writing mistakes, but it is not a replacement for backing up the complete data directory.

Use Ctrl/Cmd+P to open a project file quickly and Ctrl/Cmd+Shift+F for literal project-wide search and replace. Project replacement is staged as one operation and creates a history version. The outline follows `\\input`, `\\include`, and `\\subfile` references from the main document. Structured warning/error entries resolve project-relative file names and jump directly to the matching source line; the raw latexmk transcript remains available.

Administrators can open **System status** on the project list. It reports only counts and timings—never source text, passwords, Git tokens, or comments. The same data is available at authenticated endpoint `GET /api/health/metrics`.

## GitHub backup

The Git panel is visible only to the project owner. A GitHub personal access token is configured per project and stored encrypted in SQLite. The local repository is initialized in the project source directory; Git identity is temporary for each command:

~~~text
user.name  = project owner's username
user.email = <username>@texlite.com
~~~

For a fine-grained GitHub token, the intended trusted-user deployment should grant repository Administration and Contents read/write permissions and use All repositories, because a repository may not exist when the token is configured and later repositories may be created. The token never appears in the remote URL or command-line arguments.

Normal checkout uses Git's preserving behavior and refuses conflicts. Only the explicit force option discards tracked, untracked, and ignored working-tree files. After checking out a historical revision, return to the default branch before committing or pushing.

## Data, backup, and deletion

The default data directory is:

~~~text
.texlite/
├── texlite.db
├── texlite.db-wal
├── texlite.db-shm
├── git-token.key
└── projects/
    └── <project-id>/
        ├── source/
        └── output/
            └── .texlite/   # compile cache/runs and history objects
~~~

Back up texlite.db, git-token.key, and projects/ together. The encryption key is required to recover saved GitHub tokens. SQLite WAL files should be included when taking a live filesystem backup, or use a SQLite-aware backup procedure.

Deleting a user removes their memberships and comments remain attributable as “Deleted User”. Depending on the administrator's choice, projects owned by that user can be transferred to the current administrator or deleted together with their files. The last active administrator cannot be removed or disabled.

## Security boundaries

texLite is designed for trusted users on localhost. The default compiler disables shell escape, does not concatenate shell commands, and enforces compile timeouts and concurrency limits. Nevertheless, LaTeX itself and a project latexmkrc are not a security sandbox. Before exposing texLite to an untrusted network or public registration, add an isolated compiler sandbox and an appropriate authentication/reverse-proxy layer.

## License and status

texLite is licensed under the GNU Affero General Public License v3.0. See [LICENSE](LICENSE). If you need proprietary modifications or commercial terms different from AGPL-3.0, contact the copyright holder for a separate commercial license.

This repository is an early, single-host application rather than a drop-in replacement for Overleaf. Review and adapt the deployment, backup, and security settings for the environment in which it will run.
