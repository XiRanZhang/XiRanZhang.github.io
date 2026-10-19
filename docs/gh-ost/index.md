---
title: gh-ost 实战笔记
editLink: false
---

# gh-ost 实战笔记

这个栏目只有一条主线：**MySQL 在线改表**。前面是对 gh-ost 机制的拆解，后面是在它上面踩过的坑——每篇都按「现象 → 定位 → 根因 → 取舍」写，而不是罗列参数。

> 其中两篇是对 **goInception** 的 PR 复盘。它们不在 gh-ost 仓库里，但属于同一条链路：gh-ost 负责改表，goInception 负责调用它、解析它的输出、校验它的结果——好几个问题恰恰出在两者的接缝上。

## 机制

- [gh-ost 原理及源码解析](./gh-ost-principles-and-source.md) —— 从改表流程、三种执行模式，到 row-copy／binlog 回放的顺序无关性证明，最后用 8 个阶段拆解原子表交换（cut-over）算法及其失败场景。
- [gh-ost 加唯一索引为什么会静默丢数据](./gh-ost-unique-index-data-loss.md) —— 一次"成功"的迁移把 7 行变成 2 行。拆开 ALTER、行拷贝、binlog 回放三步，说明数据在哪一步丢的，以及上游争论六年后才给出的修复为什么默认关闭。
- [gh-ost DROP 旧表后连接数暴涨：一次 critical-load 误判的根因分析](./gh-ost-critical-load-connection-spike.md) —— cut-over 收尾窗口里的瞬时尖峰，被每秒一次的瞬时采样判定成持续过载。

## 复盘

- [gh-ost 管道死锁：一次 3 行修复背后的定位过程](./goinception-718-ghost-pipe-deadlock.md) —— `session/osc.go`，+3 −6。从 `strace` 推到"把逻辑完成误当成进程结束"，以及顺带发现的第二个静默 bug。
- [备份校验的线程号错配：把亚毫秒竞态变成确定性复现](./goinception-720-backup-thread-id.md) —— 5 个文件，+632 −2（其中 520 行是测试）。身份取自另一条连接，以及怎么用连接池的 LIFO 语义把"间歇性"变成构造保证。

## 贡献索引

下面这张表由 GitHub Actions 每周拉取 API 自动生成，**只显示真实存在的提交记录**——复盘可以讲故事，索引不行。

<!-- @include: ./_contributions.md -->
