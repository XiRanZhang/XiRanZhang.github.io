#!/usr/bin/env node
/**
 * 生成 docs/gh-ost/_contributions.md —— 作者在 GitHub 上提交的公开 PR 与 Issue 索引。
 *
 * 由 .github/workflows/oss-index.yml 定时运行；本地手动运行需要 token：
 *   GITHUB_TOKEN=$(gh auth token) node scripts/gen-oss-index.mjs
 *
 * 设计取舍：
 * - 只列「提交到别人仓库」的 PR / Issue，自己仓库的不算开源贡献，混在一起会稀释信号。
 * - 任一请求失败即中止且不写文件，避免一次 API 抖动把页面清空。
 * - 结果意外为空时同样中止，防止「抓取成功但拿不到数据」造成静默清空。
 */

import { writeFileSync, readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const AUTHOR = 'XiRanZhang'
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const OUT = join(ROOT, 'docs', 'gh-ost', '_contributions.md')

const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN
if (!token) {
  console.error('[oss-index] 缺少 GITHUB_TOKEN / GH_TOKEN')
  process.exit(1)
}

const headers = {
  accept: 'application/vnd.github+json',
  'x-github-api-version': '2022-11-28',
  authorization: `Bearer ${token}`,
  'user-agent': 'xiranzhang-oss-index',
}

async function search(kind) {
  const q = encodeURIComponent(`author:${AUTHOR} type:${kind} -user:${AUTHOR}`)
  const url = `https://api.github.com/search/issues?q=${q}&sort=created&order=desc&per_page=100`
  const res = await fetch(url, { headers })
  if (!res.ok) {
    throw new Error(`${kind} 查询失败：HTTP ${res.status} ${await res.text()}`)
  }
  const { items, total_count: total } = await res.json()
  return { items, total }
}

/** PR 的合并状态要单独看 merged_at；state 只有 open / closed 两种。 */
function statusOf(item) {
  if (item.pull_request?.merged_at) return '已合并'
  return item.state === 'open' ? '进行中' : '已关闭'
}

function repoOf(item) {
  return item.repository_url.replace('https://api.github.com/repos/', '')
}

function table(items, withMergeStatus) {
  if (items.length === 0) return '_暂无。_\n'
  // 状态与日期列加 nowrap：否则浏览器会把这两列压到最窄，中文字符被迫竖排
  const head = '| 仓库 | 标题 | 状态 | 日期 |\n| --- | --- | --- | --- |\n'
  const rows = items
    .map((it) => {
      const repo = repoOf(it)
      const title = it.title.replace(/\|/g, '\\|')
      const status = `<span style="white-space:nowrap">${statusOf(it)}</span>`
      const date = `<span style="white-space:nowrap">${it.created_at.slice(0, 10)}</span>`
      return `| \`${repo}\` | [#${it.number}](${it.html_url}) ${title} | ${status} | ${date} |`
    })
    .join('\n')
  return head + rows + '\n'
}

const [prs, issues] = await Promise.all([search('pr'), search('issue')])

// 抓取成功但一条都没有，几乎一定是 token 权限或查询被限流，宁可报错也不要清空页面。
if (prs.total === 0 && issues.total === 0) {
  console.error('[oss-index] 两个查询都返回 0 条，中止以免清空页面')
  process.exit(1)
}

const now = new Date().toISOString().slice(0, 10)
const body = `<!-- 本文件由 scripts/gen-oss-index.mjs 自动生成，请勿手工编辑。 -->
_最后更新：${now}_

### Pull Requests（${prs.total}）

${table(prs.items, true)}
### Issues（${issues.total}）

${table(issues.items, false)}
`

if (existsSync(OUT)) {
  const prev = readFileSync(OUT, 'utf8')
  // 只更新时间戳不算变化，避免每周产生空提交
  const strip = (s) => s.replace(/_最后更新：\d{4}-\d{2}-\d{2}_/, '')
  if (strip(prev) === strip(body)) {
    console.log('[oss-index] 内容无变化')
    process.exit(0)
  }
}

writeFileSync(OUT, body)
console.log(`[oss-index] 已写入：PR ${prs.total} 条，Issue ${issues.total} 条`)
