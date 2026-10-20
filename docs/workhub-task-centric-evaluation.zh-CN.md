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

# WorkHub 任务中心固定评测

此表是行为契约，不是通过记录。`packages/eval` 现有可执行计划与证据检查器；真实模型用例仍须由 Desktop 的正常协调模型工具循环执行。检查器本身不选任务、不调用模型、不连接 Host、不生成历史、不写用户配置。实测以 Host 的持久派活、Turn、工具、交互与请求用量为准；离线合成夹具不计入真实模型质量或计费结果。

## 可执行入口

从仓库根目录安装依赖、按依赖顺序构建后运行；测试使用本次构建的 `dist`：

```sh
npm --workspace @maka/eval run build
node packages/eval/dist/workhub-cli.js plan
node packages/eval/dist/workhub-cli.js plan T01
node --test packages/eval/dist/__tests__/workhub-evidence.test.js
node packages/eval/dist/workhub-cli.js check /private/path/capture.json
```

`plan` 输出固定用户原文、操作位置、布置及私有身份绑定槽位，状态始终为 `pending_desktop_execution`。已实现的路由检查为 T01、T02、T13、J07、J12；附有 T03-direct、T03-queue、T06-fresh 的布置和执行证据检查。其他目录项尚未实现检查器，不能因该文件或离线测试存在就计为通过。

实际运行流程：

1. 使用与生产相同模型、连接及 Desktop 能力的隔离配置。依计划在真实 UI 中输入固定原文，正常经历模型请求与工具调用；记录模型实际选择。预期任务的不可变 ID 只保存在私有 `bindings`，不填进用户原文、标题提示或工具提示来帮助命中。
2. 从 UI/Host 的实际观察导出下述原始事实与来源绑定。完整记录整个观察窗口内的写工具调用、派活和输入事实，包括失败尝试、自动反馈与意料之外的动作；不能只挑正确目标的记录。
3. 对导出文件计算 SHA-256，把证据对象通过引用接入私有清单，运行 `check`。退出码 0 为契约检查通过，1 为证据缺失或行为不满足，2 为清单/引用无效。JSON 输出区分准入、队列、消费和终态，不把受理当成消费。
4. 保留私有原始证据。公开报告只摘录代码版本、用例、模型与执行器、判断及必要计数，不提交业务正文、密钥或模型推理。`realModelPass` 只有 `desktop-model` 模式且所有必需证据检查通过时为真；`offline-checker-fixture` 即使 `verdict=pass` 也始终为假。

历史同主题任务可以真实自然老化，也可以是带标签的隔离历史夹具。T01 的 `history=natural` 要求原始创建时间确实早于本次至少九天；`tagged-isolated-fixture` 必须带 `historyLabel`，报告为夹具设置，不能写成“自然老化九天的真实用户任务”。不能改现场时间戳、伪装模型/用户身份，或向原用户数据库插入编造历史。外部 SDK 没有 Desktop 协调能力时不得用私有 API 绕过能力或认证；真实路由运行仍通过 Desktop。

## 私有证据清单

清单是 JSON 对象。元数据和预期绑定可直接填写；所有实际观察对象在 `desktop-model` 模式都必须引用导出证据文件：

```json
{"$evidence":{"file":"desktop-export.json","sha256":"<原始文件的64位SHA-256>","pointer":"/steps/follow-a/consumption"}}
```

`file` 相对清单目录解析，也支持绝对路径；`pointer` 为 RFC 6901 JSON Pointer，必须选中对象或数组。检查器验证文件摘要与指针，不接受引用旁边追加内联事实。选中数组或对象时，其全部子对象都绑定同一个原始导出，因此可以一次引用整个 `steps` 数组，无需为每个子字段重写引用。哈希只保证后续检查与导出文件一致，不验证导出者的真实性，也不能补足未捕获的执行；隔离来源、观察窗口完整性及 UI 操作来源仍须运行者如实记录。

