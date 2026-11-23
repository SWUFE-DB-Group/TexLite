<div align="center">

<img src="https://raw.githubusercontent.com/SWUFE-DB-Group/TexLite/main/src/client/public/texlite-icon.svg" width="72" height="72" alt="TexLite 标志" />

# TexLite

面向*小型、可信*研究团队的轻量自托管 Overleaf 替代方案。直接使用现有的 LaTeX
发行版和 Coding Agents，无需沉重的服务栈。

[![CI](https://github.com/SWUFE-DB-Group/TexLite/actions/workflows/ci.yml/badge.svg)](https://github.com/SWUFE-DB-Group/TexLite/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/texlite?logo=npm&label=npm)](https://www.npmjs.com/package/texlite)
[![Docker Hub](https://img.shields.io/docker/v/zhongpu/texlite?logo=docker&label=Docker%20Hub)](https://hub.docker.com/r/zhongpu/texlite)

**文档：** [English](README.md) · [运维指南（英文）](OPERATIONS.md) · [设计文档（英文）](DESIGN.md) · 简体中文（当前文件）

**网站：** [TexLite GitHub Pages](https://swufe-db-group.github.io/TexLite/)

</div>

https://github.com/user-attachments/assets/c2b277ab-7cab-4f2b-8684-358fd9fefe8f

## 为什么选择 TexLite

- **用自己的 TeX 和 Coding Agents。** 编译直接使用宿主机上的宏包和字体。需要 Agent 时，
  CLI 和模型由你选择，改动可在项目里逐项审阅。
- **从初稿到 PDF，都在同一个工作区。** 在浏览器中实时协作，对具体段落提出修改建议；文献、
  draw.io 图表和可编辑的 TikZ 图都能随稿件一起管理。
- **一台机器就能自托管。** 默认部署只需一个 Node.js 服务、SQLite 和本地文件，无需另起数据库
  或缓存服务。
- **稿件随时可以带走。** 源码、历史和编译产物存放在自己的宿主机上。可将标准 LaTeX 项目文件
  下载为 ZIP，也可备份到自己的 GitHub 仓库。

## 快速开始

安装 Node.js 24 或更高版本、`latexmk`，以及至少一个 TeX 引擎，例如 `pdflatex`、
`xelatex` 或 `lualatex`。只有使用可选 Git/GitHub 集成时才需要 Git。

安装后可先执行 `texlite requirements`，检查相关宿主机软件及版本。

```bash
npm install --global texlite
texlite requirements
texlite init
texlite start
texlite status
```

<details>
<summary><code>texlite requirements</code> 输出示例</summary>

以下是我在 Manjaro Linux 上的输出示例；已安装的工具、版本和路径因宿主机而异。

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

访问 <http://127.0.0.1:3000>。`texlite init` 会创建配置并建立第一个管理员；TexLite
不开放公众注册。
如需把 TexLite 挂载到现有域名的 `/texlite` 等子路径，请设置
`server.basePath`，并参考[反向代理说明（英文）](OPERATIONS.md#reverse-proxy-subpath)。

升级与日常管理：

```bash
npm update --global texlite
texlite restart
texlite logs
```

`texlite serve` 会以前台方式运行，适合调试、Docker 或 systemd。`start`、`stop`、
`restart`、`status`、`logs` 使用 npm 包内置的 PM2 运行时；完整命令请执行
`texlite help`。

## 与 Overleaf 的实际区别

[Overleaf](https://www.overleaf.com/about/features-overview) 在团队需要其托管产品或更完整生态时
仍然是很好的选择。TexLite 面向的是更窄的自托管场景：

- 共享托管服务在使用高峰期可能排队、变慢或出现编译超时。
- Overleaf 开源 [Community Edition](https://github.com/overleaf/overleaf) 的
  [Docker 部署路径](https://docs.overleaf.com/on-premises/getting-started/what-is-the-overleaf-toolkit) 更复杂，且源码批注等高级功能 [仅限 Server Pro](https://docs.overleaf.com/on-premises/user-and-project-management/roles-and-permissions)。
  *如果不介意一个更庞大的 Docker 镜像，[我们也准备好了](#docker-deployment) :)*
- TexLite 可在项目终端中直接运行宿主机安装的 Coding Agent CLI（如 Claude Code、Codex、OpenCode，以及 Linux 上的 Antigravity），让 Agent 读取和编辑项目文件，由团队自主选择模型和工作流，而不局限于内建的 AI 聊天界面。

自托管并不保证每份文档都编译得更快，速度仍取决于宿主机和文档本身；它带来的是对容量、
TeX 更新、数据位置与协作工作流的掌控。

若是以个人、本地桌面工作流为主，建议优先考虑
[VS Code + LaTeX Workshop](https://github.com/James-Yu/LaTeX-Workshop) 或
[TeXstudio](https://texstudio.org/)。TexLite 的目标是浏览器中的共同写作，而不是取代个人 IDE。

## LaTeX 写作与研究亮点

- **在项目里用 draw.io 画图。** 用[内嵌的 diagrams.net 编辑器](OPERATIONS.md#drawio-diagrams)
  （支持官方版或自托管版）编辑 `.drawio` 文件。可将当前页或选中内容按边界裁切后导出为 PDF，保存在源文件旁，
  便于正文用 `\includegraphics` 引入。导出使用 TexLite 宿主机上安装的浏览器。
- **从可编辑的 TikZ 图例起步。** 通过可选的 [TikZ 图库扩展](addon.md)（Beta）浏览并导入
  TikZ / pgfplots 模板、示例、图标和数据图。即使不安装图库，也能将独立 TikZ 图编译成
  PDF，不必重新编译正文。
- **使用自己的 Coding Agents。** 管理员启用后，可在项目终端中运行宿主机安装的 Claude Code、
  Codex、OpenCode 或 Antigravity（Linux）。任务可恢复，Agent 的跨文件改动可通过差异和
  源码高亮逐项审阅。参见[外部 Agent 终端](OPERATIONS.md#external-agent-terminals)。
- **编写和浏览 LaTeX / BibTeX。** 支持补全、引文预览、折叠、大纲和可选 Vim 模式；跨文件
  查找替换可先预览。TeX 和 BibTeX 可在浏览器中格式化，也可选用 TeXcount、ChkTeX 和 Harper
  进行字数统计、LaTeX 检查及拼写和语法检查。
- **使用自己的 TeX 环境编译。** 通过 `latexmk` 选择编译引擎，也可启用项目级 `latexmkrc`。
  使用 SyncTeX 在源码和 PDF 间双向跳转，查看结构化编译诊断；编译失败时仍可查看上一次成功的
  PDF。安装 `pdffonts` 后，还能检查编译产物或上传的 PDF 中是否包含 Type 3 或未嵌入的字体。
- **建立个人文献库。** 在项目 `.bib` 文件与私有文献库之间复用条目，按主题文件夹和标签整理。
  可用 BibTeX 或保留笔记的 TexLite JSON 导入、导出整个文件夹。文献笔记和 Markdown 文件的
  实时预览都支持公式与 GitHub 风格提示框。
- **在源码旁协作和审阅。** 实时共同编辑、查看在线协作者，并通过锚定批注与 `@` 提及讨论
  具体段落。协作者可提出替换建议而不直接改动源码，由指定的有写权限审阅者查看差异后接受或拒绝。
- **对比与恢复早期版本。** 查看选区的编辑历史、比较项目快照，或恢复单个文件和整个项目。
  项目所有者也可通过内置 Git 面板提交更改并备份到 GitHub。
- **创建、整理与分享项目。** 从空白项目起步，或上传 ZIP、通过 ZIP 链接导入模板。使用私有标签
  和归档整理项目，下载项目 ZIP 或转移所有权。可邀请有读写或只读权限的协作者，也可分享可过期、
  可撤销的免登录只读链接，让访客查看源码和已有 PDF。

<a id="docker-deployment"></a>

### Docker 部署

如果宿主机没有，或不希望自行维护 Node.js、TeX Live、Git 和 Harper 等软件，可使用更重的
[TexLite-Docker](https://github.com/SWUFE-DB-Group/TexLite-Docker) 部署。其已发布镜像会
一并提供这些运行时依赖。

当前 Docker 镜像未预装 Coding Agent CLI。如需使用此功能，推荐通过 npm 直接部署
TexLite，并在宿主机安装、配置所需 CLI。

```bash
git clone https://github.com/SWUFE-DB-Group/TexLite-Docker.git
cd texlite-docker
cp deployment.example.json deployment.json
# 首次启动前请编辑 deployment.json。
./scripts/compose.sh pull
./scripts/compose.sh up -d
# 访问 <http://127.0.0.1:3040>
```

Docker 版的用户配置和日常运维请参见
[TexLite-Docker README](https://github.com/SWUFE-DB-Group/TexLite-Docker#readme)。

## 文档导航

| 需要了解                                                       | 阅读                                                       |
| -------------------------------------------------------------- | ---------------------------------------------------------- |
| 安装、配置路径、生效默认值、环境变量、服务管理、备份与安全边界 | [运维指南（英文）](OPERATIONS.md)                          |
| 协作、源码持久化、编译隔离、历史版本和设计权衡                 | [设计文档（英文）](DESIGN.md)                              |
| TikZ 图库扩展（Beta） | [TikZ 图库扩展（英文）](addon.md) |
| 发布前测试 npm 包                                              | [NPM 测试指南（英文）](NPM_TESTING.md)                     |
| 完整配置起点                                                   | [texlite.config.example.json](texlite.config.example.json) |

## 范围与安全

TexLite 是面向小型可信团队的单宿主机应用。账号由管理员创建，项目权限由服务端校验。
它不是编译沙箱：LaTeX 本身以及启用的项目 `latexmkrc` 都可以在宿主机上执行强大的命令，
因此只应给可信的人开设账号。

**局域网内使用。** TexLite 默认监听 `127.0.0.1`，只有本机可以访问。若要让同一实验室或
办公网络中的同事使用，在 `texlite.config.json` 中把 `server.host` 设为 `0.0.0.0`
（或设置环境变量 `TEXLITE_HOST=0.0.0.0`），然后运行 `texlite restart`。其他人即可通过
`http://<宿主机 IP>:3000` 访问；如有需要，请在宿主机防火墙中放行该端口。
`texlite config` 会显示当前使用的配置文件。

**局域网外访问。** 请使用隧道或私有网络，不要在路由器上直接做端口转发。此时 TexLite
继续监听 `127.0.0.1`，所有项目仍由 TexLite 自身的登录保护。

<details>
<summary><b>TexLite Share</b>：为 TexLite 提供最简单的 HTTPS 链接</summary>

[TexLite Share](https://share.zhongpu.info/) 目前部署在美国纽约州。
确保 TexLite 已在默认端口启动，然后安装并运行隧道客户端：

```bash
curl -fsSL https://raw.githubusercontent.com/ChenZhongPu/TexLite-Share/main/install-client.sh | bash
~/.local/bin/texlite-tunnel-client --server-url https://share.zhongpu.info
```

如果 TexLite 使用非默认端口，请明确指定本地地址：

```bash
~/.local/bin/texlite-tunnel-client \
  --server-url https://share.zhongpu.info \
  --local-addr 127.0.0.1:8080
```

</details>

其他常见选择包括
[Tailscale Serve](https://tailscale.com/docs/reference/tailscale-cli/serve)、
[Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/)
和 [frp](https://github.com/fatedier/frp)。

## 许可证

TexLite 使用 GNU Affero General Public License v3.0，详见 [LICENSE](LICENSE)。如需
闭源修改，或需要不同于 AGPL-3.0 的商业条款，请联系版权所有者。
