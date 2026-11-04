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

# WorkHub 验证与用量快照 / Validation snapshot

整理日期：2026-10-23；当前代码：[`04281faee`](https://github.com/sunrioa/baka/commit/04281faee875d381d7f5d6a13e7408888ae9ba27)。这是已有记录的公开汇总，不是本次整理文档又运行了一轮测试。真实模型为 Command Code `deepseek/deepseek-v4.1-flash`，平台为 macOS；生产式原生 SDK、桌面 UI、离线夹具和受控成本对照分别标注。

English summary: the fork has case-based evidence for task routing, same-Turn input, queue handling, native fresh history and coordinator compaction. The latest runtime fix passed 788 focused tests and a real isolated Host crash/restart regression. Results span multiple revisions; they are not a single benchmark score, a fresh full-repository run, or evidence of monetary savings. Raw user transcripts, credentials and reasoning remain private.

## 1. 证据怎么读

- Host 持久派发、准入、Turn / Run、消费和终态是执行证据；模型最终说“通过”不够。
- 相同编译产物、同一测试重复运行、重叠窗口不能重复相加。下面不提供伪精确的“所有测试总数”。
- 每一行只证明列出的版本、布置与观察窗口。模型行为测试是个案，不是总体路由成功率。
- 公开汇总保留必要计数、版本、来源和摘要；私有原始导出不随文档上传。SHA-256 只绑定同份文件，不认证测试者声明或缺失的观察。
- 历史测试命令可在当前版本重跑，但不能据此把旧运行次数写成新提交的全量通过。

## 2. 真实功能证据

| 范围 / 版本 | 真实观察 | 结论与限制 |
| --- | --- | --- |
| 自然追问、J07、修订 J12 / T02；`365e088ca`，2026-10-21 | 空主对话模糊输入触发 find → 原生 ask；计划结束后“接着做吧。”续办原任务；预览 A、总主题 B 时只说“继续。”仍续办 B | 三个固定场景各自 checker 通过。J07 只证明等待选择且未派发，不证明用户选择后的执行；T02 / J12 使用明确等待实施的修订布置 |
| 取消追问 T13、带标签 T01；`99ee88701`，2026-10-21 | 用户停止尚未派出的追问后，新独立 A/B 没有补投旧要求；同主题旧任务夹具存在时仍选本轮目标 | checker 通过；T01 是带标签隔离夹具，不是自然老化九天。T01 / T13 共用 20 条 attempt，不能相加 |
| 真实 coding、Steering、FIFO 与取消；收敛阶段至 `b61eb25cf` | 原任务同 Turn / Run 消费侧栏纠正；排队补充保留原位置；投递前取消没有 worker 模型请求；停止不误伤另一任务 | 各窗口有持久证据。严格工具期间发送与较早“工具结束后、轮次仍活动”的测试分开记录，不能混称 |
| 原实例界面；`b61eb25cf` | 统一入口先打开任务列表；切换 A/B、查看历史、直接发送；关闭右栏后卡片不再残留选中 | UI 与原生输入证据通过，不扩大成所有布局或警告均已解决 |
| 自主 fresh；2026-10-21 隔离压力任务 | 先查询真实配置与用量，再由 AI 选择同任务 fresh；新段实际编码，并经原生审批后跑 Node 测试 | 证明一次自主选择；后续审批验证是独立续作。该 worker 没有独立调用历史读取，不拿此例证明原文恢复 |
| 同任务工具全文；`6d6d36ba8`，2026-10-22 | fresh 后 6 个历史片段拼回同一份旧 stdout；没有重跑生成命令 | 21,322 字节 / 160 条记录，SHA-256 一致；该次读取均正常，没有新的 not_found。不是任意源缺失也能恢复 |
| 主协调压缩与压缩后追问；`362808a9d`，2026-10-22 | 原生压缩后，“继续，把方案落实并运行相关测试。”仍进入原任务 reuse；旧任务按需查找 / 读取可用 | 原实例真实 coding / API 证据；随后另补 UI `/compact` 操作。后者复用旧摘要，不能仅凭成功分隔线当成新增压缩收益 |
| 公共异常压缩补修；`04281faee`，2026-10-23 | 普通 Session 问题等待 → 测试 Host 真实 SIGKILL → 恢复 → 新对话 → 压缩 → 追加 → 再压缩 → 立即重复 | 隔离 Host、原生 SDK 与真实模型；原实例未被故障注入。详细结果见第 4 节，不冒充桌面 UI 故障测试 |

功能过程、最初失败和后续修复分别见[任务中心实施记录](../workhub-task-centric-implementation.zh-CN.md)与[主协调上下文记录](../workhub-coordination-context-implementation.zh-CN.md)。这些记录随同收敛代码进入 `6f1902d7f`；原测试仍绑定各自的实现提交，不追记为 `04281faee` 的全量实测。

## 3. 跨 Session 全文的字节核验

负面对照中原工具输出一直存在，但 `WorkHubRead` 只返回显示预览且缺少下一页；新段用旧 Session 的资源地址调用普通 `Read` 得到 `not_found`。修复的是授权内的回源和分页，不是找回丢失文件或放宽普通 `Read`。

成功复测复用原输出，没有重跑命令、把随机值放入新段指令或额外交接摘要：

- stdout：21,322 字节，160 条记录。
- 历史读取：6 个片段；含元数据 JSON 的字符 offset 为 `0 → 937 → 4687 → 8437 → 12187 → 15937 → 21876`。21,876 不是 stdout 字节数。
- 原 / 复原 stdout SHA-256 均为 `5a9a5b16d734fd2268433830eb89197ada2d2b5befb16cbfdc8e7feccda59357`。
- 该次读取 `status=ok`、目标归档 `archiveStatus=loaded`，没有新的 `not_found / unavailable / source_mismatch`；历史里的旧错误保留，不把它删除后宣称“从未失败”。
- 可见原生导出 SHA-256：`cf0b8f2e7334f78bab678964ec256bf20d57e408de14defc67aeb371d6e03b74`。

## 4. 最新公共压缩修复

### 回归范围

本轮压缩实测在 `f560cd80a` 加冻结补丁上完成，验证后原样提交为 `04281faee`；以下差异与构建摘要绑定这份代码，不是把其他版本的通过记录移过来。

| 运行批次 | 通过 | 失败 / 跳过 | 覆盖 |
| --- | --- | --- | --- |
| `04281faee` 压缩 / 预算 / 回放，9 个文件 | 562 | 0 / 0 | 安全范围、检查点、有效历史、摘要、溢出与 active/manual 后端 |
| 同版本恢复 / 交互 / 策略，5 个文件 | 226 | 0 / 0 | SessionManager、recovery resolver、kernel interaction、WorkHub context policy、safe-boundary resume policy |
| 同版本静态与构建 | 通过 | 不适用 | 全仓 typecheck、改动文件 Biome、ASF 头、相关包构建、diff-check |

788 是两个不重叠定向批次的测试数。新 recovery 文件的 21 项与 backend 两项已包含其中，不再额外累加。没有宣称这一提交重跑了整个仓库或桌面 UI。

较早的完整批次：预览状态项补修后 Core 937；Host 2,530 通过 / 12 既有跳过；设置框补修所在 `f560cd80a` 阶段 Desktop 官方入口 3,406 通过 / 0 失败 / 0 跳过。它们不是最新压缩提交的新增测试总数，详见原实施记录。

### 真实异常与健康对照

测试使用独立数据根、真实模型、生产 Host 和原生 SDK。测试者仅终止拥有的隔离 Host；原 App、原数据库和配置不动。恢复后的未知调用没有可靠回包，必须保留这种不确定性，而不是伪造成成功。

| 检查 | 结果 |
| --- | --- |
| 越过旧异常调用 | 首次覆盖 9 条内容事件；后续扩大到 13 条 |
| 未知结果 | 摘要保留 unknown 事实；没有补造工具 response、重跑旧工具或改写原事件 |
| 立即重复压缩 | `unchanged / already_compacted`；0 次新摘要调用、0 个新检查点、0 条压缩成功提示 |
| 第一次压缩前后实际请求输入 | 32,735 → 6,248 token |
| 第二次压缩前后实际请求输入 | 14,900 → 6,210 token |
| 健康对照 | 覆盖从 3 条推进到 7 条；实际请求输入 19,542 → 6,323 token |

这是功能对照，不是相同任务的等价成本实验。第一次脚本运行已完成有效压缩，但核验阶段误用上游较新 schema 的 `session_ordinal` 字段失败；之后更正外部核验脚本，以全新隔离根完整重跑成功。首轮失败与消耗保留，不能从账目里删掉。

两个生产文件差异 SHA-256：`c368916f8eb4430bf3a2c719ab74ee797c718e1e611ea9da8d3952cae9e94b46`。最终关闭后数据库副本 SHA-256：`092314987906e608d8a1bce8442674d3f67bd2ce3ec34ea2c13c714b4edec22e`。私有 `verification.json` 保留原事件逐字比较、全部请求和配置断言；此文只摘录聚合数据。

## 5. 用量，不冒充账单

| 互相不重复相加的说明 / 窗口 | 物理请求 | input | output | cache read | 费用 |
| --- | --- | --- | --- | --- | --- |
| 最新压缩完整最终运行 R2 | 14 | 213,260 | 3,958 | 114,048 | 未定价 |
| 最新压缩首次部分运行 R1 | 4 | 98,101 | 1,414 | 52,352 | 未定价 |
| **仅上述两次合计** | **18** | **311,361** | **5,372** | **166,400** | **未知，不是零** |
| 2026-10-22 工具全文成功复测，独立窗口 | 14 | 1,910,066 | 14,394 | 1,856,128 | 未定价 |
| 2026-10-22 主协调真实 coding / 压缩窗口 | 30 | 4,443,389 | 30,118 | 3,444,608 | 未定价 |

最后一行含 29 次 main、1 次 history_compact；该摘要调用本身为 input 229,547 / output 2,061、cache read 0。该次压缩前最近请求 398,259，压缩后首次请求 152,443 token，首次缓存读也是 0，后续重新出现命中。两次用户输入不同，不能称为等价费用对照；“压缩不影响缓存”也不成立。

`input` 已包含缓存读取部分，不能再与 cache read 相加。缓存子字段可能来自账本归一化或推算，不能都称供应商逐项显式报告；缺失不补零，未定价不换算美元。

### 历史受控 reuse / fresh 编码对照

两边官方导入同一份明确标记的合成历史，后续 coding 正文相同；生产环境的 AI 自主判断没有被改成强制规则。两臂都通过同一组独立 27 项字节 / 退出码检查。

| 编码臂，含协调与最终通知、不含准备 | 请求 | input / output | cache read / miss | worker 准入至结束 |
| --- | --- | --- | --- | --- |
| fresh | 10 | 133,195 / 14,878 | 107,136 / 26,059 | 86.556 s |
| reuse | 14 | 10,209,830 / 13,989 | 10,187,648 / 22,182 | 200.884 s |

准备阶段各 4 请求，连准备共 32 请求，完整账目在[原对照章节](../workhub-task-centric-implementation.zh-CN.md#受控等价编码成本对照)。首个 worker 请求输入为 7,251 与 1,007,120 token；两边都没有按需读旧历史，所以不能用来评估依赖旧证据的任务。顺序、缓存、模型输出和 reuse 的测试修复均不同；fresh 的 miss 还略多。不能把时长差全归因于换窗，也不能断言 fresh 更便宜。

## 6. 本地可重跑的自动化入口

以下是复核入口，不表示整理本文时重新执行。先安装依赖、构建当前代码，再运行编译产物；不要用陈旧 `dist`：

```sh
npm run build
npm run typecheck
node --test packages/runtime/dist/__tests__/history-compaction.test.js packages/runtime/dist/__tests__/history-compaction-recovery.test.js packages/runtime/dist/__tests__/history-compact-checkpoint.test.js packages/runtime/dist/__tests__/history-compact-summarizer.test.js packages/runtime/dist/__tests__/effective-history-compaction.test.js packages/runtime/dist/__tests__/history-compact-mid-turn-checkpoint.test.js packages/runtime/dist/__tests__/mid-turn-capacity-backend.test.js packages/runtime/dist/__tests__/overflow-reactive-recovery.test.js packages/runtime/dist/__tests__/ai-sdk-backend.test.js
node --test packages/runtime/dist/__tests__/session-manager.test.js packages/runtime/dist/__tests__/recovery-resolver.test.js packages/runtime/dist/__tests__/runtime-kernel-interaction.test.js packages/runtime-host/dist/__tests__/workhub-context-policy.test.js packages/runtime-host/dist/__tests__/safe-boundary-resume-policy.test.js
node packages/eval/dist/workhub-cli.js plan
node packages/eval/dist/workhub-cli.js check /private/path/to/capture.json
```

最后两项的协议和证据要求见[固定评测说明](../workhub-task-centric-evaluation.zh-CN.md)。`plan` 不调用模型，离线 checker 通过也不等于真实模型通过。真实重跑需另建隔离数据、明确模型费用与交互授权，不能对正在使用的用户实例做崩溃注入。

## 7. 未证明或暂不处理

- 任意自然语言追问都能正确关联、所有旧任务都可从近期引用找回。
- 自然九天老化、所有固定目录项、所有模型 / 执行器 / 平台的效果。
- executor fresh、跨 Host 接续、全局文件 / 历史读取、新记忆或恢复框架。
- 独立冷缓存试验、真实美元费用、更优 harness 或一般性性能提升。
- 所有历史环境、布局和 React / ResizeObserver 警告已修复。
- 压缩目标与模型窗口的合理性校验；当前仅已有正整数等基础检查，不把它写成完善的配置保护。

历史负面样本还包括连续调用退役工具、一次空输出、初次 T13 补发旧要求、工具全文只得预览以及沙箱下运行时依赖被拒绝。已有补修与成功复测不抹除这些记录，也不把独立复跑产物测试等同于 Agent 在原权限内运行成功。

本文不改变产品代码、权限、排队、模型配置或阈值；公共异常压缩补丁也不作为本次 WorkHub RFC 必须向上游提交的重复修复。相关上游问题见 [Maka #6254](https://github.com/apache/maka/issues/6254)，其后续修复状态不由本快照保证。
