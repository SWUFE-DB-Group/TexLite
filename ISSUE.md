# TexLite issue backlog

This file records the issues identified during the project review. It is a
working backlog rather than a promise that every item is already reproduced in
the same environment. Items are grouped by impact and should be closed with a
regression test where practical.

## High priority

- [x] **Project routing is state-only.** Opening a project only changes React
  state. The project is not represented in the browser URL, so refresh/deep
  links do not reliably reopen the project and browser back/forward history is
  incomplete. A missing or inaccessible project also has no clear route-level
  recovery action. The client now uses `/project/:id`, accepts the plural alias,
  preserves browser history and offers a return action for failed project loads.
- [x] **Same-name file overwrite.** New-file creation and project uploads could
  overwrite an existing path. New files now use create-only semantics, uploads
  reject collisions by default and require an explicit overwrite confirmation,
  and duplicate ZIP entries are rejected.
- [x] **Workspace startup is too eager.** Project metadata, files, completion
  indexes, dictionary, compile state, artifacts, PDF state and collaboration
  are initialized together. Prioritize the first render and make secondary
  requests cancellable so a cached PDF/editor is visible sooner. The workspace
  now treats metadata/files/retained-PDF as the critical path, defers completion
  indexing/dictionary/artifact loading until after the first render, aborts stale
  requests, and remounts collaboration state when the project changes.
- [x] **Compile diagnostics need a structured result.** Parsing human-readable
  latexmk output can classify warnings, BibTeX messages and recoverable LaTeX
  diagnostics incorrectly. The compiler should return explicit phases and
  severity, while retaining the raw log for inspection. Compile responses now
  include structured diagnostics, and historical runs are parsed on read.
- [x] **Collaboration lifecycle needs stronger recovery.** Reconnects,
  project changes and failed websocket handshakes should stop all pending
  timers/requests and show a recoverable state instead of leaving stale
  presence or editor data behind. The client now rejects pending flushes,
  clears presence/shared transient state, blocks writes until synchronization,
  rechecks project access after a disconnect, and offers an explicit reconnect
  action.

## Medium priority

- [x] **Compile request UX.** The UI should make queued/running/finished states
  and the retained successful PDF unambiguous, including when a newer compile
  fails. Avoid replacing a good PDF with an incomplete result. The workspace
  now shows queued/running/failed status strips and explicitly says when the
  last successful PDF is being retained.
- [x] **File-operation consistency.** File creation, upload, move, delete and
  project settings should share one path-validation/error contract and report
  conflicts in the active dialog rather than only in a generic toast. Shared
  path/error codes now cover these operations, and create/move dialogs display
  their server errors in context.
- [x] **Error localization.** Some server errors are Chinese text and are
  passed through differently for English and Chinese users. Prefer stable error
  codes with localized client messages, while keeping server logs detailed.
  API responses now include stable codes and the client resolves them through
  the English/Chinese resource files while retaining server-side messages for
  logs.
- [x] **Long-running request cancellation.** Search, spell checking, completion
  indexing, compile polling and file loading should cancel or ignore stale
  requests consistently when the active file/project changes. Dashboard and
  workspace fetches, comments, previews, SyncTeX, compile polling and compile
  response handling now abort or ignore stale requests.
- [x] **Access/session edge cases.** Expired sessions and permission changes
  during an open project should redirect or downgrade the workspace cleanly,
  without leaving an editor that appears writable. A 401 event returns to the
  login route; collaboration disconnects revalidate access, downgrade writes,
  and return to the dashboard when access is gone.

## Lower priority / maintainability

- [ ] **Browser-level regression coverage.** Add a small Playwright suite for
  login, project deep links, back/forward navigation, upload conflicts,
  read-only comments and retained-PDF loading.
- [ ] **Accessibility pass.** Review focus restoration for dialogs, keyboard
  navigation in the file tree/editor controls, status announcements and labels
  for icon-only actions.
- [ ] **Observability.** Expose bounded server timing/queue metrics for project
  loading, collaboration connection and compilation without logging source
  contents or credentials.
- [x] **Configuration validation.** Validate configuration values at startup
  with actionable messages (paths, limits, engines, compile timeout and queue
  size) and document the effective defaults. `loadConfig()` now rejects
  malformed explicit values instead of silently restoring defaults, validates
  path targets and engine combinations, and the English/Chinese READMEs list
  effective defaults and accepted ranges.

## Work log

- 2026-08-03: Recorded the review backlog and fixed the project-routing issue
  with URL/history state and route regression tests.
- 2026-08-03: Staged project startup requests, added abort/stale-response
  protection, and added a keyed workspace remount for project changes.
- 2026-08-03: Moved spell checking into the browser bundle and removed the
  server-side source-check endpoint; the backend now only stores the shared
  project dictionary.
- 2026-08-03: Added structured compile diagnostics with phase/severity/source
  location metadata. Compile success is authoritative, so intermediate BibTeX
  messages no longer turn a successful PDF into a false error; raw logs remain
  available in the log tab.
- 2026-08-03: Hardened collaboration recovery and access changes: pending
  flushes are rejected on disconnect, stale presence/transient state is cleared,
  writes stay disabled until sync, and a reconnect action reopens the room after
  permission validation.
- 2026-08-03: Added compile status/retained-PDF messaging, shared path-operation
  error codes, localized API error handling, and abort/stale guards for dashboard,
  comments, previews, SyncTeX, compile polling and compile responses.
- 2026-08-04: Added strict startup configuration validation for paths, limits,
  engines, URLs, compile timeout and queue size. Documented effective defaults,
  ranges, and environment override behavior in both READMEs.
