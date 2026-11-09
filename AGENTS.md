# Working on TexLite

This file guides Coding Agents developing **TexLite itself**. It applies to this
repository. `templates/agents/AGENTS.md` is a different artifact: instructions
copied into users' LaTeX projects for writing assistance. Its manuscript-only
task restrictions do not apply to development of this application.

## Project direction

TexLite is a lightweight, self-hosted collaborative LaTeX workspace for trusted
users. Keep the default deployment simple: one Node.js process, SQLite, local
project files, and host-installed TeX tools. Coding Agent integration is an
optional, administrator-controlled bridge to host CLIs, not a built-in model
service. Avoid introducing infrastructure or dependencies without a concrete
need.

Read the relevant implementation before editing. Keep changes scoped, preserve
unrelated work, and do not commit, amend commits, publish, or deploy unless asked.
Do not inspect credentials or modify real project data as part of ordinary
development. Never stop an existing service or remove its lock just to run tests.

## Where to look

- `src/client/pages/`: dashboard, management pages, and workspace controller.
- `src/client/workspace/`: workspace panels, feature hooks, compilation state,
  collaboration, comments, suggestions, and project settings.
- `src/client/latex/` and `src/client/bibtex/`: internal CodeMirror language
  modules. Read their local `README.md` files before changing parser behavior.
- `src/client/agents/`: terminal UI, agent selection, and task/access hooks.
- `src/shared/`: browser/server contracts and pure parsing, validation, and
  classification helpers. Keep Node-only and DOM-only code out of this layer.
- `src/server/routes/`: HTTP and WebSocket endpoints; services live alongside
  `src/server/app.ts`. Database schema and migrations are in `src/server/db.ts`.
- `src/server/agents/`: native CLI adapters, execution, sessions, and source sync.
- `scripts/`: development launcher, generated assets/parsers, and build plugins.
- `tests/`: Vitest tests; individual UI tests opt into `happy-dom`.
- `website/`: standalone public website, with its own CSS and locale catalogs.
- `src/client/tikzGallery/` and `src/server/tikzGallery.ts`: the optional TikZ
  gallery, reading an add-on repository named by `tikzGallery.path`. Treat its
  files as untrusted content and keep this code independent of the workspace.

Use `DESIGN.md` for architecture, `OPERATIONS.md` for deployment/configuration,
and `NPM_TESTING.md` for isolated package verification. Check code when a document
and implementation disagree; do not carry a stale description into new code.

## Development and verification

Use Node.js as required by `package.json` (currently Node 24+) and npm with the
checked-in lockfile. Source builds need development dependencies:

```sh
npm ci
npm run dev:init  # first-time development configuration/account setup
npm run dev      # API/server watcher
npm run dev:web  # Vite UI, in a separate terminal
```

`scripts/run-dev.mjs` deliberately overrides inherited deployment settings:
configuration and data live under ignored `.texlite-dev/`, the API port is
currently `3009`, and Vite normally uses `5173`. Shell overrides of
`TEXLITE_CONFIG`, `TEXLITE_DATA_DIR`, or `TEXLITE_PORT` will not redirect this
launcher. For another test instance, use separate temporary configuration,
data, and ports; never share a data directory between running instances.
`.texlite-dev/` may still contain the developer's valuable test projects.

Useful checks:

```sh
npm test -- tests/updates.test.ts  # substitute tests relevant to the change
npm run typecheck
npm test
npm run build
git diff --check
```

Run focused tests during development and broader checks for shared contracts,
cross-feature refactors, or release work. `npm test` runs asset/parser generation
first; direct `vitest` invocation does not run that npm lifecycle step.

Builds write to `dist/`; web builds empty `dist/client`. If a running instance
serves that directory, do not rebuild it in place without coordinating. For a
frontend-only build check after generating any changed parser artifacts, use an
isolated output directory instead:

```sh
qa_dir="$(mktemp -d)"
npx vite build --outDir "$qa_dir/client"
```

Do not run `npm start`, deployment lifecycle commands, or installed `texlite`
commands against the default user configuration just to check a source change.
Package testing, including `npm pack`, can invoke builds; follow
`NPM_TESTING.md` and use temporary install prefixes, configuration, and data.

## Correctness boundaries

- **Permissions:** trusted users are not permissionless users. Enforce project
  access, owner-only settings, and private-library ownership on the server.
  Anonymous read-only links must not permit source mutation, Yjs updates,
  compilation, Git operations, or agent execution. Hiding a button is not an
  authorization check. Apply the same access rules to resources and WebSockets.
- **Collaboration and files:** the on-disk source can lag a live Yjs document.
  Use existing collaboration flush/update and project mutation coordination
  paths when changing files, compiling, or restoring history. Do not write
  around these paths and silently replace a collaborator's unsaved changes.
  Preserve cancellation, stale-result checks, and cleanup when extracting hooks.
- **Compilation and PDF:** results belong to `{ projectId, mainFile, runId }`.
  `workspace/compilationResults.ts` owns result acceptance/reset decisions.
  A retained successful PDF may come from a different run than the latest failed
  log; never infer one identity from the other. Preserve main-file switching,
  obsolete-request rejection, and SyncTeX alignment with the displayed PDF.
