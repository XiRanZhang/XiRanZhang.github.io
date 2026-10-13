import { defineConfig } from 'vitepress'

export default defineConfig({
  lang: 'zh-CN',
  title: 'XiRanZhang',
  description: '云原生、分布式数据库与有状态工作负载的调度与运维笔记',

  // 发布到 https://xiranzhang.github.io/ （仓库名 XiRanZhang.github.io）时用 '/'
  // 若改为项目仓库（如 blog），需同步改为 '/blog/'
  base: '/',

  cleanUrls: true,
  lastUpdated: true,

  // `_` 前缀的文件是「被 @include 的片段」，不应生成独立页面
  // （否则 docs/oss/_contributions.md 会变成一个只有表格的孤儿路由，并被搜索引擎收录）
  srcExclude: ['**/_*.md'],

  head: [
    ['link', { rel: 'icon', type: 'image/svg+xml', href: '/favicon.svg' }],
    ['meta', { name: 'author', content: 'XiRanZhang' }],
  ],

  markdown: {
    lineNumbers: true,
  },

  themeConfig: {
    nav: [
      { text: '开源书', link: '/book/' },
      { text: '技术文章', link: '/posts/' },
      { text: '开源贡献', link: '/oss/' },
      { text: '关于', link: '/about/' },
    ],

    sidebar: {
      '/book/': [
        {
          text: '有状态工作负载在 Kubernetes 上的调度与运维',
          items: [
            { text: '序：这本书要回答什么', link: '/book/' },
            { text: '3 · Quorum 与角色感知的变更与中断', link: '/book/quorum-role-aware' },
          ],
        },
      ],
      '/oss/': [
        {
          text: '开源贡献',
          items: [
            { text: '索引与说明', link: '/oss/' },
            { text: '备份校验的线程号错配：亚毫秒竞态的确定性复现', link: '/oss/goinception-720-backup-thread-id' },
            { text: 'gh-ost 管道死锁：3 行修复背后的定位过程', link: '/oss/goinception-718-ghost-pipe-deadlock' },
          ],
        },
      ],
      '/posts/': [
        {
          text: '技术文章',
          items: [
            { text: '全部文章', link: '/posts/' },
            { text: 'gh-ost 加唯一索引为什么会静默丢数据', link: '/posts/gh-ost-unique-index-data-loss' },
            { text: 'gh-ost 原理及源码解析', link: '/posts/gh-ost-principles-and-source' },
          ],
        },
      ],
    },

    socialLinks: [
      { icon: 'github', link: 'https://github.com/XiRanZhang' },
    ],

    outline: { level: [2, 3], label: '本页目录' },

    search: {
      provider: 'local',
      options: {
        translations: {
          button: { buttonText: '搜索', buttonAriaLabel: '搜索' },
          modal: {
            displayDetails: '显示详情',
            resetButtonTitle: '清除查询',
            noResultsText: '没有找到相关结果',
            footer: {
              selectText: '选择',
              navigateText: '切换',
              closeText: '关闭',
            },
          },
        },
      },
    },

    editLink: {
      pattern: 'https://github.com/XiRanZhang/XiRanZhang.github.io/edit/main/docs/:path',
      text: '在 GitHub 上编辑此页',
    },

    docFooter: { prev: '上一节', next: '下一节' },
    returnToTopLabel: '回到顶部',
    sidebarMenuLabel: '目录',
    darkModeSwitchLabel: '主题',
    lightModeSwitchLabel: '主题',
    externalLinkIcon: true,

    footer: {
      message: '内容采用 <a href="https://creativecommons.org/licenses/by-nc-sa/4.0/" target="_blank" rel="noreferrer">CC BY-NC-SA 4.0</a> 许可协议',
      copyright: 'Copyright © 2026 XiRanZhang',
    },
  },
})
