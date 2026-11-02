---
title: MySQL 8.0 热备为什么全程持锁：backup lock 与从库延迟
date: 2026-11-02
---

# MySQL 8.0 热备为什么全程持锁：backup lock 与从库延迟

::: warning 一句话结论
MySQL 8.0 的 XtraBackup 默认在备份一开始就执行 `LOCK INSTANCE FOR BACKUP`，并一直持有到 copy 阶段结束。它只挡 DDL、不挡 DML，所以在主库上几乎无感；但如果备份跑在从库，主库执行的 DDL 会随 binlog 复制到从库，applier 线程执行时等这把锁。开启 `replica_preserve_commit_order` 后，一条 DDL 的等待会让后续事务也无法提交——**备份跑多久，从库就延迟多久**。
:::

## 现象：主库一切正常，从库延迟跟着备份涨

一个很容易让人误判的组合：

- 全备固定在从库上执行，备份期间主库照常对外服务；
- 主库执行 DDL 正常返回，没有任何等待；
- 从库的 `Seconds_Behind_Source` 从备份开始后持续上涨，备份结束后才逐步回落；
- 从库没有报错，SQL 线程看起来只是"停在那里"。

第一反应通常是查网络、大事务、磁盘 IO，但主库"完全没问题"恰恰是线索：**锁只存在于备份所在的那个实例上**。MySQL 8.0 的 backup lock 是实例级的，主库根本感知不到从库上的这把锁；真正被挡住的是从库回放 binlog 的 applier 线程。

## 先确认：延迟是不是在等 backup lock

在**执行备份的那个实例**上查 `performance_schema.metadata_locks`，backup lock 会以一条独立的记录出现：

```sql
-- 谁持有 backup lock
SELECT OBJECT_TYPE, OBJECT_SCHEMA, OBJECT_NAME,
       LOCK_TYPE, LOCK_STATUS, OWNER_THREAD_ID
FROM performance_schema.metadata_locks
WHERE OBJECT_TYPE = 'BACKUP LOCK';
```

典型结果是 `LOCK_TYPE = 'SHARED'`、`LOCK_STATUS = 'GRANTED'`，`OBJECT_SCHEMA` / `OBJECT_NAME` 为空——它是实例级对象，不属于某张表。

```sql
-- 谁在等
SELECT OBJECT_TYPE, OBJECT_SCHEMA, OBJECT_NAME,
       LOCK_TYPE, LOCK_STATUS, OWNER_THREAD_ID
FROM performance_schema.metadata_locks
WHERE LOCK_STATUS = 'PENDING';

-- 把持有者关联到具体线程
SELECT t.PROCESSLIST_ID, t.PROCESSLIST_USER,
       t.PROCESSLIST_STATE, t.PROCESSLIST_INFO
FROM performance_schema.metadata_locks ml
JOIN performance_schema.threads t ON t.THREAD_ID = ml.OWNER_THREAD_ID
WHERE ml.OBJECT_TYPE = 'BACKUP LOCK';
```

复制侧看两个地方：

```sql
-- 8.0.22+ 用 REPLICA 术语；更早版本是 SHOW SLAVE STATUS
SHOW REPLICA STATUS\G
```

重点看 `Replica_SQL_Running_State`（旧版本为 `Slave_SQL_Running_State`）。如果显示 `Waiting for backup lock`，基本可以实锤。

```sql
SELECT WORKER_ID, SERVICE_STATE, LAST_ERROR_NUMBER, LAST_ERROR_MESSAGE
FROM performance_schema.replication_applier_status_by_worker;
```

另外，`information_schema.processlist` 里也能直接看到 `system user` 线程处于 `Waiting for backup lock`：

```sql
SELECT ID, USER, COMMAND, TIME, STATE, INFO
FROM information_schema.processlist
WHERE STATE LIKE '%backup lock%';
```

需要区分另一种情况：如果 SQL 线程状态一直在正常执行、延迟却持续上涨，那更可能是备份把磁盘 IO 或 CPU 打满了，而不是锁。前者查锁，后者查 `iostat -x 1`、备份是否限流、备份盘是否与数据盘共用。

## backup lock 是什么

MySQL 8.0 用实例级元数据锁 `LOCK INSTANCE FOR BACKUP` 保证热备期间表定义和文件集合不变。XtraBackup 在备份开始时获取它，在 copy 阶段结束时释放。在 MySQL 8.0 上，XtraBackup 实际执行的就是 `LOCK INSTANCE FOR BACKUP`。

它是 **S 锁**，几个特征需要记清楚：

| 特性 | 说明 |
| --- | --- |
| 作用范围 | 整个实例，不是某张表 |
| 冲突对象 | DDL / 管理类语句：`ALTER`、`CREATE`、`DROP`、`TRUNCATE`、`RENAME` 等 |
| 不冲突对象 | 普通 DML：`SELECT`、`INSERT`、`UPDATE`、`DELETE` |
| 并发性 | S 锁，多个备份可以同时持有 |
| 持有时长 | 从 copy 开始到 copy 结束；`--prepare` 是离线阶段，不需要连库 |
| 权限 | 执行者需要 `BACKUP_ADMIN` |

