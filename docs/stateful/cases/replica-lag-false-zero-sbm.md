---
title: Seconds_Behind_Master 为 0，从库却落后 6GB：一次跨地域追 binlog 的排查
date: 2026-11-16
---

# Seconds_Behind_Master 为 0，从库却落后 6GB：一次跨地域追 binlog 的排查

::: warning 一句话结论
`Seconds_Behind_Master` 衡量的是 SQL 线程相对**已收到的 relay log** 的延迟，不包含 IO 线程还没从主库拉下来的 binlog。当瓶颈在跨地域网络、IO 线程慢而 SQL 线程随到随处理时，它会稳定显示 0——从库可能落后几 GB、几个小时，但所有"复制正常"的指标都告诉你没问题。
:::

## 现象：复制一切正常，主库的新变更却查不到

一台跨地域 DR 从库刚用备份重建完成，状态看起来无可挑剔：

- `Slave_IO_Running` / `Slave_SQL_Running` 都是 `Yes`；
- `Last_Errno = 0`，没有任何复制错误；
- `Replicate_Do_DB` / `Replicate_Ignore_DB` / `Replicate_Wild_Ignore_Table` 全为空，没有过滤；
- `Seconds_Behind_Master = 0`，实例状态在线；
- 主库上刚完成的一次变更（例如新建账号），在从库上还看不到。

几项"正常"信号叠在一起，很容易得出错误结论：变更没生效/数据不一致。实际情况是，这条变更 DDL 确实在主库执行了，但它只是 binlog 流里的一个事件，**还没有到达这台正在补历史的从库**。

## 第一个坑：SBM 测不到 IO 线程的落后

