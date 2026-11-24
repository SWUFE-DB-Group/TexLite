<div align="center">

<img src="https://raw.githubusercontent.com/SWUFE-DB-Group/TexLite/main/src/client/public/texlite-icon.svg" width="72" height="72" alt="TexLite logo" />

# TexLite

A lightweight self-hosted alternative to Overleaf for _small, trusted_ research
teams. Use your existing LaTeX distribution and coding agents, with no heavyweight service stack.

[![CI](https://github.com/SWUFE-DB-Group/TexLite/actions/workflows/ci.yml/badge.svg)](https://github.com/SWUFE-DB-Group/TexLite/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/texlite?logo=npm&label=npm)](https://www.npmjs.com/package/texlite)
[![Docker Hub](https://img.shields.io/docker/v/zhongpu/texlite?logo=docker&label=Docker%20Hub)](https://hub.docker.com/r/zhongpu/texlite)

**Documentation:** English (this file) · [Operations](OPERATIONS.md) · [Design](DESIGN.md) · [简体中文](README.zh-CN.md)

**Website:** [TexLite GitHub Pages](https://swufe-db-group.github.io/TexLite/)

</div>

https://github.com/user-attachments/assets/c2b277ab-7cab-4f2b-8684-358fd9fefe8f

## Why TexLite

- **Bring your own TeX and coding agents.** Compile with the packages and fonts
  installed on your host. If you use a coding agent, choose the CLI and model
  yourself and review its changes in the project.
- **Take a paper from draft to PDF in one workspace.** Co-edit in the browser,
  suggest changes at the exact passage, and keep references, draw.io diagrams,
  and editable TikZ figures alongside the manuscript.
- **Self-host without a separate database or cache service.** The default setup
  runs on one machine with a Node.js service, SQLite, and local files.
- **Keep your work portable.** TexLite stores sources, history, and compiled
  output on your host. Take the manuscript elsewhere as a ZIP of ordinary LaTeX
  project files, or back it up to your own GitHub repository.

## Quick start

Install Node.js 24 or newer, `latexmk`, and at least one TeX engine such as
`pdflatex`, `xelatex`, or `lualatex`. Git is needed only for the optional
Git/GitHub integration.

> [!NOTE]
> TexLite is developed and tested primarily on Linux. Testing on macOS and
> Windows is limited; if you encounter platform-specific issues, please report
> them via [GitHub Issues](https://github.com/SWUFE-DB-Group/TexLite/issues).

After installation, `texlite requirements` checks the relevant host software
and versions before initialization.

```bash
npm install --global texlite
texlite requirements
texlite init
texlite start
texlite status
```

<details>
<summary>Example <code>texlite requirements</code> output</summary>

Example from my Manjaro Linux. Installed tools, versions, and paths vary by host.

```text
$ texlite requirements
● TexLite requirements — all host requirements passed

Host software (automatic discovery)
┌──────────────────────────────────┬──────────┬───────────┬──────────────────────────────────────────────────────────┐
│ Tool / command                   │ Need     │ Status    │ Version / diagnostic                                     │
├──────────────────────────────────┼──────────┼───────────┼──────────────────────────────────────────────────────────┤
│ Node.js 24+ (node)               │ Required │ Installed │ v24.22.1                                                 │
│ latexmk                          │ Required │ Installed │ Latexmk, John Collins, 15 June 2025. Version 4.87        │
│ pdflatex                         │ One of   │ Installed │ pdfTeX 3.141592653-2.6-1.40.29 (TeX Live 2026/Arch Linu… │
│ xelatex                          │ One of   │ Installed │ XeTeX 3.141592653-2.6-0.999998 (TeX Live 2026/Arch Linu… │
│ lualatex                         │ One of   │ Installed │ This is LuaHBTeX, Version 1.24.0 (TeX Live 2026/Arch Li… │
│ Git (git)                        │ Optional │ Installed │ git version 2.56.0                                       │
│ TeXcount (texcount)              │ Optional │ Installed │ TeXcount version 3.1.1, 2018 Oct 28.                     │
│ pdffonts                         │ Optional │ Installed │ pdffonts version 26.08.0                                 │
│ BibTeX (bibtex)                  │ Optional │ Installed │ BibTeX 0.99e (TeX Live 2026/Arch Linux)                  │
│ Biber (biber)                    │ Optional │ Installed │ biber version: 2.22                                      │
│ MakeIndex (makeindex)            │ Optional │ Installed │ This is makeindex, version 2.18 [TeX Live 2026] (kpaths… │
│ ChkTeX (chktex)                  │ Optional │ Installed │ ChkTeX v1.7.9 - Copyright 1995-96 Jens T. Berger Thiele… │
│ Harper CLI (harper-cli)          │ Optional │ Installed │ harper-cli 2.12.0                                        │
│ Harper language server (harper-… │ Optional │ Installed │ harper-ls 2.12.0                                         │
│ Draw.io PDF browser              │ Optional │ Installed │ /usr/bin/google-chrome-stable                            │
└──────────────────────────────────┴──────────┴───────────┴──────────────────────────────────────────────────────────┘

Required tools and at least one tool in every “One of” group must be installed to compile with TexLite. Optional tools enable their named feature without blocking the editor.
This command does not read a TexLite configuration, data directory, database, or administrator state.
Harper CLI is used by TexLite; harper-ls is reported for host diagnostics and external editor integrations.
```

</details>

Open <http://127.0.0.1:3000>. `texlite init` creates the configuration and the
first administrator; public registration is deliberately unavailable.
To mount TexLite below an existing domain path such as `/texlite`, configure
`server.basePath` and follow the [reverse-proxy guide](OPERATIONS.md#reverse-proxy-subpath).

For upgrades and routine management:

```bash
npm update --global texlite
texlite restart
texlite logs
```

`texlite serve` runs in the foreground for debugging, Docker, or systemd.
`start`, `stop`, `restart`, `status`, and `logs` use the PM2 runtime bundled
with the npm package. Run `texlite help` for the complete command list.

## A practical distinction from Overleaf

[Overleaf](https://www.overleaf.com/about/features-overview) is a strong choice
when its hosted product or broader ecosystem is the right fit. TexLite addresses
a narrower self-hosted use case:

- A shared hosted service can queue, slow down, or time out at usage peaks.
- Overleaf's open-source [Community Edition](https://github.com/overleaf/overleaf)
  follows a more involved [Docker deployment path](https://docs.overleaf.com/on-premises/getting-started/what-is-the-overleaf-toolkit), and
  several functionalities, such as source comments, are [Server Pro features](https://docs.overleaf.com/on-premises/user-and-project-management/roles-and-permissions).
  _If you do not mind a heftier Docker image, [we have one ready too](#docker-deployment) :)_
- TexLite can run host-installed Coding Agent CLIs (e.g., Claude Code, Codex, OpenCode, or Antigravity) directly in a project terminal. Agents can inspect and edit project files, while the team chooses the models and workflows; this goes beyond a built-in AI chat interface.

Self-hosting does not make every document compile faster: that still depends on
the host and the document. It does give the team control over capacity, TeX
updates, data location, and the collaboration workflow.

For a desktop-first, individual workflow, start with
[VS Code + LaTeX Workshop](https://github.com/James-Yu/LaTeX-Workshop) or
[TeXstudio](https://texstudio.org/) instead. TexLite is purpose-built for
shared browser writing, not a replacement for a personal IDE.

## LaTeX writing and research highlights

- **Draw diagrams with draw.io.** Edit `.drawio` files in the
  [embedded diagrams.net editor](OPERATIONS.md#drawio-diagrams) (official or
  self-hosted). Export the current page or just the selection as a cropped PDF
  beside the source, ready for `\includegraphics`. PDF export uses a browser
  installed on the TexLite host.
- **Start from editable TikZ figures.** Browse and import TikZ and pgfplots
  templates, examples, icons, and plots with the optional
  [TikZ gallery add-on](addon.md) (beta). Compile any standalone TikZ figure to
  its own PDF without rebuilding the manuscript, even without the add-on.
- **Run your own coding agents.** With administrator approval, use host-installed
  Claude Code, Codex, OpenCode, or Antigravity (`agy`) in a project terminal.
  Resume managed tasks and review agent edits across files with diffs and source
  highlights. See [external agent terminals](OPERATIONS.md#external-agent-terminals).
- **Write and navigate LaTeX and BibTeX.** Get completion, citation previews,
  folding, an outline, optional Vim mode, and project-wide find and replace with
  a preview. Format TeX and BibTeX in the browser; optionally use TeXcount,
  ChkTeX, and Harper for word counts, LaTeX checks, and spelling and grammar.
- **Compile on your own TeX toolchain.** Use `latexmk` with selectable engines
  and an optional project `latexmkrc`. Jump between source and PDF with SyncTeX,
  inspect structured diagnostics, and keep the last successful PDF visible if a
  build fails. With `pdffonts`, check for Type 3 or non-embedded fonts in compiled
  or uploaded PDFs.
- **Build a private reference library.** Reuse references directly from project
  `.bib` files and organize them with topic folders and tags. Import and export
  whole folders in BibTeX or in TexLite JSON, which preserves notes. Reference
  notes and the live Markdown file preview support math and GitHub-style callouts.
- **Co-write and review at the source.** Edit together in real time, see who is
  present, and discuss specific passages with anchored comments and mentions.
  Collaborators can suggest replacements without changing the source; an assigned
  reviewer with write access can inspect the diff and accept or reject each edit.
- **Compare and recover earlier work.** Inspect the edit history of a selected
  passage, compare project snapshots, and restore individual files or a project
  state. Owners can also commit and back up their work to GitHub from the built-in
  Git panel.
- **Start, organize, and share projects.** Start from a blank project, upload a
  ZIP, or import a template by ZIP URL. Organize projects with private tags and
  archives, download project ZIPs, and transfer ownership. Invite collaborators
  with read or write access, or send an expiring, revocable read-only link that
  lets guests view source and existing PDFs without signing in.

<a id="docker-deployment"></a>

### Docker deployment

If the host does not have—or you do not want to maintain—Node.js, TeX Live,
Git, and Harper locally, use the heavier
[TexLite-Docker](https://github.com/SWUFE-DB-Group/TexLite-Docker) deployment.
Its published image bundles those runtime dependencies for you.

The Docker image currently does not include Coding Agent CLIs. For agent
integration, we recommend deploying TexLite directly via npm and installing and
configuring the CLIs on the host.

```bash
git clone https://github.com/SWUFE-DB-Group/TexLite-Docker.git
cd texlite-docker
cp deployment.example.json deployment.json
# Edit deployment.json before the first start.
./scripts/compose.sh pull
./scripts/compose.sh up -d
# Open <http://127.0.0.1:3040>
```

See the [TexLite-Docker README](https://github.com/SWUFE-DB-Group/TexLite-Docker#readme)
for its user-facing configuration and operations guide.

## Documentation map

| Need                                                                                                                               | Read                                                       |
| ---------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| Installation, configuration paths, effective defaults, environment overrides, service management, backups, and security boundaries | [Operations guide](OPERATIONS.md)                          |
| Collaboration, source persistence, compilation isolation, history, and design trade-offs                                           | [Design](DESIGN.md)                                        |
| TikZ gallery add-on (beta) | [TikZ gallery add-on](addon.md) |
| Testing an npm package before publication                                                                                          | [NPM testing guide](NPM_TESTING.md)                        |
| Complete configuration starting point                                                                                              | [texlite.config.example.json](texlite.config.example.json) |

## Scope and security

TexLite is a single-host application for a small, trusted team. Accounts are
created by an administrator, and project access is enforced by the server. It
is not a compiler sandbox: LaTeX and an enabled project `latexmkrc` can run
powerful commands on the host, so only give accounts to people you trust.

**Within a local network.** TexLite listens on `127.0.0.1` by default, so only
the host itself can open it. To let colleagues on the same lab or office
network use it, set `server.host` to `0.0.0.0` in `texlite.config.json` (or
set `TEXLITE_HOST=0.0.0.0`) and run `texlite restart`. Others can then open
`http://<host-ip>:3000`; allow the port in the host firewall if needed.
`texlite config` prints the configuration file in use.

**Outside the local network.** Use a tunnel or a private network instead of
forwarding the port on your router. TexLite keeps listening on `127.0.0.1`, and
its own login still protects every project.

<details>
<summary><b>TexLite Share</b>: the simplest HTTPS link for TexLite</summary>

[TexLite Share](https://share.zhongpu.info/) is currently hosted in New York State, USA.
With TexLite running locally on its default port, install and launch the tunnel
client:

```bash
curl -fsSL https://raw.githubusercontent.com/ChenZhongPu/TexLite-Share/main/install-client.sh | bash
~/.local/bin/texlite-tunnel-client --server-url https://share.zhongpu.info
```

For a non-default local port, specify the address explicitly:

```bash
~/.local/bin/texlite-tunnel-client \
  --server-url https://share.zhongpu.info \
  --local-addr 127.0.0.1:8080
```

</details>

Other common options include
[Tailscale Serve](https://tailscale.com/docs/reference/tailscale-cli/serve),
[Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/),
and [frp](https://github.com/fatedier/frp).

## License

TexLite is licensed under the GNU Affero General Public License v3.0; see
[LICENSE](LICENSE). For proprietary modifications or commercial terms that
differ from AGPL-3.0, contact the copyright holder.
