---
title: fs.aio-max-nr 耗尽：一次 MySQL 实例初始化失败的根因分析
date: 2026-10-14
---

# fs.aio-max-nr 耗尽：一次 MySQL 实例初始化失败的根因分析

::: warning 一句话结论
新建 MySQL 实例反复重启，不是参数、镜像或存储的问题——是**节点级内核 AIO 事件配额被现有实例占满了**。

节点上的 `fs.aio-max-nr` 仍是内核默认值 65536，而几十个开着 `innodb_use_native_aio=ON` 的 mysqld 已经把水位推到接近 99%。新实例在 InnoDB 初始化阶段申请 slot 时得不到满足，内核返回 `EAGAIN`；InnoDB 重试 5 次后放弃，`--initialize` 以 exit 1 退出，初始化入口 panic，容器进入无限重启。
:::

关键认知：**CPU 和内存还有余量，不代表这个节点还能再起一个实例。AIO 配额是独立于 CPU、内存、Pod 数的第三种节点资源，而且完全不被 Kubernetes 调度器感知。**

## 现象：容器无限重启，panic 里没有任何错误

容器日志呈现典型的三段式，每十几秒重复一次：

```text
panic: Prepare mysql env failed: output: , err: exit status 1
goroutine 1 [running]:
main.main()
mysql_dir_initialize failed
WARN exited: mysqld (exit status 1; not expected)
INFO spawned: 'mysqld' with pid ...
INFO  Check dir initialized: .../.initialized is exist: false
INFO  Init mysqld dir
```

两个容易把人带偏的细节：

**一、panic 里的 `output` 是空的。** mysqld `--initialize` 的错误并不写到 stdout / stderr，而是写进 datadir 下的 `log_error.err`。只看容器日志，会误以为"mysqld 什么都没输出"，从而把方向引向镜像、挂载或权限。

**二、重启是无退避的无限循环。** 镜像内的 supervisord 配置为 `autorestart=true`、`startretries=9999`、`startsecs=10`，每次重启都重新执行初始化和 `--initialize`，失败后立刻再来一轮。日志里的时间间隔正是这个重试节奏。

## 定位：真实错误不在容器日志里

按"哪里能拿到子进程的原始输出"去找，四步就收敛了：

| 步骤 | 动作 | 结果 |
| --- | --- | --- |
| 1 | 看 Pod 状态与容器日志 | 反复重启，只有 `exit status 1`，`output` 为空 |
| 2 | 进 datadir 看 `log_error.err` | 找到 `io_setup() failed with EAGAIN after 5 attempts` / `Cannot initialize AIO sub-system` |
| 3 | 读节点的 AIO 计数 | `aio-nr` 已逼近 `aio-max-nr`，水位接近 99% |
| 4 | 排除其他因素 | CPU / 内存 request 仍有富余；磁盘、镜像、权限均正常；失败点固定在 InnoDB 的 AIO 初始化 |

取证命令很短：

```bash
# 节点全局 AIO 配额（在节点上任意 Pod 内执行，结果相同）
kubectl exec <pod-on-node> -- sh -c 'cat /proc/sys/fs/aio-nr; cat /proc/sys/fs/aio-max-nr'

# mysqld 的真实初始化错误
kubectl exec <pod> -- tail -n 100 <datadir>/log_error.err
```

第 2 步是关键：**容器日志里那个空的 `output` 不等于"没有错误"，只等于"错误没被转发到这里"。**

## 根因：AIO 配额是第三种节点资源

### AIO 是什么

**AIO = Asynchronous I/O**，描述的是"发起 I/O 之后要不要原地等结果"。

- **同步 I/O**：线程发起 read/write 后阻塞，直到数据就绪。一个线程同时只有一个在途请求，想并发只能多开线程。
- **异步 I/O**：发起后立即返回，内核在完成时通过事件通知。一个线程可以同时挂几十上百个在途请求，用更少的线程把磁盘队列压满。

