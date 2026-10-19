---
title: gh-ost DROP 旧表后连接数暴涨：一次 critical-load 误判的根因分析
date: 2026-10-19
---

# gh-ost DROP 旧表后连接数暴涨：一次 critical-load 误判的根因分析

## 现象

一次长事务的 gh-ost 迁移终于跑到 100%，cut-over 也完成了，眼看着就要成功，结果进程在最后一步退出：

```text
INFO Locking `db`.`users`, `db`.`_users_del`
...
INFO Dropping table `db`.`_users_del`
FATAL critical-load met: Threads_connected=1019, >=1000
```

监控上能看到连接数在 drop 旧表前后突然冲高，随后 gh-ost 以 FATAL 结束。更尴尬的是，此时新表已经上线，业务其实已经切过去了，但迁移被标记为失败，旧表和 changelog 表还可能残留。

这就是 gh-ost 里一个很典型的"最后一步误杀"问题。它在 2016 年由 PR [#266](https://github.com/github/gh-ost/pull/266) 引入 `--critical-load-interval-millis` 来缓解：不要一撞到 critical-load 就杀，隔一段时间再确认一次。

但要说清楚这个问题，得先纠正一个直觉：**不是 DROP 旧表需要更多连接，而是 cut-over 收尾窗口里本来就存在一个短暂的连接/线程尖峰，而 critical-load 的判定方式把这个瞬时尖峰当成了持续过载。**

## 结论先行

- `--critical-load` 原本是**每秒采样一次瞬时值，`value >= threshold` 就立即 abort**。它没有"持续 N 秒"或"连续 N 次"的概念。
- cut-over 会对原表加写锁，业务请求被阻塞；等锁释放，积压请求一起放行，再叠加客户端超时重连、连接池扩容，就形成一个持续一两秒的尖峰。
- DROP 旧表紧跟在 cut-over 后面，日志上看起来像是 DROP 导致的，实际上它更多是同一个窗口里的"第二个 DDL 停顿"，甚至只是时间上的巧合。
- `--critical-load-interval-millis` 把"一次就杀"改成"隔 N 毫秒再检查一次"，相当于两次采样的防抖。它过滤的是短尖峰，不是消除尖峰。

## 一、gh-ost 收尾阶段到底做了什么

以默认的 atomic cut-over 为例，代码里的顺序大致是：

1. **锁原表**。`Applier.AtomicCutOverMagicLock()` 执行 `LOCK TABLES original WRITE, _del WRITE`，同时锁住原表和 `_del` 哨兵表。从这一刻开始，业务对原表的读写全部被阻塞。
2. **等 binlog 追平**。gh-ost 在持锁状态下调用 `Migrator.waitForEventsUpToLock()`，等待所有该处理的事件处理完。高写入表上，这个等待可能持续数秒。
3. **RENAME**。把原表改名为 `_del`，把 ghost 表改名为原表，然后 `UNLOCK TABLES`。锁释放的瞬间，之前排队的业务请求全部被放行。
4. **标记 cut-over 完成**。`migrationContext.CutOverCompleteFlag` 被置为 1。
5. **清理**。进入 `Migrator.finalCleanup()`，先 drop changelog 表，再 drop 旧表（`OkToDropTable` 为真时）。
6. **收尾**。最后才执行 `teardown()`，在里面调用 `Throttler.Teardown()`，而这里才是停止每秒采样循环的地方。

画成时间线大致是这样：

```text
业务请求  ──┬──── blocked ────┬── 积压请求一起放行 ──> ...
            │                 │
gh-ost    LOCK              RENAME        DROP old      teardown
                             ^ CutOverComplete=1
            |<── critical-load 仍每秒采样 ─────────────>|
```

也就是说，**drop 旧表时 throttler 并没有停**。它仍然在每秒执行一次 `collectGeneralThrottleMetrics()`。

## 二、critical-load 是怎么判定的

核心逻辑在 `go/logic/throttler.go`。`Throttler.criticalLoadIsMet()` 会执行 `SHOW GLOBAL STATUS`，然后对每个配置项做比较：

```go
func (thlr *Throttler) criticalLoadIsMet() (met bool, variableName string, value int64, threshold int64, err error) {
	criticalLoad := thlr.migrationContext.GetCriticalLoad()
	for variableName, threshold = range criticalLoad {
		value, err = thlr.applier.ShowStatusVariable(variableName)
		if err != nil {
			return false, variableName, value, threshold, err
		}
		if value >= threshold {
			return true, variableName, value, threshold, nil
		}
	}
	return false, variableName, value, threshold, nil
}
```

真正"杀人"的地方在 throttler 的主循环里：

```go
if criticalLoadMet && thlr.migrationContext.CriticalLoadIntervalMilliseconds == 0 {
    // 立即 abort
    _ = base.SendWithContext(thlr.migrationContext.GetContext(),
        thlr.migrationContext.PanicAbort,
        fmt.Errorf("critical-load met: %s=%d, >=%d", variableName, value, threshold))
    return nil
}
```

而采样周期是固定的一秒：

```go
ticker := time.NewTicker(time.Second)
```

所以默认行为是：**只要某一秒的采样值越过阈值，就立即 Fatal**。它不关心这个值是一秒前才涨上来的，还是已经持续了十分钟；也不关心它下一秒会不会掉回去。

对于行拷贝这种持续几分钟到几小时的负载，这种判定方式问题不大。但在 cut-over 这种"锁表—解锁—放行"的窗口里，一两秒的尖峰几乎必然出现，误判概率就很高。

## 三、为什么连接数会在这个窗口暴涨

"drop 旧表之后连接数大量上升"这个观察本身没错，但原因往往不是 DROP 语句本身，而是下面这几件事叠在了同一个窗口里。

### 1. cut-over 的原表写锁（主因）

`LOCK TABLES original WRITE` 会阻塞其他会话对原表的所有读写。业务请求不会消失，它们会排队等锁：

- 排队的请求占着连接，连接池很快被耗尽；
- 新请求拿不到连接，开始超时；
- 客户端/连接池超时后重试，或者新建连接；
- `UNLOCK TABLES` 之后，所有排队请求一起执行，形成瞬时并发高峰。

如果 critical-load 配的是 `Threads_running`，锁等待中的线程本来就会计入 running，会直接看到尖峰；如果配的是 `Threads_connected`，则更多体现为连接池打满和重连带来的会话数上涨。

gh-ost 作者在 issue [#216](https://github.com/github/gh-ost/issues/216) 里的描述很直接：cut-over 阶段表被锁住，连接自然会堆积。issue [#1596](https://github.com/github/gh-ost/issues/1596) 里有一个非常典型的现场：

```text
08:59:28 INFO Locking db.users, db._users_del
08:59:29 FATAL critical-load met: Threads_connected=1019, >=1000
```

一秒钟内从正常涨到 1019，这不是 DROP 造成的，而是锁表导致的连接堆积。

### 2. RENAME 让表定义缓存和预处理语句失效

`RENAME TABLE` 完成后，原表名的表定义已经变了。使用预处理语句或缓存了表元数据的客户端可能收到 `ER_TABLE_DEF_CHANGED`（1412）之类的错误，连接池通常会选择重连或重建连接。这也会在 cut-over 完成的瞬间制造一波 connection storm。

它和 drop 旧表在时间上几乎重合，所以从监控上看很容易把账算到 DROP 头上。

### 3. DROP 本身也是一个 DDL

DROP 旧表并不是一个"纯元数据、瞬间完成"的操作：

- 它需要拿 MDL。如果有长事务在 cut-over 之前访问过原表，cut-over 之后它持有的是 `_del` 这张表的元数据锁，DROP 就必须等它结束。
- 它要清理 table cache、删除表空间。在 MySQL 5.6/5.7 上，DDL 还可能短暂持有全局的 `LOCK_open`，阻塞其他会话打开表。
- 如果表很大、实例很忙，这个停顿会被放大。

gh-ost 自己的 `--ok-to-drop-table` 帮助信息里就写着：

> DROPping tables can be a long locking operation, which is why I'm not doing it by default.

所以 DROP 确实可能叠加第二层停顿，但它是"叠加项"，不是唯一的根因。

### 4. 连接池和代理会把短停顿放大成连接尖峰

数据库只停顿了两三秒，但连接池的健康检查、客户端的超时重试、ProxySQL 之类的连接复用层，会把这两三秒放大成：

```text
查询变慢 -> 健康检查失败 -> 摘除连接 -> 批量新建连接 -> 停顿结束后一起涌入
```

最终监控上看到的就是 `Threads_connected` 陡增。

### 5. 为什么日志看起来像 DROP 的锅

cut-over 解锁、RENAME、DROP changelog、DROP 旧表，这几件事在日志里往往只隔几十毫秒到一两秒。critical-load 又是每秒采样一次，很容易正好采在 DROP 之后的尖峰上。

还有一个反证：`--ok-to-drop-table` 默认是 false，很多迁移根本不会 drop 旧表，但 cut-over 阶段一样会出现连接堆积。PR #266 是通用地给 critical-load 加二次确认，而不是去优化 DROP，说明维护者也很清楚问题不在 DROP 本身。

## 四、PR #266 做了什么

PR #266 把 critical-load 的判断抽成了 `criticalLoadIsMet()`，然后引入了一个可选的二次检查：

```go
if criticalLoadMet && thlr.migrationContext.CriticalLoadIntervalMilliseconds == 0 {
    _ = base.SendWithContext(..., PanicAbort, fmt.Errorf("critical-load met: %s=%d, >=%d", ...))
    return nil
}

if criticalLoadMet && thlr.migrationContext.CriticalLoadIntervalMilliseconds > 0 {
    thlr.migrationContext.Log.Errorf("critical-load met once: %s=%d, >=%d. Will check again in %d millis", ...)

    go func() {
        timer := time.NewTimer(time.Millisecond * time.Duration(thlr.migrationContext.CriticalLoadIntervalMilliseconds))
        <-timer.C

        if criticalLoadMetAgain, variableName, value, threshold, _ := thlr.criticalLoadIsMet(); criticalLoadMetAgain {
            _ = base.SendWithContext(..., PanicAbort,
                fmt.Errorf("critical-load met again after %d millis: %s=%d, >=%d", ...))
        }
    }()
}
```

配置 `--critical-load-interval-millis=2500` 之后，行为变成：

1. 第一次命中：只记日志，不退出；
2. 2.5 秒后再查一次；
3. 如果已经回落，继续迁移；
4. 如果仍然超限，才 Fatal。

文档里把它类比成 Nagios 的 `n` 次确认，只是这里的 `n` 固定为 2。默认值 0 保持旧行为，所以这是一个向后兼容的可选开关。

这个方案之所以有效，是因为它过滤的正是"短于 interval 的瞬时尖峰"。如果数据库真的持续过载，第二次检查仍然会命中，迁移还是会退出。

## 五、但 interval 不是根治

`--critical-load-interval-millis` 是一个很实用的缓解手段，但它没有改变一个事实：**cut-over 成功之后，abort 已经没有意义了。**

cut-over 完成意味着 RENAME 已经提交，新表已经上线，业务已经在写新表。此时再因为 critical-load 杀掉 gh-ost：

- 不可能回滚这次迁移；
- 只会让进程以失败状态退出；
- 可能留下旧表、changelog 表等残留，需要人工清理；
- 监控上会出现一次"迁移失败"的假告警。

更合理的语义是：**cut-over 完成之后，critical-load 只告警，不再 abort。** 如果确实担心清理阶段影响生产，可以记录日志、发 hook，或者让清理延后/限速，而不是直接杀掉一个已经完成切换的进程。

`--critical-load-hibernate-seconds` 是另一条路：命中后不退出，而是休眠一段时间再继续。它适合"负载高但希望迁移最终完成"的场景，但同样不能解决 cut-over 之后 abort 无意义的问题。

所以配置建议是分层的：

- 行拷贝阶段：用 `--max-load` 做节流，用 `--critical-load` 做最后的安全刹车；
- cut-over/清理阶段：要么给 critical-load 配 interval，要么在 cut-over 完成后直接关闭 abort 语义；
- 不要把 `--critical-load` 的阈值设得离正常峰值太近，否则任何一次抖动都会变成事故。

## 六、线上怎么确认是哪一种

排查时最重要的是对齐时间点，而不是只看最后一行 FATAL。

可以按下面的顺序看日志：

```text
Session locking original / Tables locked
Waiting for events up to lock
Lock & rename duration
Dropping table ...
FATAL critical-load met ...
```

- **FATAL 紧跟在 `Locking` 之后 1 秒内**：主因是 cut-over 锁积压，连接在等表锁。
- **FATAL 紧跟在 `Dropping table` 之后**：叠加了 DDL/MDL 停顿，或者客户端重连。
- **`Lock & rename duration` 特别长**：说明原表锁持有时间很久，积压更严重。

现场还可以看：

```sql
-- 是否有大量会话在等元数据锁
SHOW PROCESSLIST;
-- 重点看 State: Waiting for table metadata lock

-- MySQL 8.0 可以看 MDL
SELECT * FROM performance_schema.metadata_locks;

-- 是否有长事务卡住 DROP
SELECT * FROM information_schema.innodb_trx;
```

同时对比两个指标：

- `Threads_running`：正在执行/等待的线程数，锁积压时会直接上升；
- `Threads_connected`：当前连接数，连接池打满、客户端重连时会上升。

如果 `Threads_running` 先涨、`Threads_connected` 后涨，通常是"锁等待导致执行堆积，进而触发连接池扩容/重连"；如果 `Threads_connected` 涨得比 `Threads_running` 还快，则要重点看连接池、ProxySQL 和客户端重连策略。

## 七、总结

这次"DROP 旧表后连接数暴涨导致误判"的问题，可以拆成三层：

1. **触发层**：cut-over 对原表加写锁，业务请求排队；解锁后积压请求一起放行，叠加 RENAME 后的客户端重连和 DROP 的 DDL 停顿，形成一个短暂的连接/线程尖峰。
2. **判定层**：critical-load 每秒只采一个瞬时值，`>=` 阈值就立即 abort，没有持续性判断，于是短尖峰被当成持续过载。
3. **语义层**：cut-over 完成后迁移实际上已经成功，此时 abort 既不能回滚，也没有保护意义，只会制造一次假失败。

PR #266 的 `--critical-load-interval-millis` 解决的是第 2 层：用两次采样过滤短尖峰。它简单、有效、向后兼容，所以一直保留至今。但如果要彻底解决第 3 层，更好的做法是在 cut-over 完成之后停止 critical-load 的 abort 语义，只保留观测和告警。

理解了这个区别，下次再看到"DROP 旧表后连接数暴涨"，就不会急着去优化 DROP 语句，而是先问一句：**这个尖峰是持续过载，还是 cut-over 窗口里的瞬时抖动？** 这两者的处理方式完全不同。

---

## 参考资料

- PR [#266: support for --critical-load-interval-millis](https://github.com/github/gh-ost/pull/266)
- Issue [#216: Discussion: redefine critical-load behavior during cut-over](https://github.com/github/gh-ost/issues/216)
- Issue [#1596: Locked tables at the final stage with FATAL critical-load met](https://github.com/github/gh-ost/issues/1596)
- gh-ost 代码：`go/logic/throttler.go`、`go/logic/migrator.go`、`go/logic/applier.go`
- gh-ost 文档：`doc/command-line-flags.md` 中的 `critical-load`、`critical-load-interval-millis`
