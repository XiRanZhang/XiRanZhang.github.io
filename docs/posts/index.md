---
title: 技术文章
---

# 技术文章

这里放和中长期工作相关、但**不适合塞进书里**的内容——大多是某个工具或机制的深入拆解。书（[有状态工作负载在 Kubernetes 上的调度与运维](/book/)）是一条主线，这里是主线之外的支线。

写作原则和书一致：先讲清机制，再谈边界。

## 全部文章

- [gh-ost DROP 旧表后连接数暴涨：一次 critical-load 误判的根因分析](./gh-ost-critical-load-connection-spike.md) —— cut-over 收尾窗口里的瞬时尖峰被每秒一次的瞬时采样判定为持续过载。拆成触发层、判定层、语义层三层，并说明 `--critical-load-interval-millis` 为什么只解决了第二层。
- [gh-ost 加唯一索引为什么会静默丢数据](./gh-ost-unique-index-data-loss.md) —— 一次"成功"的迁移把 7 行变成 2 行。拆开 ALTER、行拷贝、binlog 回放三步，说明数据在哪一步丢的、上游为之争论六年后的修复（v1.1.8）为什么默认关闭，以及加唯一索引前必须做的那一次检查。
- [gh-ost 原理及源码解析](./gh-ost-principles-and-source.md) —— 从改表流程、三种执行模式，到 row-copy／binlog 回放的顺序无关性证明，最后用 8 个阶段拆解原子表交换（cut-over）算法及其失败场景。附常见问题与改进方向。
