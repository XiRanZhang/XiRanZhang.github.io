---
title: 关于
---

# 关于

小米后端工程师，四年数据库基础设施经验。日常在大规模 MySQL 集群的运维平台、Kubernetes 原生的有状态数据库编排、以及异构数据库统一管控这三件事之间来回切换。

这些经历有个共同点：**数据库要的语义，Kubernetes 的对象模型表达不了。** 这本书就是把这些年在这条缝里撞到的问题、试过的解法、以及最后发现"还是缺一块"的地方，系统地写下来。

## 做过什么

- **有状态 MySQL on Kubernetes** —— 基于开源 [KubeBlocks](https://github.com/apecloud/kubeblocks) 自研 Operator 的核心研发，负责备份回放、带数据水平扩容、物理机与容器双向在线迁移三个模块。有状态扩缩容的难点不在扩容本身，而在 PVC 绑定、副本同步、主从拓扑变更这条链路必须有序且幂等——尤其当多个控制器并发更新同一个 CR 的时候。

- **规模化 MySQL 运维** —— 建设并维护大规模集群的运维平台；对 [gh-ost](https://github.com/github/gh-ost)（在线 DDL）与 [Orchestrator](https://github.com/openark/orchestrator)（高可用与复制管理）有源码级理解。

- **统一 SQL 执行层** —— 从 0 到 1 独立设计平台唯一的 SQL 变更执行入口，串起「审核 → 审批 → 执行 → 回调 → 自动回滚」全流程。压测定位到「锁内网络 I/O + 热路径互斥锁」双重瓶颈后重建连接池，高并发下请求延迟下降两个数量级、吞吐提升一个数量级以上。

- **数据库 AI 接入层（MCP）** —— 把数据库平台的能力抽象为一套标准化 Agent 工具，已接入多个内部 AI 平台。多套认证并存、普通用户与 DBA 工具级隔离，并实现了首个可由 AI 提交 SQL 变更的入口——高危语句自动拦截、提交前强制人工确认。

- **数据库管控平台（DBaaS）** —— 分库分表场景的 SQL 变更工单引擎（路由解析 + AST 语句分级）、异地备份体系、以及小米分库分表中间件 [Gaea](https://github.com/XiaoMi/Gaea) 的平台管理面；抽象出统一的 `DBService` 引擎接口，大幅降低新引擎的接入开发量。

## 发表与开源

- **[goInception #718](https://github.com/hanchuanchuan/goInception/pull/718)** —— 修复 gh-ost 执行器的管道死锁：InnoDB 行数估算偏差导致进度计数器溢出、reader 退出、管道写满阻塞，生产环境曾使迁移挂起一小时以上。改动只有 3 行，工作量全在定位上。（**PR 仍在 review 中**，尚未合并。）
- **在开源项目之上构建** —— 我的工作与 [KubeBlocks](https://github.com/apecloud/kubeblocks)（有状态 MySQL Operator）、[Gaea](https://github.com/XiaoMi/Gaea)（平台管理面）、[Soar](https://github.com/XiaoMi/soar)（SQL 审核引擎）相关，但都是在小米内部代码库上完成的，**不会出现在公开的提交历史里**（公开仓库是下游镜像）。这一点我如实写明，不冒充上游提交。
- **CCF-B 会议论文** —— [Fault-Tolerating Edge Computing with Server Redundancy Based on a Variant of Group Degree Centrality](https://www.researchgate.net/publication/347461271_Fault-Tolerating_Edge_Computing_with_Server_Redundancy_Based_on_a_Variant_of_Group_Degree_Centrality)（IEEE SCC 2020）

## 关注方向

面向有状态负载的 quorum 感知调度 · 遵循数据库协议语义的 Kubernetes Operator · 能安全操作数据库的 AI Agent。

## 为什么写这本书

上面那些工作里，最难受的不是某个参数调不对，而是**控制面看不见数据库的语义**。一次"合规"的滚动升级能打掉主库，一个"满足 PDB"的节点排空能击穿 quorum——每个动作单独看都对，叠起来就出事。

这本书不打算罗列 API，而是想固定问题与约束，再看 Kubernetes 原生给了什么、缺什么，然后沿"观测 → 准入 → 编排 → 协议保证"这条线把可行解法和它们的能力边界讲清楚。全书以 KubeBlocks 作为主要参照实现——因为我在它上面写过代码，知道它做到了哪一步，也知道它还没做到哪一步。

## 联系方式

技术讨论欢迎走 GitHub Issue，比私信更容易沉淀下来。

- 书稿仓库：<https://github.com/XiRanZhang/XiRanZhang.github.io>
- GitHub：<https://github.com/XiRanZhang>

::: tip 关于内容准确性
文中涉及 KubeBlocks 等开源项目的描述基于其公开架构，版本演进较快，落地前请对照在用版本核对。标注为「仍待补齐」的部分，建议先用最小实验验证再作为结论引用。
:::