数据库是重 I/O 负载：InnoDB 要并发发起大量随机读、脏页刷盘和 redo 写，天然适合异步模型。开启 `innodb_use_native_aio=ON` 后，InnoDB 用的是 Linux 原生 AIO（libaio）：

| 系统调用 | 作用 |
| --- | --- |
| `io_setup(nr_events, &ctx)` | 创建 AIO 上下文，**一次性预定** `nr_events` 个事件槽位 |
| `io_submit(ctx, ...)` | 提交读/写请求，立即返回 |
| `io_getevents(ctx, ...)` | 取回已完成的请求 |
| `io_destroy(ctx)` | 销毁上下文，释放槽位 |

"event slot" 可以理解为内核登记的"在途请求位"：提交一个 I/O 占一个，完成后释放。槽位不是免费的——内核要为每个完成事件维护数据结构，所以总量必须设上限。这就引出了下面四道限制。

### 限制一：配额是节点级全局的，没有隔离

Linux 用两个全局计数管理 AIO 事件：

| 文件 | 含义 |
| --- | --- |
| `/proc/sys/fs/aio-nr` | 节点当前已分配的 AIO event 总数（只读） |
| `/proc/sys/fs/aio-max-nr` | 节点允许分配的上限（可写，内核默认 65536） |

这两个值属于整机内核，**不随 namespace / cgroup 隔离，也不在 Kubernetes 的资源模型里**。

于是出现一个反直觉的局面：Pod 的 CPU / 内存 request 还有充足余量，调度器认为装得下，但新实例就是起不来。kubelet、koordinator 这类组件都不会为 `fs.aio-nr` 做预留或打分——**这是本次故障能够发生的结构性前提**。

### 限制二：启动时一次性预占，闲着也占着

`io_setup()` 是在进程启动时按最大可能并发量一次性预定的，不是"用多少申请多少"。申请成功立即计入 `fs.aio-nr`，直到进程退出才释放。

- 实例即使完全空闲、没有实际 I/O，也仍然占着配额；
- 单实例占用量由 `innodb_read_io_threads` / `innodb_write_io_threads`（每个 I/O 线程的待处理请求数）与实例规格共同决定，实测约 **0.7K–1.8K**；
- 所以**按 Pod 数估算容量必然失准**，必须看 `aio-nr` 的实际占用。

### 限制三：只影响新进程，不影响存量

配额不足时，失败的是"新发起 `io_setup` 的进程"，已启动的实例不受影响。这解释了"老实例全都正常、只有新实例起不来"的现象，也意味着**重启不会自愈**——其他实例不会主动释放槽位，重试多少次结果都一样。

### 限制四：默认上限偏低，且不会自动扩容

`fs.aio-max-nr` 的内核默认值只有 65536，不会随节点规格或 Pod 密度自动调整。高密度 MySQL 节点如果不显式调大，很容易被占满。安全线是：

```text
aio-nr + 单实例占用 ≤ 80% × aio-max-nr
```

**超过 85% 就应该视为危险。** 本次现场的水位已接近 99%，远超危险线——任何新建动作都注定失败。

### 容易混淆的三个点

| 常见误解 | 事实 |
| --- | --- |
| "AIO 是更快的 I/O" | 它提升的是并发度和线程效率，不是单次 I/O 的延迟 |
| "`innodb_use_native_aio=OFF` 就是关掉异步 I/O" | 实际是退化为"模拟 AIO"（用后台线程池模拟），功能还在但并发能力下降，只适合临时救急 |
| "glibc 的 `aio_read` / `aio_write` 就是同一套东西" | 那是 POSIX AIO，历史上多用用户态线程模拟；InnoDB 用的是 libaio 原生接口。更新的替代是 `io_uring`（Linux 5.1+），但 MySQL 8.0 默认仍走 libaio |

### 失败路径：内核直接返回 `EAGAIN`

内核的判断条件近似为：

