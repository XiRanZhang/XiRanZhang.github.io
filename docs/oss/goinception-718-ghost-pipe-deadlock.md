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

`execCommand` 为 stdout / stderr 各起了一个 reader goroutine，读到的每一行交给 `mysqlAnalyzeGhostOutput`，由它从 gh-ost 的输出里解析复制进度。出问题的是这个判断：

```go
if ok := s.mysqlAnalyzeGhostOutput(line, p); ok {
    wg.Done()      // 分析器说"完成了"
    break          // 于是 reader 直接退出
}
```

`mysqlAnalyzeGhostOutput` 返回 `true` 的条件是 **进度 ≥ 100%**。而进度来自 gh-ost 自己的输出，gh-ost 的行数又来自 InnoDB 基于 `EXPLAIN` 的估算。

**`EXPLAIN` 的估算可以严重偏离实际行数。** 这次是估算 1270 万、实际 7000 万——于是进度条早早就冲到了 100%，而此时真正的数据复制才走了不到五分之一。

于是：

1. 两个 reader 都拿到"完成"信号 → 各自 `wg.Done()` 然后退出
2. `wg.Wait()` 返回，代码顺序走到 `cmd.Wait()`
3. 但 gh-ost **还在跑**，还在往 stdout 写
4. 没有消费者了 → 64KB 管道缓冲写满 → gh-ost 阻塞在 `write()`
5. `cmd.Wait()` 永远等不到 gh-ost 退出

**根子上的错误是把两个不同的生命周期绑在了一起：** "我解析到逻辑完成了" 和 "这个进程结束、管道关掉了" 是两件事。前者是业务判断，后者是进程事实，代码把它们当成了同一个信号。

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

> 想先弄懂 gh-ost 的整体机制（影子表、row-copy、binlog 回放、cut-over），可以看[《gh-ost 原理及源码解析》](/posts/gh-ost-principles-and-source)——那个管道就是这篇文章 2.3 节里"应用 binlog"那一步的底座。
