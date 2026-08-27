# TexLite design

This document records the design goals and the implementation choices that
shape TexLite. It complements the short [README](README.md) and the
[operations guide](OPERATIONS.md), which covers installation, configuration,
and day-to-day operation.

## Design goals

- Use the host's TeX Live/LaTeX installation so it can be updated independently.
- Keep the deployment small: one Node.js process, SQLite, local files, and no
  Redis, MongoDB, reverse proxy, or bundled LaTeX image for the default
  localhost setup.
- Keep project source, compile output, history, and credentials under one
  configurable data directory so that a complete backup is straightforward.
- Provide useful real-time collaboration for a small trusted group rather than
  emulate a distributed Overleaf deployment.
- Prefer durable, explicit boundaries over silently accepting a possibly stale
  or mixed-time source tree.

## Architecture

| Area | Implementation |
| --- | --- |
| Browser UI | React, Vite, CodeMirror, PDF.js |
| Localization | Frontend JSON resources plus a server-side error-code catalog, selected from `Accept-Language` |
| Editor language features | CodeMirror LaTeX syntax/folding, auto-pairs, project completion index, optional Vim mode |
| Writing assistance | One shared server-side Harper.js runtime with native browser spellcheck fallback; project dictionary stored by the server |
| API and static server | Fastify, WebSocket |
| Collaboration | Yjs, y-websocket, awareness messages, y-codemirror.next |
| Database | SQLite through better-sqlite3, foreign keys and WAL mode |
| Files | Local project directories under the configured data directory |
| Compilation | Host `latexmk` and a configured LaTeX engine |
| Formatting | Browser-side `tex-fmt` WASM package and `bibtex-tidy` |
| Git backup | Optional host Git and the GitHub REST API |
| Process management | Foreground `serve`, or the bundled PM2 lifecycle commands |

## Localization

The browser owns interface copy through the English and Chinese JSON resources
in `src/client/locales`. API errors use stable codes rather than route-local
human text. The server resolves those codes through `src/server/i18n.ts` using
the request's `Accept-Language` header; the browser API helper always supplies
its active language, and unmatched or non-browser requests fall back to
English. This keeps direct API clients usable while allowing the React client
to retain its more contextual local translations.

New user-correctable server failures must use `apiError()` for an immediate
response or `httpError()` for a thrown response. Do not place translated text
in route, filesystem, Git, or compiler-control code. Operational logs and
raw LaTeX output remain in their original form, so they can be searched and
diagnosed without changing behavior by browser language.

### Citation library

The citation library is stored in SQLite and is independent of project source
files. A `.bib` editor tab parses complete BibTeX entries locally, so saving a
reference preserves the author's original formatting; importing inserts the
selected entry at the current editor cursor and requires project write access.
Each user owns a private library. Citation entries and color tags are scoped to
the owning user; other users cannot list, search, import, edit, or delete them.
The homepage keeps Projects as the default view and exposes the
citation library as a separate management page beside the other management
controls; the project workspace keeps a smaller `.bib` import dialog for
in-context writing. Library results are server-filtered and paginated with 60
entries per page by default (the API accepts a bounded page-size override).
Library entries are checked in the browser with the `bibtex-tidy` JavaScript
parser and formatter before a mutation request is sent. Citation keys are unique
per user without regard to letter case. Creating an existing key is rejected;
updating an entry or its tags requires the revision last read by the client, so
concurrent browser sessions report a conflict instead of silently overwriting
newer content. Entry-text and tag-only mutations use separate endpoints, while
the explicit save-from-`.bib` action can replace the stored entry without
discarding its existing tags. The server retains only transport-level size and
field-shape limits; it does not reparse BibTeX syntax.

TexLite is intentionally a single-instance application. The collaboration
rooms, project mutation queues, compile coordinator, and SQLite database are
process-local. Startup acquires an atomic `.texlite.lock` directory in the data
directory and installs its owner record atomically; a live second process is
rejected, while a stale lock from a dead process can be recovered without
deleting a lock that is still being initialized. Cluster mode and multiple
application processes sharing one data directory are not supported.

## Configuration and startup

The npm package keeps configuration outside the package installation. The
effective configuration is selected in this order:

1. `--config PATH`;
2. `TEXLITE_CONFIG`;
3. `$XDG_CONFIG_HOME/texlite/texlite.config.json`;
4. `~/.config/texlite/texlite.config.json`.

