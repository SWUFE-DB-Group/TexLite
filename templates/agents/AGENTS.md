# Working in a TexLite project

TexLite is a self-hosted collaborative LaTeX editor. You are working directly
in a project's live source directory, not in a disposable copy. Changes are
synchronized to collaborators and attributed to the user who started this task.
Keep edits focused and avoid overwriting unrelated work.

Only one Coding Agent task runs in this project at a time, but human
collaborators can still edit. Re-read a file before applying a change if work
has continued since you last inspected it. Do not reset the whole project or
discard unfamiliar edits to make your patch apply.

## Source and compilation output

The project layout is:

```text
<project>/
  source/       Your working directory: LaTeX, bibliography, figures and other sources.
  output/       TexLite-managed compilation output, caches and published results.
```

The output directory is `../output` relative to this file. TexLite compiles from
an isolated source snapshot, so a retained PDF or log describes a particular
compile run and may predate the current source. There can be multiple candidate
main documents; do not assume the main document is named `main.tex`.

Start with the configured main document, follow `\input` / `\include` to the
relevant chapter, and inspect linked bibliography files when needed. If the
user asks about a different main document, make sure the log belongs to that
document: the default terminal context describes the configured main document,
not necessarily every root a collaborator has compiled.

## Finding the current compilation result

Two environment variables are available in the agent terminal:

- `TEXLITE_PROJECT_CONTEXT`: the path to a JSON file with the source directory,
  configured main document, output directory, latest compile run/status and log path.
- `TEXLITE_COMPILE_LOG`: the path to the latest configured-main-document
  compilation log. This file is outside the source tree.

Read the context and log first when investigating a compilation failure. They
are refreshed after compilation through TexLite. The context's `latestCompile`
is `null` if no result has been recorded. TexLite may retain the last successful
PDF even after a later compilation fails; a visible PDF does not imply that
the newest compilation succeeded.

Use the first relevant error and its surrounding context to identify the cause;
later errors may be consequences. Preserve useful diagnostic information and
do not hide failures by suppressing warnings or replacing a failed result with
an old PDF. If the result is still queued/running, wait for the completed result
before claiming the change fixed compilation.

Successfully published PDF/SyncTeX results are under
`../output/.texlite/runs/<run-id>/output/`; incremental compilation caches are
also managed below `../output/.texlite/`. A failed run may have no published
output directory. Use the context's paths and status rather than guessing from
file modification times or treating an older retained PDF as the latest result.

## Editing and checking work

- Edit sources in this directory, not retained compile snapshots or generated
  output. Do not remove or rewrite TexLite's output/cache metadata manually.
- Check the relevant included files and bibliography when diagnosing errors.
- Preserve existing citation keys, labels and document structure unless the
  task specifically requires changing them. Check references to anything renamed.
- Avoid whole-file reformatting or unrelated package/template changes for a
  localized fix. Respect the project's existing formatting conventions.
- Use TexLite's Compile action to generate results for its PDF preview. A build
  run independently in the terminal does not automatically publish a new preview.
- For an independent diagnostic build, use a separate temporary output
  directory outside `source/` and outside TexLite's managed `.texlite/` trees.
  Match the project's engine and build settings; if they are unclear, ask
  rather than assuming `pdflatex`. Such a build does not update the browser PDF.
- Keep generated auxiliary files out of the source tree when running tools.
- If `.texlite-agent-conflicts/` appears, stop and inspect the preserved versions
  with the user before proceeding. Do not silently discard either version.
- Summarize the files changed and checks performed. If you did not recompile,
  or could not verify a fix, state that explicitly.

This file was copied from TexLite's default template because the project had
no root `AGENTS.md`. Project maintainers can edit it; TexLite does not overwrite
an existing file.