| 字段 | 必需内容与来源 |
|---|---|
| `schemaVersion`, `mode`, `caseId` | `1`；`desktop-model` 或 `offline-checker-fixture`；`plan` 中的用例 ID |
| `run` | 完整 40 位 `commit`、`profile: isolated`、毫秒 `startedAt`/`endedAt`、`completeObservation: true`、`history: none/natural/tagged-isolated-fixture`；夹具另带标签。这是运行者声明，不能冒充 Host 证明 |
| `environment` | 引用当次有效配置观察：`modelId`、`connectionId`、`connectionSlug`、`executor`、`effectiveContextWindow`、`configuredInputLimit`、`compactionThreshold`、`pricingVerified`；数值未知或主动阈值未配置显式为 `null`。价格核实时补 `pricingSource`，代理连接不得套用上游保证 |
| `bindings` | `plan.bindings` 每个槽位的 `workId`、初始 `generationId`/`sessionId`、`title`；来自真实创建/阶段记录，只用于私有断言，不注入用户输入。模型自主选 fresh 时，检查器沿当前来源派活的 `continuesActionId` 证明同任务、新 generation 与新 Session 后更新本次检查的段身份，不把路由用例强行固定为 reuse，也不改写初始绑定 |
| `setup` | 引用实际布置观察。T01：`oldCreatedAt`（自然历史时）；T02：`previewWorkId`、`mainTopicWorkId`；J07：`coordinatorHistory: empty`、`antecedentWorkIds: []`；T13：`undeliveredFollowup` 的原 `messageId`、`workId`、`userText`、`consumption: null`、`coordinationStatus: cancelled`。应保留这些观察所依据的原始 UI/Host 记录，不把总结性字段当作独立的消费证明 |
| `factsBefore`, `factsAfter` | 引用观察窗口前后的完整、相同范围的持久 WorkHub 事实数组，保留原生 `id`、`kind`、`work`/`workId`、目标与来源字段；至少覆盖所有派活与 `task_input`。原有事实必须保持，新增效果必须逐条归属于固定步骤。额外任务派发、重复效果或复活旧追问都失败 |
| `retiredMutations` | 引用同一窗口新写入或变更的旧纠正事务、任务授权、证据等待、跨任务问答记录差异，原生记录逐条保留，预期为空数组；不能只导出正确目标分组或只检查新六工具而漏掉旧协议副作用。此字段缺失或出现旧协议写入均失败 |
| `toolCalls` | 引用完整正常工具回调序列，条目可为 `{turnId, toolCallId, request: {kind, input}, result?}`（`request` 对应 Desktop `WorkHubTaskToolRequest`），也可直接使用原生可见 function-call RuntimeEvent，或既有 collector 的 `coordinatorTools` 行（`kind/operation/selectedWorkId/name/toolCallId/turnId`）。保留正常 `find/read`、失败动作及自动通知动作；已退休的 `correct/continue_work/...` 写调用也必须计入，不能被丢弃。调用身份按 Turn + toolCallId 绑定 |
| `requests` | 引用每次物理供应商请求的原生 `ModelCallAttempt` 数组，或既有 collector 从 `usage_model_call_attempts` 导出的原生 snake_case 列（`attempt_id`、`logical_call_id`、`completed_at`、`session_id`、`turn_id`、`call_kind`、`provider_id`、`model_id`、`latency_ms`、`status`、`usage_basis`、各 token 列、`cost_basis/cost_usd`）。SQL 投影不补造缺失的 run/trace 字段，`null` 仍是未知。包括协调者、worker、压缩、修复和重试；必须至少关联每个协调 Turn 和已消费 worker Turn，不拿聚合用量或最后一次请求代替完整捕获序列 |
| `steps` | 按 `plan.steps` 的 ID 填写以下逐步骤观察引用；不能增加提示原文或把明确信息的续作变成任务选择 |

每个步骤的 `trigger` 优先直接引用不可变协调 `RootTurnAdmission`（或 `{admission, sourceMessage}` 证明）；检查器从 `execution.feedback` 判断 user/feedback、从 `userMessageId` 与 `normalizedInput`/源消息读原文。任务视图可直接引用原生 `task_input`。也支持实际 UI/Host 回调观察的 `turnId`、`sourceMessageId`、`inputOrigin: user/feedback`、`surface: main/task`、`userText`。不要求重新发明触发封套；用户消息需要来源 ID，自动反馈没有用户来源 ID时不补造。固定用户原文逐字检查；反馈原文由实际事件提供，不能重放旧用户文字作为新授权。

普通派活/续作步骤需要：

