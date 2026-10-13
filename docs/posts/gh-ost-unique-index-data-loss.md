---
title: gh-ost 加唯一索引为什么会静默丢数据
---

# gh-ost 加唯一索引：一次"成功"的迁移，7 行只剩 2 行

::: warning 一句话结论
用 gh-ost 给已有列加唯一索引时，它**不会报错、也不会失败，而是静默地少数据**。上游为这件事争论了六年，v1.1.8 才给出修复——但**默认关闭**，必须显式加 `--panic-on-warnings`。
:::

## 一、现象：迁移报告 Done，数据却少了

[issue #825](https://github.com/github/gh-ost/issues/825) 是这个 bug 最干净的复现。一张 7 行的表，`name` 列有若干大小写不同的值，执行：

```sql
alter table users
  change `name` `name` varchar(255)
    character set utf8mb4 collate utf8mb4_unicode_ci not null,
  add unique index `index_users_on_name` (`name`)
```

gh-ost 的日志一路 INFO，最后 `Done migrating`，**没有任何错误或警告**。然后看数据：

| 原表（迁移后成了 `_users_del`） | 迁移后的 `users` |
| --- | --- |
| `14 hoge` | ✅ `14 hoge` |
| `15 Hoge` | ❌ **丢失** |
| `16 HOge` | ❌ **丢失** |
| `17 HOGe` | ❌ **丢失** |
| `18 HOGE` | ❌ **丢失** |
| `19 piyo` | ✅ `19 piyo` |
| `20 piyO` | ❌ **丢失** |

**5 行在"成功"的迁移里消失了**：7 行变 2 行。注意例子里同时改了排序规则（`utf8mb4_bin` → `utf8mb4_unicode_ci`），这让原本"不同"的值在新规则下变成了重复值——这一点在第七节会变成一个很关键的排查提醒。

## 二、为什么 ALTER 本身不报错

如果手工执行那条 ALTER，MySQL 会当场拒绝：

```sql
ERROR 1062 (23000): Duplicate entry 'hoge' for key 'index_users_on_name'
```

但 gh-ost 的做法是**先建一张空表再 ALTER**：

```sql
create table db.t_gho like db.t;
alter table db.t_gho add unique index `index_users_on_name` (`name`);
```

空表上没有任何数据能违反唯一约束，所以这一步必然成功。**约束是在迁移过程中、数据流进来的时候，才第一次被真正触发的。**这也解释了为什么 gh-ost 的 ALTER 阶段看起来一切正常。

## 三、数据是在两步里丢掉的

### 第一步：行拷贝用的是 `INSERT IGNORE`

gh-ost 把数据从原表批量拷到影子表时，生成的语句是 `insert ... ignore`：

```sql
insert /* gh-ost db.t */ ignore into db.t_gho (id, name)
(
    select id, name
    from db.t force index (`PRIMARY`)
    where ...
)
```

`IGNORE` 的语义是"遇到唯一键冲突就跳过这行、不报错"。于是拷贝那 7 行时，5 行因为 `name` 重复被静默跳过，影子表里只剩 2 行。

**而且这个 `IGNORE` 是必须的。** 因为 gh-ost 里 binlog 回放的优先级高于行拷贝（见[《gh-ost 原理及源码解析》](/posts/gh-ost-principles-and-source)的 2.3 节），某一行可能已经被 binlog 事件写进影子表了，拷贝语句再插一次就会撞键——没有 `IGNORE` 就会直接报错。

### 第二步：binlog 回放用的是 `REPLACE INTO`（v1.1.8 已修）

在 v1.1.8 之前，binlog 事件回放生成的是 `REPLACE INTO`：

```sql
replace /* gh-ost db.t */ into db.t_gho (id, email) values (3, 'bob@example.com')
```

`REPLACE` 的语义是**"遇到任何唯一键冲突，先把冲突行删掉，再插入"**。所以在批量拷贝完成之后（比如 `--postpone-cut-over-flag-file` 拖住 cut-over 的期间），业务又插入一行重复值时：

| 时刻 | 原表 | 影子表 |
| --- | --- | --- |
| 拷贝完成后 | `(1, 'bob@…')`<br>`(2, 'alice@…')` | `(1, 'bob@…')`<br>`(2, 'alice@…')` |
| 业务插入 | `(1, 'bob@…')`<br>`(2, 'alice@…')`<br>**`(3, 'bob@…')`** | 不变 |
| 回放 binlog<br>`REPLACE INTO … (3, 'bob@…')` | 同上 | **`(1, …)` 被删除**<br>`(2, 'alice@…')`<br>`(3, 'bob@…')` |

**`id=1` 这一行凭空消失。** 而 `REPLACE` 的这次删除**不产生任何 warning 或 error**——这正是 [issue #1636](https://github.com/github/gh-ost/issues/1636) 标题里那句"even when using PanicOnWarnings"：你明明开了告警开关，它却抓不到。

**两条路径叠在一起，就是"报告成功、数据变少"的完整解释。**

## 四、上游六年的态度：这是"预期行为"

2020 年 #825 里，maintainer 的答复很直接：

> yes this is expected behavior. I would advise you to proceed very carefully when adding a unique index with a tool like gh-ost. **Verify that the table really has unique values, and that the application won't write duplicate values, before proceeding with the alter.**

也就是说，gh-ost 把"数据是否真的唯一"这个判断**完全推给了使用者**。这个假设一旦不成立，代价是静默的数据丢失——没有报错，你甚至不知道该去核对。

社区一直在推动它改变默认行为，但进展缓慢：

| Issue | 状态 | 诉求 |
| --- | --- | --- |
| [#477](https://github.com/github/gh-ost/issues/477) | **open** | 加唯一索引时**默认**失败 |
| [#912](https://github.com/github/gh-ost/issues/912) | open | 修复加唯一键的数据完整性问题 |
| [#1526](https://github.com/github/gh-ost/issues/1526) | closed | gh-ost lose data with UNIQUE KEY |
| [#1556](https://github.com/github/gh-ost/issues/1556) | open | migration-on-replica cut-over 后从库报 `HA_ERR_FOUND_DUPP_KEY` |

## 五、修复：把"静默删除"换成"响亮失败"

[PR #1633](https://github.com/github/gh-ost/pull/1633)（merged 2026-03-09，随 **v1.1.8** 发布）做了两件事。

**一、回放语句从 `REPLACE INTO` 改成 `INSERT IGNORE INTO`**

```diff
 	stmt := fmt.Sprintf(`
-		replace /* gh-ost %s.%s */
+		insert /* gh-ost %s.%s */ ignore
 		into
 			%s.%s
 			(%s)
```

`INSERT IGNORE` 遇到唯一键冲突只是**跳过插入**，不会删除已有行，并且会**产生一条 warning**——这就为下一步提供了可检测的信号。`REPLACE` 的问题恰恰在于它"太成功"：既删了行，又什么都没说。

**二、开启 `--panic-on-warnings` 时，检查 warning 并区分两类冲突**

每批 DML 执行后读取 `SHOW WARNINGS`，然后分两种情况处理：

- 撞的是**迁移自身的唯一键**（gh-ost 用来切分 chunk 的那个键，通常是主键）→ **预期之内，忽略**。这行在批量拷贝阶段已经拷过了，跳过插入是正确的。
- 撞的是**其它唯一索引**（也就是你正在新增的那个）→ **收集起来，回滚事务，让迁移失败**。

于是你会看到明确的报错，而不是一个"成功"：

```text
# 行拷贝阶段
ApplyIterationInsertQuery failed because of SQL warnings: [Warning: Duplicate entry 'hoge' for key 'index_users_on_name' (1062)]

# binlog 回放阶段
warnings detected in statement 3 of 10: [Warning: Duplicate entry 'bob@example.com' for key 'users_gho.email_unique' (1062)]
```

> 实现上还有个细节值得记一笔：`SHOW WARNINGS` 只反映**最后一条**语句的告警，而 gh-ost 是把一批 DML 合并成 multi-statement 发送的。所以修复必须把语句改成 `stmt1; SHOW WARNINGS; stmt2; SHOW WARNINGS; …` 交错执行，否则批中间那些语句的告警会被吞掉。这是初版 PR 作者在 review 里自己指出、后来才补上的。

## 六、为什么 `INSERT IGNORE` 是安全的（一次有价值的技术分歧）

替换 `REPLACE` 这个方向，一开始被 maintainer 否决了：

> Unfortunately we can't use `INSERT IGNORE` instead of `REPLACE INTO` because **the binlog applier must overwrite rows that were copied to the ghost table.** The binlog applier is responsible for inserting the latest version of the row, while `INSERT IGNORE` would keep the old one.

这个担心是合理的：如果一行先被行拷贝写进影子表，随后 binlog 里有一条针对它的**更新**，而回放用的是 `INSERT IGNORE`，那这次更新就会被跳过，影子表留下旧值——那是另一种数据错误。

作者的反驳给出了关键事实：**UPDATE 事件不会走 INSERT 语句。**

```text
binlog InsertDML → NewDMLInsertQueryBuilder → insert ignore
binlog UpdateDML → NewDMLUpdateQueryBuilder → update
binlog DeleteDML → NewDMLDeleteQueryBuilder → delete
```

gh-ost 对三类事件分别建语句，只有 Insert 事件会生成 `insert ignore`。所以：

- **UPDATE 仍然照常覆盖**，不存在"旧值被留下"的问题；
- 对 INSERT 事件跳过插入是正确的——**如果这行已经在影子表里，说明行拷贝已经读过它，而拷贝读到的是当前（不早于该 INSERT）的值**。

作者把三种时序（binlog 先／拷贝先／带 update）都列了一遍，maintainer 复核后确认："Aha I forgot that, then it does seem OK."

**这个分歧值得记住的原因**：直觉上"把 `REPLACE` 换成 `INSERT IGNORE` 会丢掉更新"听起来完全成立，只有把三类事件分别看，才知道它只影响 INSERT 路径。改一个语义很强的 SQL 关键字之前，先确认它在代码里**实际覆盖了哪些路径**。

## 七、所以现在该怎么做

**先确认版本。** 修复包含在 **v1.1.8 及以上**：

```bash
gh-ost --version   # 需要 >= 1.1.8
```

**再打开开关。** 这一点最重要——`--panic-on-warnings` **默认为 `false`**，官方文档写的是：

> While `panic-on-warnings` is currently disabled by defaults, **it will default to `true` in a future version of `gh-ost`.**

也就是说在这个开关变成默认之前，**不显式加上它，gh-ost 的行为和六年前没有区别：依然静默丢数据。**（这也是 #477 至今还开着的原因。）

```bash
gh-ost \
  --panic-on-warnings \
  --alter="add unique index idx_email (email)" \
  ...
```

**加唯一索引前，自己查一遍重复。** 注意一个很容易漏的点：**必须按目标排序规则比较**，否则查不出来。上面 #825 那个例子里，`hoge` / `Hoge` / `HOge` / `HOGe` / `HOGE` 在原来的 `utf8mb4_bin` 下**是不同的值**，只有换成 `utf8mb4_unicode_ci` 之后才互相重复——按原排序规则去查，你会得到"没有重复"的结论，然后迁移丢数据。

```sql
-- 用「目标」排序规则查，而不是当前排序规则
select name collate utf8mb4_unicode_ci as k, count(*) as dup
from users
group by k
having dup > 1
order by dup desc
limit 20;
```

同理，如果迁移里同时改了字符集或排序规则、改了列类型、或者加了生成列，都要按**变更之后**的口径去检查数据是否满足新的唯一约束。

**最后，把这三件事当成前置条件而不是可选项：** 版本 ≥ 1.1.8、显式开 `--panic-on-warnings`、按目标排序规则确认无重复。缺任何一条，你都是在赌。

## 参考

1. [github/gh-ost#1633 — Fix data loss when inserting duplicate values during a migration](https://github.com/github/gh-ost/pull/1633)（merged）
2. [github/gh-ost#1636 — Adding unique indexes causes data loss even when using PanicOnWarnings](https://github.com/github/gh-ost/issues/1636)
3. [github/gh-ost#825 — gh-ost doesn't fail when unique key is added - maybe intended?](https://github.com/github/gh-ost/issues/825)（含完整的复现与 maintainer 说明）
4. [github/gh-ost#1500 — PanicOnWarnings option to detect SQL warnings and fail the copy process](https://github.com/github/gh-ost/pull/1500)
5. [gh-ost v1.1.8 release notes](https://github.com/github/gh-ost/releases/tag/v1.1.8)
6. [gh-ost 命令行参数：panic-on-warnings](https://github.com/github/gh-ost/blob/master/doc/command-line-flags.md)
