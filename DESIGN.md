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
| Writing assistance | Optional host `harper-cli` plus opt-in host `chktex`; Harper provides spelling/grammar suggestions, ChkTeX provides LaTeX writing diagnostics, and the project dictionary is stored by the server |
| API and static server | Fastify, WebSocket |
| Collaboration | Yjs, y-websocket, awareness messages, y-codemirror.next |
| Database | SQLite through better-sqlite3, foreign keys, WAL mode, and `synchronous=NORMAL` |
| Files | Local project directories under the configured data directory |
| Compilation | Host `latexmk` and a configured LaTeX engine |
| Formatting | Browser-side `tex-fmt` WASM package and `bibtex-tidy` |
| Git backup | Optional host Git and the GitHub REST API |
| Process management | Foreground `serve`, or the bundled PM2 lifecycle commands |
| External tool terminals | Administrator opt-in; adapter-based host CLIs, optional `node-pty`, lazy xterm.js UI, independent task working copies |

## Localization

The browser owns interface copy through English (`en`), Simplified Chinese (`zh`),
and Traditional Chinese (`zh-Hant`) JSON resources in `src/client/locales`.
The shared locale resolver preserves existing `zh` preferences and recognizes
`zh-TW`, `zh-HK`, and `zh-MO` as Traditional Chinese; an explicit `Hans` or
`Hant` script takes precedence over the region. Saved choices take precedence
over browser preferences. The active locale also drives the HTML language and
localized dates and relative times. API errors use stable codes rather than route-local
human text. The server resolves those codes through `src/server/i18n.ts` using
the request's `Accept-Language` header; the browser API helper always supplies
its active language for both JSON requests and ZIP uploads. The server honors
language preference weights and uses matching Traditional Chinese messages;
unmatched or non-browser requests fall back to
English. This keeps direct API clients usable while allowing the React client
to retain its more contextual local translations.

New user-correctable server failures must use `apiError()` for an immediate
response or `httpError()` for a thrown response. Do not place translated text
in route, filesystem, Git, or compiler-control code. Operational logs and
raw LaTeX output remain in their original form, so they can be searched and
diagnosed without changing behavior by browser language.

Traditional Chinese is a separately maintained catalog, not a runtime character
conversion. Use consistent terminology such as 專案, 檔案, 原始碼, 儲存庫,
and 批註 (collaborative comments). Tests check catalog keys, interpolation
variables, rich-text tags, language detection, persistence, and API headers.

### Project catalog

The homepage places All projects, Owned by me and Shared with me tabs below the
page title. Ownership is filtered on the server before pagination (20 projects
per page), preserving the existing list/grid views, search, private tags,
sorting and per-user archive filter. Each response includes counts for all three
categories under the current search and tag conditions, including both active
and archived projects, independently of the selected category, archive filter
and page; zero counts are not displayed. Pagination totals still follow the
archive filter. Archiving/unarchiving preserves tab counts; deletion reduces
them. Administrators only see and count projects they own or that were explicitly
shared with them.

Changing category resets pagination. The browser caches rows together with the
category, filters, counts and page, so returning from a workspace restores the
same view before revalidation. Obsolete requests are aborted and ignored, and
rows from a previous category are not shown while its replacement is loading.
Successful catalog mutations revalidate the currently selected view.

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
Entry management actions live in an accessible, portalled overflow menu, with
deletion separated from ordinary actions and still requiring confirmation.
Copy BibTeX remains a direct button, preserves the full entry text and shows a
two-second result on the button. It falls back to selection-based copying for
HTTP/LAN browsers without usable
Clipboard API access. Save/import remain direct actions in project dialogs.
Library rows use compact spacing and a single-line title with the full title
available on hover.
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

Update reminders use a single server-side npm `latest` check, with a 24-hour
success interval, one-hour failure backoff, five-second timeout and shared
in-flight request. Listening starts the background checker; authenticated
administrator dashboard requests can also refresh a stale result. The SQLite
cache survives restarts. Per-administrator dismissals suppress that release and
older releases, and cascade on account deletion. Both tables are introduced by
schema migration 5. `updates.enabled: false` disables checks and reminders.
The dashboard polls the local cached endpoint every 30 minutes and when made
visible, without adding requests to the writing workspace. The browser never
contacts the registry. Only the version response is consumed; no project data
or credentials are sent. Installation detection selects npm or Docker help,
and administrators can switch the displayed method. Docker help updates the
launcher with `git pull --ff-only` before image pull/container recreation;
it explicitly notes that images can lag behind npm. Updates remain manual.

The npm package includes the built frontend, PDF worker, Adobe CMaps, formatter
WASM, fonts, and generated Lucide SVGs. Browser libraries and build tools are
development dependencies; the published installation needs only the server's runtime
dependencies. Source builds require development dependencies. A dependency
check covers emitted imports from server and shared modules, including dynamic
imports, while release testing installs the tarball outside the checkout with
`--omit=dev` as described in [NPM_TESTING.md](NPM_TESTING.md).

Production builds also emit gzip (level 6) and Brotli (quality 5) variants of
JS, MJS, CSS and WASM assets under `assets/`, including bundled Worker scripts.
Compression uses Node's built-in zlib with bounded concurrency, applies only
to files of at least 2 KiB, and keeps a variant only when it saves at least 10%.
PDFs, archives, images, fonts, packed CMaps and the runtime-injected HTML are
excluded. Fastify negotiates the precompressed variants through
`Accept-Encoding`, sets `Vary: Accept-Encoding`, and preserves original MIME
types and fingerprinted cache policies. Original files remain available for
clients without compression support and for older builds without variants.
No request-time compression or additional runtime dependency is required;
the trade-off is a modest increase in build time and distribution size.

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

`server.basePath` mounts the complete application below an origin path while
retaining one distributable frontend build. Fastify scopes API, WebSocket,
static-resource, and SPA routes to that prefix; the generated HTML declares the
runtime base for relative Vite assets and client URL helpers. Browser-side
collaboration drafts and layout preferences include the mount point in their
storage namespace so two instances under one origin cannot share local state.

`texlite init` creates the configuration when necessary and creates the first
administrator. New configuration files contain only explicit initialization
choices: a supplied site name/contact email and host, port, base-path or data
directory overrides. Accepting all defaults can produce an empty JSON object;
omitted options use runtime defaults and can follow future default changes.
Existing configuration files are never automatically rewritten or stripped.
The server refuses to start without at least one active
administrator; public registration is not enabled. Configuration values are
validated before environment checks, database opening, or binding the HTTP
listener. Validation covers paths, limits, engines, timeout/queue settings,
URLs, and cross-field constraints such as the default engine being present in
the allowed-engine list.

Startup checks Node.js, `latexmk`, and every configured LaTeX engine.
`texlite requirements` performs a configuration-free preflight over the
default host commands, requiring Node.js, `latexmk`, and at least one supported
LaTeX engine. `texlite doctor` also reports optional host tools in a
requirement/status/version table: Git, TeXcount, bibliography/index tools,
ChkTeX, Harper CLI, and `harper-ls`. A host without Git can run the editor and compiler;
Git is checked on demand when an owner opens or uses Git integration. Formatting is also optional: the browser loads
the bundled npm `tex-fmt` WASM module and `bibtex-tidy` only when formatting is
requested. TexLite never installs or updates TeX packages.

`texlite serve` runs in the foreground and is suitable for debugging, Docker,
or systemd. `start`, `status`, `stop`, `restart`, and `logs` use the bundled
PM2 dependency. Managed startup waits for both PM2 and the HTTP health probe;
status has a colored systemctl-style view and a `--json` form for scripts.
Managed processes use fixed `logs/stdout.log` and `logs/stderr.log` paths
under the configured data directory. An internal asynchronous copy/truncate
rotator checks at startup (after the instance lock) and every minute, rotates
at 10 MiB, and retains three uncompressed backups for each stream. Checks do
not overlap and shutdown waits for any active rotation before releasing the
instance lock. Copy failures leave the original log intact. Copy/truncate can
lose concurrent diagnostic messages, and this is not a strict disk quota or
an audit trail. No external PM2 module is installed; old numbered PM2 logs,
daemon logs and other applications' logs are untouched. Existing processes
adopt these paths on `texlite restart`; foreground output remains caller-managed.
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

Event-loop latency uses Node's interval histogram with a shared 20 ms sampling
resolution. The API subtracts that interval before rounding P50, P95 and Max to
0.1 ms, clamping timer jitter below the baseline to zero. These are estimated
excess scheduling delays, not exact per-callback latency measurements. Empty
histograms report `null` (displayed as a dash). The window is cumulative since
service startup; reading metrics does not reset it or affect another viewer.

Memory uses a storage-style segmented bar: total used memory, service and TeX
process shares, other usage, and available capacity. Process shares are RSS
estimates, not exclusive allocations. If they exceed measured usage because of
shared pages or sampling skew, their visual proportions are fitted inside the
used region; raw values are preserved and other usage is never negative.
Unavailable readings remain unavailable rather than being interpreted as zero;
without a container limit, only the used-memory breakdown is drawn.
Collection uses only Node.js and OS facilities: Linux `/proc`, macOS
`ps`, and Windows PowerShell/CIM. Linux containers use cgroup v1/v2 usage and
visible ancestor limits; an unset/unreadable limit is not replaced with host
capacity. Container usage includes page cache and other cgroup-accounted memory;
host usage uses Linux `MemAvailable` where available, otherwise OS free memory.
The TeX sample matches a fixed set of common engine and auxiliary-tool names,
including Perl-hosted latexmk and native Harper CLI writing checks, rather than
tracking only TexLite's own jobs. The existing UI labels remain unchanged.
It is limited to processes visible to the service, normally the current
container in Docker. It does not inspect the Docker socket or other containers.
These are current estimates, not peaks or exclusive allocations; shared pages
may be counted in multiple RSS values; host usage and process totals are not additive.
Resource probes run only on authenticated administrator metrics requests, share
in-flight work and a two-second cache, and never run inside the compile path.
External probes have time/output limits; unsupported or failed sampling is
reported as unavailable rather than zero. No additional npm dependency is used.