所以"一开始就上锁，直到备份结束"不是异常，而是默认行为。XtraBackup 8.0 的源码里 `--lock-ddl` 的默认值就是开启：

```c
{"lock-ddl", OPT_LOCK_DDL,
 "Issue LOCK TABLES/LOCK INSTANCE FOR BACKUP if it is "
 "supported by server at the beginning of the backup to block all DDL "
 "operations.",
 (uchar *)&opt_lock_ddl, (uchar *)&opt_lock_ddl, 0, GET_BOOL, NO_ARG, 1, ...}
```

几个相关参数的关系：

- `--lock-ddl=OFF`：跳过 `LOCK INSTANCE FOR BACKUP`，DDL 不再被挡；
- `--no-lock`：同时关掉 lock-ddl 和 `FLUSH TABLES WITH READ LOCK`，只适用于全部是 InnoDB、且不在意 binlog 位点的场景；
- `--no-backup-locks`：不用 backup locks（回退到 FTWRL），同样会把 `opt_lock_ddl` 置为 false；
- `--lock-ddl-per-table`：逐表加 MDL，已标记 deprecated，而且同样是"持有到备份完成"，并不解决"DDL 全程被挡"；
- `--lock-ddl-timeout`：xtrabackup 获取锁的等待上限，默认 31536000 秒（一年），拿不到就失败退出。

### 为什么 8.0 要用实例级锁

InnoDB 热备必须保证 copy 期间"表定义不变、文件不被换掉"。如果允许 DDL 穿插，可能出现：文件被删了但备份清单里还有、表结构变了但 `.ibd` 还是旧格式、新表的文件不在备份范围内。这些都是恢复阶段才会暴露的不一致。

8.0 选择一把实例级 S 锁，而不是逐表加 MDL，主要是不用为每张表维护锁、也不会在表多时把 MDL 数量推高。代价很直接：**整个 copy 阶段，这个实例上的 DDL 都不可用**。

反过来说，锁的持有时间就等于 copy 阶段的时间。增量备份、并行、压缩、更快的磁盘和网络，都会直接缩短这个窗口；`--prepare` 不占锁。

## 从库上，一条 DDL 为什么能放大成整段延迟

关键在复制回放的顺序约束。

```text
从库开始 xtrabackup --backup
        ↓
LOCK INSTANCE FOR BACKUP 生效（只冲突 DDL）
        ↓
主库执行 DDL（主库无感，正常提交）
        ↓
binlog 传到从库，applier 执行这条 DDL
        ↓
DDL 请求 MDL，等待 backup lock
        ↓
replica_preserve_commit_order = ON：
后续事务即使执行完，也不能先提交
        ↓
整个 apply 停在原地，Seconds_Behind_Source 持续上涨
        ↓
备份结束、锁释放，DDL 和后续事务才开始回放
```

三个放大因素：

1. **提交顺序**。MySQL 8.0.27 起，开启并行复制时 `replica_preserve_commit_order` 默认 ON。worker 可以并行执行，但必须按顺序提交。一条 DDL 卡住，后面的事务即使已经执行完也只能等着，于是不是"这条 DDL 慢"，而是"整个 apply 停住"。
2. **MDL 队列**。等待中的 DDL 会在该表上排一个 MDL 请求，后续对同一张表的 DML 可能继续排队；如果 DDL 打在热点表上，业务读也会跟着受影响。
3. **relay log 堆积**。SQL 线程停住后，I/O 线程仍在接收 binlog，relay log 会持续增长。备份时间很长时，要盯 relay log 所在磁盘的余量（`relay_log_space_limit` 默认 0，即不限制）。

所以延迟的规模不是"一条 DDL 的执行时间"，而是"备份剩余时长"。备份三小时，中间来一条 DDL，延迟就会涨到接近三小时，之后才慢慢追平。

## 为什么"DDL 侧设 lock_wait_timeout"救不了从库

这条建议只在一种拓扑下成立：DDL 是客户端直接发到**持有备份锁的那个实例**上的。那样确实可以在会话里设一个短超时，让 DDL 快速失败、排队重试，避免无限挂起。

但在"备份在从库、DDL 在主库"的拓扑下不成立：

- 从库上的 DDL 是 replication applier 线程从 relay log 里执行的，没有地方给它 `SET SESSION lock_wait_timeout`；
- 改全局变量还要重启 applier 才生效；
- 真让它超时，结果是 SQL 线程报 `1205`（lock wait timeout）并停止，问题从"复制延迟"变成"复制中断"，需要人工介入，代价更大。

`--lock-ddl-timeout` 也不是干这个的。它控制的是 **xtrabackup 自己等锁的上限**：如果备份启动时正好有一个长 DDL 在跑，设短一点可以让备份快速失败、由调度重试，而不是卡在 acquiring backup lock。它不会缩短锁的持有时间，也不会让从库的 DDL 少等。

