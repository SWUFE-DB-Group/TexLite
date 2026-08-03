# texLite

texLite 是一个轻量、以本机为中心的 LaTeX 网页工作区，用于编写、编译、预览和讨论 LaTeX 文档。它面向同一台服务器上的少量可信用户。texLite 使用服务器已经安装的 LaTeX 环境，不打包 LaTeX 镜像；其余技术栈也尽量保持简单。

**文档：** [English](README.md) · 简体中文（当前文件）

![texLite 预览](preview.png)

## 设计目标

- 使用宿主机已有的 TeX Live/LaTeX，使 LaTeX 可以独立更新。
- 默认不依赖 Redis、MongoDB、Caddy 或 Nginx，适合 localhost 部署。
- 项目源码和编译产物保存在本地文件系统。
- 使用 better-sqlite3 访问 SQLite，保存持久化应用数据。
- 在不引入分布式部署的前提下，为少量并发会话提供实用的协作能力。

## 功能

- 管理员初始化和用户管理；不开放公众注册。
- 用户独立的“创建项目”权限，新用户默认关闭。
- 项目、文件夹、文件和资源管理，支持拖拽上传。
- ZIP 项目导入、安全解压和主文档自动选择。
- 项目列表/网格视图、搜索、按最后修改时间或创建时间排序，以及每个用户私有的 Finder 风格彩色标签。
- 项目重命名、源码 ZIP 下载、删除，以及所有者和修改信息展示。
- 中文和英文界面，自动识别浏览器语言，并可手动切换。
- 基于 CodeMirror 的 LaTeX 编辑器：语法高亮、折叠、补全、大纲跳转、查找/替换和外观设置。
- 基于 Yjs CRDT 的协作编辑，显示活动会话头像、远程光标；单个项目建议不超过约 10 个并发会话。
- 源码范围批注、回复、resolved 状态、用户/时间信息，以及源码变化后的批注锚点重映射。
- 使用宿主机 latexmk 编译，支持 pdflatex、xelatex、lualatex、项目级 latexmkrc、项目编译串行化、源码快照、最新 PDF 保留、SyncTeX 跳转、日志/警告/错误和 .bbl 等编译产物下载。
- 项目共享支持只读和读写权限；只读用户仍然可以添加和回复批注。
- 项目所有者专用的本地 Git 历史和 GitHub 备份：commit、push、diff、checkout 和恢复已跟踪修改。
- 可选 PM2 进程管理，支持异常重启、状态查看和日志管理。

## 技术结构

| 部分 | 实现 |
| --- | --- |
| 浏览器界面 | React、Vite、CodeMirror、PDF.js |
| API 和静态服务 | Fastify、WebSocket |
| 协作 | Yjs、y-websocket、y-codemirror.next |
| 数据库 | better-sqlite3 访问 SQLite |
| 文件 | 配置数据目录下的本地项目目录 |
| 编译 | 宿主机 latexmk 和配置的 LaTeX 引擎 |
| Git 备份 | 宿主机 git 和 GitHub REST API |

texLite 按单个 Node.js 进程设计。不要让多个应用实例同时使用同一个 SQLite 数据库或项目目录；协作状态、编译队列和文件系统都是单进程资源。

## 环境要求

- Node.js 24 或更高版本
- npm
- git
- latexmk
- 至少一个配置好的引擎：pdflatex、xelatex 或 lualatex

初始化前可以检查：

~~~bash
node --version
npm --version
git --version
latexmk --version
xelatex --version
~~~

npm run init 会检查 git、latexmk 以及 latex.allowedEngines 中列出的每个引擎。如果命令不可用，初始化和启动都会停止并给出错误。

## 快速开始

~~~bash
npm ci
cp texlite.config.example.json texlite.config.json
# 按需要编辑 texlite.config.json
npm run init
npm run build
npm start
~~~

打开 http://127.0.0.1:3000。默认只监听 localhost，也不开放公众注册。初始化命令会要求创建第一个管理员；没有有效管理员时服务不会启动。

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

默认从当前工作目录读取 texlite.config.json。可以通过 TEXLITE_CONFIG 指定其他配置文件；配置中的相对路径以配置文件所在目录为基准。

示例配置：