CPU uses the same segmented presentation, with **TexLite + TeX**, other work,
and idle capacity adding up to 100%. It compares cumulative OS and process CPU
timers between requests, not load averages or lifetime-average `ps %cpu`.
The first request (or a gap longer than 15 seconds) primes a fresh window.
Host percentages cover all logical CPUs; Linux container percentages use cgroup
CPU usage and the smaller of visible affinity and ancestor quota capacities,
including fractional CPU quotas. Unavailable container accounting never falls
back to host-wide busy percentages. TeX CPU timers are gathered in the same
process scan as memory, with start identities guarding against PID reuse. Native
counter units are preserved: Linux process ticks are compared to aggregate
ticks, and macOS/Windows process times are converted to microseconds.
There is no background sampler. These interval estimates can miss short-lived
TeX processes that exit between requests; such work can appear under other CPU
usage. This is a lightweight status indicator, not per-process accounting.

## Collaboration and source persistence

User avatars default to the first visible character of the display name (or
username). Users can select a DiceBear Characters style from their user menu.
The server generates the SVG locally with `@dicebear/core` and
`@dicebear/styles`, seeded by the username. The selected style and SVG
are stored together in the user row; returning to initials clears both values.
Existing users retain initials after migration. Style selection uses a dropdown
and previews only the chosen style; previews do not change the saved avatar.
Startup applies separate, append-only
migrations for style selection (version 6) and SVG storage (version 7), including
databases that already recorded the earlier style-only version. Previously
saved styles without an SVG are generated and stored automatically on first use.
Version 8 invalidates older user-ID-seeded SVGs without clearing style choices;
the first read regenerates them with the username. Avatar URLs carry a render
version so browsers do not keep displaying the older cached images.
Style definitions are loaded on demand; ordinary avatar reads return the stored SVG without generating it
again. Authenticated image responses use private browser caching and ETags.
Previews are restricted to the current user and never save a selection.
There are no requests to DiceBear's public API and no browser-side generator.
Shared avatar rendering covers the account menu, comments, replies, participant
filters, shared members and collaboration sessions, with an initial fallback
while loading or after a failed image request. Avatar changes refresh active
presence and affected comment lists without restarting collaborative editing.
Authentication and per-message collaboration queries exclude the SVG column.

Each open project has one Yjs room. Awareness data provides active-session
avatars, user names, permissions, file paths, cursor colors, and the ten-session
project limit. Ordinary Yjs edits remain concurrent; source-tree replacement
operations temporarily enter maintenance, notify/close collaborators, and
rotate the collaboration epoch so an old offline draft cannot overwrite a
checkout or history restore. Browser IndexedDB retains unsent updates across a
transient disconnect.

The browser session boundary creates `ProjectCollaboration` inside an Effect.
Rendering never opens IndexedDB or installs collaboration listeners. Cleanup
defers destruction by one microtask: an immediate StrictMode/Fast Refresh
setup reclaims the same live instance, preserving editor bindings and local
workspace state; a real unmount closes the provider, persistence and Yjs
document after descendant cleanup. Changing the user or project destroys the
old instance and creates a new one. The controller mounts only after its
session exists and remounts only when that session is replaced. The
collaboration hook owns subscriptions; the session boundary owns resources.
Ordinary file, permission and UI updates retain the current session, and
leaving never deletes the persisted offline draft. A client DOM regression
test exercises StrictMode replay, identity changes and cleanup.

Workspace connection status distinguishes opening the socket (`connecting`),
an open socket awaiting document synchronization (`syncing`), a synchronized
connection (`connected`), and an actual connection failure (`disconnected`).
Only a synchronized connection enables editing. Connection labels overlay
save progress rather than overwrite it, so a successful reconnect cannot leave
an old offline label behind. The retained-draft notice is shown on disconnect
only when there are pending local edits or a recoverable browser draft. Client
DOM tests cover startup, synchronization, failed connections, retries and
subscription cleanup without changing or deleting the draft.

Read permission is intentionally different from edit permission: read-only
members cannot modify source files, but can view the project and add or reply
to source comments. Comments are anchored to source offsets and selected text,
can be resolved, edited, deleted, and replied to. If an author is removed,
the record remains visible as “Deleted User”.

The workspace Share button shows a superscript count of explicitly shared
read/edit members, excluding the owner and hiding zero. This is unrelated to
online presence. Initial counts come with project metadata; successful share
form loads and member changes update the badge without reloading the workspace.

The owner-only share form uses one editable user combobox: opening it lists
available users, and typing filters by display name or username. Candidates
exclude the owner and existing members. The popup is at most 240 px tall,
bounded by the dialog's available space, with internal scrolling and keyboard
navigation. Filtering uses the loaded active-user directory without per-keypress
requests. Typing clears an old selection but retains the permission draft;
only Add member grants access. Loads are aborted when the dialog closes or
changes project, and member mutations are guarded against duplicate submissions.

Live anchor updates replay the actual Yjs text deltas against their saved
source baseline. Agent disk imports retain an inferred-diff flag even when
their changes are transported as Yjs operations. HTTP replacements, recovered
state without a delta chain, and chains that do not reconstruct the final
source also use a before/after diff. Unlike actual edits, inferred partial
matches require contiguous meaningful text, sufficient retention relative to
both ranges, and matching context (or a substantially intact quote). Exact
quotes and whitespace-only formatting remain recognizable; scattered shared
letters must not stretch a discussion across unrelated replacement prose.
Partial edits retain the discussion; fully erased selections preserve their
last attached quote and surrounding context for recovery. Recovery requires
the original quote to be formed by the current insertion, replacement or an
interior deletion, together with matching context. An unchanged duplicate
elsewhere cannot inherit the discussion. A selection covering the entire file
can recover only when that exact file content returns.

Source persistence and anchor persistence have separate baselines. If a source
write succeeds but its anchor transaction fails, the room retains the old
anchor baseline and all subsequent edit batches. The save receipt reports the
failure, and the existing save timer retries without requiring further typing
or rewriting an unchanged source file. Idle cleanup retains rooms with pending
anchor writes; successful retries notify comment views. This bookkeeping is
in memory and does not provide atomic database/filesystem crash recovery.

Resolving a comment records the acting user's id and the server timestamp in
`resolved_by` and `resolved_at`. Repeating an already-resolved update or editing
the comment does not replace that attribution. Reopening clears both fields;
resolving again records the new action. The resolved discussion shows the user
and time; deleting that user retains the timestamp and displays “Deleted User”.
Schema migration 4 adds nullable columns without guessing metadata for existing
resolved comments. This stores the current resolution, not an activity log.

The source-pin button opens an independent current-comment view: only that Open
thread in the active source file is shown and highlighted, without status,
scope, participant, unread or sorting controls. Saved review filters do not
affect it. Resolving or deleting the thread leaves a short empty-state message
and a View all comments action, rather than selecting a different discussion.
The top Comments button opens project-wide review or switches a current view to it;
when already in full-review mode it retains its open/close behavior. View all
comments preserves the source target and saved sorting/participant preferences. File
switches, new comments and @-notification navigation leave current-comment mode.
Both modes share the same workspace draft store and reply expansion preferences.
The dashboard badge and workspace toolbar both count unresolved top-level
discussions across the project, including `.bib` files and non-root sources.
File and project comment responses include the same small project summary;
editor decorations still receive only active-file comments. This avoids fetching
all discussion bodies merely to show a count. A current-file/project selector
appears for roots with includes or discussions outside the active file. Hiding
that selector never forces project review back to the active file while its
summary is loading. Newer summary responses take precedence over late responses
from another scope.
File-comment refresh failures retain the last successfully loaded same-file
discussion, display an error with a file-specific retry action, and are not
treated as a successful empty response. An explicit access rejection clears
cached contents instead. Source-navigation readiness requires a successful
load; loading and error states are separate, so a failure never leaves an
indefinite loading indicator. Full file review uses the same error handling.

