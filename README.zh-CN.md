# texLite

texLite 是一个轻量、以本机为中心的 LaTeX 网页工作区，用于编写、编译、预览和讨论 LaTeX 文档。它面向同一台服务器上的少量可信用户。texLite 使用服务器已经安装的 LaTeX 环境，不打包 LaTeX 镜像；其余技术栈也尽量保持简单。

**文档：** [English](README.md) · [Design（英文）](DESIGN.md) · 简体中文（当前文件）

[![CI](https://github.com/SWUFE-DB-Group/TexLite/actions/workflows/ci.yml/badge.svg)](https://github.com/SWUFE-DB-Group/TexLite/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/texlite?logo=npm&label=npm)](https://www.npmjs.com/package/texlite)

![texLite 预览](preview.png)

设计目标、技术架构、协作与编译模型、历史与诊断、GitHub 备份以及数据管理
请参阅英文文档 [DESIGN.md](DESIGN.md)。

## 环境要求

- Node.js 24 或更高版本
- npm
- git（可选；仅项目所有者使用 Git/GitHub 集成时需要）
- latexmk
- 至少一个配置好的引擎：pdflatex、xelatex 或 lualatex

初始化前可以检查：

~~~bash
node --version
npm --version
latexmk --version
xelatex --version
# 可选，仅在需要 Git/GitHub 集成时检查：
git --version
~~~

npm run init 和应用启动会检查 latexmk 以及 latex.allowedEngines 中列出的每个引擎。Git 不参与这项核心检查，因此未安装 Git 的宿主机仍可正常初始化并运行 TexLite。项目所有者打开 Git 面板或执行 Git/GitHub 操作时，TexLite 才会按需检查 git.binary；如果 Git 不可用，界面会给出可操作的错误提示。

格式化功能同样是可选的，并直接在浏览器中运行。TexLite 内置 [npm 包 `tex-fmt`](https://www.npmjs.com/package/tex-fmt)（WASM 版本）格式化 `.tex`、`.cls` 和 `.sty`，并在浏览器中使用 `bibtex-tidy` 格式化 `.bib`。编辑器设置中可以为当前用户和项目填写 `tex-fmt` 的 TOML 参数；不需要在宿主机安装格式化命令，也不需要配置 PATH。

## 快速开始

### 全局 npm 安装

发布后的 npm 包提供 `texlite` 命令，配置和项目数据不会写入全局 npm
安装目录：

~~~bash
npm install --global texlite
texlite init
texlite start
texlite status
~~~

打开 http://127.0.0.1:3000。可以从任意工作目录管理服务：

~~~bash
texlite stop
texlite restart
texlite logs
~~~

默认配置文件为
`$XDG_CONFIG_HOME/texlite/texlite.config.json`；如果没有设置
`XDG_CONFIG_HOME`，则为 `~/.config/texlite/texlite.config.json`。默认数据目录为
`$XDG_DATA_HOME/texlite`；如果没有设置 `XDG_DATA_HOME`，则为
`~/.local/share/texlite`。可以使用 `--config PATH` 或 `TEXLITE_CONFIG`
指定其他配置文件。

`texlite serve` 以前台方式运行，适合 Docker、systemd 和调试。
`start`、`status`、`stop`、`restart` 和 `logs` 使用 npm 包内置的 PM2。后台启动会
等待 HTTP 健康检查真正就绪；如果 PM2 进程存在但没有实际提供 TexLite 服务，
`status` 会显示 `unhealthy`。`restart` 会重新创建 PM2 条目，确保 npm 升级后使用
当前版本的包路径和环境变量。启动失败的重试次数是有限的，不会进入无限重启循环。

升级时可以执行：

~~~bash
npm update --global texlite
texlite restart
~~~

卸载 npm 包不会删除配置和项目数据：

~~~bash
npm uninstall --global texlite
~~~

### 从仓库/源码运行

~~~bash
npm ci
cp texlite.config.example.json texlite.config.json
export TEXLITE_CONFIG="$PWD/texlite.config.json"
# 按需要编辑 texlite.config.json
npm run init
npm run build
npm start
~~~

默认只监听 localhost，也不开放公众注册。初始化命令会要求创建第一个
管理员；没有有效管理员时服务不会启动。

如果需要非交互初始化，可以只为该命令设置以下环境变量：

~~~bash
TEXLITE_INIT_USERNAME=admin \
TEXLITE_INIT_DISPLAY_NAME=Administrator \
TEXLITE_INIT_PASSWORD='至少 8 个字符的密码' \
npm run init
~~~

在共享机器上不要让密码进入 shell 历史记录。

## 开发和验证

在两个终端分别运行 API/server 和 Vite：

~~~bash
npm run dev       # API/server：http://127.0.0.1:3000
npm run dev:web   # Vite 界面：http://127.0.0.1:5173
~~~

Vite 会把 /api 请求代理到后端。生产式运行前可以执行：

~~~bash
npm run typecheck
npm test
npm run build
npm start
~~~

## 配置

配置文件路径优先级如下：

1. `texlite --config PATH`；
2. `TEXLITE_CONFIG`；
3. `$XDG_CONFIG_HOME/texlite/texlite.config.json`；
4. `~/.config/texlite/texlite.config.json`。

配置中的相对路径以配置文件所在目录为基准。`storage.dataDir` 默认使用
`$XDG_DATA_HOME/texlite`；未设置时使用 `~/.local/share/texlite`。可以在配置中
设置 `storage.dataDir`，或使用 `TEXLITE_DATA_DIR` 指定其他数据目录。生产环境
的前端资源默认定位到 npm 包内部的 `dist/client`，开发或自定义部署可以用
`TEXLITE_CLIENT_DIR` 覆盖。

示例配置：

~~~json
{
  "siteName": "TexLite",
  "adminEmail": "admin@example.com",
  "sessionDays": 14,
  "server": { "host": "127.0.0.1", "port": 3000 },
  "storage": { "dataDir": ".texlite" },
  "uploads": { "maxFileSizeMB": 50 },
  "history": { "maxVersions": 200, "maxStorageMB": 512 },
  "git": {
    "binary": "git",
    "operationTimeoutSeconds": 120,
    "githubApiBaseUrl": "https://api.github.com"
  },
  "latex": {
    "latexmk": "latexmk",
    "defaultEngine": "xelatex",
    "allowedEngines": ["pdflatex", "xelatex", "lualatex"],
    "extraArgs": [],
    "allowProjectLatexmkrc": true,
    "compileTimeoutSeconds": 600,
    "maxCompileJobs": 10
  }
}
~~~

仓库中的示例为了方便源码开发，显式使用 `.texlite`。`texlite init` 自动生成
的 npm 配置则使用前面所述的 XDG 数据目录默认值。

重要配置：

- server.host、server.port：监听地址和端口。除非已经准备好安全部署，否则保持 127.0.0.1。
- storage.dataDir：SQLite 数据库、项目源码、编译输出和 Git token 加密密钥的位置。
- uploads.maxFileSizeMB：项目上传、ZIP 条目、项目文件和资源的最大大小，默认 50 MB。
- history.maxVersions：每个项目最多保留的普通、未标记版本数；初始版本和已标记版本受保护。
- history.maxStorageMB：每个项目去重历史对象的软上限。超过后优先删除最旧的普通版本；受保护版本和当前内部基线可使实际用量超过上限。
- latex.defaultEngine、latex.allowedEngines、latex.extraArgs：界面中可选择的编译方式。
- latex.compileTimeoutSeconds：单次编译超时时间。
- latex.maxCompileJobs：全局 LaTeX 进程并发上限。同一项目的同一主文档串行编译；多个源码版本排队时只保留最新请求。不同主文档使用独立工作区，可在该全局上限内并行编译。
- latex.allowProjectLatexmkrc：是否允许项目提供多行 latexmkrc。该文件是可执行的 Perl 配置，只建议对可信用户开启。

### 生效默认值和启动校验

如果没有设置某项，texLite 使用以下内置默认值（自动生成的示例配置
可以显式写出例如管理员邮箱这样的值）：

| 配置项 | 生效默认值 |
| --- | --- |
| `siteName` | `TexLite` |
| `adminEmail` | 空 |
| `server.host` / `server.port` | `127.0.0.1` / `3000` |
| `storage.dataDir` | `$XDG_DATA_HOME/texlite` 或 `~/.local/share/texlite` |
| `clientDir` | npm 包内部的 `dist/client` |
| `sessionDays` | `14` 天 |
| `uploads.maxFileSizeMB` | `50` MB |
| `history.maxVersions` | 每项目 `200` 个普通版本 |
| `history.maxStorageMB` | 每项目 `512` MB（软上限） |
| `latex.latexmk` | `latexmk` |
| `latex.defaultEngine` | `xelatex` |
| `latex.allowedEngines` | `pdflatex`、`xelatex`、`lualatex` |
| `latex.extraArgs` | `[]` |
| `latex.allowProjectLatexmkrc` | `true` |
| `latex.compileTimeoutSeconds` | `600` 秒 |
| `latex.maxCompileJobs` | `10` |
| `git.binary` / `git.operationTimeoutSeconds` | `git` / `120` 秒 |
| `git.githubApiBaseUrl` | `https://api.github.com` |

配置会在环境检查、打开数据库和启动 HTTP 监听之前完成校验。显式设置的
非法值不会静默回退到默认值。允许范围为：端口 `1–65535`，会话有效期
`1–3650` 天，单文件大小 `1–2048` MB，历史版本数 `10–5000`，历史存储
`16–102400` MB，编译超时 `1–3600` 秒，编译并发数 `1–32`，Git 超时
`1–3600` 秒。引擎名称必须受支持且不能重复；允许引擎
列表必须包含选中的默认引擎。数据目录和项目目录不能指向文件，数据目录
不能是文件系统根目录；数据目录不存在时，其父目录必须已经存在且可写。
GitHub API 地址必须是 `http://` 或 `https://` URL。

JSON 类型错误、必填字符串为空、整数格式错误（包括带小数或非数字的环境
变量）、不支持的引擎、非法 URL 和不可用路径都会停止启动，并显示配置项、
期望格式及修复提示。`npm run init` 也执行同样的校验，因此可以在创建第一个
管理员前先发现配置问题。

环境变量会覆盖配置文件中的对应值：

~~~text
TEXLITE_CONFIG
XDG_CONFIG_HOME                 XDG_DATA_HOME
TEXLITE_SITE_NAME             TEXLITE_ADMIN_EMAIL
TEXLITE_HOST                  TEXLITE_PORT
TEXLITE_DATA_DIR              TEXLITE_CLIENT_DIR
TEXLITE_SESSION_DAYS          TEXLITE_MAX_UPLOAD_SIZE_MB
TEXLITE_HISTORY_MAX_VERSIONS TEXLITE_HISTORY_MAX_STORAGE_MB
TEXLITE_LATEXMK               TEXLITE_DEFAULT_ENGINE
TEXLITE_COMPILE_TIMEOUT       TEXLITE_MAX_COMPILE_JOBS
TEXLITE_GIT                   TEXLITE_GIT_TIMEOUT
TEXLITE_GITHUB_API_URL
~~~

texLite 不执行 tlmgr，也不会自动安装缺失宏包。宿主机更新 TeX Live 后，下一次编译会直接使用新环境。

## 服务管理

通过全局 npm 安装时，生命周期命令使用包内置的 PM2，不需要额外全局安装：

~~~bash
texlite start
texlite status
texlite logs
texlite restart
texlite stop
~~~

`texlite status` 默认使用带颜色的 systemctl 风格终端视图；脚本或监控集成可使用
`texlite status --json` 获取结构化输出。

`texlite doctor` 会校验配置、路径、LaTeX 和管理员；使用 `--git` 可以额外
检查可选的 Git 集成。`texlite config` 显示生效的配置和路径。
`texlite serve` 以前台方式运行，不启动 PM2。

从仓库运行时仍可以使用 `ecosystem.config.cjs` 和 npm PM2 快捷命令。
该配置明确使用一个 fork 实例（`instances: 1`）。不支持 cluster 模式，因为
协作状态、编译队列、SQLite 连接和项目文件系统都属于单个进程。

在服务器上安装一次 PM2，构建后启动：

~~~bash
npm install --global pm2
npm run build
pm2 start ecosystem.config.cjs
pm2 status
pm2 logs texlite
~~~

对应的 npm 快捷命令是 npm run pm2:start、npm run pm2:restart、npm run pm2:stop、npm run pm2:delete、npm run pm2:logs 和 npm run pm2:save。

发布新代码后：

~~~bash
npm run build
pm2 restart texlite --update-env
~~~

如果需要开机自动恢复，执行 pm2 startup 输出的命令，然后保存进程列表：

~~~bash
pm2 save
~~~

常用命令还有 pm2 stop texlite、pm2 restart texlite、pm2 delete texlite 和 pm2 monit。

## 协作和编译模型

编辑器使用 Yjs CRDT 支持并发编辑。项目顶部显示活动浏览器会话，远程光标使用不同颜色；单个项目的目标规模约为 10 个活动会话。只有服务端确认源码已经持久化后，保存状态才会显示“已保存”。尚未同步的更新也会保留在浏览器 IndexedDB 中，并在临时断线后恢复；恢复历史版本或 Git checkout 会轮换协作 epoch，避免旧的本地草稿覆盖刚恢复的源码树。删除或移动文件后，其他会话仍绑定旧编辑器时产生的迟到修改会被拒绝。

项目设置中保存的主文档是默认主文档。用户打开另一个包含 `\documentclass` 的 `.tex` 文件后，该文件仅在当前浏览器会话中成为编译主文档；打开被引用的普通片段不会切换主文档。系统只编译当前主文档。编译状态、日志、保留的 PDF、编译产物、大纲和 SyncTeX 均按主文档隔离，因此查看不同主文档的协作者不会看到彼此的编译提示，也不会覆盖彼此的 PDF。

编译与编辑相互隔离：

1. 服务端捕获不可变源码快照。
2. 将有变化的文件增量同步到按项目、主文档和编译设置区分的持久编译工作区。
3. latexmk 复用依赖数据库和辅助文件；同一主文档的任务仍然串行执行。
4. 将 PDF、日志、SyncTeX 和其他产物复制到不可变的运行快照。
5. 编译成功后，以原子方式发布最新产物快照。

同一主文档的可变缓存不会被并发使用，不同主文档使用独立缓存，已经发布的产物也不会被原地修改。编译时仍可查看旧 PDF；BibTeX 文档所需的多轮编译由 latexmk 自动处理，参考文献输入未变化时不会重复运行 BibTeX。编译响应提供 Server-Timing 响应头，可以分别查看快照、缓存同步、latexmk、产物复制和请求总耗时。TexLite 不保留可浏览的编译历史：仅按主文档保存最近一次尝试的状态，以及仍用于 PDF 预览的最近成功结果（如果需要）。更早的数据库记录和不可变产物包会自动清理。

## 历史、导航和诊断

自动历史会记录源码/文件操作、编译器设置、Git 操作、恢复操作和服务端确认的协作保存。协作保存采用固定的两分钟版本窗口，因此连续编辑仍会形成有用的恢复点，同时不会按每次按键记录。TexLite 默认保留最近 200 个普通版本，以及全部已标记版本和初始版本。文件内容以完整的 SHA-256 对象保存：未变化内容会复用，变化文件则产生一个新的完整对象。默认每个项目设置 512 MB 软上限，超过后优先删除最旧的普通版本；受保护版本和当前内部基线可能使实际用量超过上限。项目所有者可以查看历史存储用量、删除单个版本或清空全部历史，而不会改变当前项目文件。不再被引用的对象会被清理。历史功能适合修正写作误操作，但不能替代对完整数据目录的备份。

Ctrl/Cmd+P 用于快速打开项目文件，Ctrl/Cmd+Shift+F 用于全项目纯文本搜索和替换。全项目替换按一次操作暂存，并自动创建历史版本。大纲从主文档开始跟随 `\\input`、`\\include` 和 `\\subfile`。结构化警告/错误会解析项目内文件名，点击后直接跳到源码行；完整 latexmk 原始日志仍然保留。

管理员可在项目列表打开“系统状态”。指标只包含数量和耗时，绝不包含源码、密码、Git token 或批注；也可通过需要管理员登录的 `GET /api/health/metrics` 获取。

## GitHub 备份

Git 面板仅对项目所有者显示。GitHub personal access token 按项目配置并加密保存到 SQLite。本地仓库位于项目源码目录；每次命令临时使用以下身份：

~~~text
user.name  = 项目所有者 username
user.email = <username>@texlite.com
~~~

对于 fine-grained token，在可信用户部署中建议授予仓库 Administration 和 Contents 的读写权限，并选择 All repositories。配置 token 时远程仓库可能还不存在，之后也可能创建新仓库。token 不会出现在远程 URL 或命令行参数中。

普通 checkout 遵循 Git 的默认保留行为，冲突时拒绝操作。只有在确认框中明确选择强制选项，才会丢弃已跟踪、未跟踪和 ignored 的工作区文件。checkout 历史版本后，需要先返回默认分支才能提交或 push。

## 数据、备份和删除

默认数据目录：

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
            └── .texlite/   # 编译缓存/运行和历史对象
~~~

请同时备份 texlite.db、git-token.key 和 projects/。恢复已保存的 GitHub token 必须保留加密密钥。在线备份 SQLite 文件时也要包含 WAL 文件，或者使用 SQLite 感知的备份方式。

删除用户会删除其成员关系，但既有批注仍会保留，并显示为“已删除用户”。根据管理员选择，该用户拥有的项目可以转移给当前管理员，也可以连同文件一起删除。最后一个有效管理员不能被删除、禁用或降级。

## 安全边界

texLite 面向 localhost 上的可信用户。默认编译关闭 shell escape、不通过 shell 拼接命令，并限制编译超时和并发数量。但 LaTeX 本身以及项目 latexmkrc 不能视为安全沙箱。如果将来需要对不可信网络开放或允许公众注册，应增加独立的编译沙箱和合适的认证/反向代理层。

## 许可证和状态说明

texLite 使用 GNU Affero General Public License v3.0，详见 [LICENSE](LICENSE)。如果需要闭源修改，或需要不同于 AGPL-3.0 的商业条款，请联系版权所有者获取单独的商业许可证。

这是一个早期的单机应用，不是 Overleaf 的直接替代品。请根据实际运行环境审核并调整部署、备份和安全配置。
