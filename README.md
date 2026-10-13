# XiRanZhang.github.io

《有状态工作负载在 Kubernetes 上的调度与运维》开源书稿，以及相关技术笔记。

站点基于 [VitePress](https://vitepress.dev/) 构建，通过 GitHub Actions 发布到 GitHub Pages。

## 目录结构

```
docs/
├── .vitepress/config.mts          # 站点配置（导航、侧边栏、搜索）
├── index.md                       # 首页
├── about.md                       # 关于
├── public/favicon.svg
├── book/
│   ├── index.md                   # 序 + 全书结构
│   ├── quorum-role-aware.md       # 第 3 章正文
│   └── figures/                   # 章内插图
├── posts/
│   ├── index.md                   # 技术文章列表
│   ├── gh-ost-principles-and-source.md
│   └── figures/
└── oss/
    ├── index.md                   # 开源贡献页（说明 + 索引）
    ├── _contributions.md          # 自动生成的索引片段，勿手工编辑
    └── goinception-718-ghost-pipe-deadlock.md   # PR 复盘

scripts/gen-oss-index.mjs          # 生成贡献索引（由 Actions 定时运行）
```

## 开源贡献索引

`docs/oss/_contributions.md` 由 `scripts/gen-oss-index.mjs` 通过 GitHub Search API 生成，
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

## 新增一章

1. 在 `docs/book/` 下新建 Markdown 文件，frontmatter 写 `title`。
2. 在 `docs/.vitepress/config.mts` 的 `sidebar['/book/']` 中补一条 `{ text, link }`。
3. 在 `docs/book/index.md` 的结构表里把状态改为「已发布」。

> VitePress 在构建时检查死链，侧边栏里不要提前放还不存在的页面链接。

## 许可

文字内容采用 [CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/) 许可协议，代码示例采用 MIT。