The data directory defaults to `$XDG_DATA_HOME/texlite` or
`~/.local/share/texlite`, and can be changed with `storage.dataDir` or
`TEXLITE_DATA_DIR`. Relative configured paths are resolved relative to the
configuration file. The effective defaults and accepted ranges are documented
in the [operations guide](OPERATIONS.md) and are also available through
`texlite config`.

`texlite init` creates the configuration when necessary and creates the first
administrator. The server refuses to start without at least one active
administrator; public registration is not enabled. Configuration values are
validated before environment checks, database opening, or binding the HTTP
listener. Validation covers paths, limits, engines, timeout/queue settings,
URLs, and cross-field constraints such as the default engine being present in
the allowed-engine list.

Startup and `doctor` check `latexmk` and every configured LaTeX engine. Git is
optional: a host without Git can run the editor and compiler, while Git is
checked on demand when an owner opens or uses Git integration (or explicitly
with `texlite doctor --git`). Formatting is also optional: the browser loads
the bundled npm `tex-fmt` WASM module and `bibtex-tidy` only when formatting is
requested. TexLite never installs or updates TeX packages.

`texlite serve` runs in the foreground and is suitable for debugging, Docker,
or systemd. `start`, `status`, `stop`, `restart`, and `logs` use the bundled
PM2 dependency. Managed startup waits for both PM2 and the HTTP health probe;
status has a colored systemctl-style view and a `--json` form for scripts.
PM2 7.0.3 currently declares `js-yaml@4.3.0`, so dependency audits may report
the upstream GHSA-5p4m-2wfm-xmqj advisory. TexLite invokes PM2 through its
JavaScript API and does not load user- or project-supplied YAML configuration;
deployments requiring a zero-advisory dependency tree can instead supervise
`texlite serve` with systemd or Docker until PM2 updates that dependency.
Expired login sessions are pruned at startup and periodically while the
process is running, rather than merely being ignored during authentication.
Administrators can open the System status view (or authenticated
`GET /api/health/metrics`) for in-memory uptime, resource, queue, collaboration,
event-loop, and recent latency summaries. These metrics intentionally exclude
source text, passwords, tokens, and comment content.

## Collaboration and source persistence

Each open project has one Yjs room. Awareness data provides active-session
avatars, user names, permissions, file paths, cursor colors, and the ten-session
project limit. Ordinary Yjs edits remain concurrent; source-tree replacement
operations temporarily enter maintenance, notify/close collaborators, and
rotate the collaboration epoch so an old offline draft cannot overwrite a
checkout or history restore. Browser IndexedDB retains unsent updates across a
transient disconnect.

Read permission is intentionally different from edit permission: read-only
members cannot modify source files, but can view the project and add or reply
to source comments. Comments are anchored to source offsets and selected text,
can be resolved, edited, deleted, and replied to. If an author is removed,
the record remains visible as “Deleted User”.

The collaboration service uses a versioned handshake and a versioned epoch
marker. When a browser from an incompatible release connects, it is forced to
reload before it can decode or send source updates. Protocol-only migrations
preserve the browser's offline draft; source-tree replacements still clear the
draft because the server tree is authoritative.

The collaboration service persists dirty text with atomic temporary-file writes
and returns a receipt containing `revision`, `persistedAt`, `ok`, and failed
paths. Failed writes remain dirty and are retried in the background. Every
ordinary source operation must accept a successful receipt: the coordinator
returns `409 SOURCE_FLUSH_FAILED` with `failedPaths` instead of proceeding with
a stale disk tree. This applies to Git checkout/restore, history restore,
file/folder writes, moves/deletes, project deletion, and consistent reads. A
flush requested while a snapshot barrier is active is deferred until the
barrier closes, so the browser does not receive a false failure for an edit that
was intentionally held in memory. If a collaborative text edit exceeds the
configured limit, it is restored to the last durable content and the flush
receipt identifies the rejected path.

Yjs state persistence is reserved for source and HTTP-originated text updates.
Ephemeral metadata such as compile status, file-list revisions, and comment or
dictionary invalidation markers is broadcast live and reconstructed from the
database/source tree after restart; metadata-only events therefore do not cause
another full synchronous Yjs state rewrite. During room recovery the server
removes old markers and validates any queued/running compile state against
`compile_runs`. The collaboration handshake also sends a small
server-authoritative compile-state snapshot, so a stale browser IndexedDB entry
cannot make a read-only workspace appear permanently busy.

Each collaboration message refreshes the account record before applying an
update. Disabling a user, deleting the account, or changing project membership
therefore takes effect for an already-open socket rather than relying only on
the next reconnect. Binary uploads also publish a source-tree event so other
open workspaces refresh their file lists even though binary files are not Yjs
text objects.