MySQL 手册对 [`Seconds_Behind_Master`](https://dev.mysql.com/doc/refman/5.7/en/show-slave-status.html) 的定义有几个容易被忽略的限定（5.7 与 8.0 语义一致，8.0 改名为 `Seconds_Behind_Source`）：

- 它比较的是"当前正在处理的事件的原始时间戳"和"从库当前时间"；
- **没有事件正在处理时，值为 0**；
- **IO 线程在跑、但 relay log 已被 SQL 线程消费干净时，值为 0**；
- 它**不考虑** IO 线程还没从主库取到的 binlog。

换成一句话：它测的是 **SQL 线程 vs 已收到的 relay log**，不是 **从库 vs 主库**。

```text
主库 binlog: [已回放] [待回放] [未拉取]
                │        │        │
                │        │        └─ SBM 看不到
                │        └─ relay log 堆积
                └─ SQL 线程已执行
```

复制落后其实有两种形态，SBM 只对第一种有效：

| 形态 | 典型原因 | Read vs Exec | relay log | SBM |
| --- | --- | --- | --- | --- |
| <span style="white-space:nowrap">SQL 线程慢</span> | 大事务、单线程回放、DDL 等锁 | <span style="white-space:nowrap">Read 远大于 Exec</span> | <span style="white-space:nowrap">持续堆积</span> | <span style="white-space:nowrap">会真实上涨</span> |
| <span style="white-space:nowrap">IO 线程慢</span> | 跨地域带宽、网络抖动 | <span style="white-space:nowrap">两者基本相等</span> | <span style="white-space:nowrap">接近空</span> | <span style="white-space:nowrap">**稳定 0（假象）**</span> |

这次是第二种：网络把 binlog 一点点送过来，SQL 线程随手就应用完，然后进入 `Slave has read all relay log; waiting for more updates` 的空闲状态。没有"正在处理的事件"，SBM 自然就是 0。

## 确认真实落后：不要看 SBM，看位置

### 1. 看 SQL 线程状态

```sql
SHOW SLAVE STATUS\G
```

关键的一行是：

```text
Slave_SQL_Running_State:
  Slave has read all relay log; waiting for more updates
```

它说明 SQL 线程已经把收到的 relay log 全部执行完，正在等 IO 线程继续喂数据。此时 SBM 为 0 是必然结果，不代表追平。

### 2. 用文件 + 偏移对比主库

```sql
-- 从库
SHOW SLAVE STATUS\G
-- 看 Master_Log_File / Read_Master_Log_Pos
-- 和 Exec_Master_Log_Pos

-- 主库
SHOW MASTER STATUS\G
-- 看 File / Position
```

把从库的 `Master_Log_File`（或 `Relay_Master_Log_File`）与主库当前 `File` 比较。只要文件名不是同一个，或者同一个文件里偏移差了几百 MB，就是明确落后，和 SBM 无关。

### 3. 用 GTID 集合对比

```sql
-- 从库
SHOW SLAVE STATUS\G
-- Retrieved_Gtid_Set: IO 线程已经拉取到的区间
-- Executed_Gtid_Set:  SQL 线程已经执行到的区间

-- 主库
SHOW MASTER STATUS\G
-- Executed_Gtid_Set: 主库已经产生的全部事务
```

`Retrieved_Gtid_Set` 的终点就是 IO 线程的进度；它小于主库 `Executed_Gtid_Set` 的部分，就是**还没拉取**的 binlog。`Auto_Position: 1` 时，从库会按 GTID 顺序把这部分补齐。

### 4. 找到"该到没到"的事件在 binlog 的哪里

如果有一个具体事件（比如某条 DDL）需要确认是否已到达，可以直接在 binlog 里定位它：

```sql
SHOW BINLOG EVENTS IN 'binlog.000100' FROM <position> LIMIT 5;
```

输出里的 `Gtid` 事件可以把"位置"和"GTID"对上。找到目标语句的 `Pos` 后，把它和从库的 `Exec_Master_Log_Pos` 比较，就能算出还差多少字节、多少个 GTID。

一次排查的示意数据（数字做了脱敏，只保留量级）：

| 点位 | 说明 |
| --- | --- |
| 从库恢复/复制起点 | 约 8 小时前的全备位点 |
| 从库当前已拉取/已执行 | 同一个位置，relay log 已消费完 |
| 目标 DDL | 在主库当前 binlog 的靠后位置 |
| 差距 | 约 6GB binlog、3 万多个 GTID |
| `Seconds_Behind_Master` | 0 |

## 为什么会落后几 GB

用备份重建从库的标准流程大致是：

```text
取一份全备恢复数据目录
        ↓
SET GLOBAL GTID_PURGED = '<备份位点>'
        ↓
CHANGE MASTER TO ... MASTER_AUTO_POSITION = 1
        ↓
从备份位点开始，把之后产生的 binlog 全部拉取并回放
```

备份越旧、跨地域链路越窄，需要补的量越大。这次备份点在大约 8 小时前，跨地域链路实测在 1MB/s 量级，于是要补约 6GB。

关键点在于两段速度不匹配：

- SQL 线程单条应用的速度远高于网络拉取速度；
- 所以 IO 线程每次只送到一小批，SQL 线程立刻处理完就空闲；
- SBM 在"随到随处理"的模式下永远是 0。

真正决定追平时间的是**剩余字节数 ÷ 网络吞吐**，不是 GTID 个数——事务大小差异很大，几万个 GTID 可能只有几十 MB，也可能有几个 GB。

## 怎么估算还要多久

```text
剩余时间 ≈ 从从库当前位置到目标事件的剩余字节数 ÷ 实测拉取吞吐
```

用一次 30 分钟的进度采样：

- 已推进 1.6GB / 30 分钟 ≈ 52MB/min；
- 到目标事件还剩约 6GB；
- 估算约 115 分钟。

再叠加主库的新增写入：如果主库进入突发写入（批量任务、大批量 DML），追平会被推迟，甚至长时间追不上。所以重建从库前要评估目标时段主库的写入速率，而不只是备份大小。

## 处理方式

确认是 IO 线程落后之后，通常只有三种选择：

- **等它追平**：按上面的吞吐估算剩余时间，追平后主库的变更自然可见；
- **把读流量切到主库或已追平的从库**：绕开还没准备好的实例；
- **用更新的备份重建**：缩短待补区间。

选择哪种取决于业务对这台从库读流量的依赖程度，以及主库当前写入速率是否会继续推高 backlog。

## 监控与调度该怎么改

这次暴露出两个容易失真的判断：

1. **复制延迟指标失真**。不要用 `Seconds_Behind_Master` 做跨地域从库的延迟告警。用位点差/GTID 差，或者 heartbeat 方案（`pt-heartbeat`、`MASTER_HEARTBEAT_PERIOD` + `performance_schema.replication_connection_status`）。
2. **新从库的就绪状态缺失**。用备份重建的从库在追平前不应该进入读池，应该有一个明确的 `catching up` 状态，而不是靠复制线程"活着"就认为可用。

对应的改进方向：

- 从库追平前不参与读流量调度；
- 跨地域重建优先用增量备份/更快链路，或选择更近的备份点；
- 为大 backlog 的追平过程加一个"预计完成时间"的观测项。

## 一分钟判断清单

满足以下条件，基本可以判定为"IO 线程落后、SBM 假 0"：

- ☐ `Seconds_Behind_Master = 0`，但 `Master_Log_File` / `Read_Master_Log_Pos` 落后主库 `File` / `Position`；
- ☐ `Slave_SQL_Running_State` 为 `Slave has read all relay log; waiting for more updates`；
- ☐ `Read_Master_Log_Pos ≈ Exec_Master_Log_Pos`，relay log 接近空；
- ☐ `Retrieved_Gtid_Set` 的终点小于主库 `Executed_Gtid_Set` 的终点；
- ☐ 没有复制错误、没有复制过滤。

反过来，如果 `Read_Master_Log_Pos` 远大于 `Exec_Master_Log_Pos`、relay log 持续增长，那才是 SQL 线程真的慢，应该去查大事务、DDL 等锁、并行回放配置。

## 小结

`Seconds_Behind_Master` 是一个"看起来最权威、实际最容易骗人"的复制指标。它回答的问题是"SQL 线程落后已收到的数据多少秒"，而不是"从库落后主库多少"。

这次事故的完整链条是：

```text
用旧备份跨地域重建从库
        ↓
从旧位点补 6GB binlog，网络是瓶颈
        ↓
SQL 线程随到随处理，relay log 始终为空
        ↓
Seconds_Behind_Master = 0，复制"看起来正常"
        ↓
期间主库新增的变更还在未拉取的 6GB 里
        ↓
从库看不到这些变更，但各项复制指标都显示正常
```

排查时只要多做一步——把从库的位点和主库对比——就能识破这个假 0。处理上通常只需要等它追平，或把读流量暂时切到已追平的节点。

> 本文基于 MySQL 5.7 的复制语义，8.0 中字段名改为 `Seconds_Behind_Source`，判断逻辑一致。不同版本、不同云厂商的备份恢复流程会改变具体参数，落地前请以所用版本的 `SHOW SLAVE STATUS` 输出和手册为准。
