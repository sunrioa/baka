<!--
  Licensed to the Apache Software Foundation (ASF) under one
  or more contributor license agreements.  See the NOTICE file
  distributed with this work for additional information
  regarding copyright ownership.  The ASF licenses this file
  to you under the Apache License, Version 2.0 (the
  "License"); you may not use this file except in compliance
  with the License.  You may obtain a copy of the License at

      http://www.apache.org/licenses/LICENSE-2.0

  Unless required by applicable law or agreed to in writing,
  software distributed under the License is distributed on an
  "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
  KIND, either express or implied.  See the License for the
  specific language governing permissions and limitations
  under the License.
-->

# Jev 决策层：设计与实施计划

> **状态：设计稿，尚未实施。** 本文档描述把 TypeSafe Jev 接入 Maka 的六个方案、
> 它们为什么按这个顺序排、以及每一个的落地步骤与验收标准。
>
> 代码和契约测试始终是最终权威；本文档与实现冲突时以实现为准。

## 目录

- [0. 摘要](#0-摘要)
- [1. Jev 是什么](#1-jev-是什么)
- [2. 为什么值得接：带外判断](#2-为什么值得接带外判断)
- [3. 两条约束](#3-两条约束)
- [4. 共享基础设施](#4-共享基础设施)
- [5. 六个方案](#5-六个方案)
- [6. 明确不做的](#6-明确不做的)
- [7. 实施流程](#7-实施流程)
- [8. 参考](#8-参考)

---

## 0. 摘要

Jev 是 TypeSafe 的 "System One" 模型：不生成文本，只返回**带校准概率的类型化判断**。
约 250ms、$0.042/M input token、output 免费。

Maka 里有三类位置适合它：

1. **一个正则在假装自己是分类器** —— `isLikelySandboxDenial` 是一条英文正则；
   `classifyGeneralizedError` 是 `lower.includes('timeout')`。
2. **现在要烧一次完整 LLM 调用** —— 记忆抽取、压缩时的取舍、召回排序。
3. **现在直接甩给用户** —— 沙箱边界弹窗。

排序不是按价值排的，是按**前缀缓存代价**排的（见 [§3.1](#31-前缀缓存)）。
这条约束推翻了直觉上最诱人的那个方案。

| # | 方案 | 缓存代价 | 工作量 |
|---|---|---|---|
| 1 | [Grep 密钥判断](#方案-1grep-密钥判断) | 零 | 小 |
| 2 | [带外核验三件套](#方案-2带外核验三件套) | 零 | 中 |
| 3 | [测试选择](#方案-3测试选择) | 零 | 小 |
| 4 | [压缩取舍策略](#方案-4压缩取舍策略) | 无额外 | 大 |
| 5 | [模型路由](#方案-5模型路由带滞回) | 高 | 中 |
| 6 | [改工具集的 turn 路由](#6-明确不做的) | **最高** | —— 不做 |

---

## 1. Jev 是什么

### 1.1 API

`POST /v1/systemone`

```json
{
  "state": "string | object | array",
  "model": "jev-latest",
  "questions": { "q_id": { "type": "...", "instructions": "...", "criteria": ... } }
}
```

三种问题类型：

| 类型 | criteria | 返回 |
|---|---|---|
| `noul` | `{"true": "...", "false": "..."}` | `{noul: 0.0..1.0}` 命题为真的概率 |
| `choice` | `{"选项名": "描述" \| null}` | `{choice, probabilities{}, confidence}` |
| `score` | `["低", "中", "高"]` | `{score: 0..N-1, legend, probabilities, confidence}` |

**同一个 `state` 上的多个问题并行执行，几乎不加开销。** 这一点对成本模型很关键：
批量问 10 个问题 ≈ 问 1 个的价钱和时间。

"校准"有确切含义：在大量预测上，模型给出 80% 概率的那些，约 80% 是对的。
训练方法是 RLCD（Reinforcement Learning for Calibrated Decisions），
优化目标就是校准本身，而不是人类偏好。

### 1.2 性能与限额

| 项 | 值 |
|---|---|
| 延迟 | ~250ms |
| 价格 | $0.042 / M input token；output 免费 |
| 吞吐 | 1200 req/min，250k token/s |
| 单请求预算 | 64k token；state + 最长问题合计 32k |
| state 实测上限 | ~107,500 字符（英文约 32,388 token） |
| Choice 选项数 | ≤ 255 |
| Score 档位数 | 2–10 |

对比：frontier 模型在同类分类任务上约 $0.03–$0.18/次、10–38 秒。

### 1.3 一个文档没写的坑

**位置索引不可靠。** 第三方在 320 项上实测：

| 引用方式 | 150 项/请求 | 25 项/请求 | 320 项/请求 |
|---|---|---|---|
| `candidates[i]` | **27% 指错** | 9% 指错 | —— |
| `candidates.k137`（键值对象）或把条目嵌进问题里 | —— | —— | **0% 指错** |

官方示例里就有 `items[i]` 的写法，且没有任何警告。

**本项目的硬性约定：批量场景一律用键值对象，禁止位置索引。**
下面每个批量方案的设计都遵守这条。

---

## 2. 为什么值得接：带外判断

便宜和快都不是最重要的性质。最重要的是：

> **Jev 能判断一样东西，而那样东西不进 agent 的上下文。**

今天 agent 要判断任何事，都得先把东西读进上下文。读进去就占预算、进 transcript、
发给模型厂商、并在之后每一轮重放。Jev 在**带外**判断。

这条性质有两个直接推论，贯穿全文：

1. **安全上**：可以问"这一行是不是密钥"而**那个密钥值从不进入 agent 上下文**。
   任何基于 LLM 的方案都没有这条性质——要判断就得先读进去。
2. **成本上**：大多数 Jev 集成对前缀缓存的影响是**零**，因为它们改变的是行为，
   不是 prompt 的字节。

---

## 3. 两条约束

### 3.1 前缀缓存

Maka 用 Anthropic 的 ephemeral 缓存（`packages/runtime/src/model-factory.ts`
里的 `cacheControl: { type: 'ephemeral' }`），并把 `cachedInputTokens` /
`cache_creation_input_tokens` 记进遥测。

规则：**改动位置 N 之后的全部作废。** Anthropic 的计价是缓存读 0.1x、缓存写 1.25x。

算一笔账。设上下文 10 万 token，淘汰掉位于第 2 万 token 处的一个 tool result：

| 做法 | 等效输入 token |
|---|---|
| 不动它（全部命中缓存） | 100k × 0.1 = **10k** |
| 淘汰它 | 20k × 0.1 + 80k × 1.25 = **102k** |

**贵约 10 倍——而这件事的目的本来是省上下文。**

每轮都淘汰就等于每轮冷启动，缓存形同虚设。

由此得出两条设计规则：

- **R1｜只追加，不回改。** 任何写进历史的东西，一旦追加就不再改动。
  这样前面的前缀永远命中。
- **R2｜作废要集中，不要摊薄。** 必须重写历史时，只在已经要作废的时刻做
  （即压缩点），而不是每轮做一点。

### 3.2 方向不变量

> **Jev 可以自由地增加摩擦；只能在确定性层已经允许的范围内减少摩擦。**

方向很要紧。概率模型往"放行"方向走是漏洞；往"这明显没问题，别再问了"方向走，
是在一个已经封顶的范围内改善体验，错了也就多一次弹窗。

具体到权限：Jev **永远不能**把 profile 拒绝的写入变成允许。它只能在确定性检查
已经判定"这在已授权的读范围内"之后，决定还要不要问用户。

**顺序不能反：先确定性判定，再概率减噪。**

参照：Codex 的 `DenyReadValidator`（`codex-rs/protocol/src/permissions/deny_read_validator.rs`）
是同一思路的硬化版——一个强制拒绝校验器，检查会话选定的 profile 有没有漏掉
必须的 deny 项，漏了就报 `MissingRequiredDeny`。那一层永远在概率层前面。

### 3.3 不该去的地方

校准的意思是"80% 置信 = 80% 正确"，反过来读就是**五次错一次**。

对于**不可逆且无人复核**的动作，这个数字在任何实际会设的阈值上都不可接受：

- 删除文件
- 推送远端
- 转账或任何金融动作
- 授予写权限

Jev 只属于那些"错了的代价是多弹一次窗 / 多读一次文件 / 多跑一次测试"的地方。

---

## 4. 共享基础设施

六个方案都依赖同一套底座。**这部分必须先做，且独立可测。**

### 4.1 客户端

位置：`packages/runtime/src/jev/client.ts`

```
JevClient
  ask(state, questions, opts): Promise<JevAnswers | undefined>
```

要求：

- **硬超时**，建议 500ms（约 2× p99）。超时返回 `undefined`，不抛异常。
- **不重试**。250ms 的东西重试没有意义，只会把延迟翻倍。
- **请求预算检查**：state 超过 ~100k 字符时分块，或直接放弃（返回 `undefined`）。
- **键值化助手**：`keyedState(items)` 把数组转成 `{k0: ..., k1: ...}`，
  杜绝 [§1.3](#13-一个文档没写的坑) 那个坑。类型上禁止直接传数组。

### 4.2 失败即今日行为

这是整套设计里最重要的一条工程规则：

> **每个 Jev 集成点在 Jev 不可用时的行为，必须精确等于今天的行为。**

含义：

- Jev 超时、报错、未配置密钥、开关关闭 —— 走同一条回退路径
- 回退路径就是现有代码，一行不改地保留
- 因此每个功能都可以**在运行时安全关闭**，上线风险接近零

具体到每个方案，"今天的行为"是什么会在各自的[实施步骤](#5-六个方案)里写明。

### 4.3 配置与开关

位置：沿用 `packages/core/src/settings.ts` 的既有形状。

```
jev: {
  enabled: boolean        // 总开关，默认 false
  apiKey?: string         // 走现有凭据存储，不落明文
  features: {
    grepCredentials: boolean
    writePreflight: boolean
    turnReview: boolean
    claimCheck: boolean
    compactionSelection: boolean
    modelRouting: boolean
  }
}
```

每个功能独立开关，全部默认关闭。总开关关掉时，客户端连构造都不做。

### 4.4 遥测

复用 `packages/runtime/src/telemetry/llm-call-usage.ts` 的形状。每次调用记录：

- `input_tokens`（Jev 返回的 usage）
- 延迟
- 是否超时 / 回退
- 该次判断的 **probability / confidence**
- **决策是否与回退路径不同**（关键指标，见下）

最后一项是判断一个功能值不值得留下的唯一依据：如果 Jev 的判断和现有启发式
99% 时候一样，那它只是在花钱买延迟。

### 4.5 校准验证

每个方案上线前，需要一份**标注过的固定样本集**（100–300 条），
用来测三件事：

1. **校准曲线**：把预测按概率分箱，每箱的实际正确率应贴近该箱的概率
2. **相对现有启发式的增量**：新抓到多少、新误报多少
3. **阈值选点**：在这份样本上，哪个阈值给出可接受的误报率

样本集放 `packages/runtime/src/jev/__fixtures__/`，随代码走。
**没有这份数据就不要合并** —— 否则无法回答"它到底有没有用"。

---

## 5. 六个方案

每个方案统一给出：现状 / 缺口 / 设计 / 缓存代价 / 实施步骤 / 验收 / 风险。

---

### 方案 1｜Grep 密钥判断

#### 现状

`packages/core/src/redaction.ts` 的 `redactContextCredentials()`（已实现）
在匹配行进入模型上下文前，按**格式**抹掉可识别的凭据：
`sk-` / `AIza` / `gh?_` / `xox?-` 前缀、PEM 私钥armor、authorization 头、
URL userinfo 与 query 凭据。

调用点：`packages/runtime/src/builtin-tools.ts` 的 Grep impl，
以及 `packages/runtime/src/bash-model-output.ts`。

#### 缺口

按格式识别必然漏掉没有格式的密钥：

```
DB_PASSWORD=hunter2
internal_token: 8f3a9c2e1b
```

这一点在实现的注释里已经写明是设计边界，不是 bug。

#### 设计

在正则之后追加一层 Jev Noul，**只增不减**：正则已经抹掉的不会回来。

```
state:     { l0: "src/a.ts:12:...", l1: "...", ... }   ← 键值对象，禁止数组
question:  noul
  instructions: 这一行是否包含一个真实的凭据值？
  criteria:
    true:  行内出现了一个实际的密钥、口令或令牌的值
    false: 只是变量名、占位符、示例值、环境变量引用，或普通代码
```

命中阈值以上的行，保留 `path:line:` 前缀，正文整体替换为 `[redacted]`
（Noul 只判断整行，不定位值的位置）。

`redacted` 标志沿用现有字段。

#### 缓存代价

**零。** 改写发生在结果首次追加进上下文时，历史不回改（规则 R1）。

#### 实施步骤

1. 建 [§4](#4-共享基础设施) 的客户端与开关
2. 建标注样本集：从本仓库和几个公开仓库抓 200 行，人工标注
3. 在 Grep impl 里的 `redactContextCredentials` 之后插入 Jev 调用
4. 超时 / 失败 / 开关关闭 → **直接返回正则的结果**（= 今天的行为）
5. 空结果集时跳过调用
6. 匹配行超过 state 上限时分块

#### 验收

- 样本集上：召回率相对纯正则提升 ≥ 20 个百分点
- 样本集上：对普通源码的误报率 ≤ 2%（误报会让模型看到不存在的文件内容）
- Grep p95 延迟增加 ≤ 300ms
- Jev 全量失败时，所有既有 Grep 测试仍然通过

#### 风险

| 风险 | 缓解 |
|---|---|
| 误报污染代码搜索结果 | 阈值按样本集选点；误报率进验收标准 |
| Grep 变慢 | 硬超时 500ms；超时即回退 |
| 成本 | 50 行匹配 ≈ 2k token ≈ $0.00008，可忽略 |

---

### 方案 2｜带外核验三件套

三个独立特性，共用"完全不碰 prompt"这个性质。

#### 2a. 写入预检

**现状**：`Write` / `Edit` / `apply_patch` 直接落盘。

**设计**：落盘前 Noul：

```
这个改动是否删除了一条错误处理路径、一处安全检查、或一条测试断言？
```

**不是门禁，是标记。** 命中时不阻断，而是在工具结果里附一条提示，
让模型在继续之前回头再读一遍。假阳性的代价是多读一次文件。

这符合[方向不变量](#32-方向不变量)：只增加摩擦。

#### 2b. 轮次自检

**现状**：一轮结束即结束。

**设计**：拿本轮 diff 对照用户最初那条消息 Score：

```
criteria: ["完成", "部分完成", "跑偏"]
```

高置信度的"部分完成"触发继续，而不是宣布完成。

这直接打在 agent 最常见的失败模式上——**提前收工并报告成功**。
今天没人做是因为每轮多一次 frontier 调用太贵。

#### 2c. 声明核对

**现状**：模型说"测试通过了"就是通过了。

**设计**：当本轮结论里出现可验证的断言时，拿实际工具输出 Noul：

```
这份输出是否支持这个说法？
```

**三件里最不成熟的一件** —— 难点在"从结论里抽出可验证断言"这一步本身
需要判断。建议最后做，或先限定在几个固定句式上。

#### 缓存代价

**三件都是零。** 完全带外，不产生任何进入 prompt 的内容。
（2a 的提示文本会进 prompt，但它是追加的，符合 R1。）

#### 实施步骤

1. 2a：在 `builtin-tools.ts` 的 Write / Edit impl 里，返回结果前插入
2. 2b：在轮次收尾处插入，需要拿到本轮 diff 与首条用户消息
3. 2c：暂缓，等 2a/2b 有了真实数据再评估
4. 三者各自独立开关

#### 验收

- 2a：在一组人工构造的"删掉了错误处理"的 diff 上，命中率 ≥ 80%；
  在正常重构 diff 上误报率 ≤ 10%
- 2b：在一组"明显只做了一半"的历史会话上，识别率 ≥ 70%
- 任一失败时，行为与今天完全一致

#### 风险

| 风险 | 缓解 |
|---|---|
| 2b 导致 agent 不肯停下来 | 硬上限：每轮最多触发一次继续 |
| 2a 提示噪音过多 | 阈值调高；统计"提示后模型真的改了"的比例 |

---

### 方案 3｜测试选择

#### 现状

完整 runtime 套件 3500+ 测试，跑一次数分钟到数十分钟。
仓库里已有 `apps/desktop/e2e-budget.json`，说明测试成本本来就是被关心的。

#### 缺口

改一行代码要等全量套件，或者靠人肉猜该跑哪个。

#### 设计

一个**开发脚本**，不进产品代码：

```
scripts/select-tests.mjs
  输入: git diff --name-only <base>
  输出: 按相关性排序的测试文件列表
```

对每个测试文件 Score：

```
criteria: ["无关", "可能相关", "很可能相关"]
```

先跑高分的，全量在后台继续。

**这是六个方案里风险最低的一个** —— 它连产品代码都不碰，
最坏情况是排序没用，退回全量。

#### 缓存代价

**零。** 完全不在 prompt 里。

#### 实施步骤

1. 列出所有测试文件（`packages/*/src/**/__tests__/*.test.ts`）
2. 按 state 上限分块，每块用键值对象
3. diff 的摘要（改动文件名 + 函数名）作为 state 的一部分
4. 输出排序列表；提供 `--top N` 参数
5. 不接 CI，先当本地工具用

#### 验收

- 在 20 个历史 commit 上回放：真正失败的测试，在前 10% 的推荐里命中 ≥ 90%
- 单次选择耗时 ≤ 5 秒（含分块）

#### 风险

| 风险 | 缓解 |
|---|---|
| 漏掉真正会失败的测试 | 全量始终在后台跑；这只改变顺序不改变覆盖 |

---

### 方案 4｜压缩取舍策略

#### 现状

`packages/runtime/src/history-compact-*.ts` 一族。上下文到阈值后触发压缩，
生成摘要替换历史。

同时 `packages/runtime/src/tool-result-archive.ts` 已有三种裁剪原因：

```
tool_result_pruned
stale_tool_result_pruned_before_compact
active_current_turn_tool_result_pruned_before_next_step
```

以及配套的归档 / 恢复。**基础设施已经全在了，缺的只是选择策略**
—— 现在是结构性的（陈旧度、大小）。

#### 缺口

摘要是有损的。一段被摘要掉的关键 tool result，模型后面再也拿不回原文。

#### 设计

在压缩点（**且仅在压缩点**，见规则 R2）批量 Score 每一项：

```
state:     { m0: <消息或工具结果摘要>, m1: ..., ... }   ← 键值对象
criteria:  ["无关", "可能有用", "承重"]
```

- "承重"的**保留原文**
- "可能有用"的截断
- "无关"的丢弃（仍在归档里，可恢复）

相比今天：同样的缓存行为（每次压缩作废一次），但保留质量更高
—— 存活下来的是按相关性选的**原文**，而不是一段有损摘要。

> 生态里的 `tamaratran/fast-jev-compaction` 收敛到的正是这个形态：
> "stale ones are dropped or truncated, **everything kept stays verbatim**"。

#### 缓存代价

**无额外代价。** 压缩本来就要重写历史、作废缓存。

#### 实施步骤

1. 先只做**观测模式**：在现有压缩旁边跑 Jev 打分，只记遥测不改行为
2. 用观测数据对比：Jev 会丢的东西，现有策略丢了吗？后来被恢复过吗？
3. 观测满意后再切换为生效
4. 归档保持不变 —— 误判可恢复，这是本方案敢做的前提

#### 验收

- 观测期 ≥ 50 次真实压缩
- 被 Jev 判为"无关"而后来又被恢复的比例 ≤ 5%
- 压缩后首轮的 token 数相对今天不增加

#### 风险

| 风险 | 缓解 |
|---|---|
| 丢掉承重内容 | 归档可恢复；先观测后生效 |
| 项目太多超 state 上限 | 分块；每块独立打分（相关性判断不需要全局视野） |

---

### 方案 5｜模型路由（带滞回）

#### 现状

模型是 session 级设置。一个"把这个变量改个名"的请求和一个"重构认证层"的请求
用同一套配置。

#### 设计

轮次开始时 Score 难度：

```
criteria: ["简单查找", "常规改动", "多文件重构", "需要设计判断"]
```

映射到模型和思考预算。

#### 缓存代价

**高，而且是本方案唯一的真问题。缓存按模型分——切一次，冷一次。**

因此必须加滞回：

- 只在 **session 开始**和**明确的任务边界**处路由
- 或要求**连续 N 轮**的判断一致才切换
- 或要求 `confidence > 0.8` 才切换

**工具集不能随路由改动。** 工具定义在 prompt 最前面，动一下 100% 作废
（这就是[方案 6](#6-明确不做的)被否决的原因）。

思考预算是请求参数而非前缀内容，理论上不作废缓存，
但 Anthropic 那边思考配置变化是否影响缓存键**需要实测**，不要当成已知。

#### 实施步骤

1. 先只做**观测模式**：打分、记遥测，不改实际模型
2. 对比：Jev 的难度判断和实际消耗（token 数、轮数、是否失败）相关吗？
3. 相关性成立后，先只做**向下**路由（难度低 → 换便宜模型），不做向上
4. 每次切换前后记录 `cacheRead`，量化真实缓存损失
5. 滞回参数按实测调

#### 验收

- 观测期 ≥ 200 轮
- 难度评分与实际 token 消耗的秩相关系数 ≥ 0.5
- 启用后，总成本（含缓存损失）相对基线下降 ≥ 15%，否则不值得

#### 风险

| 风险 | 缓解 |
|---|---|
| 缓存抖动吃掉全部收益 | 滞回；验收标准直接看总成本而非模型单价 |
| 难任务被路由到弱模型 | 只做向下路由，且阈值保守 |

---

## 6. 明确不做的

### 6.1 随 turn 改动工具集

设想：根据任务难度决定开放哪些工具、是否允许派子 agent。

**否决理由**：工具定义位于 prompt 最前面。改动一次，**100% 的缓存作废**
—— 这是所有可能位置里最差的一个。收益无法覆盖代价。

### 6.2 每轮上下文工作集淘汰

设想：每轮批量打分、淘汰最低分项，把上下文变成带替换策略的工作集。

**否决理由**：见 [§3.1](#31-前缀缓存) 的算术。每轮从中间淘汰 ≈ 每轮冷启动 ≈
成本上升约 10 倍，而目的本来是省上下文。

正确形态是[方案 4](#方案-4压缩取舍策略) —— 同样的想法，只在压缩点执行。

### 6.3 任何不可逆动作的门禁

删除、推送、转账、授予写权限。理由见 [§3.3](#33-不该去的地方)。

---

## 7. 实施流程

### 7.1 顺序

```
第 0 步   共享基础设施（§4）             ← 前置，独立可测
第 1 步   方案 3 测试选择                ← 不碰产品代码，风险最低，先练手
第 2 步   方案 1 Grep 密钥判断           ← 最小的产品改动，验证带外性质
第 3 步   方案 2a/2b 核验                ← 零缓存代价，价值高
第 4 步   方案 4 压缩取舍（先观测）       ← 工作量大，但基础设施已就位
第 5 步   方案 5 模型路由（先观测）       ← 唯一有缓存代价的，最后做
```

把方案 3 放在方案 1 之前，是因为它完全在产品代码之外 ——
用它把客户端、键值约定、超时、遥测这套底座跑通，代价最小。

### 7.2 每个方案的推进流程

```
1. 建标注样本集（§4.5）          ← 没有它不要动手
2. 观测模式接入                   ← 只记遥测，不改行为
3. 看数据回答两个问题：
     a. 判断质量够不够？（校准曲线）
     b. 和现有启发式的差异率是多少？（差异 < 5% 就别做了）
4. 定阈值（在样本集上选点，不要拍脑袋）
5. 开关后启用，默认关
6. 跑够一段时间，按验收标准判定去留
```

### 7.3 每个 PR 的门槛

- [ ] Jev 不可用时的行为 = 今天的行为，并有测试覆盖这条路径
- [ ] 批量场景用键值对象，无位置索引
- [ ] 有硬超时，且超时路径有测试
- [ ] 遥测记录了 probability / confidence / 是否与回退路径不同
- [ ] 独立开关，默认关闭
- [ ] 标注样本集随代码提交
- [ ] 阈值的选取有数据依据，写在注释里

---

## 8. 参考

### Jev

- [TypeSafe Jev 介绍（DataCamp）](https://www.datacamp.com/blog/system-one-models-jev)
- [API 规格与实测坑（pedramamini gist）](https://gist.github.com/pedramamini/014676fa8684d91bf7000f4623701ada)
  —— 位置索引问题的来源
- [LangChain: Building a harness with Jev](https://www.langchain.com/blog/building-a-harness-with-jev)
- [awesome-jev](https://github.com/kraayenjon/awesome-jev)

### 本仓库相关位置

| 主题 | 位置 |
|---|---|
| 已实现的模型侧脱敏 | `packages/core/src/redaction.ts` → `redactContextCredentials` |
| Grep / Bash 调用点 | `packages/runtime/src/builtin-tools.ts`、`packages/runtime/src/bash-model-output.ts` |
| 缓存控制 | `packages/runtime/src/model-factory.ts` |
| 缓存遥测 | `packages/runtime/src/telemetry/llm-call-usage.ts` |
| 压缩 | `packages/runtime/src/history-compact-*.ts` |
| 工具结果归档 / 恢复 | `packages/runtime/src/tool-result-archive.ts` |
| 沙箱拒绝检测（正则） | `packages/runtime/src/sandbox/detect.ts` |
| 错误分类（关键词） | `packages/core/src/redaction.ts` → `classifyGeneralizedError` |
| 权限 profile | `packages/core/src/permission-profile.ts` |
| 沙箱边界 | `packages/core/src/sandbox-boundary.ts` |

### Codex 对照

`openai/codex` 里的相关实现，可作设计参照：

| 主题 | 位置 |
|---|---|
| 强制拒绝校验器 | `codex-rs/protocol/src/permissions/deny_read_validator.rs` |
| glob → seatbelt 正则翻译 | `codex-rs/sandboxing/src/seatbelt.rs` |
| bwrap 的 glob 预展开 | `codex-rs/linux-sandbox/src/bwrap.rs` |
| 内容脱敏（用于命令串与记忆，非文件内容） | `codex-rs/secrets/src/sanitizer.rs` |
