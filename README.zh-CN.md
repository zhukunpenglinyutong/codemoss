<div align="center">

# CC GUI 客户端

<img width="120" alt="ccgui 图标" src="./icon.png" />

[English](./README.md) · **简体中文**

<a href="https://trendshift.io/repositories/25546" target="_blank"><img src="https://trendshift.io/api/badge/repositories/25546" alt="zhukunpenglinyutong%2Fdesktop-cc-gui | Trendshift" style="width: 250px; height: 55px;" width="250" height="55"/></a>

![][github-contributors-shield] ![][github-forks-shield] ![][github-stars-shield] ![][github-issues-shield]

</div>

**ccgui** 是一个开源的 AI 编程桌面客户端。简单说：它把 Claude Code、Codex CLI、OpenCode 这些命令行 AI 编程工具，装进了一个好看好用的图形界面里。

你不用再盯着黑乎乎的终端敲命令——打开 ccgui，选好项目，像聊天一样让 AI 帮你写代码、改 Bug、提交 Git。AI 改了哪些文件、跑了什么命令、花了多少钱，全都看得清清楚楚。

应用基于 **Tauri 2 + React 19 + TypeScript + Rust** 开发，所有数据都存在你自己的电脑上，支持 macOS / Windows / Linux。

> 本项目最初源自 [CodexMonitor](https://github.com/Dimillian/CodexMonitor)，现在已经成长为一个功能完整的多引擎 AI 编程客户端。

<img src="./docs/banner.png" alt="ccgui 界面截图" width="800" />

---

## ccgui 能干什么

### 一个客户端，装下多个 AI 引擎

- 同时支持 **Claude Code**、**Codex CLI**、**OpenCode**，随时切换，同一个项目里可以混着用。
- 不挑渠道：官方 API、国内中转站、聚合平台、第三方供应商都能配，每个引擎可以保存多套 Provider 配置。
- 会话不丢：关掉应用再打开，历史对话还在；会话断了可以接着聊，还能看每个会话用了多少上下文。

### 聊天框是为写代码设计的

- 输入框支持 `@` 引用项目文件、斜杠命令、粘贴图片、上传附件。
- AI 干活全程透明：改了哪个文件、跑了什么命令、读了什么内容，都有卡片实时展示。
- 说错话了？消息支持**回退**（rewind）和**分叉**（fork），随时回到之前的状态重新来。
- 懒得打字可以用**语音输入**；提示词写不好，内置的**提示词增强**帮你润色。
- 排队提问：AI 正在干活时，你可以把下一个问题先排上队。

### 不只是聊天，是一整套开发面板

- **文件树**：浏览、预览、复制、粘贴、重命名，直接拖文件进对话。
- **内置终端**：完整的终端体验，不用切出去开别的窗口。
- **Git 面板**：暂存、提交（AI 帮你写提交信息）、分支、worktree、看 diff、翻提交历史。
- **全局搜索**：文件、会话、历史消息、技能、命令，一个搜索框全搞定。

### 任务多了也不乱

- **Plan 面板**：AI 的执行计划一步步列出来，做到哪了一眼看清。
- **Kanban 看板**：任务卡片拖来拖去，管理整个迭代。
- **任务中心**：每次 AI 执行都有记录，失败了能重试，随时翻执行日志。
- **意图画布**：在画布上拖节点做规划，想清楚再动手。

### 项目智能（ccgui 比较独特的部分）

- **项目知识地图**：AI 扫描你的项目，生成可交互的结构图谱——文件关系、API 接口、模块依赖一目了然，还支持增量更新。
- **项目记忆**：把项目的关键约定、踩过的坑存成长期记忆，AI 下次打开还记得。
- **上下文账本**：AI 这次回答用了哪些上下文、各占多少，明明白白。
- **用量统计**：token 消耗、费用、缓存命中率全有报表，还能设每月预算上限。

### 扩展和个性化

- **MCP 市场、Skills 市场、插件市场**：点一下就能装，给 AI 加新本事。
- **浏览器 Agent**：让 AI 能读网页内容，查文档不用复制粘贴。
- **主题随便换**：15+ 内置主题（VS Code 风格）、自定义配色、窗口透明度、字体字号都能调。
- **中英双语界面**，快捷键全部可自定义。
- macOS / Windows / Linux 全平台，支持应用内**自动更新**。

每个版本的详细更新内容，见 [CHANGELOG.md](./CHANGELOG.md)。

---

## 下载安装

直接去 [Releases 页面](https://github.com/zhukunpenglinyutong/desktop-cc-gui/releases) 下载对应平台的安装包：

| 平台 | 安装包 |
| --- | --- |
| macOS（M 系列芯片） | `aarch64.dmg` |
| macOS（Intel 芯片） | `x64.dmg` |
| Windows | `.exe` / `.msi` 安装包 |
| Linux | `.AppImage` |

装好之后，在设置里配置好你的 AI 引擎（比如 Claude Code 的 API Key 或本地 CLI），添加一个项目文件夹，就可以开始用了。

---

## 把项目跑起来（启动教程）

想自己编译、或者参与开发？跟着下面三步走。

### 第一步：准备环境

需要装这三样东西：

| 工具 | 版本要求 | 用来干嘛 |
| --- | --- | --- |
| [Node.js](https://nodejs.org/) | 20 或更新 | 跑前端 |
| [Rust](https://rustup.rs/) | stable（用 rustup 装） | 编译后端 |
| [CMake](https://cmake.org/download/) | 较新版本即可 | 编译部分依赖 |

不同系统还需要一点额外准备（这是 Tauri 框架的要求，详见 [Tauri 官方环境文档](https://v2.tauri.app/start/prerequisites/)）：

- **macOS**：装 Xcode 命令行工具：`xcode-select --install`；CMake 用 `brew install cmake`。
- **Windows**：装 Microsoft C++ Build Tools 和 WebView2（Win 11 自带 WebView2）。
- **Linux**：装 `webkit2gtk` 等系统库，照着 Tauri 官方文档抄命令就行。

### 第二步：装依赖

```bash
git clone https://github.com/zhukunpenglinyutong/desktop-cc-gui.git
cd desktop-cc-gui
npm install
```

注意：**必须用 npm**。用 pnpm 或 yarn 会被脚本拦下来（为了保证所有人的依赖版本一致）。

### 第三步：启动

```bash
# macOS / Linux
npm run tauri:dev

# Windows
npm run tauri:dev:win
```

几个小提示：

- **第一次启动要编译整个 Rust 后端，可能等上几分钟**，去倒杯水。之后是增量编译，很快。
- 启动前会自动做环境自检（doctor）。报错了就单独跑 `npm run doctor`，它会告诉你缺什么、怎么装。
- 前端跑在 `1420` 端口。端口被占了不用管，脚本会自动清理。
- 只想改界面、不碰 Rust？跑 `npm run dev` 可以在浏览器里调前端（但调不了和后端相关的功能）。

### 打安装包

```bash
npm run build:mac-arm64      # macOS Apple Silicon
npm run build:mac-x64        # macOS Intel
npm run build:mac-universal  # macOS 通用包
npm run build:win-x64        # Windows x64
npm run build:win-portable   # Windows x64 免安装 ZIP（需在 Windows 上运行）
npm run build:linux-x64      # Linux x64
npm run build:linux-arm64    # Linux arm64
```

Windows 便携包会输出到 `release-local/ccgui_<version>_windows_x64_portable.zip`。它不需安装，但依赖系统已有 WebView2 Runtime，配置和会话仍保存在 Windows AppData。没有 Windows 开发机时，可在 GitHub Actions 中运行 **Windows Portable** workflow 并下载 artifact；该流程不需发布密钥，也不会创建正式 Release。

---

## 怎么改代码（开发教程）

### 技术栈一览

| 部分 | 用的什么 |
| --- | --- |
| 界面 | React 19 + TypeScript + Tailwind CSS 4 |
| 构建 | Vite 7 |
| 桌面框架 | Tauri 2（后端是 Rust） |
| 测试 | Vitest（前端）+ cargo test（Rust） |

### 目录结构

```text
desktop-cc-gui/
├── src/                    # 前端代码
│   ├── features/           # ★ 功能模块（50+ 个），按功能分目录，开发主战场
│   │   ├── composer/       #    输入框
│   │   ├── messages/       #    消息流
│   │   ├── git/            #    Git 面板
│   │   ├── project-map/    #    项目知识地图
│   │   └── ...             #    每个目录就是一个独立功能
│   ├── components/         # 跨功能共享的通用 UI 组件
│   ├── services/           # 业务逻辑；其中 tauri.ts 是前端调用 Rust 的桥梁
│   ├── i18n/               # 中英文界面文案
│   ├── styles/             # 全局样式
│   └── lib/ utils/         # 工具函数
├── src-tauri/              # Rust 后端
│   └── src/                # 按模块分目录：engine / codex / git / terminal / files ...
├── scripts/                # 构建、检查、诊断脚本
└── docs/                   # 架构文档、性能基线
```

### 改一个功能的套路

1. **只改界面**：找到 `src/features/` 下对应的模块改就行。新组件直接放在该模块自己的目录里。
2. **需要后端配合**：在 `src-tauri/src/` 对应模块里加一个 `#[tauri::command]`，再到 `src/services/tauri.ts` 里加一个调用封装，前端就能用了。
3. **改了界面文字**：去 `src/i18n/` 里把中文和英文**都**加上，界面文字不允许硬编码。

### 常用命令

| 命令 | 干嘛的 |
| --- | --- |
| `npm run tauri:dev` | 启动完整应用（开发模式） |
| `npm run dev` | 只启动前端（浏览器调试） |
| `npm run lint` | 代码风格检查 |
| `npm run typecheck` | TypeScript 类型检查 |
| `npm run test` | 跑单元测试 |
| `npm run test:watch` | 监听模式跑测试（边改边测） |
| `npm run test:integration` | 跑包含重型集成测试的完整测试 |

### 测试怎么写

- 测试文件和源码放一起，命名 `xxx.test.ts` / `xxx.test.tsx`。
- 框架是 [Vitest](https://vitest.dev/)，写法和 Jest 基本一样。
- 重型集成测试命名为 `xxx.integration.test.tsx`，默认不跑，`npm run test:integration` 才跑。
- Rust 端测试照常写在模块里，`cargo test` 跑。

---

## 开发规范

规矩不多，但都有原因，提交前过一遍：

1. **提交前跑三件套**：`npm run lint && npm run typecheck && npm run test`，全绿再提。CI 也会跑，本地先过省得来回折腾。
2. **界面文字必须走 i18n**：所有用户能看到的文字都从 `src/i18n/` 取，中英文都要加，不许硬编码。
3. **组件就近放**：新组件先放自己 feature 的目录里；确实被多个功能复用了，再挪到 `src/components/`。
4. **CSS 类名加功能前缀**：比如 Git 历史面板的样式类用 `git-history-*` 开头，避免不同功能的样式互相打架。
5. **单个文件别超过 3000 行**：有脚本（`npm run check:large-files`）卡这个，文件太大就拆。
6. **TypeScript 严格模式**：别用 `any` 糊弄，类型写明白。
7. **Rust 端写文件走统一封装**：用 `storage.rs` 提供的原子写入，不要直接 `write`，避免写一半断电把用户数据写坏。
8. **加 Tauri command 前先搜一搜**：`command_registry` 里可能已经有现成的，别重复造。
9. **永远不要提交密钥**：API Key、token 这类东西绝对不能进代码和提交记录。

### Commit 信息怎么写

格式：`type(scope): 做了什么`（[Conventional Commits](https://www.conventionalcommits.org/) 规范）。描述用中文或英文都行，格式对就好。

| type | 什么时候用 |
| --- | --- |
| `feat` | 加新功能 |
| `fix` | 修 Bug |
| `refactor` | 重构（行为不变） |
| `docs` | 改文档 |
| `test` | 加/改测试 |
| `chore` | 杂活（版本号、依赖、脚本） |
| `perf` / `style` / `ci` | 性能优化 / 格式 / CI |

真实例子：

```text
feat(composer): 支持粘贴图片自动转附件
fix(git): 修复 diff 面板滚动位置丢失
docs(readme): update setup guide
```

不要在 commit 信息里写 emoji，也不要带 AI 生成署名。

---

## 怎么提交你的代码（贡献流程）

1. **Fork** 本仓库，clone 到本地。
2. 从 `main` 切一个分支，名字按 `feat/xxx`、`fix/xxx` 这种风格起。
3. 改代码，本地把三件套跑绿（`lint` / `typecheck` / `test`）。
4. 提 PR 到本仓库的 **`main` 分支**。标题按 commit 格式写，描述里说清楚：改了什么、为什么改、怎么验证的。
5. CI 会自动跑 lint、类型检查、测试和构建；PR 审查里指出的中高风险问题需要修复后才能合并。

不知道从哪下手？看看 [Issues](https://github.com/zhukunpenglinyutong/desktop-cc-gui/issues)，挑一个感兴趣的开干。发现 Bug 或有新点子，也欢迎直接开 Issue 聊。

### 想深入了解项目内部？

- `AGENTS.md` — 仓库规则总入口（用 AI 辅助开发本项目时必读）。
- `.trellis/spec/` — 前端、后端的详细实现规范。
- `openspec/` — 功能变更的提案与规格记录。
- `docs/architecture/` — 架构治理文档。

---

## License

[MIT](https://github.com/zhukunpenglinyutong/desktop-cc-gui?tab=MIT-1-ov-file)

---

## 友链

感谢 [LINUX DO](https://linux.do/) 用户的支持与反馈。

---

## 贡献者列表

感谢所有帮助 ccgui 变得更好的贡献者。

<a href="https://github.com/zhukunpenglinyutong/desktop-cc-gui/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=zhukunpenglinyutong/desktop-cc-gui" alt="Contributors" />
</a>

---

## Star History

[![Star History Chart](https://api.star-history.com/svg?repos=zhukunpenglinyutong/desktop-cc-gui&type=date&legend=top-left)](https://www.star-history.com/#zhukunpenglinyutong/desktop-cc-gui&type=date&legend=top-left)

<!-- LINK GROUP -->

[github-contributors-shield]: https://img.shields.io/github/contributors/zhukunpenglinyutong/desktop-cc-gui?color=c4f042&labelColor=black&style=flat-square
[github-forks-shield]: https://img.shields.io/github/forks/zhukunpenglinyutong/desktop-cc-gui?color=8ae8ff&labelColor=black&style=flat-square
[github-issues-link]: https://github.com/zhukunpenglinyutong/desktop-cc-gui/issues
[github-issues-shield]: https://img.shields.io/github/issues/zhukunpenglinyutong/desktop-cc-gui?color=ff80eb&labelColor=black&style=flat-square
[github-license-link]: https://github.com/zhukunpenglinyutong/desktop-cc-gui/blob/main/LICENSE
[github-stars-shield]: https://img.shields.io/github/stars/zhukunpenglinyutong/desktop-cc-gui?color=ffcb47&labelColor=black&style=flat-square