The full comment drawer sorts top-level threads by source position by default,
or by creation time, newest first. Project review follows the configured main
document's expanded reading order: notes before an `\input`/`\include`, notes
inside that source (recursively), then notes after the include. Static subfile
and import-package paths share the outline's path resolution. Each file uses
its first occurrence; cycles are ignored. Files outside the graph, missing
sources and work beyond the bounded scan fall back to file path and source
position after the reachable discussions. The additional include-order scan
visits at most 200 files, parses files up to 3 MiB and processes at most 32 MiB
of source; it reuses contents already read to calculate comment line numbers.
It does not expand macros or evaluate TeX conditionals. Response-only ranks
preserve this order through local filters and previous/next navigation; no
database or anchor changes are needed. Switching editor files does not change
the root, while changing the configured main document notifies open reviewers.
Tree/settings changes also reload an open project review, with obsolete
requests cancelled; merely switching editor tabs does not reload that resource.
File review still sorts within the current file; time sorting remains global.
Open/Resolved tab counts describe all top-level discussions in the selected
file/project scope, independent of participant and unread filters. The Unread
badge and displayed list still intersect those filters with the selected status.
Resolved review initially renders 50 top-level discussions and exposes a Load
more action for another 50 only while more remain. There are no displayed
batch counts or end-of-list message.
Replies do not consume this limit. Filtering and sorting apply before slicing;
counts and previous/next navigation still use the complete matching queue.
Navigation and an active inline composer expand the window as needed. Ordinary
data refreshes retain the window; scope, file (in file review), sorting and
filter changes reset it. This is browser-side presentation only: the API still
returns the full resource, including replies, and Open discussions remain
unlimited. No additional request is made by Load more.
Comment server state is owned by a workspace/user-scoped TanStack Query client,
loaded with the workspace rather than the login/dashboard bundle. File lists,
project review, project totals, personal unread mentions and mention candidates
have separate project-qualified keys. No cache is persisted to disk or shared
between accounts. Drafts and review presentation (filters, navigation, expanded
replies and the resolved window) remain independent of this query cache.
All comment/reply writes return a shared typed acknowledgement with the actual
persisted object or deleted id and project totals. One cache updater applies
these changes to all relevant loaded lists, without creating partial lists or
overwriting live source anchors, reading-order ranks or unrelated replies.
Reply upserts are idempotent by reply id. Acknowledged writes complete locally
before background reconciliation: a failed GET must not make a successful reply
invisible or invite a duplicate submission. Mutation requests are not retried
automatically. Delete failures remain in their confirmation dialogs.
Pre-mutation reads cannot overwrite the acknowledgement; retrying review also
refreshes source decorations and unread notifications. Cross-list project
summary responses are ordered by request start rather than completion.
Temporary refresh errors retain
these confirmed states and cached unread notifications, rather than implying
that discussions or notifications disappeared. Resolving removes the existing
thread mentions locally; reopening does not restore notifications already read.
Transient reads retry at most twice with bounded backoff; access rejections are
not retried and rejected resources are not displayed. Final read errors expose
the existing retry action, including errors that affect only unread mentions.
Mention candidates use the same cache; failure is never cached as a successful
empty result, and focusing/retyping a mention can retry. Stale candidates can
refresh on focus. Query defaults also reconcile stale data on browser focus and
refetch on network reconnection, without continuous polling.
Connected collaborators, including read-only reviewers, receive comment
revisions over Yjs and automatically reload comments and personal unread mentions
(up to 100). Mark-read/read-all changes reuse that revision signal so another
session for the same account updates too; the signal contains no personal
notification data. Repeated mark-read clicks share the pending request and
dashboard counts use the server's actual changed count, not the number of clicks.
Current scope/status/participant filters and the resolved display
window still apply. Disconnected clients need to reconnect; failed comment reads
expose the existing retry action instead of requiring a page reload.
Replies keep their original chronological order. Long inactive
discussions initially show only the latest two replies with an earlier-replies
toggle. Explicit expand/collapse choices are kept locally by thread id for the
workspace lifetime and survive file/filter/sidebar changes and refreshes of
comment data. Reading focus expands a discussion unless deliberately collapsed;
active forms, notification targets and older unread or participant-matching
replies always remain visible. Notification targets are expanded during render,
before the drawer's scroll effect looks up the reply DOM. Opening a form or
marking a mention read keeps the discussion expanded to avoid a content jump
when the action completes. Folding never alters review counts, participant
matching or source anchors. Participant filtering is multi-select: a thread
matches any selected top-level author by default. Unchecking “Top-level comments
only” also includes reply authors; clearing the participant selection restores
the top-level-only default. It combines with the existing
file/project scope, resolution status, and an independent unread-@-me toggle.
The unread toggle intersects with Open or Resolved rather than forming a third
resolution state; reading all mentions in a thread removes it from that filtered
queue. Only matching authors' display names and usernames are highlighted;
the thread/reply surfaces and the rest of the discussion stay unchanged. Explicit source or
mention navigation can still reveal a thread outside the active filters;
changing filters clears that temporary focus. Sorting and filtering run locally
on the already-loaded comment resource, without additional server requests.
Resolving or reopening a thread clears its temporary navigation reveal after
the status changes, including changes from another coauthor. It then leaves the
current status queue with a brief fade/slide and collapse; the outgoing card is
inert and does not count toward review navigation. Failed requests leave the
thread visible, changing filters cancels exits, and reduced-motion preferences
skip the movement.
Opening or focusing an inline composer activates its thread without navigating
to or focusing the source editor. Ordinary data refreshes preserve that active
discussion and do not scroll to an older source-navigation target.
Reply, comment-edit and reply-edit composers share request feedback and a
workspace-owned synchronous submission guard for button clicks and Ctrl/Cmd+Enter. While a
request is pending, the form shows Sending/Saving and disables inputs, cancel
and conflicting actions in that thread. Request errors appear beside the
composer, preserving its input for retry; only success closes the form.
Drafts, errors and in-flight state live in a project-workspace memory store,
not in thread components, so file/filter/sidebar changes and resolution-driven
unmounts do not discard them or allow duplicate submissions. Draft updates
notify only the corresponding thread. Restored forms do not steal editor focus.
Explicit Cancel or successful submission removes that form's draft; switching
between reply editors preserves each reply's text. New-comment drafts are kept
per file together with their original selection and source hash. Reopening one
restores that source binding, with an explicit action to adopt the newly selected
source instead; the server's source-revision validation still applies. Closing
the new-comment dialog preserves its draft, while Cancel discards it. Nothing is
written to browser storage or the server; leaving the project or refreshing the
page clears this workspace's drafts.
The participant selector uses a non-modal, anchored Radix popover so it does not
push the discussion down. Selections apply immediately without closing the
popover; outside interaction or Escape dismisses it. Its trigger summarizes the
selected authors and provides a separate clear action. A top-level-only filter
remains visible in the toolbar after dismissal; clearing the participant filter
also resets that restriction.
Open/Resolved and previous/next navigation appear beneath the drawer title.
A separator distinguishes the toolbar below: participants, unread @ mentions,
then neutral-colored source-position/newest-first sorting. Source excerpts use
monospaced, single-line truncated blocks with a green edge; replies use a thin
gray indentation rule. Author-only edit/delete actions live in each comment or
reply's header menu, with deletion still requiring confirmation.
Clicking unresolved annotated source or its trailing marker opens and scrolls
the corresponding thread into view, temporarily revealing it across review
filters without marking mentions as read. This drawer-only navigation does not
select the annotated source range or take over the editor caret; dragging to
select text and modifier-click citation navigation keep their normal behavior.
Resolved and orphaned threads have no source markers.

Source comment ranges follow partial insertions, deletions and replacements,
updating the quoted excerpt to the current text rather than requiring exact
equality with the initial selection. Full deletion or whole-range replacement
detaches the thread without discarding its last attached quote and surrounding
context. A later undo or restoration can reattach the complete last attached
quote by contextual matching; partial quote restoration and unrelated duplicate
text alone are not sufficient. Collaborative persistence replays actual Yjs
edit ranges, so common characters in a whole-range replacement do not falsely
count as retained source. Non-collaborative writes use a before/after text diff
because they do not carry editor operations. These existing
database fields remain durable across restarts, without a schema change.
The server and editor share the range/context rules. Live editor anchors retain
detached state through undo and supply current offsets for thread-to-source
navigation, even before a save. Comment responses include a response-only
SHA-256 source revision, computed once per file. An authoritative server anchor
can correct a misleading live mapping only at that exact revision, including
when its HTTP response arrives before the Yjs source update. Stale saved
anchors cannot replace a live mapping, reactivate a deleted selection at a
duplicate occurrence, or overwrite undo recovery. Results for a different
revision remain pending; a view-owned 200 ms trailing check retries after
document updates, coalesces typing, and is cancelled on editor destruction.
Failed checks do not poll or reschedule themselves. Browser recovery searches
are bounded around the hint and newly inserted fragments; document-change
mapping never flattens/hashes the file for revision reconciliation. Incoming
comment responses may hash the current source once to apply matching results
immediately.

The collaboration service uses a versioned handshake and a versioned epoch
marker. When a browser from an incompatible release connects, it is forced to
reload before it can decode or send source updates. Protocol-only migrations
preserve the browser's offline draft; source-tree replacements still clear the
draft because the server tree is authoritative.

The wire contract is defined in the dependency-free
`src/shared/collaborationProtocol.ts` module. It assigns stable message numbers
for Yjs sync/awareness, flush receipts, the protocol handshake, maintenance and
permission notices, compile-state metadata, and formatter leases, and currently
uses protocol version `3`. The module also owns the shared compile-state and
save-receipt shapes plus their status validators; client and server modules
re-export these types so existing imports remain valid. Binary encoding and
decoding remain next to the transport code on each side, which keeps field order
and established packet bytes unchanged. A wire-incompatible change must bump
the shared version and provide an intentional migration or reload path.

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

The workspace toolbar exposes project snapshots as a single button. Selecting
source text reveals comment and selection-history actions in the line-number
column; their tooltips remain enabled independently of the interface-tooltip
preference. Opening selection history captures the file, selected range, and
source together, including before the lazily loaded dialog mounts.

Diff calculation uses the public functional API from
`@sanity/diff-match-patch`: semantic cleanup for selection history and anchor
fallbacks, and efficiency cleanup for formatter edits. Cleanup functions return
new arrays; callers use those results. A shared cleanup guard falls back to the
original diff if cleanup splits a UTF-16 surrogate pair, keeping Unicode
characters intact in rendered pieces and formatter/anchor boundaries.
Offsets remain JavaScript UTF-16 offsets
for CodeMirror/Yjs and do not use the library's UTF-8 patch-index conversion.
Project snapshot comparisons encode complete lines in a small local module,
using non-surrogate BMP tokens to preserve line-oriented hunks without importing
package internals. Inputs that exceed token capacity retain the remaining tail
as one token, allowing coarser but lossless comparisons of unusually large files.

