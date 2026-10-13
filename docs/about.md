---
title: 关于
---

# 关于

小米后端工程师，四年数据库基础设施经验。日常在 2000+ MySQL 集群的运维平台、Kubernetes 原生的数据库编排、以及异构数据库统一管控这三件事之间来回切换，也是 [KubeBlocks](https://github.com/apecloud/kubeblocks) 的贡献者。

这些经历有个共同点：**数据库要的语义，Kubernetes 的对象模型表达不了。** 这本书就是把这些年在这条缝里撞到的问题、试过的解法、以及最后发现"还是缺一块"的地方，系统地写下来。

## 做过什么

- **KubeBlocks 贡献者** —— 实现数据库集群的水平与垂直扩缩容，支持异构存储卷扩容。
- **MySQL 规模化运维** —— 建设并维护 2000+ 集群的运维平台；对 [gh-ost](https://github.com/github/gh-ost)（在线 DDL）与 [Orchestrator](https://github.com/openark/orchestrator)（高可用与复制管理）有源码级理解。
- **多集群编排** —— 为跨可用区／跨地域的 MySQL 容器集群设计轮询、负载均衡、拓扑亲和等多策略调度算法，以及可插拔的运维操作接口框架。
- **数据库中间件** —— [Gaea](https://github.com/XiaoMi/Gaea)（小米 MySQL 代理）贡献者，为其增加分库分表的在线 DDL 支持。
- **统一数据库平台** —— 设计异构数据库（MySQL / PostgreSQL / OceanBase 等）的抽象层与异步任务框架，管理规模 1 万+ 实例。
- **MCP 工具链** —— 把 AI 能力接入数据库运维流程。

## 发表与开源

- **CCF-B 会议论文** —— [Fault-Tolerating Edge Computing with Server Redundancy Based on a Variant of Group Degree Centrality](https://www.researchgate.net/publication/347461271_Fault-Tolerating_Edge_Computing_with_Server_Redundancy_Based_on_a_Variant_of_Group_Degree_Centrality)（IEEE SCC 2020）
- 贡献过 [goInception](https://github.com/hanchuanchuan/goInception)（修复 gh-ost 执行的管道死锁）、[Gaea](https://github.com/XiaoMi/Gaea)、Soar（MySQL 语法兼容修复）

## 为什么写这本书

上面那些工作里，最难受的不是某个参数调不对，而是**控制面看不见数据库的语义**。一次"合规"的滚动升级能打掉主库，一个"满足 PDB"的节点排空能击穿 quorum——每个动作单独看都对，叠起来就出事。

这本书不打算罗列 API，而是想固定问题与约束，再看 Kubernetes 原生给了什么、缺什么，然后沿"观测 → 准入 → 编排 → 协议保证"这条线把可行解法和它们的能力边界讲清楚。全书以 KubeBlocks 作为主要参照实现——因为我确实在它上面写过代码，知道它做到了哪一步，也知道它还没做到哪一步。

## 联系方式

技术讨论欢迎走 GitHub Issue，比私信更容易沉淀下来。

- 书稿仓库：<https://github.com/XiRanZhang/XiRanZhang.github.io>
- GitHub：<https://github.com/XiRanZhang>

::: tip 关于内容准确性
文中涉及 KubeBlocks 等开源项目的描述基于其公开架构，版本演进较快，落地前请对照在用版本核对。标注为「仍待补齐」的部分，建议先用最小实验验证再作为结论引用。
:::
