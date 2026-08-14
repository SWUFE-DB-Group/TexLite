# TexLite design

This document records the design goals and the implementation choices that
shape TexLite. It complements the [README](README.md), which focuses on
installation, configuration, and day-to-day operation.

## Design goals

- Use the host's TeX Live/LaTeX installation so it can be updated independently.
- Avoid Redis, MongoDB, and a reverse proxy for the default localhost deployment.
- Keep projects and generated artifacts on the local filesystem.
- Use SQLite through better-sqlite3 for durable application data.
- Provide useful collaboration for a small number of active sessions without requiring a distributed deployment.

## Architecture

| Area | Implementation |
| --- | --- |
| Browser UI | React, Vite, CodeMirror, PDF.js |
| API and static server | Fastify, WebSocket |
| Collaboration | Yjs, y-websocket, y-codemirror.next |
| Database | SQLite via better-sqlite3 |
| Files | Local project directories under the configured data directory |
| Compilation | Host latexmk and a configured LaTeX engine |
| Formatting | Optional host `tex-fmt` executable |
| Git backup | Host git and the GitHub REST API |

TexLite is designed as a single Node.js process. Do not run multiple
application instances against the same SQLite database or project directory;
the in-memory collaboration service and compile queue are intentionally
single-instance.

## Collaboration and compilation model

The editor uses a Yjs CRDT document for concurrent editing. Each active
browser session is shown in the project header, and remote cursor colors
identify editors. The intended scale is up to roughly ten active sessions on
one project. The save indicator changes to “saved” only after the server
acknowledges durable source persistence. Unsynchronized updates are also
retained in browser IndexedDB and replayed after a transient disconnect; a
history restore or Git checkout rotates the collaboration epoch so an obsolete
local draft cannot overwrite the restored tree. Deleting or moving a file
rejects late edits from sessions that still held its old editor binding.

The main document saved in project settings is the default root. When a user
opens another `.tex` file containing `\documentclass`, that file becomes the
compile root for that browser session; opening an included fragment does not
change the current root. Only the current root is compiled. Compile status,
logs, retained PDF, artifacts, outline, and SyncTeX state are keyed by root
document, so collaborators working on different roots do not see each other's
compile notification or replace each other's PDF.

Compilation is isolated from editing:

1. The server captures an immutable source snapshot.
2. Changed files are synchronized into a persistent compile workspace keyed by
   project, root document, and compiler settings.
3. latexmk reuses its dependency database and auxiliary files; jobs for the
   same root remain serialized.
4. The resulting PDF, logs, SyncTeX, and other artifacts are copied into an
   immutable run bundle.
5. A successful bundle is published atomically as the latest retained result.

The mutable cache for one root is never used concurrently, while different
roots have separate caches and published artifacts are never modified in
place. A user can continue viewing the previous PDF while a new compile is
running. latexmk handles the necessary repeated passes for BibTeX-based
documents and avoids rerunning BibTeX when its inputs have not changed.
Compile responses expose a Server-Timing header for snapshot, cache
synchronization, latexmk, artifact-copy, and total request time. TexLite does
not retain a browsable compile history: it keeps only the latest attempt state
and, when needed, the last successful result currently published for each root
document. Older database rows and immutable artifact bundles are removed
automatically.

## History, navigation, and diagnostics

Automatic history records source/file operations, compiler-setting changes, Git
operations, restores, and acknowledged collaborative saves. Collaborative saves
use fixed two-minute version windows, so continuous editing still creates
useful recovery points without recording every keystroke. TexLite retains the
latest 200 ordinary versions by default, plus every labeled and initial
version. File contents are stored as complete SHA-256-addressed objects:
unchanged data is reused, while a changed file creates a new complete object.
A 512 MB soft per-project limit removes the oldest ordinary versions first;
protected versions and the current internal baseline may exceed it. Project
owners can see history storage usage and delete one version or clear all
history without changing current project files. Unreferenced objects are
garbage-collected. History is useful for correcting writing mistakes, but it is
not a replacement for backing up the complete data directory.

Use Ctrl/Cmd+P to open a project file quickly and Ctrl/Cmd+Shift+F for literal
project-wide search and replace. Project replacement is staged as one operation
and creates a history version. The outline follows `\input`, `\include`, and
`\subfile` references from the main document. Structured warning/error entries
resolve project-relative file names and jump directly to the matching source
line; the raw latexmk transcript remains available.

Administrators can open **System status** on the project list. It reports only
counts and timings—never source text, passwords, Git tokens, or comments. The
same data is available at authenticated endpoint `GET /api/health/metrics`.

## GitHub backup

The Git panel is visible only to the project owner. A GitHub personal access
token is configured per project and stored encrypted in SQLite. The local
repository is initialized in the project source directory; Git identity is
temporary for each command:

~~~text
user.name  = project owner's username
user.email = <username>@texlite.com
~~~

For a fine-grained GitHub token, the intended trusted-user deployment should
grant repository Administration and Contents read/write permissions and use
All repositories, because a repository may not exist when the token is
configured and later repositories may be created. The token never appears in
the remote URL or command-line arguments.

Normal checkout uses Git's preserving behavior and refuses conflicts. Only the
explicit force option discards tracked, untracked, and ignored working-tree
files. After checking out a historical revision, return to the default branch
before committing or pushing.

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

Back up `texlite.db`, `git-token.key`, and `projects/` together. The encryption
key is required to recover saved GitHub tokens. SQLite WAL files should be
included when taking a live filesystem backup, or use a SQLite-aware backup
procedure.

Deleting a user removes their memberships and comments remain attributable as
“Deleted User”. Depending on the administrator's choice, projects owned by that
user can be transferred to the current administrator or deleted together with
their files. The last active administrator cannot be removed or disabled.