- `admission`：原生持久 `delegation_assigned` 或 `task_input` 事实，包含绑定、来源、`targetMessageId`；输入事实需 `targetContentDigest`。单纯工具回执或“已受理”文案不满足。已结束任务的 continuation 会原子写入一条 `task_input` 和一条 `delegate_existing` 派活；检查器要求恰好一条相同消息/任务/阶段且 `continuesActionId` 指向输入原来源的伴随派活，把这两条事实算作同一次执行准入。输入事实的 `turnId` 保留原来源协调轮，当前触发由 `sourceMessageId` 及伴随派活的 `coordinationTurnId` 共同证明，不按字段名误认为另一次派发。
- `queue`：有观察到队列时引用原生 `queue_update`，保留 `steeringEntries`/`followupEntries` 与消息身份；没有捕获时报告 `not_observed`。T03-queue 额外需要 `queueBefore`，补充前后消息身份与顺序相同，`cancellation` 为取消后的原生任务输入回执，`activeBefore`/`activeAfter` 为 A 相同执行的仍运行快照。被取消输入不能声称消费或完成。
- `consumption`：原生 `{admission, sourceMessage}` Root 源消息证明，或 `{event}` 不可变 Steering 证明。执行身份、消息身份与已受理内容摘要必须一致。T03-direct 另需 `activeBefore` 及 `activeTool` 的原执行、`startedAt`/`completedAt`/`status`，证明输入发生在工具期间、消费在工具完成后且仍是同一 Turn/Run。队列记录消失或回执 `delivered` 本身不能代替此证明。
- `terminal`：消费所属执行的原生已完成 `TurnSnapshot`，带 `terminalEventId`。自动反馈步骤也须有自己的协调终态，确保观察没有停在动作发生之前。J07 改用仍待回答的原生 `interaction` 快照，选项同时有候选与 `new_task`，且没有派活。
- T06-fresh 另需 `previousSegment` 旧段观察，以及 `historyReads`：新段实际 `read` 工具回调数组，保留 `{sessionId, turnId, runId, input: {taskId, view: history}, result}`，`result` 是原生 `status/history` 页。要求原请求、`recordSource: task_input` 的纠正、工具参数与结果均实际读到，记录的 `actionId` 必须属于本任务既有权威事实；无关任务内容、不可用或不支持不当作空成功。此项只检查实际读取与血缘，不据此宣称模型已遵守全部纠正；后者还需具体 coding 产物核验。

## 检查器的边界

离线测试故意构造正确与错误记录，验证错误旧目标、预览误派、重复调用、旧追问复活、缺失消费、跨 Turn 纠正、队列换位及历史泄露能被检查出来；测试名称明确标为 OFFLINE。它们不模拟真实路由器，不替模型选 ID，也不证明任何真实模型用例通过。

用量按原生 `usageBasis` 与可用字段汇总：任何请求缺少某项计数时，该项总数为 `null`，不会补零；供应商报告的零则保留为零。`estimatedUsd` 只在连接价格已核实、每个已捕获请求均有价格时给出，标签固定为 `connection_price_estimate_only`。这些记录只能证明已捕获请求，输出固定注明 `coverage: captured_attempts_only`；不能证明崩溃期间无遗漏，不称为账单，不输出未选方案费用或虚构的冷缓存节省。

## 原 Jev 十二例的生产路径替代

原始输入、三个候选及历史期望完整保留在 [原始 JSON](archive/jev-routing-evaluation-2026-09-22/results/default.json)。新评测通过正常 WorkHub 工具循环运行，不再调用 Intent / Recall 适配器。阶段 1 先保留行为语义；六工具落地后使用右列入口核验。

| 编号 | 原输入 | 新路径期望 |
|---|---|---|
| J01 | 什么是指数退避？只解释一下原理。 | 直接回答，不派发 |
| J02 | 新建一个任务，实现 CSV 导出功能。 | `start` 独立任务 |
| J03 | 继续 Maka 工作区的 Payments retry 工作。 | 找到明确任务，`continue` |
| J04 | 继续修正文档拼写错误，接着 Documentation spelling 那个任务做。 | 找到明确任务，`continue` |
| J05 | 把登录表单的校验补完整，就在已有的 Login form validation 任务里做。 | 找到明确任务，`continue` |
| J06 | 帮我分析火星探测器轨道数据。 | 无旧任务指向；可 `start`，缺必需输入时询问。不同于旧预分类器强制 clarify |
| J07 | 继续那个任务。 | 没有可确认的对话先行词时 `ask`，含“新建任务”选项 |
| J08 | 停止 WorkHub 刚才委派的工作。 | 用户轮、唯一明确目标时停止；身份与动作重放保持绑定 |
| J09 | 恢复刚才被我停止的 WorkHub 委派。 | 普通 `continue` 不重放旧工具；安全恢复仍按现有恢复策略 |
| J10 | 纠正你刚才的委派：不要改样式，只修逻辑。 | 当前执行走 Steering；排队走原位补充；不走替换事务 |
| J11 | 不要继续 Payments retry；新建一个单独的支付重试任务。 | `start`，不因主题相似复用旧任务 |
| J12 | 接着做吧。 | 先行对话明确为 Payments retry 时回到该任务，不靠标题关键词 |

