# XiRanZhang.github.io

两组技术文章：**有状态负载在 Kubernetes 上**（调度、变更与运维），以及 **gh-ost 实战笔记**。

站点基于 [VitePress](https://vitepress.dev/) 构建，通过 GitHub Actions 发布到 GitHub Pages。

## 目录结构

```
docs/
├── .vitepress/config.mts          # 站点配置（导航、侧边栏、搜索）
├── index.md                       # 首页
├── about.md                       # 关于
├── public/favicon.svg
├── stateful/                      # 有状态负载在 Kubernetes 上
│   ├── index.md                   # 主题说明 + 文章列表
│   ├── quorum-role-aware.md       # Quorum 与角色感知的变更与中断
│   ├── cases/                     # 故障案例（aio-max-nr / OOM killer）
│   └── figures/
└── gh-ost/
    ├── index.md                   # 栏目总览（机制 / 复盘 / 贡献索引）
    ├── _contributions.md          # 自动生成的索引片段，勿手工编辑
    ├── gh-ost-principles-and-source.md
    ├── gh-ost-unique-index-data-loss.md
    ├── gh-ost-critical-load-connection-spike.md
    ├── goinception-718-ghost-pipe-deadlock.md
    ├── goinception-720-backup-thread-id.md
    └── figures/

scripts/gen-oss-index.mjs          # 生成贡献索引（由 Actions 定时运行）
```

## 栏目划分

- `/stateful/` —— 有状态负载在 Kubernetes 上：控制器语义与协议约束的错位，以及节点级资源不被调度器建模导致的故障案例。
- `/gh-ost/` —— MySQL 在线改表：gh-ost 机制拆解、线上问题复盘，以及 goInception 侧的 PR 复盘。
  所有 gh-ost 相关内容收在这一个栏目下，按「机制 / 复盘」分组。

## 开源贡献索引

`docs/gh-ost/_contributions.md` 由 `scripts/gen-oss-index.mjs` 通过 GitHub Search API 生成，
由 `.github/workflows/oss-index.yml` 每周一自动运行并提交，也可手动触发。

```bash
GITHUB_TOKEN=$(gh auth token) node scripts/gen-oss-index.mjs   # 本地手动生成
gh workflow run oss-index.yml                                  # 手动触发 Actions
```

几点约定：

- 只收录提交到**别人仓库**的 PR / Issue，自己仓库的不算开源贡献。
- 任一请求失败或结果意外为空时脚本会中止且不写文件，避免一次 API 抖动把页面清空。
- 该工作流刻意不订阅 `push`，否则它自己提交的索引会再次触发本工作流形成循环。
- `_` 前缀的文件由 `srcExclude` 排除，不生成独立页面；想加新片段沿用该命名。

## 本地开发

需要 Node.js 18 或更高版本。

```bash
npm install      # 首次
npm run dev      # 本地预览，默认 http://localhost:5173
npm run build    # 构建到 docs/.vitepress/dist
npm run preview  # 预览构建产物
```

## 写作约定

- 正文用 Markdown；提示块用 VitePress 容器语法（`::: tip` / `::: info` / `::: warning`）。
- 图片放在与正文同级的 `figures/` 目录，用相对路径引用，便于 Vite 处理资源。
- 涉及具体开源项目的描述基于公开架构；版本演进较快，落地前请对照在用版本核对。

## 新增一篇文章

1. 在对应栏目目录（`docs/stateful/` 或 `docs/gh-ost/`）下新建 Markdown 文件，frontmatter 写 `title`。
2. 在 `docs/.vitepress/config.mts` 的对应 `sidebar['/<栏目>/']` 中补一条 `{ text, link }`。
3. 在该栏目落地页（`docs/stateful/index.md` / `docs/gh-ost/index.md`）的列表里补一行。

> VitePress 在构建时检查死链，侧边栏里不要提前放还不存在的页面链接。

## 许可

文字内容采用 [CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/) 许可协议，代码示例采用 MIT。