Recovery snapshots are created only for actual file additions, changes, or
deletions. Settings-only changes update the persistence baseline without adding
a timeline entry; effective compiler settings are captured with the next file
change. Older zero-file-change entries are excluded from timeline pagination and
previous-version comparisons, but are not automatically purged. New snapshots
record UTF-8 text by default; PDFs, images, archives, fonts and other binary
attachments are excluded. Known resource types are skipped without reading their
contents; other files must pass the existing UTF-8/text-content check. Writers
can manage per-file inclusions/exclusions from Project snapshots. These shared,
path-based choices are stored in SQLite, survive clearing history, and affect
future recording only. Including a file captures its current contents; excluding
a file does not create a deletion entry or remove existing recovery data.
Missing paths with overrides remain visible so their choices can be reset.

Each new manifest captures its tracking policy. Whole-project restoration keeps
current files outside that snapshot's scope, restores its managed files and
removes managed files created later. The replacement tree is fully staged before
the live source tree is swapped. Legacy manifests without a tracking policy
retain their full-tree restoration behavior and historical binary contents;
upgrading does not rewrite or discard old snapshots. Before a restore, its safety
checkpoint also captures currently excluded files that will be overwritten or
deleted (including attachments affected by legacy restores), without changing
project tracking settings. Failure to save that checkpoint aborts restoration.
Explicitly included non-text attachments are shown as a compact change notice
without decoding a text diff. Automatic recording and text comparison share
the same file-kind and UTF-8 content classifier, rather than separate extension
lists (including Windows batch scripts and text with unfamiliar extensions).
New manifest entries cache this classification from the bytes already read
during recording. Snapshot details expose it for changed files, including
deleted files when the previous snapshot is available. Older snapshots are
classified on demand within the text-preview size limit without rewriting
their manifests; missing objects and oversized previews retain their normal
comparison errors. Source and
ordinary text/data formats support bounded UTF-8 comparisons, including file
deletions; invalid or oversized text is reported as unavailable, not as unchanged.

After a source write succeeds, connection-originated Yjs text deltas are also
stored as ordered edit segments. Each segment belongs to exactly one user, one
file, and one operation type (`edit` or `format`). The edit records store only
positional replacements with complete deleted and inserted text, rather than
per-edit whole-file snapshots. Browser and agent edits use the same lossless
span encoding; only displayed passage previews are shortened. Older truncated
records remain readable but cannot reconstruct affected earlier passages.
The records live in SQLite separately from recovery snapshots and are retained
as the newest 20,000 project segments (`editHistory.maxSegments`) within an
independent 64 MB serialized payload budget (`editHistory.maxStorageMB`). Both
settings are optional; omitted values use these defaults. Explicit existing
limits are preserved. Selection-history reads stream records and stop when
the requested display windows are complete, rather than loading all retained
payloads at once. This budget never shares or
reduces the 128 MB recovery-snapshot budget. A too-large individual edit burst
is omitted, and retention removes the oldest records; both deliberately create
a visible history boundary rather than presenting an unsafe attribution. When selection history is viewed,
adjacent records affecting the selection are consolidated into a bounded
two-minute editing window. Its raw per-user records remain separate, while the
timeline lists every contributor to that window. Each entry maps the selected
passage backward through the durable edit chain and presents the resulting
selected content, a semantic character-level comparison with the preceding
older state, contributors, and latest edit time in reverse chronological order.
Long unchanged runs are compacted around the local rewrite; truncated passage
previews are never compared. Consecutive windows whose
fully reconstructed selected content is identical are coalesced, so the
timeline only shows effective text states. If a file was replaced, restored, imported,
or reached an edit-record retention boundary, mapping stops instead of guessing
across the gap.

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

Project file types are recognized by common suffixes and a small set of known
extensionless names such as `LICENSE`, `README` and `latexmkrc`. Unknown types
use the generic file icon and remain downloadable instead of guessing their
contents. File-tree refreshes read only directory entries and file metadata,
never source contents. Recognized text can use the collaborative editor up to
the existing 5 MiB limit, or the configured upload limit if lower. Opening a
text file validates its full contents through the existing text API, without
returning a duplicate source body already supplied by Yjs. Room hydration and
the text API reject binary controls and invalid UTF-8 instead of silently
replacing bytes. Known images (including SVG) and PDFs retain their resource
previews up to 10 MiB. Larger files and unsupported types show a download prompt
rather than opening in the editor.

Generic text uses CodeMirror language support for JSON, YAML, Shell, TOML,
JavaScript/TypeScript, Python, HTML/CSS/XML, Markdown, INI, Perl/latexmkrc,
Dockerfile and CMake where recognized, otherwise plain text. LaTeX semantic
highlighting, auto-pairs, completion and reference navigation stay scoped to
LaTeX source; BibTeX and BST retain their dedicated languages.
Auxiliary text languages load together on the first recognized non-LaTeX file,
not when entering a TeX/BibTeX/BST workspace or opening plain text. Detection is
synchronous and independent of the parser bundle. The import is shared across
files and projects in the current browser page; failures can be retried.
The editor starts as plain text and installs the language through a CodeMirror
compartment without replacing its document, selection, undo history or Yjs
binding. Late results are ignored after file/instance changes or unmount, and a
load failure leaves editing and saving available with a nonblocking retry notice.
Writing checks remain limited to prose-oriented files rather than running
Harper on newly editable configuration and program files.

`ProjectMutationCoordinator` has two related controls:

| Operation class | Examples | Coordination behavior |
| --- | --- | --- |
| Serialized source operation | File writes, settings, Git metadata | Waits for queued operations, waits for a ready room, flushes the room, then runs while holding the per-project queue. |
| Exclusive source replacement | Git checkout/restore, history restore, project deletion, path move | Waits for active compilation, flushes successfully, enters maintenance, performs the replacement, and resets the collaboration epoch. |
| Consistent source read | Archive/download, raw source, history comparison, outline, completion index, Git diff/history | Uses the queue and a short snapshot barrier. The barrier blocks disk autosaves while an asynchronous scan/copy runs, then validates the deferred flush before returning. |
| Background compilation | `latexmk` on an immutable snapshot | Holds a compile reservation but not the ordinary source queue, so editing, source reads, and the retained PDF can continue. |
| Compile-state cleanup | Cache/artifact recovery | Waits for active compiles and serializes output removal without disconnecting collaborators. |
| Published PDF read | PDF.js/range requests | Reads an immutable published bundle directly and does not wait for cold Yjs-room initialization; a concurrent cleanup may produce a normal 404. |
| Cold file-list read | Project file tree | Uses the queue and a short barrier, but does not wait for a cold Yjs-room hydration; a concurrent cleanup is treated as a normal missing entry. |

The source tree is checked with `lstat`-based path walks. ZIP imports, project
duplication, Git checkout, file listing, and source resolution reject symbolic
links (except that deletion may address a final link itself without following
its target). This prevents a project path from escaping its source directory.

Project ZIP import and export use `@zip.js/zip.js` on the server with Node's
native compression streams. The public custom-codec entry point avoids loading
browser workers or WASM; entries are processed sequentially with backpressure.
Imports inspect all accepted entry metadata before writing, reject unsafe or
duplicate paths and symbolic links, and enforce the 1,000-entry limit, configured
single-file limit and total expanded-size limit (the larger of 200 MiB and the
single-file limit). Streamed output is independently byte-counted and CRC-checked.
Import directory creation and main-document reads are asynchronous; each import
caches directories it has created to avoid repeated filesystem calls for siblings.
The uploaded compressed ZIP remains in memory, while expanded files go directly
to disk. Exports exclude `.git`, preserve empty folders, and finish in a private
temporary ZIP under the consistent-read barrier before the HTTP download starts.

## Editor, files, and navigation

Workspace resizing uses `react-resizable-panels` v4 (`Group`, `Panel`,
`Separator`). Constraints use explicit percentage strings; numbers in v4
would mean pixels. The editor and preview share the space remaining after the
file panel and optional drawer. Each visible panel combination keeps its own
browser layout using `useDefaultLayout` and a storage adapter scoped to the
deployment base path. The adapter validates current v4 per-combination records
and does not convert v2 layout arrays. Missing, unsupported or corrupt records
use default sizes; older browser records are left untouched. Blocked browser
storage also falls back to usable defaults. File-panel collapse state follows `onResize`.
Source comments sit at the left edge of the preview region, immediately beside
the editor. They do not add an outer resizable panel or change the editor/file
widths. A 760 px preview-container breakpoint switches between a 300–360 px
inline review column and a drawer over the PDF; closing it restores the preview.
The PDF stays mounted, and a stable portal host preserves review filters and
reply forms across responsive changes. Editor-only mode falls back to an
adjacent resizable context pane; settings keep their existing right-hand pane.
Source annotations use small outlined comment icons with the same toggle,
keyboard activation and tooltip behavior as the former pins.
SyncTeX arrows are portalled outside the group and anchored to the separator,
so v4's document-level drag capture does not consume their pointer/keyboard
actions. Observers and window listeners are removed when the separator unmounts.

The editor is CodeMirror-based and provides LaTeX syntax highlighting, folding,
auto-pairs (including `\begin{...}`/`\end{...}`), indentation, Vim mode when
explicitly enabled, and completion items from built-in LaTeX plus project
`.tex`, `.sty`, and `.cls` definitions and BibTeX labels. Completion indexes and
outlines are metadata-keyed and coalesced; a source-tree change invalidates the
corresponding cache.

