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

> **状态：设计稿，尚未实施。** 本文档描述把 TypeSafe Jev 接入 Maka 的若干方案、
> 它们为什么按这个顺序排、以及每一个的落地步骤与验收标准。
>
> 代码和契约测试始终是最终权威；本文档与实现冲突时以实现为准。
>
> 没有验收标准、暂不承诺实施的方向探索在
> [Jev：更远的方向](./jev-beyond-maka.zh-CN.md)。

## 目录

- [0. 摘要](#0-摘要)
- [1. Jev 是什么](#1-jev-是什么)
- [2. 为什么值得接：带外判断](#2-为什么值得接带外判断)
- [3. 两条约束](#3-两条约束)
- [4. 共享基础设施](#4-共享基础设施)
- [5. 方案](#5-方案)
- [6. 明确不做的](#6-明确不做的)
- [7. 实施流程](#7-实施流程)
- [8. 先验技术与已有实现](#8-先验技术与已有实现)
- [9. 参考](#9-参考)

---

## 0. 摘要

Jev 是 TypeSafe 的 "System One" 模型：不生成文本，只返回**带校准概率的类型化判断**。
约 250ms、$0.042/M input token、output 免费。

Maka 里有三类位置适合它：

1. **一个正则在假装自己是分类器** —— `isLikelySandboxDenial` 是一条英文正则；
   `classifyGeneralizedError` 是 `lower.includes('timeout')`。
2. **现在要烧一次完整 LLM 调用** —— 记忆抽取、压缩时的取舍、召回排序。
3. **现在直接甩给用户** —— 沙箱边界弹窗。
4. **现在是静态设置，本可以逐请求决定** —— 思考档位（`thinkingLevel`）
   在设置里选一次就锁定整个会话。

排序不是按价值排的，是按**前缀缓存代价**排的（见 [§3.1](#31-前缀缓存)）。
这条约束推翻了直觉上最诱人的那个方案。

| # | 方案 | 缓存代价 | 工作量 |
|---|---|---|---|
| 1 | [Grep 密钥判断](#方案-1grep-密钥判断) | 零 | 小 |
| 2 | [带外核验三件套](#方案-2带外核验三件套) | 零 | 中 |
| 3 | [测试选择](#方案-3测试选择) | 零 | 小 |
| 4 | [压缩取舍策略](#方案-4压缩取舍策略) | 无额外 | 大 |
| 5b | [自适应推理与 effort 路由](#方案-5b自适应推理与-effort-路由) | 零 | 中 |
| 6 | [中断恢复判定](#方案-6中断恢复判定) | 零 | 小 |
| ✗ | [模型路由](#62-模型路由) | 高 | 不做 |
| ✗ | [改工具集的 turn 路由](#61-随-turn-改动工具集) | **最高** | 不做 |

换 **model** 和换 **effort** 看着是同一件事，缓存代价差一个数量级：缓存按模型分，
换模型作废；`effort` 是请求参数而非前缀内容，不作废。前者还另有实测的反面证据，
已移入 [§6.2](#62-模型路由)。

### 0.1 六份独立评测给出的统一结论

[§8](#8-先验技术与已有实现) 汇总了社区对 Jev 的六份独立评测。它们指向同一个模式，
而这个模式是本文档的前提：

> **Jev 赢在成本、延迟和误报率；在原始准确率上打平或输，
> 而且——出人意料地——在校准上也常常输给 Claude Haiku。**

连贯的结论是：**它是一个便宜的高精度过滤器，不是一个更好的判断者。**

这条改写了用法。不要把它当"更便宜的 judge"接在需要判断质量的地方；
把它当"先筛一遍的漏斗"，放在昂贵步骤的前面。社区那份重排序评测的结论
（Jev 与 BM25 单独都不赢，**fusion 赢**）是同一件事的另一种说法。

它也意味着 [§2](#2-为什么值得接带外判断) 那条"带外"性质的价值高于"校准"性质 ——
前者是结构性的，后者实测下来比宣称的弱。

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
   **但这不等于"不离开你的机器"**：值仍然发给了 Jev 的服务方，只是没进
   transcript、不被后续每一轮重放、不被模型厂商长期留存。这是**换了一个暴露
   对象**，不是零暴露；任何用于敏感数据的设计都要按这个前提评估。
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

所有方案都依赖同一套底座。**这部分必须先做，且独立可测。**

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

具体到每个方案，"今天的行为"是什么会在各自的[实施步骤](#5-方案)里写明。

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

### 4.5 校准验证：自己校准，不要信厂商的校准

**这一节的前提被实测推翻过一次，重写后的版本更严格。**

社区的注入检测评测（11,900 条标注 prompt）测出 Jev 的 ECE 是 **0.058**，
而 Claude Haiku 是 **0.021** —— 校准好约三倍，与 TypeSafe 的宣称相反。
更要紧的是作者的这句：

> Jev's confidence scores **in the 0.5–0.9 range lack reliability**
> despite being operationally critical.

**0.5–0.9 正是阈值所在的区间。** 所以"信任返回的概率 + 定期监控"这个做法不够，
它把整套阈值数学建在一个实测不可靠的地基上。

#### 正确的做法：split conformal 自校准

学术界对"LLM 置信度未校准"的标准答案是 **conformal abstention** ——
不依赖模型自称的校准，而是用**你自己的留出集**重新校准，得到
**分布无关、有限样本**的保证。

这顺带解决了另一个问题：厂商校准是在它的训练分布上成立的，**你的输入会漂移，
而漂移不会报警**。自己校准时，校准的就是你自己的分布。

#### 现成工具，不要自己搭

| 工具 | 用途 |
|---|---|
| `jevcal` | CLI，在标注数据上**拟合置信阈值到目标准确率** |
| `Jev DSPy Lab` | 测量 calibration / selective risk / abstention |

#### 每个方案上线前要测的四件事

每个方案需要一份**标注过的固定样本集**（100–300 条）：

1. **校准曲线** —— 按概率分箱，每箱实际正确率应贴近该箱概率
2. **离散程度** —— 一个永远返回 0.5 的模型是**完美校准且完全无用**的。
   校准让那个数**可信**，不让它**有信息量**；两者必须分别测。
3. **相对现有启发式的增量** —— 新抓到多少、新误报多少
4. **阈值选点** —— 用 `jevcal` 在这份样本上拟合，不要拍脑袋

**标注必须按结果，不能按"答案看起来对不对"**：

```
✗  标注「这个 hunk 看起来危险吗」
✓  标注「这个 hunk 后来真的出问题了吗」
```

第一种在验证的是你的直觉和 Jev 的直觉是否一致，而那个东西一致了说明不了什么。

样本集放 `packages/runtime/src/jev/__fixtures__/`，随代码走。
**没有这份数据就不要合并。**

---

## 5. 方案

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

**这是所有方案里风险最低的一个** —— 它连产品代码都不碰，
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

### 方案 5b｜自适应推理与 effort 路由

#### 背景：`thinking` 参数的三代演进

理解这个方案最快的方式，是看 `adaptive` 在解决上一代的什么问题。

**第一代：没有思考。** 模型直接出答案。

**第二代：`thinking: { type: 'enabled', budget_tokens: N }`**

请求里给一个 token 预算，模型回答前先"想"，最多想 N 个 token，思考 token 按
output 计费。问题是 **N 是在看到问题之前拍的数**：定低了难题上思考被截断，
定高了简单题上模型倾向于把预算填满，而且整个会话一个值。

**第三代：`thinking: { type: 'adaptive' }`**

**没有 budget 字段。** 模型自己按感知到的难度**逐请求**决定想多少，
按实际生成计费。

**这就是"自适应推理"，而 Maka 已经在用了。**

#### 现状：两层，一层已自适应，一层是静态的

`packages/runtime/src/model-factory.ts` 的 `visibleClaudeThinking()`：

```ts
const thinking =
  mode === 'adaptive'
    ? { type: 'adaptive' as const, display: 'summarized' as const }   // 现代 Claude
    : { type: 'enabled' as const, budgetTokens: 1_024 };              // 老 Claude 4 裸别名
return { thinking, ...(effort ? { effort } : {}) };
```

`claudeThinkingMode()` 查 `getAnthropicModelCapabilities(...).supportsAdaptiveThinking`
决定走哪条。于是形成两层：

| 层 | 决策者 | 信息量 | 现状 |
|---|---|---|---|
| `thinking: adaptive` | **模型** | **完整** —— 看得见整个上下文、工具结果、当前进展 | 已启用 |
| `effort` | 外部 | 少 —— 只看得见请求文本 | **静态**，来自 `settings.thinkingLevel` |

几个实现细节值得记住：

- 不支持 adaptive 的模型退回**固定 1024 token**，很小，实际上被钉死在浅档
- `level === 'off'` 且 provider 声明 `offBehavior: 'anthropic-thinking-disabled'`
  → `thinking: { type: 'disabled' }`，彻底关闭
- 档位**原样透传**，不做换算。代码注释：
  > No budget-token mapping — the provider's native effort values pass through unchanged.
- 不只 Claude。Kimi K3 那条分支的注释是
  「supports adaptive thinking only; effort defaults to max when unset」

#### 设计原则：两层互补，不是竞争

Jev 的作用**不是替模型判断难度** —— 它的信息比模型少得多，抢这个活是输定的。
它的作用是**移动模型自适应的基线**。

Jev 判断"这轮像个多文件重构" → `effort=high` → 模型在更高的基线上继续自适应，
仍然会在简单的子步骤上少想。两层叠加，不冲突。

这也解释了为什么外部路由在 `effort` 上合理，而在"决定思考多少 token"上不合理。

**由此得出一个不对称：设高的代价小，设低的代价大。**

```
effort = max  + "1+1 等于几"   →  模型还是不会想很久（adaptive 兜着）
effort = low  + 一个难重构      →  模型受限，想得比它该想的浅
```

所以 effort 路由应主要**往下**调（识别明显简单的请求，省钱），
往上调的收益大半被 adaptive 层吃掉了。

#### 设计：criteria 必须按模型的实际档位梯子构造

**这是实现时第一个会踩的坑。** 不同模型的档位数不同 —— 有的三档，有的六档。

`packages/core/src/model-thinking.ts` 已经有完整的能力阶梯系统：

```ts
thinkingVariantsForConnection(connection, modelId): readonly ThinkingLevel[]
```

按显示顺序返回该模型支持的档位。解析链两级：

1. `modelOverride(connection, modelId)?.thinkingLevels` —— 用户为
   openai-compatible 中转声明的。粒度是**模型**而不是连接，因为
   「a relay may front a DeepSeek-family reasoner and a plain instruct model side by side」
2. 回落到 `thinkingVariantsForModel()` —— 从 `model-metadata.ts` 的
   `thinkingOptions` 派生（`deriveThinkingChoices`）：
   `offBehavior` → 加 `'off'`；`efforts` 里的 `'none'` → `'off'`；
   合法 `ThinkingLevel` → 加；**不认识的值丢弃**；没有声明 → 返回 `[]`，UI 隐藏开关

所以 criteria 必须这样构造：

```ts
const levels = thinkingVariantsForConnection(connection, modelId)
  .filter((l) => l !== 'off');        // off 不是强度档，Jev 不碰
if (levels.length < 2) return;        // 没有可选空间，跳过调用
// levels 直接就是 criteria —— Jev 的 Score 要 2–10 档，天然满足
```

**为什么不能用固定的 `THINKING_LEVELS`：** Jev 会返回 `xhigh`，而模型只有
`low/medium/high`。映射到 `high`？还是判为无效？`resolveThinkingLevel()`
现在的行为是**丢弃**，而丢弃意味着回落到默认值 —— 这次路由白做了，钱也白花了。

按实际梯子构造就绕开了整个问题，还有个附带好处：**给 Jev 的选项集本身就是一份
能力声明**，返回值天然合法，`resolveThinkingLevel()` 在这条路径上退化成冗余保险
而不是实际的过滤器。

`off` 不进量表，依据是 `model-thinking.ts` 的注释：

> `off` is not an intensity tier but a *disable* wire (`reasoning_effort: 'none'`)

这也符合[方向不变量](#32-方向不变量)：Jev 能在强度轴上移动，但不能替用户关掉思考。

#### 三个零缓存代价的形态

按可做程度排序：

**5b.1 追加计划指令。** 判断这轮像多文件重构时，在当前轮尾部**追加**一条提示
（「这看起来要动多个文件，先规划再改」）。纯追加，符合规则 R1，前缀照常命中。
效果与调高 effort 有相当部分重叠，但代价确定为零。**最先做这个。**

**5b.2 effort 路由。** 上面那套。零缓存代价 —— `effort` 是请求参数而非前缀内容。

**5b.3 子 agent 委派判断。** `packages/core/src/subagent-settings.ts` 的
`SubagentPreset` **自带 `model` 和 `thinkingLevel`**，注释写着
「User-approved model route」。子 agent 在**自己全新的上下文**里跑，
没有缓存可破坏 —— 这是零缓存代价地用上强模型 + 高 effort 的唯一途径。

今天由模型自己通过 `agent_list` + `agent_spawn` 选（`subagent-tools.ts`），
要花工具调用和上下文。Jev 的两个可能接入点里，第二个更值钱：

- 帮它挑 preset —— 省几个工具调用，收益一般
- **判断"该不该委派"** —— 模型经常意识不到该委派，自己一头扎进去干

而且 preset 是用户批准的，Jev 只能在已批准的路由里**选**，不能**造**，
天然满足方向不变量。

> 压缩点也可以重定 effort：缓存在那里本来就要作废，且此时判断是**有信息的**
> （已看完整段会话）。归入[方案 4](#方案-4压缩取舍策略)一并实现。

#### 缓存代价

**零。** `effort` 与 `thinking` 是请求参数，不是消息前缀内容；5b.1 是纯追加；
5b.3 的子 agent 本来就是冷上下文。

#### 一条硬约束：不能自己给自己提价

Claude Code 对会话 effort 的规定是：

> a session must not silently re-price its own turns

理由很直接：那等于 agent 悄悄抬高自己的消费。Jev 自动拨 effort 正是这个形状。

**因此本方案必须满足以下至少一条：**

- 用户设的档位是**上限**，Jev 只能在其下移动，不能突破；或
- 变更对用户**可见**（例如在轮次页脚显示本轮实际用了哪档）

推荐第一条 —— 它和方向不变量是同一个形状：**Jev 可以省钱，不能花钱。**

#### 实施步骤

1. 5b.1 先做：在轮次组装处按 Score 结果追加计划提示，纯追加
2. 5b.2 观测模式：按模型梯子构造 criteria，打分、记遥测，**不改实际 effort**
3. 对比：Jev 的档位建议与实际消耗（思考 token 数、轮数、是否返工）相关吗？
4. 相关性成立后启用，且**只向下**，以用户设定为上限
5. 5b.3 单独评估，它的验收标准与前两者不同

#### 验收

- 5b.1：在一组多文件改动任务上，追加提示后的返工率下降 ≥ 15%
- 5b.2 观测期 ≥ 200 轮；档位建议与实际思考 token 消耗的秩相关系数 ≥ 0.5
- 5b.2 启用后 `cacheRead` 相对基线**无下降**（若下降，说明关于 effort 不作废
  缓存的前提不成立，立即停用并回到观测）
- 任一失败时，行为与今天完全一致（静态 `thinkingLevel`）

#### 风险

| 风险 | 缓解 |
|---|---|
| 难任务被压到低档，质量下降 | 只向下调，且以用户设定为上限；阈值保守 |
| 档位映射错误导致静默回落 | criteria 按实际梯子构造，从源头消除 |
| 前提（effort 不作废缓存）不成立 | 验收标准直接盯 `cacheRead`，不达标即停用 |
| 用户感到失控 | 上限语义 + 页脚可见，二选一必须实现 |

#### 一个已知的观察

`deriveThinkingChoices()` 会丢弃不认识的 effort 值，注释写着：

> add the level to `THINKING_LEVELS` if a provider introduces a new effort tier

所以某个 provider 引入新档位（例如 `ultra`）时，在有人手工把它加进
`THINKING_LEVELS` 之前，那一档会**静默消失** —— 模型支持，但 Maka 不给选，
也不告警。对 Jev 路由本身是安全的（它只在已知档位里选），
但排查"某模型档位比官方文档少"时应先看这里。

---

### 方案 6｜中断恢复判定

#### 现状

一轮被中断后（应用重启、超时、宿主消失），是否给用户一个"继续"按钮，
由 `apps/desktop/src/renderer/interrupted-resume.ts` 决定，全文如下：

```ts
export function latestInterruptedResumeTurnId(turns): string | undefined {
  const latestTurn = turns.at(-1);
  if (latestTurn?.status !== 'failed') return undefined;
  const errorClass = latestTurn.errorClass?.toLowerCase();
  if (errorClass === 'app_restarted') return latestTurn.turnId;
  if (
    errorClass?.includes('timeout') &&
    latestTurn.tools?.every((tool) => tool.status === 'completed')
  ) {
    return latestTurn.turnId;
  }
  return undefined;
}
```

它看三样东西：**状态、错误类、工具完成情况**。注意 `errorClass?.includes('timeout')`
—— 又一个子串匹配，与 [`classifyGeneralizedError`](#a-类一个正则在假装自己是分类器)
是同一个毛病的第二例。

底下那层 `classifyAgentRunRecovery`（`packages/runtime/src/agent-run-recovery.ts`）
按**最后一个事件类型**做结构性归类：`tool_started` → `tool_interrupted`、
`permission_requested` → `stale_user_wait`，等等。

**这一层不该动。** 它回答的是"中断时在干什么"，答得准确，而且它的存在理由写在
注释第一句：「Why a run the events never closed has to be failed closed」。

#### 缺口

**没有任何一层看那一轮实际在做什么。** 同样是 `app_restarted`，下面四种处境
该不该继续完全不同，但从 `status` + `errorClass` + 工具状态里看起来一模一样：

| 中断时的处境 | 继续是否合适 |
|---|---|
| 实际工作已完成，正在写总结 | 继续几乎免费且正确 |
| 12 步重构做到第 5 步，4 个文件改了一半 | 工作区状态不自洽，继续可能比重来更糟 |
| 卡在无效循环里被中断 | 继续就是继续打转 |
| 目标在更早的轮次已经达成 | 纯浪费 |

#### 设计

用 Choice 而不是布尔判断 —— 有用的不只是"要不要"，而是"恢复前该知道什么"：

```
criteria: {
  work_complete_summary_pending: 实际工作已完成，中断在收尾阶段
  work_partial_consistent:       做了一部分，但工作区状态自洽
  work_partial_inconsistent:     改到一半，文件处于中间状态
  unproductive_loop:             中断前在重复同样的动作
  goal_already_met:              目标在更早的轮次已经达成
}
```

这直接决定按钮该说什么。「继续」和「4 个文件处于半改状态，建议先检查再继续」
是完全不同的两句话，而今天这两种情况显示同一个按钮。

#### 为什么这里特别适合

**带外性质在这里格外关键。** 中断那一轮的内容**还没在上下文里** —— 恢复才会把它
放进去。所以用 LLM 判断"要不要恢复"会陷入一个悖论：为了判断该不该读进来，
得先读进来；判断完决定不恢复，那些 token 也已经花掉了。

Jev 没有这个问题。这是 [§2](#2-为什么值得接带外判断) 那条性质最纯粹的一次体现。

#### 缓存代价

**零。** 决策发生在请求构造之前，此时还没有 prompt。

#### 一条必须守住的线

**Jev 只决定要不要给这个按钮，不决定自动恢复。**

今天的代码正好就是这个形状 —— `latestInterruptedResumeTurnId` 产出
`resumeCandidateTurnId` 交给 view model（`app-shell-turn-view-model.ts`），
最终由用户点击。**保持这个形状。**

理由：中断的那一轮可能正在做写操作。自动恢复一个做到一半的破坏性动作，
属于 [§3.3](#33-不该去的地方) 那类不可逆动作，「五次错一次」在那里不够用。

#### 无人值守时的非对称规则

scheduled task 或自主循环里没有人点按钮，"要不要继续"必须自动答。
此时规则是**非对称的**：

```
work_complete_summary_pending + 高置信度  →  自动继续
其他所有情况                              →  停下并上报
```

**自动继续只在一种明确安全的情形下发生，其余一律 fail-closed。**
这与 `classifyAgentRunRecovery` 本身的哲学一致 —— Jev 在那道保守默认之上
开一个很窄的口子，而不是把默认改成乐观。

#### 实施步骤

1. 观测模式：在现有启发式旁边跑 Choice，只记遥测，按钮照旧
2. 对比：Jev 的处境判断与用户**实际是否点了恢复**、以及**恢复后是否返工**相关吗？
3. 相关性成立后，用 Choice 结果决定按钮的**文案**（风险最低的一步）
4. 再之后才用它决定按钮的**有无**
5. 无人值守分支单独评估，规则见上

#### 验收

- 观测期 ≥ 50 次真实中断
- 用户点了恢复的场景中，被判为 `work_complete_summary_pending` 或
  `work_partial_consistent` 的占比 ≥ 70%
- 被判为 `work_partial_inconsistent` 却被用户顺利恢复的比例 ≤ 15%
  （高于此说明判据过于悲观）
- Jev 不可用时，行为与今天的启发式完全一致

#### 风险

| 风险 | 缓解 |
|---|---|
| 漏掉用户想要的恢复 | 错的代价不对称：多给一个不点的按钮代价为零，先偏向"提供" |
| 自动恢复半成品破坏工作区 | 只在无人值守分支自动，且只对一种处境自动 |
| 判据与真实处境脱节 | 第 3 步先只改文案，风险可控且能收集数据 |

---

## 6. 明确不做的

### 6.1 随 turn 改动工具集

设想：根据任务难度决定开放哪些工具、是否允许派子 agent。

**否决理由**：工具定义位于 prompt 最前面。改动一次，**100% 的缓存作废**
—— 这是所有可能位置里最差的一个。收益无法覆盖代价。

### 6.2 模型路由

设想：轮次开始时 Score 请求难度，映射到不同的模型。

**这一条原本是方案 5a，有完整的滞回设计和验收标准。移到这里，是因为两条独立的
反面证据同时指向它。**

**理由一：缓存按模型分，切一次冷一次。** 这是本文档全部排序的依据
（[§3.1](#31-前缀缓存)），它是唯一有高缓存代价的方案。

**理由二：实测显示它不工作。** 社区在 RouterArena 与 LLMRouterBench 上做了
对照实验：

| | 准确率 | 成本 |
|---|---|---|
| Jev 路由 | 69.5% | $0.115/1k |
| 最好的单模型（gemini-2.0-flash） | **77.1%** | **$0.048/1k** |

小池子上**又差又贵**。大池子（13 模型、5,835 query）上 Jev+retrieval 拿到 62.4%
对 GPT-5 的 60.3%，看似赢了，但作者做了消融：

> the win is driven by the **retrieval evidence, not Jev**. The no-Jev ablation
> lands on the same frontier… Jev's difficulty signal was **largely redundant**.

**增益来自检索证据，Jev 的难度信号基本冗余。**

而且这个领域本身已经很成熟（RouteLLM、LLMRouter、best-route-llm，以及
RouterArena 这个评测基准），不是一片空白等着谁去填。

**注意范围**：被否决的是换 **model**。换 **effort**
（[方案 5b](#方案-5b自适应推理与-effort-路由)）缓存代价为零，且社区有正面结果
（按轮路由工具选择报便宜 22–40%），仍然保留。

### 6.3 每轮上下文工作集淘汰

设想：每轮批量打分、淘汰最低分项，把上下文变成带替换策略的工作集。

**否决理由**：见 [§3.1](#31-前缀缓存) 的算术。每轮从中间淘汰 ≈ 每轮冷启动 ≈
成本上升约 10 倍，而目的本来是省上下文。

正确形态是[方案 4](#方案-4压缩取舍策略) —— 同样的想法，只在压缩点执行。

### 6.4 任何不可逆动作的门禁

删除、推送、转账、授予写权限。理由见 [§3.3](#33-不该去的地方)。

---

## 7. 实施流程

### 7.1 顺序

```
第 0 步   共享基础设施（§4）             ← 前置，独立可测
第 1 步   方案 3 测试选择                ← 不碰产品代码，风险最低，先练手
第 2 步   方案 1 Grep 密钥判断           ← 最小的产品改动，验证带外性质
第 3 步   方案 6 中断恢复判定（先改文案） ← 零代价，决策点现成，带外性质最纯
第 4 步   方案 5b.1 追加计划指令          ← 纯追加，零代价，最小的行为改变
第 5 步   方案 5b.2 effort 路由          ← 零缓存代价，档位枚举现成
第 6 步   方案 2a/2b 核验                ← 零缓存代价，价值高
第 7 步   方案 4 压缩取舍（先观测）       ← 工作量大，但基础设施已就位
第 8 步   方案 5b.3 子 agent 委派         ← 零缓存代价，但验收标准自成一套
```

把方案 3 放在方案 1 之前，是因为它完全在产品代码之外 ——
用它把客户端、键值约定、超时、遥测这套底座跑通，代价最小。

**顺序由代价决定，不由价值决定。** 唯一有高缓存代价的那个方案（模型路由）
已经因为缓存和实测两条理由移入 [§6.2](#62-模型路由)。

在动任何一步之前先读 [§8](#8-先验技术与已有实现)：七个方案里五个已经有公开实现，
其中几个不该重做。

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

## 8. 先验技术与已有实现

> 调研日期 2026-09-22。Jev 生态当时只有四天历史（最早的公开仓库 09-18），
> 所以"已有实现"多数意味着"有人花了个周末"，而不是成熟方案。
> 但那也是目前唯一存在的数据。

**动手前先读这一节。** 七个方案里五个已有公开实现，其中几个不该重做。

### 8.1 每个方案的先验技术

| 方案 | 已有实现 | 判定 |
|---|---|---|
| 1 Grep 密钥判断 | `jev-secret-detection`（secret-in-diff，可重复判定） | 🟡 先比对再动 |
| 2a 写入预检 | `pi-warden`（对照项目规则查写入）、`pi-jev-auto-mode` | 🟡 参考 |
| 2b 轮次自检 | **四个**：`limpet`、`jev-belay`、`Foreman`、`OpenWork` | 🔴 别重做 |
| 3 测试选择 | 未找到；`Supercov`（按文件打质量分供 agent 排序）相邻 | 🟢 相对开放 |
| 4 压缩取舍 | `fast-jev-compaction`、四个 `pi-jev-context`、`distill` | 🔴 别重做 |
| 5b effort 路由 | `jcm-router`（同时选模型与 effort）、`jev-codex-router` | 🟡 参考 |
| 6 中断恢复 | 未找到；`limpet`/`jev-belay` 是"防止提前结束"的镜像 | 🟢 相对开放 |
| 运行中偏离检测 | **`ProgressGate`**（返回 `CONTINUE/WARN/REPLAN/HALT`） | 🔴 别重做 |
| 提示注入 | `jev-guard`、`tripwire`（每响应七项检查，~100ms） | 🟢 可做，要自己的语料 |

两个值得单独指出：

- **`ProgressGate` 的返回值已经是四级分级响应**，正是"不要直接打断"该有的形状。
- **`jcm-router` 同时路由 model 和 effort** —— 它大概没算过缓存代价
  （见 [§6.2](#62-模型路由)）。

### 8.2 六份独立评测

| 评测 | 结果 |
|---|---|
| `jev-injection-bench`（11,900 条标注 prompt） | Jev 综合最好（AUPRC 0.980，误报 0.3%），但 **Haiku 校准好 3 倍**，0.5–0.9 不可靠 |
| `jev-code-review-benchmark`（360 次评审） | 便宜 45×/274×，98.0% vs 100%；作者警告"**构造样本 + 显式规则**，不测开放式 bug 发现" |
| `jev-routing-experiment`（RouterArena） | 小池子又差又贵；大池子**消融显示增益来自 retrieval**，Jev 信号冗余 |
| `Jev Phishing Bench`（2,000 封邮件） | **Haiku 准确率更高** |
| `Jev search rerank eval`（9,831 对） | Jev 与 BM25/bge-m3 单独都不赢，**fusion 赢** |
| `ASSAY-001`（预注册） | 校准与类型安全检查，结论 **"split verdict"** |

统一结论见 [§0.1](#01-六份独立评测给出的统一结论)：**便宜的高精度过滤器，
不是更好的判断者。**

### 8.3 必用的现成工具

| 工具 | 用途 | 替代什么 |
|---|---|---|
| `jevcal` | 在标注数据上拟合置信阈值到目标准确率 | 自己写阈值选点 |
| `Jev DSPy Lab` | 测 calibration / selective risk / abstention | 自己写校准评估 |
| `jev-tree` | 递归 Choice，突破 255 选项上限 | 自己分层 |

### 8.4 开源与本地替代

四天内出现至少十个本地/开源复刻，其中 **`von`** 号称 sub-15ms、
非自回归、可本地直接替换；`openjev` 在家用 3090 上跑；`decider`
（Qwen3.5-2B 微调）输出带校准概率的类型化决策；`jevmlx` / `PocketJev`
覆盖 Apple Silicon 与 iPhone 端。

**这动摇了 [§2](#2-为什么值得接带外判断) 那条补注里的限制**：
"值仍然发给了服务方"。换成本地模型，那条不成立。代价是校准质量未知
（而 Jev 自己的校准本就已被实测打折）和自行维护推理。

对密钥与注入这两个用途，本地替代值得在设计早期就评估，而不是留作以后优化。

### 8.5 学术侧该读什么

| 主题 | 该读 |
|---|---|
| 压缩与缓存连续性的取舍 | TokenPilot（Cache-Efficient Context Management for LLM Agents）、Practical Online KV Cache Compaction for LLM Agents |
| 运行中偏离检测 | AgentTether（四信号：**loop repetition** / intent drift / expectation deviation / delayed response）、**AgentDrift（step-labeled benchmark，现成标注集）** |
| 有保证的错误率 | Conformal Cascade、UCCI、Cost-Saving LLM Cascades with Early Abstention |
| 负面结果 | Entropy Alone is Insufficient for Safe Selective Prediction in LLMs |
| 注入检测的现实 | 分类器方案生产 FPR 5–15%；DeBERTa-v3 在 JailbreakHub 上 FPR 0.96；EchoLeak(CVE-2025-32711) 绕过微软 XPIA；**PromptArmor(ICLR 2026) 做到 <1% 双向错误** |

注入检测那一行里最该记住的是文献原话：

> **Every detector loses ground on a corpus its authors did not build.**

所以 `jev-injection-bench` 那个 0.3% 误报率是**别人语料上的数字**，
不能直接搬到你的内容分布上。

---

## 9. 参考

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
| 自适应思考接线 | `packages/runtime/src/model-factory.ts` → `visibleClaudeThinking` / `claudeThinkingMode` |
| 档位能力梯子 | `packages/core/src/model-thinking.ts` → `thinkingVariantsForConnection` / `deriveThinkingChoices` |
| 子 agent 路由（自带 model + thinkingLevel） | `packages/core/src/subagent-settings.ts` → `SubagentPreset` |
| 子 agent 选择工具 | `packages/runtime/src/subagent-tools.ts` |
| 压缩 | `packages/runtime/src/history-compact-*.ts` |
| 工具结果归档 / 恢复 | `packages/runtime/src/tool-result-archive.ts` |
| 沙箱拒绝检测（正则） | `packages/runtime/src/sandbox/detect.ts` |
| 中断恢复的按钮判定（启发式） | `apps/desktop/src/renderer/interrupted-resume.ts` |
| 中断的结构性归类（不要动） | `packages/runtime/src/agent-run-recovery.ts` → `classifyAgentRunRecovery` |
| 恢复按钮的消费方 | `apps/desktop/src/renderer/app-shell-turn-view-model.ts` |
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