## 方案对比

| 方案 | 效果 | 代价与边界 |
| --- | --- | --- |
| 存储快照备份（CSI VolumeSnapshot / LVM） | 锁窗口从小时级降到秒级，从库几乎不产生延迟 | 需要存储支持；快照必须覆盖所有数据卷且保持同一时间点；依赖 CSI / 存储能力 |
| 专用备份从库，不接读流量 | 延迟只影响这个节点，备份结束后追平 | 多一个节点成本；要把它从读池和延迟告警里摘出去；长时间备份要盯 relay log 磁盘 |
| 备份窗口内冻结 DDL | 备份一致性最好，从库不会因 DDL 停顿 | DDL 要排队，依赖统一的 DDL 发布/工单系统；窗口长度受备份时长约束 |
| `--safe-slave-backup` | 备份期间主动停 SQL 线程，延迟变成确定性的"备份时长" | 读流量在备份期间看到旧数据；relay log 照样堆积；总延迟没有减少 |
| 缩短 copy 阶段（增量、并行、压缩、快盘） | 直接缩短锁和延迟增长的时间窗 | 受数据量、存储和网络限制；需要对备份限流，避免打满业务 IO |
| `--lock-ddl=OFF` | DDL 不再被挡 | 备份一致性无保证，只适合确认整个 copy 期间零 DDL 的场景 |
| DDL 会话 `lock_wait_timeout` | DDL 不会无限挂起 | 只对发到备份实例的客户端会话有效，对 applier 无效 |
| `--lock-ddl-timeout` | 备份启动时拿不到锁就快速失败 | 只影响 xtrabackup 等锁，不影响锁的持有时间 |

如果存储支持快照，优先选它；这是唯一能在"不牺牲一致性"的前提下把锁窗口压到秒级的方案。没有快照能力时，退而求其次是**专用备份从库 + 备份窗口冻结 DDL + 增量/并行缩短窗口**，并把延迟当成这个节点上的可接受成本。

## `--lock-ddl=OFF` 到底能不能用

参数本身有效：加上它，xtrabackup 不会再执行 `LOCK INSTANCE FOR BACKUP`，备份期间 DDL 不再被挡。但它只是"关掉锁"，不是"让 DDL 和备份共存且一致"。

从 8.0 的代码路径能看到几个真实后果：

- 备份期间表被 `DROP`，文件消失时，xtrabackup 会打一条警告（大意是"假设这张表在备份期间被删除了，忽略该文件"）然后跳过——备份里就少了这张表；
- `ALTER` / `CREATE` / `RENAME` 可能让数据字典和 `.ibd` 对不上，做增量备份 apply 时可能直接报 `Cannot handle DDL operation on tablespace`，整份备份作废；
- 启动时没有醒目的告警提示"Ddl 锁已关闭"，很容易被忽略；
- 最坏的情况不是报错，而是备份能 prepare、能恢复，但数据或结构是错的。

因此它只适用于一个很窄的场景：**能确认整个 copy 阶段（不是几秒，是几十分钟到数小时）实例上绝对不会执行 DDL**。如果从库还在持续接收主库的 DDL，这个前提不成立，不建议使用。

## 一分钟判断清单

满足以下条件，基本可以判定为"从库在等 backup lock"：

- [ ] 备份任务运行在从库上，主库 DDL 正常；
- [ ] 从库 `Replica_SQL_Running_State` 为 `Waiting for backup lock`；
- [ ] 备份实例的 `performance_schema.metadata_locks` 中存在 `OBJECT_TYPE = 'BACKUP LOCK'` 且 `LOCK_STATUS = 'GRANTED'`；
- [ ] 延迟开始上涨的时间与备份开始时间吻合，备份结束后逐步追平；
- [ ] 延迟上涨期间没有出现复制错误，SQL 线程只是等待。

反之，如果 worker 一直在正常执行、延迟仍然上涨，优先查备份是否打满了磁盘 IO / CPU，而不是锁。

## 小结：三个目标只能选两个

"DDL 随时可执行"、"备份一致"、"用长窗口的物理备份"这三件事，在 MySQL 8.0 的 backup lock 语义下最多同时满足两个：

- 要 DDL 随时可执行 + 备份一致 → 用存储快照，把锁窗口压到秒级；
- 要备份一致 + 继续用 XtraBackup → 接受备份窗口内 DDL 被挡，或者把备份放到专用从库上，让延迟只影响那个节点；
- 要 DDL 随时可执行 + 长窗口 XtraBackup → 只能关锁，用一致性换可用性。

backup lock 不是 bug，而是 8.0 为保证物理备份一致性做的设计取舍。真正需要治理的是**备份窗口**和**备份位置**，而不是这把锁本身。

> 本文基于 Percona XtraBackup 8.0 与 MySQL 8.0。不同小版本的默认值和参数行为可能有差异，落地前建议用 `xtrabackup --help` 和所用版本的源码再核对一次。