The live editor and server project index share the pure symbol extractor in
`src/shared/latexSymbols.ts` and the completion data types in
`src/shared/latexCompletion.ts`. It extracts command argument snippets,
environments and theorems, packages, classes, source-file references, labels,
and in-file `\bibitem` definitions using the same comment/literal masking and
reference rules. The editor owns its document-identity cache and gives current
unsaved definitions precedence over server candidates. The server owns file
I/O, metadata caches, built-in candidates, source attribution, and root-scoped
BibTeX selection; it does not promote in-file `\bibitem` entries to project-wide
citations. This extractor does not expand TeX macros or load the editor parser.

Opening `.tex`, `.bib`, `.sty`, or `.cls` files in editor tabs is an optional
per-user/per-project preference and is off by default. The active tab is
highlighted and keyboard accessible. PDF/SyncTeX synchronization uses the
selected root's compiled PDF and accepts both the root and included `.tex`
sources. Opening a source tab does not change the compile root; SyncTeX decides
whether a source location has a corresponding position in that PDF.

LaTeX editor highlighting and structural folding use an internal Lezer LR
parser derived from a pinned Overleaf lezer-latex revision, replacing the
legacy `stex` stream mode. Grammar sources, local compatibility changes, and
build instructions live in `src/client/latex/README.md`; attribution is recorded
in `THIRD_PARTY_NOTICES.md`. The parser recognizes command arguments, math,
sections, and environments, with incremental tree reuse during editing.
Editor colors are centralized in `src/client/editorThemes.ts`. Light is the
default and retains the existing LaTeX and generic BibTeX/BST syntax colors;
the optional dark palette draws on One Dark's blue-gray surfaces with clear
prose, subdued cool-gray comments and quieter line numbers. One browser-local
light/dark/system preference controls the whole application and editor. The
dashboard user popover groups identity, GitHub integration, language, theme and
sign-out controls. Explicit light/dark selections remain unchanged; system mode
follows OS color-scheme changes while the page is open. New browsers default to
System; existing explicit Light/Dark choices are preserved. Missing or blocked
browser storage follows the system too, with Light as the fallback when media
queries are unavailable. The pre-paint script uses the same resolution rules.
It is stored in localStorage
(scoped to the deployment base path), never in the database or tied to a
user/project. Other tabs follow
storage changes, and the HTML bootstrap applies the preference before the first
paint. Root-level semantic variables cover the dashboard, workspace and portaled
dialogs, while PDF paper, images and existing dark diff/log views retain their
original content colors. CodeMirror's
dark facet changes through the existing appearance compartment, without
recreating the editor, document, selection, undo history or Yjs binding.
Generic BibTeX/BST highlighting adapts CodeMirror's shipped tag rules to the
same palette variables. Editor popups, completion, search, Vim status,
diagnostics, source comments and gutter actions use those variables too.
Comments and brackets have independent color roles. In dark mode, comments on
the active line, inside a selection or under a search highlight are brighter
to remain readable. Selection marks use the existing language tree's comment
tags, restricted to the intersection of the selection and visible ranges;
they do not introduce another source scanner or force parsing.

LaTeX has a semantic palette distinct from generic BibTeX/BST syntax:
bright blue ordinary commands, teal structure commands and environment names,
ochre reference keys, rose
special characters, gray comments and brackets, and purple math delimiters
and commands. Ordinary math contents and numbers retain the prose color.
Within math, known reference, text, declaration and layout commands retain
ordinary command styling rather than inheriting purple. Generic custom math
macros keep the math accent; this lightweight classification does not expand
TeX definitions or attempt to prove the semantics of arbitrary user macros.
Sectioning commands, `\begin`/`\end`, and the document-start landmark
`\documentclass` use heavier command weight; other configuration and inclusion
commands retain ordinary weight.
Math regions have no background tint. Visible syntax-tree decorations accent
math commands and emphasize TODO/FIXME inside comments; literal content uses
a neutral background.
Cursor-local, real matching environment pairs use the same pale teal accent as
matching brackets. The white editor uses ink-colored prose, quiet line numbers,
a pale blue active line and selection, and pale yellow search matches.
LaTeX text-color contrast on both editor backgrounds is checked by regression
tests against the WCAG relative-luminance formula (at least 4.5:1); line numbers
are intentionally quieter, non-content decoration.
Pairing accents use a theme-specific green foreground, also checked against
their tint. Dark syntax also retains contrast on selection and search accents;
auxiliary controls and popup text have contrast coverage for both themes.
Reference keys are colored without a standing diagnostic-like underline; only
the pointed-at key gains an underline while Ctrl/Cmd is held. Modifier release,
mouse exit, document/viewport updates and unmount clear this temporary affordance.
They update after document, viewport, selection, or syntax-tree changes without forcing
parsing or introducing another full-source regular-expression lexer.
Local changes preserve TexLite's literal forms, spaced environment commands,
internal macro names, and macro parameters. Incomplete source is recovered for
editor use; recovery nodes are not treated as compiler errors. Environment
folding requires a real, matching close rather than an inferred recovery node.
Common argument whitespace and starred definitions are supported. Environment
folding compares parsed names, ignoring comments in name groups; multiline
headings and opening names remain visible when folding their bodies. Math
delimiter commands such as `\langle` and `\rangle` use the math palette.
Basic syntax-tree indentation adds one configured level inside ordinary
environments and multiline groups, aligns closing markers, leaves the document
body at its margin, and preserves raw literal content. This is an editing aid,
not a replacement for tex-fmt. Iosevka loads real 400 and 600 weights so structural
emphasis does not depend on synthetic bold or locally installed fonts.
Completion triggering uses a shared cursor-context adapter over the syntax
tree. It identifies comments, literal bodies, math, and environment/reference/
file/package/class arguments without repeatedly reading the document prefix.
It permits at most five milliseconds of parser catch-up and defers completion
if context remains unavailable. Known argument nodes are queried directly;
the compatibility reader is limited to a window of 8,192 UTF-16 code units
of tree-identified commands and retains the shared reference
classifier for multi-argument citations, reference ranges, and optional labels.
Incomplete end names in specialized environments also use this bounded reader
when an adjacent recovered marker identifies the command. Environment
completion recognizes multiline begin/end arguments and reuses existing closes
without taking the close of a balanced outer environment.
Reference navigation marks have a view-local prefix cache. Editing invalidates
marks from the earliest changed line onward and retains unaffected visible
marks with current position metadata; immediate syntax colors still come from
Lezer. Reference scans are coalesced after 120 ms of input inactivity, and
viewport reflow cannot bypass that delay. Stable documents reuse existing
prefix coverage across scrolls. Pending scans are cancelled on disable/unmount,
and their results apply only to the same immutable document. Ctrl/Cmd-click
revalidates retained references against the current source when a scan is
pending, including edits to later lines of multiline citation arguments.
Automatic pairing applies its existing line-local insertion predicates before
materializing a whole-document string. Only actual candidates need the full
literal-state and matching-end checks; ordinary input and skipped non-candidate
braces bypass that work without changing pairing or undo semantics.
Completion candidates and insertion behavior, reference navigation, project
include graphs, root detection, outline generation, and host-tool diagnostics
retain their existing scanner and service boundaries; editor context queries
do not replace these workflows or perform TeX macro expansion.

Each project collaboration object owns one Yjs undo manager per source file.
Editor tab remounts therefore preserve Ctrl/Cmd+Z and Vim undo history without
leaving obsolete CodeMirror/Yjs observers behind. Managers are released when
the collaboration object is destroyed or loses edit permission.

Vim support is imported only when enabled, with one shared module initialization
per browser page. Its custom undo/redo mappings are registered once and use
per-editor history callbacks rather than global project state. Enabling or
disabling Vim reconfigures a compartment without recreating the editor;
appearance changes do not reinstall it or reset Insert/Visual mode. Pending
loads cannot enable Vim after it was disabled, the file/instance changed, or
the editor unmounted. Mode listeners are removed on disable and cleanup. The
status bar distinguishes loading, active mode and failure; unsuccessful loads
leave standard editing available with a retry action.

TexLite probes the optional host `harper-cli` command at startup. Harper uses
its native LaTeX-aware parser and returns safe replacement suggestions. The
project dictionary is kept in SQLite and filters project-specific spelling
results in the browser. If Harper is absent or fails, CodeMirror enables the
browser's built-in English spellchecker until it retries. A project owner may
also enable the optional host `chktex` compiler setting. ChkTeX starts only
after two seconds of editor idle time, coalesces identical source inputs, and
uses a process-wide queue capped at eight checks across projects and users. Its
LaTeX writing diagnostics use a blue-gray dotted underline and never replace
the compile diagnostics; the setting is off by default.

Both writing-check endpoints require a page-local UUID `clientId` and a
positive safe-integer `sequence` with each source request. Missing identifiers
return HTTP 409 `CLIENT_UPDATE_REQUIRED` with a localized save-and-reload hint;
malformed identifiers return HTTP 400. There is no session-cookie lane fallback.
The server always scopes lanes by project, authenticated user, client and file.
It never forces a browser reload or discards local edits for this error.

