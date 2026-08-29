# TexLite

面向*小型、可信*研究团队的轻量自托管 Overleaf 替代方案。直接使用现有的 LaTeX
发行版，无需沉重的服务栈。

[![CI](https://github.com/SWUFE-DB-Group/TexLite/actions/workflows/ci.yml/badge.svg)](https://github.com/SWUFE-DB-Group/TexLite/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/texlite?logo=npm&label=npm)](https://www.npmjs.com/package/texlite)
[![Docker Hub](https://img.shields.io/docker/v/zhongpu/texlite?logo=docker&label=Docker%20Hub)](https://hub.docker.com/r/zhongpu/texlite)

**文档：** [English](README.md) · [运维指南（英文）](OPERATIONS.md) · [设计文档（英文）](DESIGN.md) · 简体中文（当前文件）

**网站：** [TexLite GitHub Pages](https://swufe-db-group.github.io/TexLite/)

![TexLite 工作区](preview-1.png)
![TexLite 项目视图](preview-2.png)

## 为什么选择 TexLite

- **掌控写作环境。** 直接使用宿主机 TeX 环境，并将源码、历史版本和编译产物保存在
  一个本地数据目录中。
- **无需庞大服务栈即可协作。** 默认部署只有一个 Node.js 进程、SQLite 和本地文件，
  同时提供实时编辑和源码级批注，适合少量可信协作者。

## 与 Overleaf 的实际区别

[Overleaf](https://www.overleaf.com/about/features-overview) 在团队需要其托管产品或更完整生态时
仍然是很好的选择。TexLite 面向的是更窄的自托管场景：

- 共享托管服务在使用高峰期可能排队、变慢或出现编译超时。
- Overleaf 开源 [Community Edition](https://github.com/overleaf/overleaf) 的
  [Docker 部署路径](https://docs.overleaf.com/on-premises/getting-started/what-is-the-overleaf-toolkit) 更复杂，且源码批注等高级功能 [仅限 Server Pro](https://docs.overleaf.com/on-premises/user-and-project-management/roles-and-permissions)。
  *如果不介意一个更庞大的 Docker 镜像，[我们也准备好了](#docker-deployment) :)*

自托管并不保证每份文档都编译得更快，速度仍取决于宿主机和文档本身；它带来的是对容量、
TeX 更新、数据位置与协作工作流的掌控。

若是以个人、本地桌面工作流为主，建议优先考虑
[VS Code + LaTeX Workshop](https://github.com/James-Yu/LaTeX-Workshop) 或
[TeXstudio](https://texstudio.org/)。TexLite 的目标是浏览器中的共同写作，而不是取代个人 IDE。

## 核心写作工作流

- 项目支持文件夹、ZIP 导入/导出、标签、分享、所有权转让、归档和私有的个人引用库。
- 基于 CodeMirror 的编辑器提供 LaTeX/BibTeX 高亮、折叠、补全、可选 Vim 模式、格式化、
  拼写/语法辅助、搜索替换及源码/PDF SyncTeX 跳转。
- 基于 Yjs 的协同源码编辑支持活动会话、源码锚定批注、回复、解决状态，以及让审阅者
  可批注但不能修改源码的权限模型。
- 使用 `latexmk` 和可选择引擎进行编译，提供项目设置、结构化诊断、缓存的成功 PDF、
  可下载产物以及可选的项目级 `latexmkrc`。
- 每个项目拥有历史版本和仅所有者可用的 Git/GitHub 备份；Git 是可选依赖，仅在使用
  集成时才检查。

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

访问 <http://127.0.0.1:3000>。`texlite init` 会创建配置并建立第一个管理员；TexLite
不开放公众注册。

升级与日常管理：

```bash
npm update --global texlite
texlite restart
texlite logs
```

`texlite serve` 会以前台方式运行，适合调试、Docker 或 systemd。`start`、`stop`、
`restart`、`status`、`logs` 使用 npm 包内置的 PM2 运行时；完整命令请执行
`texlite help`。

<a id="docker-deployment"></a>

### Docker 部署

如果宿主机没有，或不希望自行维护 Node.js、TeX Live、Git 和 Harper 等软件，可使用更重的
[TexLite-Docker](https://github.com/SWUFE-DB-Group/TexLite-Docker) 部署。其已发布镜像会
一并提供这些运行时依赖。

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
| 发布前测试 npm 包                                              | [NPM 测试指南（英文）](NPM_TESTING.md)                     |
| 完整配置起点                                                   | [texlite.config.example.json](texlite.config.example.json) |

## 范围与安全

TexLite 是一个面向可信用户的单宿主机应用，并非 LaTeX 编译沙箱：LaTeX 本身以及启用的
项目 `latexmkrc` 都可能执行强大的本机行为。除非已配备适合不可信环境的认证、网络控制和
独立编译沙箱，否则请保持默认的 `127.0.0.1` 监听地址。

## 许可证

TexLite 使用 GNU Affero General Public License v3.0，详见 [LICENSE](LICENSE)。如需
闭源修改，或需要不同于 AGPL-3.0 的商业条款，请联系版权所有者。