```text
fs.aio-max-nr - fs.aio-nr < 本次 io_setup 请求量   →   返回 -EAGAIN
```

InnoDB 对 `EAGAIN` 重试 5 次，仍失败则放弃初始化，在 `log_error.err` 里留下：

```text
[ERROR] [InnoDB] io_setup() failed with EAGAIN after 5 attempts.
[ERROR] [InnoDB] Cannot initialize AIO sub-system
```

随后 `mysqld --initialize-insecure` 以 exit 1 退出。

必须强调：**这是确定性失败，不是抖动。** 其他实例不会主动释放槽位，所以无论重启多少次、间隔多久，结果完全一样——这也解释了为什么"删 Pod 重建"看起来毫无效果。

### 因果链

```text
节点实例密度持续上升，每个 mysqld 启动时预占一批 AIO slot
        ↓
fs.aio-nr 逼近 fs.aio-max-nr（内核默认 65536）
        ↓
新实例进入 InnoDB 初始化，io_setup() 申请 slot
        ↓
剩余量 < 本次申请量   →   内核返回 EAGAIN
        ↓
InnoDB 重试 5 次后放弃：Cannot initialize AIO sub-system
        ↓
mysqld --initialize 以 exit 1 退出
        ↓
初始化入口 panic（output 为空，真实原因在 log_error.err）
        ↓
supervisord 无限重启，实例状态永远无法就绪
```

## 信息损失：真实错误被初始化入口吞掉了

初始化入口只捕获子进程的 stdout / stderr 并拼接进 panic 信息。由于 mysqld 的初始化错误写的是 `log_error.err`，panic 里只剩下：

```text
output: , err: exit status 1
```

**这是本次排查中最大的信息损失点，直接拉长了 MTTR。** 正确做法是 panic 时同时输出 `<datadir>/log_error.err` 的尾部内容——一个改动就能把这类故障从"小时级定位"降到"分钟级"。

## 处置：调大配额，而不是改 MySQL 参数

```bash
# 1) 临时生效
sysctl -w fs.aio-max-nr=262144

# 2) 持久化
cat >/etc/sysctl.d/99-mysql-aio.conf <<'EOF'
fs.aio-max-nr = 262144
EOF
sysctl --system

# 3) 验证
cat /proc/sys/fs/aio-max-nr   # 期望 262144
cat /proc/sys/fs/aio-nr       # 仍为原值，说明已有实例的预占不变
```

调整后让实例重新走初始化流程，确认 `log_error.err` 中不再出现 `EAGAIN`，且 `.initialized` 正常生成。

容量按公式估，而不是拍一个数：

```text
aio-max-nr ≥ 节点所有 mysql 实例的预占总和 ÷ 0.8
```

按单实例约 0.9K slot、80% 安全线估算，262144 大约能支撑两百多个实例；如果单节点密度还会继续上升、或实例规格跨度更大，可以直接评估 1048576。

**必须对整个节点池统一调整，并固化到节点镜像或初始化脚本里。** 只改一台节点只是把故障点挪到下一台；新扩容的节点如果仍带默认值 65536，故障会原地复现。

### 兜底：把实例迁到低水位节点

如果没有调参窗口，可以先迁走实例削峰。但迁移有几条红线：

- **只迁 secondary，绝不动主库。** 主库换节点会让注册中心里记录的地址失效，集群可能永久卡在 `ErrorSlave`。
- 数据卷是**节点本地盘**，删 Pod 重建会丢数据，只能走在线扩容恢复流程。
- 目标节点端口必须空闲（实例使用 hostNetwork 固定端口），否则 Pod 会永久 Pending。
- 缩容时 `replicas` 与 `offlineInstances` 必须在同一次 patch 中提交，否则中间态会被控制器解释成另一个动作。
- **迁移只削峰、不增加总容量。** 全池水位 ≥ 80% 时，必须调大 `fs.aio-max-nr` 或扩节点。

### 不推荐的应急方案

