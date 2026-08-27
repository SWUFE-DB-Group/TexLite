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
node --version
npm --version
latexmk --version
xelatex --version
# Optional, for Git/GitHub integration:
git --version
~~~

`texlite init`, `texlite start`, and `texlite doctor` validate `latexmk` and
every engine named in `latex.allowedEngines`. Git is intentionally excluded
from the core check, so a host without Git can run TexLite normally; use
`texlite doctor --git` to check it explicitly.

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

Uninstalling the package does not remove configuration or data:

~~~bash
npm uninstall --global texlite
~~~

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
| `texlite doctor` | Validate configuration, paths, LaTeX, and administrator state; add `--git` for optional Git. |
| `texlite config` | Print effective configuration and paths without changing them. |

`start`, `stop`, `restart`, `status`, and `logs` use the PM2 runtime bundled
with the global npm package—no separate global PM2 install is necessary.
Managed startup waits for the HTTP health endpoint, and `restart` recreates the
managed process so it uses paths from the newly installed npm version.

For a source checkout, `ecosystem.config.cjs` and the `npm run pm2:*` scripts
remain available. Run exactly one forked instance: cluster mode and multiple
TexLite processes sharing one data directory are unsupported because
collaboration state, the compile queue, SQLite, and project files are local to
one process.

## Configuration

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
starting point. It intentionally uses `.texlite` for repository development;
`texlite init` instead writes the XDG data-directory default.

### Important settings and effective defaults

| Setting | Default | Notes |
| --- | --- | --- |
| `siteName` | `TexLite` | Site title. |
| `adminEmail` | empty | Optional administrator contact address. |
| `server.host` / `server.port` | `127.0.0.1` / `3000` | Keep localhost unless the deployment is separately secured. |
| `storage.dataDir` | XDG data directory | Stores all persistent project data. |
| `clientDir` | Installed package's `dist/client` | Normally changed only for development or a custom deployment. |
| `sessionDays` | `14` | Login-session lifetime. |
| `uploads.maxFileSizeMB` | `50` MB | Limit for uploads, ZIP entries, and attachments. |
| `pdf.loadingStrategy` / `pdf.rangeThresholdMB` | `auto` / `5` MB | Chooses full transfer for small PDFs and byte ranges for larger ones. |
| `history.maxVersions` / `history.maxStorageMB` | `200` / `128` MB | Per-project ordinary-version count and soft storage limit. |
| `latex.latexmk` | `latexmk` | Host command. |
| `latex.defaultEngine` | `xelatex` | Must appear in the allowed list. |
| `latex.allowedEngines` | `pdflatex`, `xelatex`, `lualatex` | Engines available in the UI. |
| `latex.extraArgs` | `[]` | Additional configured compiler arguments. |
| `latex.compileTimeoutSeconds` | `600` | Per-job time limit. |
| `latex.maxCompileJobs` | `10` | Global concurrent LaTeX-process limit. |
| `latex.allowProjectLatexmkrc` | `true` | Enables an owner-configured, multi-line `latexmkrc`. |
| `git.binary` / `git.operationTimeoutSeconds` | `git` / `120` seconds | Used only by optional Git integration. |
| `git.githubApiBaseUrl` | `https://api.github.com` | GitHub REST API endpoint. |

The current environment-variable overrides are:

~~~text
TEXLITE_CONFIG
XDG_CONFIG_HOME                 XDG_DATA_HOME
TEXLITE_SITE_NAME               TEXLITE_ADMIN_EMAIL
TEXLITE_HOST                    TEXLITE_PORT
TEXLITE_DATA_DIR                TEXLITE_CLIENT_DIR
TEXLITE_SESSION_DAYS            TEXLITE_MAX_UPLOAD_SIZE_MB
TEXLITE_PDF_LOADING_STRATEGY    TEXLITE_PDF_RANGE_THRESHOLD_MB
TEXLITE_HISTORY_MAX_VERSIONS    TEXLITE_HISTORY_MAX_STORAGE_MB
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
`1–2048` MB, history count `10–5000`, history size `16–102400` MB, PDF range
threshold `1–2048` MB, compile timeout `1–3600` seconds, compile jobs `1–32`,
and Git timeout `1–3600` seconds.

Before every compile TexLite passes `-norc` to `latexmk`. A `.latexmkrc` found
in a ZIP upload, Git checkout, or project file tree is ignored. It is used only
when the owner explicitly saves it through Project Settings, which passes it
with `-r`. An `latexmkrc` is executable Perl configuration and should remain
disabled for users you do not trust.

TexLite never runs `tlmgr` or installs TeX packages. Updating the host TeX
distribution changes the environment used by subsequent compiles.

## Development and verification

Run the API/server watcher and Vite in separate terminals:

~~~bash
npm run dev       # API/server: http://127.0.0.1:3000
npm run dev:web   # Vite UI:    http://127.0.0.1:5173
~~~

Vite proxies `/api` requests to the server. Validate a production-style build
with:

~~~bash
npm run typecheck
npm test
npm run build
npm start
~~~

## Backup and security

Back up the entire configured data directory, including `texlite.db`, its WAL
files, `git-token.key`, and `projects/`. Restoring saved GitHub tokens requires
the same encryption key. For an online copy of SQLite, include WAL files or use
a SQLite-aware backup method.

TexLite is designed for trusted users on localhost. Shell escape is disabled by
default and compile jobs have timeouts and concurrency limits, but LaTeX itself
is not a security boundary. Before exposing it to an untrusted network, add an
isolated compiler sandbox plus appropriate authentication and network controls.