Formatting is independent from the editor's local appearance. A user can
manually format a selection or enable the per-user/per-project “format before
compile” preference. The browser uses bundled `tex-fmt` WASM for `.tex`, `.cls`,
and `.sty`, and `bibtex-tidy` for `.bib`; the editor settings also provide a
per-user/per-project TOML options string passed to `tex-fmt`. Each formatter and
its text-diff calculation run in a separate, lazily loaded Web Worker, so opening
a project does not wait for them and formatting does not block the editor UI.
The BibTeX worker does not load tex-fmt or its WASM runtime. Both workers use the
same Unicode-safe edit calculation. BibTeX syntax and size errors retain their
localized messages; a failed or timed-out worker is discarded and recreated on
the next format attempt, with a 30-second request timeout. Citation-library form
validation remains in the browser's main thread. A formatter failure reports an
error but does not prevent compilation. There is no silent Prettier fallback.
Missing, non-string or oversized stored TOML values use `wrap = false`; an explicitly
saved empty string uses tex-fmt's own defaults. The browser no longer guesses
whether an empty value came from an older default or requires a migration marker.

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

The outline follows `\input`, `\include`, `\subfile`, and import-package
references with the same path rules used by citation navigation and completion.
It traverses included files depth-first at their source position, so headings
remain in reading order rather than document-graph breadth-first order. The
source and PDF panes expose explicit SyncTeX arrows, and PDF double-click can
request the corresponding source location. Search and replace is project-wide,
staged as one serialized operation, and records one history version. Structured
compile diagnostics resolve project-relative file names and line numbers; the
raw `latexmk` transcript remains available.

## Compilation and retained output

The project setting supplies the default root document. Project settings list
and accept only `.tex` files containing a real `\documentclass` declaration;
an imported project with exactly one `.tex` file may use that file as a
compatibility fallback. The server enforces the same rule for compile and
preview routes. A browser session may select another detected root, and only
the currently selected root is compiled. Compile state, logs, retained PDF,
artifacts, outline, and SyncTeX are keyed by root, so collaborators working on
different roots do not replace each other's result or compile notification.

The supported direct-upgrade baseline is TexLite 0.2.0. Compilation artifacts
use the per-root v2 manifest introduced in that release:
`output/.texlite/targets/<root-hash>/latest.json` points to an immutable run
bundle under `output/.texlite/runs/<run-id>/`. Pre-0.2.0 project-wide v1
manifests, `.texlite/latest.pdf`, and direct `output/<root>.pdf` fallbacks are
not read; those generated results can be recreated by compiling. The optional
`generation` field remains backward-compatible with 0.2.0 manifests. This
output-format policy does not remove database migrations or source, comment,
and snapshot data compatibility.

Compilation follows this sequence:

1. Admission validates permissions/root selection and coalesces requests by
   project, root, and a cheap source/settings generation.
   The internal coordinator accepts only `generation`; `revision` remains the
   content fingerprint on results, not an alternate admission-key parameter.
2. After coalescing, one project-queue reservation flushes the room,
   revalidates permissions/root selection, and captures a source snapshot.
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
automatic loading policy uses a complete, cache-friendly response through 2 MB
and enables PDF.js byte-range loading above that threshold; deployments can
force either mode without changing project compiler settings. The threshold is
a size-based heuristic, not a universal latency optimum. Range mode allows
PDF.js to combine streaming and ranged requests; it does not guarantee that
only the visible page's bytes are downloaded. The output panel groups the PDF,
log, warnings, errors, generated artifacts, and recovery actions; clean-cache
and clean-artifact actions are for recovery rather than routine compilation.
The Vite build publishes the installed PDF.js version's predefined Adobe CMaps
and their license under a versioned asset directory. The development server
serves the same resources. PDF.js resolves this URL against the runtime base
path and fetches mappings on demand, allowing embedded CID fonts without
ToUnicode maps to render without a CDN or additional user configuration.

PDF page presentation uses the bundled PDF.js `PDFViewer`, `PDFLinkService`
and event bus, rather than one independently rendered React canvas per page.
The viewer owns visible-page priority, directional adjacent-page rendering,
pause/resume and a bounded page-view cache. A 16-megapixel canvas limit and
detail canvases bound high-DPI/zoom allocations. These page resources are
separate from the two-document, lease-based PDF download/parse cache; disposing
a viewer must not destroy a document still held by another lease or the shared
worker. Rendering and viewer assets remain lazy, in separate core/viewer chunks.

TexLite retains its own toolbar and fit-width-relative zoom percentages. Resize
and viewport reporting are coalesced with animation frames. Only effective width
changes recalculate the fit scale, and each zoom applies the final scale once.
The initial destination page is selected before scaling starts the native
rendering queue, avoiding an unnecessary first-page draw when restoring a later
page. A local compile uses its POST result rather than refetching the same run
after a WebSocket completion; if that POST fails in transit, the shared state
still provides a recovery lookup. Collaborators continue fetching completed
runs normally. Post-compile artifact-list refreshes wait for the replacement
PDF's first paint, or run when the PDF panel is hidden so output inspection
never depends on a successful PDF render.

`CompilationResults` owns an immutable result snapshot for one workspace
selection lifetime. Both the latest run and the retained successful PDF carry
`projectId`, `mainFile`, and their own `runId`; a failed latest run does not
change the successful PDF's identity. Switching project/root creates a new
owner, including A-to-B-to-A navigation, and old responses cannot publish into
that owner. Opening/reopening a workspace restores retained output; switching
roots inside it starts empty until another compile is observed or requested.
The initial metadata lookup settles before shared completion replays can start
a recovery lookup. Local POSTs, shared completions, and bootstrap results all
use the same result receiver, so acceptance, duplicate suppression, PDF
replacement and reset rules are not maintained as separate run/URL refs.
Saving finishes before the previous run is cleared or root-switch replay
suppression is lifted; a failed save cannot replay an old result as a new
compile success. Shared completions deferred or interrupted by cleanup are
reconciled when cleanup ends. A successful cleanup response does not discard
newer collaboration events received while its HTTP request was pending.
The hook still owns request cancellation and output-panel lifetimes. Artifact
lists/previews are checked against both the selection owner and the published
PDF, and deferred bootstrap scans are cancelled when a compile begins. Pending
local compiles are keyed by project and root; leaving a project or unmounting
cancels their HTTP requests without letting late errors affect the next view.
Leaving a project also retires its compiling/cancelling flags, independently
of whether those requests have settled; root switches within that project
keep pending tasks intact. Bootstrap active-state hints use a functional
state update so queued React notifications cannot be overwritten. The same
run cannot regress from running or completed to an earlier phase. A fresh
lookup can discover a different run when no notification arrived during it;
route preloads cannot replace existing notifications because their starting
state is unknown. This ordering does not depend on browser clock timestamps.

Page numbers use separate elements, leaving PDF.js's loading pseudo-element intact.
A replacement viewer is laid out and rendered without displaying it; the old PDF stays visible until
a visible page in the replacement has painted successfully. Failed replacements
leave the previous PDF in place with a retry action. Document changes and
unmounts cancel obsolete work and detach viewer observers/listeners. A guarded
Vite compatibility transform keeps PDF.js 6.2's global text-selection listeners
owned by its text-layer registry, rather than the first viewer's abort signal.
This permits overlapping old/new viewers without retiring the new viewer's
selection handlers. The transform applies in development and production and
fails explicitly if an upstream upgrade changes the affected code. SyncTeX
continues using top-left, scale-1 page coordinates, converted through PDF.js
viewports for click locations, target scrolling and markers. Old-document
coordinates cannot be sent against a newly selected PDF. External links retain
an explicit HTTP/HTTPS/mailto/FTP allowlist; embedded form editing and PDF
scripting are not enabled. The viewer's `.page` class is isolated from the
application's root-page layout rules.

Compile responses expose `Server-Timing` measurements for snapshot, cache
synchronization, LaTeX execution, artifact publication, and total request time
so queue and rendering regressions can be diagnosed. Artifact listing and
download endpoints treat removal of a run between manifest lookup and file
read as an empty list or 404, rather than exposing a filesystem race as a 500.
TexLite does not keep an unlimited browsable compile history: old unsuccessful
run rows and unreferenced bundles are pruned, while the latest successful
result for each root is retained.

## History and recovery

Selection-history requests bind their offsets to a SHA-256 hash of the
browser's source. After flushing, the server rejects a mismatched revision
with a retryable conflict instead of inspecting a different passage. The
dialog keeps its inspected selection fixed while collaborators keep editing.
Responses include the earliest reconstructed baseline for diffing, and an
explicit `hasMore` flag when the 60-window display limit is reached. This
display limit is separate from missing or pruned history boundaries.

Project snapshots record initial state, acknowledged collaborative saves,
file/source operations, compiler settings, Git operations, checkpoints, and
restores. They are a recovery mechanism: a snapshot can restore a file or the
whole project, but it intentionally does not attempt to assign individual lines
to collaborators. The separate selection-history stream provides that
author-attributed editing view and never changes snapshot retention or restore
semantics.
Its edit segments have their own `editHistory.maxStorageMB` hard payload cap
(64 MB by default), so selection-history retention cannot consume the snapshot
budget or affect recovery capacity.
Internal edit batches are validated before any records are inserted. Invalid
steps, spans, timestamps, or hash chains fail the batch and use the existing
bounded retry/history-warning path; they are not silently dropped or assigned
replacement timestamps. A damaged stored edit row stops selection-history
reconstruction at that boundary instead of reconstructing a partial chain.
Invalid snapshot changed-path metadata is reported as an error rather than an
empty file list. File-backed root validation and icon lookup likewise preserve
normal not-found results while allowing permission, I/O, and malformed generated
resource errors to reach the server's error handler and logs.
Autosaves across authors are coalesced within a fixed two-minute project window.
A mixed-author snapshot has no single author attribution; selection edit history
retains the individual contributions independently. File
contents are complete SHA-256-addressed objects; unchanged files are reused
across manifests. By default, ordinary version count is unlimited (`history.maxVersions: 0`),
and retention is primarily governed by the soft storage limit (default 128 MiB of deduplicated
objects plus snapshot row text and baseline manifests per project). This includes
metadata for settings-only snapshots even when all file objects are reused.
SQLite pages, indexes, free pages and WAL are shared overhead, not part of this
logical per-project quota. Deleting records releases reusable database pages;
it does not necessarily shrink the database file. An optional positive `history.maxVersions` limit can also be configured
to cap the count of ordinary versions. Initial, labeled and latest versions,
plus the current internal baseline, are protected and can make the soft limit
persistently exceed its target. The UI reports file, metadata and protected
usage separately. Protected usage is a subset of total usage, not an additional
charge. Retention pruning batches reference accounting
and removes unreferenced objects.