- **Comments and suggestions:** source edits, anchor deletion/recovery, Yjs
  updates, history, cached queries, and mention notifications interact. Update
  through the owning workflows, not just local component state. Accepting an
  edit suggestion requires server-side permission and current-source validation;
  displaying a diff is not validation. Preserve drafts and pending-submit guards.
- **History:** project snapshots and selection edit history are distinct.
  Snapshot restore must respect tracked-file scope and leave untracked files
  alone. Reuse shared file classification instead of separate extension lists
  for tracking and diff display.
- **Database/configuration:** append a new versioned migration; do not rewrite
  released migrations. Test fresh creation, upgrades with existing data, and
  reopening without reapplying changes. New optional configuration needs an
  effective default when absent. Keep initialization output minimal, and update
  relevant examples, docs, and tests when changing defaults.
- **Agent lifecycle:** adapters implement `src/server/agents/adapters/types.ts`.
  Keep durable task/native-session ownership, one active execution per project,
  resume, stop, cleanup failures, and crash recovery consistent. Hiding a terminal
  does not stop execution. Agents edit the live project source; preserve source
  synchronization and attribution. Never clean host sessions/configuration that
  TexLite does not own. Use fake CLIs in tests, not real paid agent sessions.
- **Subpaths:** use existing API, `appPath`, and scoped browser-storage helpers.
  New URLs, downloads, WebSockets, and stored preferences must work below a
  configured `server.basePath`, not only at `/`.

## Parsers, dependencies, and generated files

- Edit LaTeX/BibTeX grammar and tokenizer sources, not generated parser tables.
  Regenerate checked-in artifacts with `npm run generate:latex-parser` or
  `npm run generate:bibtex-parser`, and include resulting changes.
- Keep shared LaTeX symbol extraction and reference classification in
  `src/shared/`; do not recreate divergent browser/server scanners. Parser tests
  should cover comments, escaped delimiters, nested braces, literals, incomplete
  input, and incremental edits where relevant. A syntax recovery node is not
  automatically a user-facing diagnostic.
- Preserve the lazy boundaries for editor/PDF modules, auxiliary languages,
  formatting workers, and Vim. Avoid pulling a heavy feature into the initial
  application bundle through a static import.
- Review `scripts/pdfjs-viewer.ts` when upgrading PDF.js: it patches a specific
  upstream source fragment and intentionally fails if that fragment changes.
  Keep worker, viewer, font/CMap assets, and their build steps compatible.
- Frontend libraries are intentionally in `devDependencies`: the published npm
  artifact contains their built output. Server imports must still resolve after
  installation with `--omit=dev`. Do not move packages based on names alone.
- Preserve third-party licenses and `THIRD_PARTY_NOTICES.md` when changing
  derived language modules or bundled assets. Refactoring does not erase
  attribution requirements.

## UI and localization

- Reuse `Modal`/`ConfirmDialog`, `SaveButton`, `InfoPopover`, and existing menu
  and pagination styles. Common control sizes live in `siteTheme.css` as
  `--ui-control-*`, `--ui-menu-font-size`, and `--ui-touch-target`.
  Keep compact desktop controls and larger touch targets; do not enlarge every
  icon or flatten intentional primary/secondary action differences.
- Check light/dark themes, narrow panels as well as narrow viewports, touch,
  long names, and translated text. Preserve keyboard focus, accessible names,
  disabled/loading states, and reduced-motion behavior.
- Successful save/copy actions normally confirm on the button using the shared
  feedback pattern; failures remain visible. Avoid duplicate success toasts.
  Info icons use click-to-toggle, selectable popovers; ordinary hover hints use
  `GlobalTooltip`, respecting workspace preferences and intentional exceptions.
- Maintain English, Simplified Chinese, and Traditional Chinese together.
  Browser catalogs are in `src/client/locales/`; some feature messages live in
  shared catalogs and `src/client/agents/messages.ts`, assembled by `i18n.ts`.
  Use i18next plural forms and preserve interpolation/rich-text placeholders.
  Traditional Chinese is maintained separately, not runtime character conversion.
- Use stable server error codes with `apiError`/`httpError`, and update the
  corresponding localized catalogs. Keep raw compiler output and operational
  logs untranslated. Website copy has separate locale resources.

## Tests and handoff

Favor tests of permissions, state transitions, concurrency, cancellation,
failure/retry, persistence, and real regressions. Extend existing coverage rather
than adding a test for every wording, CSS value, or implementation detail.
Use temporary databases/directories and mocked or fixture external tools; do not
require installed TeX or authenticated agents for ordinary tests.

For UI work, inspect the affected states in a browser when possible, using an
isolated fixture or explicitly authorized development data. Do not introduce a
browser-test framework solely for a small styling change. State clearly when a
visual or platform check was not performed.

Before handing off, review the diff and report what changed, checks actually run,
and any remaining risks. Do not label a failing test as pre-existing without
checking the baseline, and do not delete or weaken it merely to get a green run.