`ProjectMutationCoordinator` has two related controls:

| Operation class | Examples | Coordination behavior |
| --- | --- | --- |
| Serialized source operation | File writes, settings, Git metadata, project-wide replace | Waits for queued operations, waits for a ready room, flushes the room, then runs while holding the per-project queue. |
| Exclusive source replacement | Git checkout/restore, history restore, project deletion, path move | Waits for active compilation, flushes successfully, enters maintenance, performs the replacement, and resets the collaboration epoch. |
| Consistent source read | Archive/download, raw source, history comparison, search, outline, completion index, Git diff/history | Uses the queue and a short snapshot barrier. The barrier blocks disk autosaves while an asynchronous scan/copy runs, then validates the deferred flush before returning. |
| Background compilation | `latexmk` on an immutable snapshot | Holds a compile reservation but not the ordinary source queue, so editing, source reads, and the retained PDF can continue. |
| Compile-state cleanup | Cache/artifact recovery | Waits for active compiles and serializes output removal without disconnecting collaborators. |
| Published PDF read | PDF.js/range requests | Reads an immutable published bundle directly and does not wait for cold Yjs-room initialization; a concurrent cleanup may produce a normal 404. |
| Cold file-list read | Project file tree | Uses the queue and a short barrier, but does not wait for a cold Yjs-room hydration; a concurrent cleanup is treated as a normal missing entry. |

The source tree is checked with `lstat`-based path walks. ZIP imports, project
duplication, Git checkout, file listing, and source resolution reject symbolic
links (except that deletion may address a final link itself without following
its target). This prevents a project path from escaping its source directory.

## Editor, files, and navigation

The editor is CodeMirror-based and provides LaTeX syntax highlighting, folding,
auto-pairs (including `\begin{...}`/`\end{...}`), indentation, Vim mode when
explicitly enabled, and completion items from built-in LaTeX plus project
`.tex`, `.sty`, and `.cls` definitions and BibTeX labels. Completion indexes and
outlines are metadata-keyed and coalesced; a source-tree change invalidates the
corresponding cache.

Opening `.tex`, `.bib`, `.sty`, or `.cls` files in editor tabs is an optional
per-user/per-project preference and is off by default. The active tab is
highlighted and keyboard accessible. PDF/SyncTeX synchronization is available
only for the current `.tex` root document; a non-root tab remains editable but
does not claim a PDF location.

Each project collaboration object owns one Yjs undo manager per source file.
Editor tab remounts therefore preserve Ctrl/Cmd+Z and Vim undo history without
leaving obsolete CodeMirror/Yjs observers behind. Managers are released when
the collaboration object is destroyed or loses edit permission.

One asynchronously initialized Harper runtime on the Node server performs spelling and
grammar checks for every project. Requests are serialized around the shared
WASM linter, while the browser masks LaTeX commands/environments, comments,
references, option keys/values, and table column specifications before sending
prose. Spelling uses a red wavy underline and grammar uses yellow. A context
menu offers Harper suggestions; read-only members can inspect suggestions but
cannot apply edits. The shared project dictionary is kept in SQLite and filters
project-specific spelling results. If the Harper endpoint fails, CodeMirror
enables the browser's built-in English spellchecker until the user retries.

Formatting is independent from the editor's local appearance. A user can
manually format a selection or enable the per-user/per-project “format before
compile” preference. The browser uses bundled `tex-fmt` WASM for `.tex`, `.cls`,
and `.sty`, and `bibtex-tidy` for `.bib`; the editor settings also provide a
per-user/per-project TOML options string passed to `tex-fmt`. The formatter and
text-diff calculation run in a lazily loaded Web Worker, so opening a project
does not wait for them and formatting does not block the editor UI. Formatter
diagnostic logs are shown as expandable warnings. A formatter failure reports
an error but does not prevent compilation. There is no silent Prettier fallback.

Before a formatter computes a replacement it acquires a short-lived, per-file
lease from the live Yjs room. The lease is held only for the format/snapshot,
final Yjs apply, and a durability flush; ordinary typing and compilation are
not blocked. A second formatter for the same path waits in a bounded FIFO queue,
and the server grants it only after the first session's update has been
received and flushed. Leases carry an expiring random token, renew before the
final apply, and are released automatically on timeout, permission loss, or
WebSocket disconnect. Because the lease is process-local, it is deliberately
scoped to TexLite's single-instance deployment; it is not a distributed lock.
If a source edit arrives while a formatter is working, the client discards the
stale replacement rather than applying offsets to newer text.