The snapshot timeline initially loads the newest 100 versions. Older versions
are appended on demand through a stable cursor rather than offset pages, so
new saves or removals cannot reorder, repeat, or skip a version already shown.

Owners can view storage statistics, delete one version, or clear all recovery
snapshots without changing current source files. Selection history has a separate owner-only project-wide payload
usage display and confirmed clear operation. Clearing edit history flushes
pending edits first and deletes edit segments and retention boundaries;
it preserves recovery snapshots and source files. Future edits start a new trail.
Restore is an exclusive source
operation, reanchors comments against the before/after text, updates project
settings when restoring a complete version, and resets the collaboration epoch.
History is a recovery mechanism, not a substitute for backing up the complete
data directory.

## GitHub backup

The Git panel is project-owner-only. Git is optional at startup and is checked
when Git integration is used. Each user's GitHub token is configured from the
account menu and encrypted in SQLite; it is never placed in a remote URL or
command-line argument. A project's current owner supplies the credential for
creating its GitHub repository and pushing. The remote URL and repository
metadata remain project-specific. The local repository lives in the project
source directory, with temporary identity:

~~~text
user.name  = project owner's username
user.email = <username>@texlite.com
~~~

For a fine-grained GitHub token in a trusted deployment, grant repository
Administration and Contents read/write permissions. “All repositories” is the
practical choice when a repository may be created after token configuration.
Only the owner can commit, push, checkout, restore, or configure the project
repository. Transferring ownership changes which account credential is used;
the former owner's personal token remains with that account. Commit messages
are entered explicitly. Normal checkout preserves local changes and refuses
conflicts; only the explicit force option discards tracked, untracked, and
ignored working-tree files. Git operations use the same project coordination
and durable-flush boundary as other source replacements.

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

TexLite opens SQLite with WAL mode and `synchronous=NORMAL`. This avoids a
full WAL fsync on most small metadata writes while preserving SQLite's atomic
and consistent database state. Following an abrupt host power loss or
operating-system crash, the most recently acknowledged database transaction
may be rolled back; normal process crashes do not have that trade-off. The
setting is deliberately not `OFF`, which could permit database corruption.

Database schema and data upgrades are append-only, versioned migrations stored
in `texlite_schema_migrations`. Each migration and its version record commit in
one SQLite transaction, so a failed upgrade is retried without being marked as
complete. The first tracked migration is a compatibility baseline for earlier
TexLite databases; it upgrades their schema once and records version 1. Future
changes must append a new migration rather than change an already released one.
This prevents historical backfills, such as the migration from project tags to
private user tags, from running again on every server restart.

Tags and archive state are private to each user. A project can therefore have
different labels, filters, and archived/active visibility for different
collaborators. Deleting a project removes its database rows and source/output
directory; deletion uses a temporary trash rename when possible and a startup
reaper cleans abandoned trash/temp entries. Deleting a user removes sessions,
memberships, private tags, and comments remain attributable as “Deleted User”.
An administrator can transfer the user's owned projects to the current
administrator or delete them with their files. Project transfer keeps the old
owner as an editor; GitHub credentials remain account-specific, so the new
owner's token is used for project operations. Administrators do not otherwise
receive implicit access to another user's projects; they see a project only
when they own it or it has been explicitly shared with them. The last active
administrator cannot be removed or disabled.

## External agent terminals

Schema migration 10 adds an initially empty administrator agent allowlist, task records,
and operation records. Tasks have independent UUIDs; project/user/agent is a
grouping key, not a uniqueness constraint. One project admits only one active
execution across all users, tasks and agents; different projects are independent.
There are no limits on distinct tasks, elapsed runtime, provider quotas, or billing. Historical
records do not retain live PTY handles. The application never automatically
starts an agent in response to a compile failure or writing action.
The workspace's Start task action creates and immediately launches a task; names
are optional and default to six uniformly sampled characters from `A–Z`, `a–z`,
`0–9` and `-`, independently of the task UUID.
Creation is accepted into the UI before launching, so a launch failure retains
the task and name for retry instead of creating duplicate conversations.
The terminal heading can maximize the panel to the editor column's full height
and restore its previous split. The source panel is also collapsible through
the separator. Editor tabs/source and the live terminal stay mounted during
maximization, preserving editor state, terminal output and the PTY connection;
the collapsed editor is inert. Closing a maximized terminal resets the split
so reopening does not leave the editor collapsed.

`AgentAdapter` in `src/server/agents/adapters/types.ts` defines feature discovery,
native preparation, start, exact-context resume, native-session identification,
and scoped cleanup. Codex, OpenCode, and Claude implement it separately;
registration/discovery and session orchestration do not contain native command
switches. PTY attachment, input ownership, process termination, task authorization,
and retry state are shared service responsibilities. A task owns one native
conversation, but launching a CLI process does not itself prove that a native
conversation was created. A previously launched task without a saved session ID
may launch again when its adapter verifies no conversation for that task. Discovery
distinguishes found, empty and unknown states: missing storage, failed commands
and ambiguous results never authorize a fresh conversation. OpenCode state is
inspected through SQLite in read-only mode, preferring the V2 `session_v2`
projection over a retained legacy `session` table. Older private layouts can use
native JSON session listing. Detected `--standalone`
support selects a private server owned by the task's process tree, avoiding
host background-service dependencies for execution, discovery and cleanup.
An existing session ID is verified before resuming because newer OpenCode
versions may create an unknown `--session` ID instead of rejecting it.
Once a session ID is saved, the service always resumes that
exact ID and never clears it or silently replaces the conversation after a
resume failure. The UI offers Continue only for an identified context. These
decisions are server-owned, not a browser-supplied start/resume toggle. A separate
conversation after an established one requires a new task UUID and state directory.

New OpenCode 2 tasks reuse the service account's native database and XDG
data/state locations, so provider sign-ins (including GitHub Copilot) and token
refreshes are shared with native terminals. TexLite asks `opencode debug paths db`
for the actual database path, respecting `OPENCODE_DB` and native channel/platform
defaults. Before launching, it registers a task-derived `ses_texlite…` ID and pins
the database path in the task's `state/opencode-session.json`. Launches always
pass that exact `--session` ID, and shared-state discovery never enumerates host
conversations or chooses a newest/unique one. An ID already present before its
ownership binding is created is not claimed. The native CLI creates the bound
conversation when needed; an unused task may still have no persisted conversation.
Existing private OpenCode conversations stay in their original database. Only
verified empty private stores switch to the shared layout; their old files remain
until task deletion.

TexLite lists and authorizes tasks exclusively from its own `agent_tasks` rows,
not the OpenCode session catalog. Shared-state cleanup uses native
`session delete <registered-id> --standalone` and verifies that exact ID is gone
before removing the task record/files. It never removes the host database,
credentials or unrelated native sessions. The native terminal's own history
picker can expose shared host conversations; this is an accepted boundary for
trusted writers, not additional tasks imported into TexLite.

All adapters inherit the service account's `XDG_CACHE_HOME`; when it is unset,
the CLI chooses its own default. Shared caches can reuse model catalogs and
installed dependencies across projects, tasks and native terminals.
Codex keeps a task-specific `CODEX_HOME`. Claude directly shares the service
account's native configuration and login instead of copying selected files.
For the default home, `CLAUDE_CONFIG_DIR` stays unset to preserve native
`~/.claude.json` onboarding discovery. An explicit configuration directory is
passed through. Each task durably binds that location and its UUID in
`state/claude-session.json` before its CLI can launch. Native discovery and
continuation target only that UUID; existing host conversations are not adopted.
Claude-specific model/context, provider-authentication, timeout and client-certificate
variables supplement the shared gateway/proxy environment on each start/resume.
The source is only the current service process, not a port-specific lookup or a
shell-profile loader. Runtime session markers and transcript controls stay excluded;
the durable ownership binding stores no inherited credentials.
Deletion removes only that session's transcript, subagent directory, transcript
sidecars and UUID-scoped checkpoint/task/debug data. Shared prompt history,
settings, credentials, plugins, project memory and caches are left untouched.
A missing or invalid ownership binding blocks native cleanup rather than
dropping the task and leaving an unmanaged conversation. After successful native
cleanup, `agent_tasks.native_cleanup_done` is committed before local file removal;
retries (including after restart) then need neither the binding nor CLI discovery.
The successful deletion audit and final task-row deletion commit together.
OpenCode management falls back to the task-state directory when a project's
source directory is gone, retaining the registered database and exact session ID.
Old private Claude conversations are not migrated and should be removed before
upgrading. Task deletion also removes its private TexLite UUID directory,
never the inherited host cache or the host configuration directory.
These locations organize tasks; they do not sandbox agents running as the same
service account.