~~~json
{
  "siteName": "texLite",
  "adminEmail": "admin@example.com",
  "sessionDays": 14,
  "server": { "host": "127.0.0.1", "port": 3000 },
  "storage": { "dataDir": ".texlite" },
  "uploads": { "maxFileSizeMB": 50 },
  "git": {
    "binary": "git",
    "operationTimeoutSeconds": 30,
    "githubApiBaseUrl": "https://api.github.com"
  },
  "latex": {
    "latexmk": "latexmk",
    "defaultEngine": "xelatex",
    "allowedEngines": ["pdflatex", "xelatex", "lualatex"],
    "extraArgs": [],
    "allowProjectLatexmkrc": true,
    "compileTimeoutSeconds": 60,
    "maxCompileJobs": 2
  }
}
~~~

重要配置：

- server.host、server.port：监听地址和端口。除非已经准备好安全部署，否则保持 127.0.0.1。
- storage.dataDir：SQLite 数据库、项目源码、编译输出和 Git token 加密密钥的位置。
- uploads.maxFileSizeMB：项目上传、ZIP 条目、项目文件和资源的最大大小，默认 50 MB。
- latex.defaultEngine、latex.allowedEngines、latex.extraArgs：界面中可选择的编译方式。
- latex.compileTimeoutSeconds：单次编译超时时间。
- latex.maxCompileJobs：全局 LaTeX 进程并发上限。同一个项目始终串行编译；多个源码版本排队时只保留最新请求。
- latex.allowProjectLatexmkrc：是否允许项目提供多行 latexmkrc。该文件是可执行的 Perl 配置，只建议对可信用户开启。

环境变量会覆盖配置文件中的对应值：

~~~text
TEXLITE_CONFIG
TEXLITE_SITE_NAME             TEXLITE_ADMIN_EMAIL
TEXLITE_HOST                  TEXLITE_PORT
TEXLITE_DATA_DIR              TEXLITE_CLIENT_DIR
TEXLITE_SESSION_DAYS          TEXLITE_MAX_UPLOAD_SIZE_MB
TEXLITE_LATEXMK               TEXLITE_DEFAULT_ENGINE
TEXLITE_COMPILE_TIMEOUT       TEXLITE_MAX_COMPILE_JOBS
TEXLITE_GIT                   TEXLITE_GIT_TIMEOUT
TEXLITE_GITHUB_API_URL
~~~

texLite 不执行 tlmgr，也不会自动安装缺失宏包。宿主机更新 TeX Live 后，下一次编译会直接使用新环境。

## 使用 PM2 部署

对于单机部署，PM2 很合适：它可以保持一个 server 进程运行、崩溃后自动重启，并提供状态和日志。PM2 是可选的；临时 localhost 使用 npm start 就足够。

仓库提供了 ecosystem.config.cjs，明确使用一个 fork 实例（instances: 1）。不支持 cluster 模式，因为协作状态、编译队列、SQLite 连接和项目文件系统都属于单个进程。

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

编辑器使用 Yjs CRDT 支持并发编辑。项目顶部显示活动浏览器会话，远程光标使用不同颜色；单个项目的目标规模约为 10 个活动会话。

编译与编辑相互隔离：

1. 服务端捕获不可变源码快照。
2. 在独立运行目录中编译快照。
3. 只从该运行目录收集 PDF、日志、SyncTeX 和其他产物。
4. 编译成功后，以原子方式发布最新 PDF 和 SyncTeX。

这样不同用户不会共享 .aux、.log、.bbl 或 SyncTeX 文件。编译时仍可查看旧 PDF；BibTeX 文档所需的多轮编译由 latexmk 自动处理。

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
~~~

请同时备份 texlite.db、git-token.key 和 projects/。恢复已保存的 GitHub token 必须保留加密密钥。在线备份 SQLite 文件时也要包含 WAL 文件，或者使用 SQLite 感知的备份方式。

删除用户会删除其成员关系，但既有批注仍会保留，并显示为“已删除用户”。根据管理员选择，该用户拥有的项目可以转移给当前管理员，也可以连同文件一起删除。最后一个有效管理员不能被删除、禁用或降级。

## 安全边界

texLite 面向 localhost 上的可信用户。默认编译关闭 shell escape、不通过 shell 拼接命令，并限制编译超时和并发数量。但 LaTeX 本身以及项目 latexmkrc 不能视为安全沙箱。如果将来需要对不可信网络开放或允许公众注册，应增加独立的编译沙箱和合适的认证/反向代理层。

## 许可证和状态说明

texLite 使用 GNU Affero General Public License v3.0，详见 [LICENSE](LICENSE)。如果需要闭源修改，或需要不同于 AGPL-3.0 的商业条款，请联系版权所有者获取单独的商业许可证。

这是一个早期的单机应用，不是 Overleaf 的直接替代品。请根据实际运行环境审核并调整部署、备份和安全配置。
