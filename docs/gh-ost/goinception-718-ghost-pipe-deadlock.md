---
title: gh-ost 管道死锁：一次 3 行修复背后的定位过程
---

# gh-ost 管道死锁：一次 3 行修复背后的定位过程

> goInception PR [#718](https://github.com/hanchuanchuan/goInception/pull/718) · 2026 年 4 月提交 · 状态：**open，等待 review**
> 改动：`session/osc.go`，+3 −6

一个 3 行的 diff 没什么好看的。值得写下来的是**怎么找到它的**——因为这类问题的难点从来不在改法上。

## 现象：任务不结束，也不报错

gh-ost 改表任务卡住了，**一个多小时没有任何进展**。界面不报错、任务不失败、日志不再更新，就是不结束。

这个形态本身就排除了一批可能：进程崩溃会有退出码，SQL 执行超时会有错误，网络中断会在重连后继续。**"什么都没有发生"通常意味着有人阻塞在等待上。**

## 定位：谁在等谁

两步确定现场：

```bash
ps -ef | grep gh-ost        # 进程还在，状态 S（可中断睡眠）
strace -p <pid>             # 关键线索
```

`strace` 给出的是：

```
write(1, "[2026/04/27 ...] Copy: 100.0% ...", 4096) = ? <unfinished ...>
```

gh-ost 在往 **stdout** 写，然后卡住了。结合父进程的调用栈——父进程停在 `cmd.Wait()`——链条就清楚了：

```
父进程 cmd.Wait()      等 gh-ost 退出
gh-ost  write(stdout)  等管道有空间
管道缓冲（64KB）       满了，等有人来读
没人来读  ← 问题在这里
```

**子进程在等父进程读，父进程在等子进程退出。** 经典死锁。剩下要回答的只有一个问题：那个本该读管道的 goroutine 去哪了？

## 根因：把"逻辑完成"当成了"进程结束"

`execCommand` 为 stdout / stderr 各起**一个** reader goroutine，每读一行交给 `mysqlAnalyzeGhostOutput` 解析进度。让 reader 提前退休的就是这一段：

```go
if ok := s.mysqlAnalyzeGhostOutput(line, p); ok {
    wg.Done()      // 分析器说"完成了"
    break          // 于是这条流从此再没有消费者
}
```

返回 `true` 只有一个出口——进度行的整数百分比 ≥ 100。先把 `Copy: 12,345,678/12,700,000 100.8%; … ETA: due` 这样的行用正则取出百分比：

```go
var regGhostPercent = regexp.MustCompile(`^Copy:.*?(\d+).\d+%;.*?ETA: (.*)?`)
```

然后只有一个分支会让它返回 `true`：

```go
if pct >= 100 { complete = true }   // 唯一的 true 出口
```

而百分比的分母是 **gh-ost 基于 `EXPLAIN` 估算的行数**。这次估算 1270 万、实际 7000 万，所以读到"100%"时真正拷完的还不到五分之一——**reader 以为自己干完了，其实还剩五千多万行。**

### 为什么管道就此没人读了

三件事叠在一起，把"提前退出"变成了死锁：

1. **那条流只有这一个读者。** `go f(reader)` 每条流只起一个 goroutine，`break` 之后没有任何兜底消费者接手。
2. **管道也不会被关闭。** 关闭靠 `execCommand` 里的 `defer stdout.Close()` / `defer stderr.Close()`，而它们要等 `execCommand` 返回——`execCommand` 正卡在等 gh-ost 退出。
3. **gh-ost 并不知道对面不读了。** 它继续往那条管道写，64KB 缓冲填满后阻塞在 `write()`。

于是形成一条闭环，没有任何一方会主动打破它：

```text
reader 读到「进度 100%」→ break 退出
        ↓
这条管道失去唯一消费者
        ↓
gh-ost 继续写 → 64KB 缓冲写满 → 阻塞在 write()
        ↓
父进程 cmd.Wait() 等 gh-ost 退出 → 永远等不到
        ↓
管道的 Close()（defer）等 execCommand 返回 → 也永远等不到
```

> **一处精确性说明**：`mysqlAnalyzeGhostOutput` 对返回值是**无状态**的——它只解析当前这一行，并不记忆"曾经到过 100%"。所以严格说是**读到进度行的那条流的 reader 退休**；另一条流的 reader 只在自己流里也出现 ≥100% 的进度行时才会退出。事故现场父进程能停在 `cmd.Wait()`，说明当时两条 reader 都已退出（`wg.Add(2)` 要等两个 `Done`）。但即便只退出一条，死锁同样成立——只是卡点从 `cmd.Wait()` 变成 `wg.Wait()`。

### 那是不是换个表、估算准了就没问题？

不是。这里有个比"估算不准"更根本的事实。gh-ost 算进度的分母来自 `progress_snapshot.go`：

```go
rowsEstimate := RowsEstimate + RowsDeltaEstimate
if atomic.LoadInt64(&mgtr.rowCopyCompleteFlag) == 1 {
    // Done copying rows. The totalRowsCopied value is the de-facto number of rows
    rowsEstimate = totalRowsCopied
}
progressPct := 100.0 * GetTotalRowsCopied() / rowsEstimate   // 没有上限截断，可以超过 100
```

**行拷贝完成的那一刻，分母被强制换成"已拷贝行数"——进度按设计就精确等于 100.0%。** 也就是说"进度到 100%"这个信号**每次改表都必然出现**，跟估算准不准毫无关系。

所以真正决定"会不会挂住"的是**第二件事：从 100% 到进程退出之间，gh-ost 还要往那条管道写多久。**

| 情形 | 100% 出现的时机 | 100% 之后还要跑多久 | 结果 |
| --- | --- | --- | --- |
| 估算准确／偏高，正常流程 | 复制真正结束时 | 秒级（立刻 cut-over 并退出） | 缓冲来不及填满，**无感** |
| 估算严重偏低（这次事故） | 复制真正结束**之前很久** | 数小时 | 持续输出 → **必然挂死** |
| 用 `--postpone-cut-over` 等人工放行 | 复制真正结束时 | 任意长 | 按约 30 秒/行输出，64KB 约两小时填满 → **同样会挂** |

而且 `shouldPrintStatus` 是**按时间节流的限流器，不是内容去重**——稳态每 30 秒打一行，临近结束（ETA ≤ 60s）每个 tick 都打。所以"复制还在推进"必然意味着"输出还在持续"，64KB 缓冲迟早填满。

**关键不是"准不准"，而是"100% 这个信号出现在复制真正结束之前，还是之后"。** 估算偏**高**反而是安全的：分母偏大 → 复制过程中进度到不了 100 → reader 不会提前退出，等复制真正结束时代码才把分母设成实际值，信号出现在正确的时刻。**只有偏低才让信号提前出现。**

这也解释了这个 bug 的形状：**它不是"偶发"，而是"条件齐备时必然"**——信号必然出现，只要 100% 之后还有足够长的输出，就一定挂。估算偏低的作用只是把那个窗口从"秒级"放大到"小时级"。

### EXPLAIN 到底为什么估不准？

先把 gh-ost 的取数方式说清楚（`Inspector.estimateTableRowsViaExplain`）：

```go
query := fmt.Sprintf(`explain select /* gh-ost */ * from %s.%s where 1=1`,
    databaseName, tableName)

// 只取 rows 这一列
isp.migrationContext.RowsEstimate = rowMap.GetInt64("rows")
```

**它读的是 `EXPLAIN` 的 `rows` 列——这个数字不是数出来的，是估出来的。** `WHERE 1=1` 只是让语句合法、不影响结果：优化器会把它简化掉，gh-ost 本质上是在问"你认为这张表有多少行"。

那这个"认为"从哪来？InnoDB 的索引统计。误差主要有四个来源。

**一、统计来自随机采样，而采样量是固定的。**

MySQL 8.0 默认 `innodb_stats_persistent=ON`，统计持久化到 `mysql.innodb_table_stats.n_rows`；采样量由 `innodb_stats_persistent_sample_pages` 控制，**默认只采 20 个索引页**（每页 16KB，合计 320KB）。

按 7000 万行、每行约 200B 估算，整表约 14GB——**320KB 的采样比例大约是 1/45000**。InnoDB 再从这 20 个页的页内平均行数外推整张表，样本越小，外推误差越大。

这也解释了一个反直觉的现象：**小表从来不出事，大表才出事**。采样量是固定的，表越大，相对覆盖率越低。

**二、统计是快照，会滞后。**

`innodb_stats_auto_recalc` 默认开启，但它只在"表数据变化约 10%"时**异步**重算。批量导入、大范围删除之后、下一次 `ANALYZE TABLE` 之前，`n_rows` 可能和现状差很远。

所以同一条 ALTER，上午跑没事、下午跑就挂——**不是代码变了，是统计变了。**

**三、采样假设"数据在页间均匀分布"。**

- 自增主键叠加大范围删除，页填充率会极不均匀；
- 热点写入集中在尾部；
- 大字段让每页能容纳的行数差别巨大。

外推时这些偏差会被放大。这是最难预测的一类误差：它既不随表变大而收敛，也不随 `ANALYZE TABLE` 而消失。

**四、误差有方向，而方向决定后果。**

`EXPLAIN` 偏高和偏低都很常见。但结合上一节：**偏高是安全的**（分母偏大，进度到不了 100%，reader 不会提前退出），**偏低才是致命的**（信号提前出现，无人消费的窗口被拉长）。你没法控制方向，所以只能不依赖这个数。

**那为什么不用 `COUNT(*)`？**

因为贵。千万级表上 `COUNT(*)` 要扫索引或全表，可能几十分钟，而且是对线上加负载——gh-ost 存在的意义就是尽量减小影响，所以它默认拿精度换速度。

`--exact-rowcount` 就是显式要求这个精度：

```sql
select /* gh-ost */ count(*) as count_rows from db.t
```

但它也有边界：**它准确的是"开始拷贝那一刻"**。如果迁移期间表继续增长，实际拷贝行数仍会超过这个数。gh-ost 用 `RowsDeltaEstimate` 在回放 binlog 时按 insert/delete 的净增减做修正，但那只是近似。所以 `--exact-rowcount` 降低风险，不是消除。

**自己验证一下本实例的偏差：**

```sql
-- 1. 采样配置（MySQL 8.0 默认 20 页）
SHOW VARIABLES LIKE 'innodb_stats%';

-- 2. 优化器的估算
EXPLAIN SELECT * FROM db.t WHERE 1=1;

-- 3. 持久化统计里的 n_rows 及其最后更新时间
SELECT table_name, n_rows, last_update
FROM mysql.innodb_table_stats
WHERE database_name = 'db' AND table_name = 't';

-- 4. 与真实值对比（大表请在从库或低峰执行，或直接用 --exact-rowcount）
SELECT COUNT(*) FROM db.t;
```

顺带一个坑：`EXPLAIN ANALYZE` 能给出实际行数，但**它会真的执行查询**——拿它去跑千万级全表扫描，本身就是一次事故。

**根子上的错误是把两个不同的生命周期绑在了一起：** "我解析到逻辑完成了"和"这个进程结束、管道关掉了"是两件事。前者是 gh-ost 基于估算得出的业务判断，后者是进程事实。代码用一个信号同时表达两者，就必然在某一天错——而且错的方式是**静默挂起，不是报错**。

## 修复：让 reader 只管读到 EOF

```diff
 func (s *session) execCommand(...) {
 	f := func(reader *bufio.Reader) {
+		defer wg.Done()
 		for {
 			line, err2 := reader.ReadString('\n')
 			if err2 != nil || io.EOF == err2 {
-				wg.Done()
 				break
 			}
 			if s.ghost.GhostOn {
-				if strings.Contains("[info]", line) {
+				if strings.Contains(line, "[info]") {
 					continue
 				}
 				buf.WriteString(line)
-				if ok := s.mysqlAnalyzeGhostOutput(line, p); ok {
-					wg.Done()
-					break
-				}
+				s.mysqlAnalyzeGhostOutput(line, p)
 			} else {
 				buf.WriteString(line)
 				s.mysqlAnalyzeOscOutput(line, p)
 ```

三处改动，每处对应一个判断：

- **reader 不再因"逻辑完成"退出**，只读到 EOF（进程真正结束）才退出。管道始终有人消费，反压死锁消失。进度判断的返回值不再承担控制流的职责——它只影响 UI 上显示什么。
- **`defer wg.Done()`** 让 `wg` 的释放与循环退出解耦。原来的写法有两个 `wg.Done()` 出口，靠手动配对，多一条退出路径就可能漏一次或重复一次。
- **`strings.Contains` 参数顺序**：原文是 `strings.Contains("[info]", line)`，判断的是"字面量 `[info]` 里是否包含这一行"。除了空行，永远为假。

**为什么 3 行够用？** 因为问题不是逻辑复杂，而是一个职责边界画错了。一旦把"解析进度"和"管理管道生命周期"分开，剩下的就是删代码。

## 顺带发现的第二个 bug

第三处改动是这次定位的副产品，但它可能比死锁更值得说：**`strings.Contains("[info]", line)` 参数反了，导致 `[info]` 过滤从来没生效过。**

死锁会让人立刻发现（任务挂了），而这个过滤失效是**静默的**：所有 `[info]` 行都被塞进了 `buf`，还会被送进 `mysqlAnalyzeGhostOutput` 参与进度解析。没有报错、没有异常，只是行为一直和设计意图不一致。

这类 bug 有个共同特征：**它的后果是"多一些噪音"，而不是"出错"**，所以能在生产环境里潜伏很久。修死锁的时候顺手 grep 了一遍同函数内的字符串操作，才发现参数顺序是反的。

## 取舍

有两种看起来更"正规"的修法，我都没选：

- **用 `context` 取消，让 `cmd.Wait()` 带超时。** 治标——超时后 gh-ost 仍在写管道，进程残留，只是把"挂住"变成了"报错退出 + 孤儿进程"。
- **在进度到 100% 时主动 kill gh-ost。** 更危险：进度是估算出来的，100% 不代表复制完成，这时候 kill 就是在数据不一致的状态下中断改表。

选择 drain 到 EOF，代价是任务结束前多读一段日志、多一点内存。**换来的是"任何情况下管道都有人消费"这个不变量**——不依赖进度估算是否准确。对一个正确性优先的改表工具，这个交换是划算的。

> 想先弄懂 gh-ost 的整体机制（影子表、row-copy、binlog 回放、cut-over），可以看[《gh-ost 原理及源码解析》](/gh-ost/gh-ost-principles-and-source)——那个管道就是这篇文章 2.3 节里"应用 binlog"那一步的底座。