## 必要交叉场景

| 编号 | 布置 | 应检查的事实 |
|---|---|---|
| T01 | 存在九天前同主题任务；本轮 A → 无关 B → 自然追问 | 明确本轮 A 的追问不误投历史；没有指向时不硬猜 |
| T02 | 总对话最近主题 B，右栏预览 A，总输入只说“继续” | 预览不参与派发；按总对话主题 B |
| T03 | A 工具执行中直接纠正；B 排队、补充后取消 | 纠正下次模型边界进同轮；不打断工具；B 原队列位置保留且取消不影响 A |
| T04 | 忙碌 / 排队 / 停止中 / 待审批时 fresh；之后空闲 fresh | 前四者无新段副作用；空闲新段同任务；旧 stop / 重试不能误作用新段 |
| T05 | 改新任务默认；再显式改 A 当前段持久设置；fresh | 默认不覆盖 A；fresh 继承 A 当前有效设置；临时许可不继承 |
| T06 | 同段混有其他任务；本任务跨段按需读旧要求、纠正、工具结果 | 同任务血缘内原文完整可读，其他任务不泄露；ai-sdk / executor 分别核验 |
| T07 | 工具审批 / 沙箱 / 客户端能力待处理 | 原交互原位回答，不经模型，不绕审批；迟到回答不续跑旧协议 |
| T08 | 多任务 stop 拆成连续调用；结果通知轮 stop | 需要确认；重放不重复计数；自动通知不当作用户新授权 |
| T09 | 重建索引、中文短词、目录过滤 AND→OR、重启分页 | 任务/段/设置保留；目录先过滤；不变集合无重复；手动会话不重复 |
| T10 | 升级前活动 / 排队 / 旧等待 / 半完成纠正，反复恢复 | 普通工作不批量停止，旧协议幂等结清，授权不复活、无重复副作用或资源泄漏 |
| T11 | 单行 / JSON 输出、失败 Write、无状态信息 | 不强加状态块，不把尝试说成成功，无额外总结调用 |
| T12 | 按当前模型窗口准备长历史的真实 coding 副本 | AI 自选 reuse/fresh；记录实际压缩、重读、纠正遵守和全部请求用量，未选方案不冒充实测 |
| T13 | 上一轮追问未投递，协调轮已停止；用户开始明确独立的新 A/B | 只执行当前要求，不在本轮补发旧追问；自动反馈也不复活旧动作 |
| T14 | 同 Session 内 A 执行、B/C 已排队；只停止 A，待 B 开始后重试旧 A 停止；包括迟到 nack / ACK、原位与提升纠正的混合恢复、已提交后继来源的交接窗口 | A 的未消费纠正不在收尾或恢复后进入 B/C；消费 echo 或后继 Root 来源证明不误取消；恢复不重放已清理旧快照；B/C 不被连带撤回、仍按 FIFO；旧停止不影响 B；普通完整停止保持原规则 |

## 结果字段与限制

每次实测记录代码提交、用例、时间、模型 / 连接、执行器、有效窗口 / 输入上限、已配置的 `compactionThreshold`（缺失即未配置）、选择、任务 / 段 / Turn / action、准入及终态、耗时、输入 / 输出 / 缓存用量及字段来源。模型最大窗口不冒充主动压缩目标。测试在隔离目录进行，不复制业务内容到公开记录。

真实请求与工具序列同时满足才能计为通过；受理不是执行完成。缺失用量标未知。当前连接价格未核实则不换算费用；估算不是账单。单次测试不是统计质量结论，未实际比较的复用 / 换窗方案不报告成本收益。