Project duplication flushes the live source room and copies the tree under a
short read barrier. Uploading a replacement text file also re-anchors existing
source comments against the old and new contents before notifying collaborators.

The outline follows `\input`, `\include`, and `\subfile` references and
jumps to source lines. The source and PDF panes expose explicit SyncTeX arrows,
and PDF double-click can request the corresponding source location. Search and
replace is project-wide, staged as one serialized operation, and records one
history version. Structured compile diagnostics resolve project-relative
file names and line numbers; the raw `latexmk` transcript remains available.

## Compilation and retained output

The project setting supplies the default root document. Project settings list
and accept only `.tex` files containing a real `\documentclass` declaration;
an imported project with exactly one `.tex` file may use that file as a
compatibility fallback. The server enforces the same rule for compile and
preview routes. A browser session may select another detected root, and only
the currently selected root is compiled. Compile state, logs, retained PDF,
artifacts, outline, and SyncTeX are keyed by root, so collaborators working on
different roots do not replace each other's result or compile notification.

Compilation follows this sequence:

1. Admission validates permissions/root selection and coalesces requests by
   project, root, and a cheap source/settings generation.
2. After coalescing, TexLite flushes the room and captures a source snapshot.
   A short snapshot barrier prevents autosave from modifying the source tree
   while the asynchronous copy and digest run. Edits that arrive during the
   barrier remain in Yjs memory until the snapshot is complete, so the
   captured tree is internally consistent even when it is already older than
   the live editor. Such a compile is accepted and the workspace labels the
   retained PDF as based on an earlier snapshot; only a failed post-barrier
   flush remains retryable.
3. Changed files are synchronized into an incremental compile workspace keyed
   by project, root, engine, latexmkrc, and compiler arguments. The cache is
   reused only for the same root; root-specific caches can compile concurrently
   within the global `maxCompileJobs` limit.
4. `latexmk` runs with `-norc` and `-synctex=1`, line-oriented error output, and shell escape
   disabled by default. Its process group, including `pdflatex`, BibTeX/Biber,
   and other descendants, is terminated on timeout. latexmk itself performs
   the repeated passes required by bibliography documents.
5. A successful PDF, SyncTeX file, log, and generated artifacts are copied into
   an immutable run bundle. A small atomic manifest switch publishes it as the
   latest result; an older bundle is retained briefly so an already-open PDF
   request can finish.

The previous successful PDF remains visible during a new compile. The latest
published bundle is recovered after a restart and can be served before a cold
collaboration room is initialized. PDF requests support range responses for
PDF.js and expose the successful compile time and artifact size. The default
automatic loading policy uses a complete, cache-friendly response through 5 MB
and enables PDF.js byte-range loading above that threshold; deployments can
force either mode without changing project compiler settings. The output panel groups the PDF,
log, warnings, errors, generated artifacts, and recovery actions; clean-cache
and clean-artifact actions are for recovery rather than routine compilation.
Compile responses expose `Server-Timing` measurements for snapshot, cache
synchronization, LaTeX execution, artifact publication, and total request time
so queue and rendering regressions can be diagnosed. Artifact listing and
download endpoints treat removal of a run between manifest lookup and file
read as an empty list or 404, rather than exposing a filesystem race as a 500.
TexLite does not keep an unlimited browsable compile history: old unsuccessful
run rows and unreferenced bundles are pruned, while the latest successful
result for each root is retained.

## History and recovery

History records initial state, acknowledged collaborative saves, file/source
operations, compiler settings, Git operations, checkpoints, and restores.
Autosaves by the same author are coalesced within a two-minute window. File
contents are complete SHA-256-addressed objects; unchanged files are reused
across manifests. The retention defaults are 200 ordinary unlabeled versions
and 128 MB of deduplicated objects per project. Initial and labeled versions,
plus the current internal baseline, are protected and can make the soft limit
temporarily exceed its target. Retention pruning batches reference accounting
and removes unreferenced objects.

Owners can view storage statistics, delete one version, or clear all history
without changing current source files. Restore is an exclusive source
operation, reanchors comments against the before/after text, updates project
settings when restoring a complete version, and resets the collaboration epoch.
History is a recovery mechanism, not a substitute for backing up the complete
data directory.

## GitHub backup

The Git panel is project-owner-only. Git is optional at startup and is checked
when Git integration is used. A per-project GitHub token is encrypted in
SQLite; it is never placed in a remote URL or command-line argument. The local
repository lives in the project source directory, with temporary identity:

~~~text
user.name  = project owner's username
user.email = <username>@texlite.com
~~~

For a fine-grained GitHub token in a trusted deployment, grant repository
Administration and Contents read/write permissions. “All repositories” is the
practical choice when a repository may be created after token configuration.
Only the owner can commit, push, checkout, restore, or configure the project
repository. Commit messages are entered explicitly. Normal checkout preserves
local changes and refuses conflicts; only the explicit force option discards
tracked, untracked, and ignored working-tree files. The Git operations use the
same project coordination and durable-flush boundary as other source
replacements.

## Data, backup, tags, and deletion

The default data layout is:

~~~text
<data-dir>/
├── .texlite.lock
│   └── owner.json
├── texlite.db
├── texlite.db-wal
├── texlite.db-shm
├── git-token.key
├── tmp/ and trash/
└── projects/
    └── <project-id>/
        ├── source/
        └── output/
            └── .texlite/
                ├── cache/
                ├── runs/
                └── history/
~~~

Back up `texlite.db`, `git-token.key`, and `projects/` together. Include the
SQLite WAL files in a live filesystem backup or use a SQLite-aware backup
procedure. The token encryption key is required to recover saved GitHub
credentials.

Tags and archive state are private to each user. A project can therefore have
different labels, filters, and archived/active visibility for different
collaborators. Deleting a project removes its database rows and source/output
directory; deletion uses a temporary trash rename when possible and a startup
reaper cleans abandoned trash/temp entries. Deleting a user removes sessions,
memberships, private tags, and comments remain attributable as “Deleted User”.
An administrator can transfer the user's owned projects to the current
administrator or delete them with their files. Project transfer keeps the old
owner as an editor and clears the project GitHub token so the new owner must
configure their own credential. Administrators do not otherwise receive
implicit access to another user's projects; they see a project only when they
own it or it has been explicitly shared with them. The last active
administrator cannot be removed or disabled.

## Known limitations and TODO

These items describe remaining engineering work rather than promises of a
particular release. Security items are especially important if the deployment
model expands beyond a small group of trusted users on localhost.

### Required before untrusted or public deployment

- [ ] Isolate compilation. LaTeX is not a security sandbox, and a project
  `latexmkrc` is executable Perl. Prefer a dedicated low-privilege account or
  container/sandbox and apply CPU, memory, process, and filesystem limits.
- [ ] Add deployment-aware HTTP protections: configurable trusted-proxy
  handling, explicit Origin/CSRF validation for deployments that are not
  localhost-only, and conservative response/security headers. Login limiting
  and strict session-cookie defaults are present but are not a complete public
  deployment policy.
- [x] Validate every PDF annotation URL against an explicit protocol allowlist,
  including the URL that PDF.js labels as sanitized, before creating an
  external browser link.
- [x] Harden compile-output serving. PDF and artifact listing/stat/copy paths
  treat cleanup races as an empty result or 404 and never expose an expected
  missing-file race as a 500.

### Correctness and recovery

- [ ] Make database/filesystem lifecycle operations fully crash-recoverable.
  Project creation/import/duplication, project deletion, user cleanup, history
  deletion, and temporary downloads still need explicit tombstones or startup
  reconciliation for every failure point.
- [x] Refresh collaboration account/access data at message time and disconnect
  revoked users; membership changes are also pushed to open clients.
- [x] Strengthen source-comment re-anchoring. A diff-mapped range is accepted
  only when it still contains the original selected text; replacements and
  ambiguous repeated text require matching surrounding context or are marked
  orphaned for manual review.
- [x] Detect root documents as source files are opened and edited, ignoring
  comments and common verbatim environments. The settings API and UI expose
  only files with a real `\documentclass` declaration as candidates; a sole
  `.tex` file remains a compatibility fallback for single-file imports. The
  editor applies the same rule instead of trusting the configured path.
- [ ] Add failure-injection tests for crashes between source snapshot,
  publication, database compile status updates, project deletion, and history
  cleanup.

### Performance and maintainability

- [ ] Move large history snapshots, retention scans, and object garbage
  collection away from synchronous request/startup paths, and add integrity
  recovery for missing or orphaned history objects.
- [ ] Record per-project queue wait time and add a real-browser concurrency
  benchmark covering a long compile alongside editing, PDF range requests,
  SyncTeX, cleanup, and Git checkout.
- [ ] Continue modularization of the largest files, especially
  `server/app.ts`, `server/collaboration.ts`, and `client/App.tsx`, so
  authorization and coordination rules are easier to audit and test
  independently.
