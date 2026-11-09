# TikZ gallery add-on

> **Beta.** The TikZ gallery is a beta feature. Its behavior, configuration and
> figure library may change between releases.

The gallery lets you browse editable TikZ and pgfplots figures and copy them into
a project. The figures live in a separate repository,
[texlite-tikz](https://github.com/ChenZhongPu/texlite-tikz), and are not shipped
with TexLite. The feature is off by default. See that repository for its figure
licenses and for how to add figures.

## Install

Clone the add-on into `addon/` beside `texlite.config.json` (`texlite config`
prints `configPath`):

~~~bash
cd <directory containing texlite.config.json>
git clone https://github.com/ChenZhongPu/texlite-tikz.git addon/texlite-tikz
~~~

Enable it in the configuration, then run `texlite restart`:

~~~json
{
  "tikzGallery": { "enabled": true }
}
~~~

To keep the add-on elsewhere, also set `tikzGallery.path`. A relative path is
resolved against the configuration file, and the default is `addon/texlite-tikz`.

`texlite doctor` reports how many figures it found. If it fails, either the
directory has no `catalog.json`, or the catalog format does not match this version
of TexLite, in which case update TexLite or the add-on.

## Update or remove

Run `git pull` in the add-on directory to update it. No restart is needed.

To remove it, set `tikzGallery.enabled` to `false`, run `texlite restart` and delete
the directory. Importing copies a figure into the project, so figures already
imported are not affected.

## Use the gallery

In a project you can edit, open the **⋯** menu of the file panel and choose
**TikZ gallery**. Figures are grouped as templates, examples, icons and data plots.
Searching icons covers every icon category. Choose a figure to see the packages it
requires, set **Save as**, and import it. The figure is a complete `standalone`
document that you can edit like any other source file.

## Compile a figure to PDF

When the open `.tex` file is a standalone TikZ figure, **Compile to PDF** appears
above the editor. It compiles the figure and saves the PDF beside the source, ready
for `\includegraphics` in the main document. The engine chosen next to the button
applies only to figures, leaves the project's own engine unchanged, and is
remembered per project in this browser.

This button does not depend on the add-on. It works for any standalone TikZ figure
in a project you can edit.

## Coding Agents

If the add-on includes `TIKZ.md`, Coding Agents read it for TikZ and pgfplots work
and may copy figures from the add-on, which they treat as read-only. The instruction
is in the `AGENTS.md` template that TexLite copies into a project only when the
project has none, so a project with an existing `AGENTS.md` needs the
"TikZ and pgfplots figures" section added by hand.

## Security

Only the sources and previews listed in the add-on's catalog are served, and only
to signed-in users. Even so, treat the repository as you would any other software
you install on the host.