The administrative screen is a separate lazy page, with agent settings and a
paginated cross-project task catalog. Task listings use server-side pagination
with 50 tasks per page across management pages and project terminals.
Administrators can stop/delete tasks but
cannot attach to another user's terminal. This metadata-specific authority does
not change ordinary project visibility. Users can manage their own tasks, and
execution/attachment additionally requires current project write
access and membership in the administrator allowlist. Mutating requests reconcile active tasks after
permission changes. Terminal input/output also validates access, and WebSocket
authentication queries the actual session row rather than the HTTP request cache.

Tasks have no archive state; project archival only organizes project lists.
Explicit termination releases the owned process
group, including children, while retaining context. Explicit deletion also
removes only task state, never project files. Cleanup failure preserves its record
for retry; an unverified native operation is never represented as successful.
Windows termination treats an OS-confirmed missing process as already stopped,
including the race with natural exit; command failures and permission errors
alone are not proof of termination. Graceful shutdown awaits every task's stop
and final source synchronization before aggregating failures, so one failed
task cannot make database shutdown overtake another task's final writes.
Deleting a project/account stops affected executions and attempts scoped
cleanup; orphaned tasks keep ownership labels and cleanup locators independently
of the deleted rows, so administrators can resolve failures. Operation records
retain project, agent, task, and actor identity after deletion, without transcripts.

New executions persist a task-owned `execution.json` lease with an independent
execution UUID, platform, launcher PID and OS birth identity. A small Node
launcher preserves the CLI's inherited TTY and waits for its verified identity
to be committed before starting the CLI. It remains the identifiable process
group leader after CLI exit; the normal stop path reaps the group before
releasing the project. The CLI's exit code is relayed through an execution-scoped
result file, not confused with the launcher's eventual termination code.

Startup recovery runs before requests are accepted. It verifies the UUID marker
and birth identity (Linux boot ID/start ticks, macOS start time, Windows CIM
creation time) before terminating any previous execution. Uncommitted launch
permits are cancelled without starting their CLI. PID reuse never authorizes a
kill. Unreadable identities, failed termination, or a live leaderless POSIX group
retain the lease, task record, project claim, and an actionable recovery error;
owners/admins can retry **End execution** or deletion after resolving the host
problem. Project replacement cannot bypass the claim. Recovered source files
are preserved and recorded in project snapshots; lost in-memory per-edit
attribution cannot be reconstructed after a service crash.

These leases apply to executions started by this implementation. Pre-lease
executions have no verifiable process locator: stop them before upgrading.
Recovery does not discover or kill unrelated native CLI sessions or deliberately
detached/escaped processes; Coding Agent terminals remain trusted host tools,
not OS sandboxes. No database schema change is required.

Agents run directly in the project source directory. Task directories retain
session bindings, private native state where used, and compilation context, not baseline/work copies. A synchronous
project claim is acquired before asynchronous startup and released only after
process-tree termination and final source synchronization. Source-tree exclusive
operations end the writer before entering the project queue, preventing deadlocks
with its final synchronization. This is a single-instance claim, not an OS lock.

An active source synchronizer polls directory metadata every 750 ms; only changed
small files are read. Before a dirty collaborative file is saved, the same
synchronizer checks its disk contents synchronously. Non-overlapping edits are
three-way merged against the last known disk text. External text is applied as
an attributed incremental Yjs transaction, preserving human edit segments and
the exact anchor-update chain. Ordinary HTTP/browser writes advance the known
disk state and are not attributed to the agent. Added/deleted/binary files update
the tree and snapshots. Overlapping replacements preserve the editor draft and
save the agent version under `.texlite-agent-conflicts/<task-id>/`, then stop the
task with a visible warning. Symlinks and unreadable files stop synchronization
instead of being followed. Polling ends with execution, not browser attachment.

Task context JSON and a compile log are exposed through `TEXLITE_PROJECT_CONTEXT`
and `TEXLITE_COMPILE_LOG`; compile API completion refreshes this context. A CLI
does not become sandboxed by running in a project, nor does this watcher impose
filesystem barriers on arbitrary host processes. Compile snapshots retain their
existing consistency checks; external edits should not be treated as OS-locked
transactions across several files.

Before each launch, the service copies the fixed English
`templates/agents/AGENTS.md` into the source root if `AGENTS.md` is absent. The
exclusive-create copy never overwrites existing instructions. Creation uses
the project write coordinator and updates collaboration, metadata and snapshots.
The template scopes the agent to the current manuscript's LaTeX and academic
writing, including bibliography work, compilation diagnostics and directly
related supporting scripts. It directs the agent to refuse unrelated requests
before using tools, handle mixed/ambiguous requests explicitly, and avoid
fabricated references or results. The collaboration, source/output and compile
context guidance remains deployment-independent; the template ships as a package
runtime asset. Existing project instructions are not migrated automatically.
The CLIs retain native instruction-file loading, without generated `CLAUDE.md`
files or injected system-prompt flags. CLI versions/settings determine whether
the file is loaded. Task scope is behavioral guidance for trusted users, not
an enforced filesystem or execution boundary.

The browser mounts a terminal only for the visible task, and streams private
terminal data over authenticated, origin-checked WebSockets with base-path and
HTTPS support. One attachment owns input/resize; takeover is explicit. Server
display replay is bounded, slow sockets disconnect without stopping the task,
and full transcripts are not persisted by TexLite. Native CLI history can still
exist in task-local or shared host state. Raw terminal replay is a bounded recent stream, not a
complete saved terminal screen; very long full-screen sessions may need a redraw.

Terminal appearance is separate from editor appearance. Its font, size and theme
are browser-local preferences shared across projects and scoped to the
deployment base path, without user/database or CLI configuration changes. The
Terminal tab also saves a default-on execution-reminder toggle in this browser
store. It controls the terminal/task-list reminder text and active-task count
badges on Terminal and Agent tasks entries, including their accessible labels.
It does not stop or reconnect tasks, alter actual counts/access, or hide
project-busy warnings and other operational guidance.
Older preferences without the toggle keep the reminder enabled. The
default is JetBrains Mono at 13 px with fixed 1.2 line spacing; existing web fonts and
a system-monospace fallback are available. The original Catppuccin-inspired
TexLite dark palette remains the default; Catppuccin Latte (light) and Gruvbox
Dark are also bundled in `terminalTheme.ts`. Terminal color schemes and
scrollbars follow the selected terminal palette, independently of the app/system
theme. Existing preferences without a theme retain the original
palette. xterm receives the selected palette at construction, before the CLI can query
terminal colors. Padding, empty states and the font preview share the same
palette; outer task controls still follow the application theme. Switching the
app/system theme does not recolor, recreate or reconnect a running terminal.
The palettes control xterm's default and ANSI colors; explicit true-color output
and a coding agent's own application theme remain under that CLI's control.
Latte uses xterm's minimum-contrast adjustment at 4.5 for readable terminal text;
dark palettes retain xterm's default contrast behavior. Cursor, selection and
preview accents are adapted for legibility on the pale Latte background.
No Starship installation or host/agent configuration changes are required.
Saving updates the current xterm palette immediately without reconnecting or
clearing output. Theme-only changes do not reload fonts or resize the terminal;
font changes fit its row/column geometry after loading. Font loading completes
before measuring the selected font, with stale
loads and unmounted terminals ignored; failed web fonts use the fallback stack.
Previously stored terminal line-spacing choices are ignored and omitted on the
next save; the editor's independent line-spacing setting is unchanged.
Manual saves for editor/terminal/compiler settings show a blue check and “Saved” on
the header and footer save buttons for two seconds, without a success banner.
Feedback is scoped to the saved tab, including delayed compiler responses;
idle buttons retain their existing labels. Unchanged compiler settings are
reported on the buttons instead. Failures remain visible as errors rather than
claiming success. User, citation, tag and Coding Agent management actions follow
the same button-only success-feedback convention. Deletions and permission
changes are reflected by their resulting list/control state without success
banners; failures keep their contextual errors. Citation/tag edit forms remain
open after saving, retaining the updated revision for subsequent writes.
Snapshot naming and GitHub token saves use the same button-only confirmation.
All explicit save buttons share `SaveButton`: a neutral surface and text,
a save icon at rest, a disabled spinner while saving, and a blue check for
confirmed feedback. The owning workflow still controls persistence, errors and
the two-second feedback timer. Dialogs that close after saving retain that
behavior; create, send and destructive actions keep their distinct semantics.

Management pages use the Coding Agent page's compact control scale: 12 px
controls and table text, 32 px main actions, and matching themed primary buttons.
User, citation and Coding Agent management share the localized “Back to projects”
navigation label and fixed 32 px button height, including when the Agent page's
stylesheet loads later. Citation list actions use the same compact height,
line height and icon scale, including Copy BibTeX and the overflow trigger.
Project-list controls and editor content are not rescaled.

`node-pty` loads dynamically and is an optional production dependency. xterm.js
and its fit addon are build dependencies behind a lazy terminal boundary. Missing
PTY support does not block startup. Graceful shutdown stops managed executions;
restart marks prior executions interrupted without trusting stored PIDs or
automatically respawning them. Native state formats and resume capabilities vary
by agent version; the deployed tools remain responsible for their own authentication.
Working copies do not provide OS isolation. See `OPERATIONS.md` for the current
adapter capability matrix and usage.

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
- [x] Strengthen source-comment re-anchoring. Actual Yjs operations take
  precedence over inferred diffs; partial edits follow the selection, and
  complete replacements remain detached until the original quote is restored
  by a new edit with matching context. Unchanged duplicate text cannot take
  over a deleted selection's anchor. Failed anchor writes retain their own
  baseline and exact edit chain for automatic retry.
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