| 方案 | 效果 | 代价 |
| --- | --- | --- |
| `innodb_use_native_aio=OFF` | 绕过 `io_setup`，实例能启动 | 退化为模拟 AIO，I/O 性能明显下降；要改配置并重启实例 |
| 调小 `innodb_read_io_threads` / `innodb_write_io_threads` | 降低单实例预占，腾出配额 | I/O 并发能力下降，且需要滚动重启才生效 |

这两个方案本质都是"用性能换启动"，只适合救急。根因仍是节点配额不足，迟早要回到调大配额或扩容节点。

## 改进措施

| 优先级 | 方向 | 改进项 | 预期收益 |
| --- | --- | --- | --- |
| P0 | 可观测 | 初始化入口 panic 时附带 `<datadir>/log_error.err` 尾部 | 直接看到 `EAGAIN`，MTTR 从小时级降到分钟级 |
| P0 | 前置校验 | 初始化前检查 `aio-nr + 单实例预估 ≤ 80% × aio-max-nr`，不满足时输出明确原因 | 避免无意义的重试风暴 |
| P0 | 监控告警 | 采集 `/proc/sys/fs/aio-nr`（node-exporter textfile 或 DaemonSet 上报），80% 告警、85% 高危 | 在故障发生前发现水位异常 |
| P0 | 节点基线 | 所有 MySQL 专属节点统一设置 `fs.aio-max-nr` 并持久化到 `/etc/sysctl.d/`，固化进镜像 | 新节点不再带默认值上线 |
| P1 | 重试治理 | `startretries=9999` 改为有限次数 + 退避；失败原因写入 Pod condition / 实例状态 | 避免无限 panic，问题更易被发现 |
| P1 | 调度建模 | 把节点 AIO 余量纳入调度或准入校验（node label + webhook，或 extended resource） | 从源头阻止"CPU/内存够、AIO 不够"的调度 |
| P1 | 容量模型 | 用 `aio-nr` 而不是 Pod 数做容量规划，安全线 80%、禁止超过 85% | 容量决策与真实约束对齐 |
| P2 | 参数规范 | 明确高密度节点池的 I/O 线程配置与单实例 slot 预算 | 降低单实例预占的不确定性 |

## 经验与常见误区

| 误区 | 事实 |
| --- | --- |
| "CPU / 内存还有余量，就能再起一个实例" | AIO 配额是独立维度，调度器完全不感知 |
| "重启几次也许就好了" | 槽位被其他实例持续占用，失败是确定性的 |
| "panic 的 output 为空，说明 mysqld 没报错" | 错误写在 datadir 的 `log_error.err` 里 |
| "把 Pod 删了重建就行" | 数据卷是节点本地盘，删 Pod 会丢数据，必须走迁移 / 恢复流程 |
| "把实例迁走就彻底解决了" | 迁移只改变分布，不增加池子总容量；全池高水位必须调参数或扩节点 |
| "`sysctl -w` 改完就一劳永逸" | 不写入 `/etc/sysctl.d/` 的话，节点重启后会恢复默认值 |

## 附录：一分钟判断清单

满足以下全部条件，即可判定为"节点 AIO 配额耗尽"：

- [ ] 新建实例反复重启，日志出现 `... failed` / `exit status 1`
- [ ] panic 信息中的 `output` 字段为空
- [ ] `log_error.err` 中存在 `io_setup() failed with EAGAIN` 或 `Cannot initialize AIO sub-system`
- [ ] 节点 `fs.aio-nr / fs.aio-max-nr` ≥ 85%

```bash
# 节点全局 AIO 配额
cat /proc/sys/fs/aio-nr
cat /proc/sys/fs/aio-max-nr

# 真实初始化错误
tail -n 100 <datadir>/log_error.err

# 调大并持久化
sysctl -w fs.aio-max-nr=262144
echo 'fs.aio-max-nr = 262144' >/etc/sysctl.d/99-mysql-aio.conf
sysctl --system
```
