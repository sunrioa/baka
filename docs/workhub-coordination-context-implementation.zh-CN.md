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

# WorkHub 主协调上下文：最小改造实施记录

## 范围

经用户确认，保留 AI 对任务关联和 reuse/fresh 的自主判断，以及现有权限、FIFO、并发、目录串行、Steering 和停止确认规则。复用超大工具结果归档/分页与原生会话压缩；不新增独立旧回包清理器、交接摘要调用、记忆服务或固定压缩阈值，不扩展 executor fresh。

按以下顺序推进，未完成项不视作通过：

1. 原实例只读基线统计，保留未压缩样本。
2. 新通知/默认回包减噪、轻量可重建任务引用；不反复改写旧请求前缀。
3. 协调会话手动压缩入口及独立配置覆盖，沿用原压缩算法与检查点。
4. 受影响测试与当前 Command Code DeepSeek 真实 coding 复测，整理到原 draft PR #54，交用户审阅，不合并。

## 2026-10-22：阶段 1，只读基线

统计代码基于 `9366818f2`（运行实现 `6d6d36ba8`）。统计用的 replay planner、projection reducer 和通知投影构建产物与运行实例逐字节一致。

`scripts/workhub-context-baseline.mjs` 以 SQLite `readOnly` 连接读取明确指定的数据库和 Session，在一个只读事务内按持久 ordinal 获取记录；复用生产 replay planner 和已提交的模型投影替换记录。没有连接 Host、迁移、触发归档/压缩、调用模型或写回数据库。报告只输出聚合尺寸和用量；可选私有快照以 `0600`、只创建不覆盖保存，不包含 reasoning 正文，不提交仓库。

复现方式（先构建 Runtime/Core）：

```sh
node scripts/workhub-context-baseline.mjs --db '<existing runtime.sqlite>' \
  --session maka_workhub_coordination --out '<new aggregate report.json>' \
  --private-snapshot-out '<new private snapshot.json>'
node scripts/workhub-context-baseline.mjs --snapshot '<private snapshot.json>' \
  --out '<new aggregate report.json>'
node --test scripts/workhub-context-baseline.test.mjs
```

采样时间：2026-10-22 09:50:36 UTC。协调会话持久 ordinal 截至 1961，原样保留；Command Code `deepseek/deepseek-v4.1-flash`。14 条已提交归档替换生效、0 条拒绝、0 个历史压缩检查点。

私有快照的规范化 JSON SHA-256：`023e542fa4e7b61f97d8afc54e199de4146d4da68982f6108584f1471f64d5a1`。原始用户文字、工具回包和私有快照均未加入仓库。

### 模型可回放文本/工具载荷组成

以下为生产 planner 的 portable 文本/工具 payload 尺寸，不是完整 HTTP 请求，不含系统提示、供应商 reasoning/media 编码和协议包装；旧工具转成历史事实时增加的包装也不在分项内。百分比按 UTF-8 字节计算，不冒称精确 token 占比。

| 分类 | 项数 | UTF-8 字节 | 载荷字节占比 |
| --- | ---: | ---: | ---: |
| 用户输入 | 85 | 56,848 | 5.35% |
| 协调模型回复 | 174 | 269,973 | 25.41% |
| 结果通知 | 89 | 221,679 | 20.86% |
| 工具参数 | 187 | 126,608 | 11.92% |
| 已退役旧工具的历史结果 | 84 | 165,307 | 15.56% |
| 其他工具回包（含旧读取入口） | 57 | 135,798 | 12.78% |
| 现行 WorkHubRead 回包 | 22 | 68,711 | 6.47% |
| 现行 find 回包 | 3 | 11,222 | 1.06% |
| 现行动作回执 | 23 | 6,385 | 0.60% |
| 合计 | 724 | 1,062,531 | 100%（四舍五入） |

当前采样的工具 schema JSON 为 18,229 字节，另列不混入历史占比。持久请求构建快照只保存系统提示 hash，没有正文，因此其精确大小保持未知。

### 实际请求与估算必须分开

最近一次已完成主协调请求 `72578fc1-9fc6-410d-876e-e9c56426c7ab` 报告输入 388,475、输出 1,652 token；用量账本缓存读 385,920、缓存未命中输入 2,555，未定价。缓存子字段是账本归一化数据，不能推定每一项都由供应商显式报告；不换算美元费用。

Runtime 对上次请求的估算为 283,998 token；本次 portable 载荷按 UTF-16 单位/4 得到 191,104，仅用于可重复的尺寸估算，不是 DeepSeek tokenizer，也不能替代上面的供应商实报值。采样历史还包含上次请求完成后的输出，不能冒称还原该请求的全部 HTTP 输入。

基线检查器对存在压缩检查点的源明确拒绝，而不是把原始全文误报为活跃上下文；后续压缩后对照必须使用经过检查点选择和有效覆盖校验的 replay。

### 结论与当前验证

- 通知和协调回复均为显著组成；现行 find/WorkHubRead 合计约 7.52%，没有证据支持先新增独立回包清理器。
- 原有大结果归档已经生效，不应重复实现；新通知从源头减噪，累计旧历史由原生压缩处理。
- 5 项诊断测试通过：分类、已归档正文不复活、UTF-8 与估算分离、未支持/损坏来源拒绝，以及 SQLite 快照不产生数据变更。
- 此阶段无新供应商调用或费用，不算真实模型行为回归已通过；后续实现、实测和压缩成本对照仍待完成。

## 阶段 2–3：最小实现与边界

### 新输入减噪，不改写累计历史

- 新结果通知采用 version 2：仅保留 taskId、现有精确结果定位 sourceActionId、真实 Host 状态、短结果预览，以及有必要的最新纠正/交互定位。内部 Session/Turn/Run/delegation 标识、重复任务正文与长工具说明不再逐条复制。原有完整来源仍在持久事件里，按需读取不受影响。
- 固定的 WorkHubRead 用法移入稳定协调提示。预览明确标注截断；两个引用逐字保留，不截断、不另造引用协议。旧通知继续采用原来的回放格式，不借此改写已发布历史前缀。
- 模型的 find 只返回候选摘要页，去掉逐项详细用量/成本观测；选中任务后用 WorkHubRead(status) 查看。Host 原始查询与 UI 页不变，游标不变，requirements/result/history 的原文按需读取不变。

### 可重建近期任务引用

从用户发起轮次里成功的 start/continue 回执与 ask 任务选择重建，只含 taskId 与短标题，按最后提及顺序排列。自动结果通知、侧栏预览、未证实或失败的回执不改变这个顺序。

实现复用现有请求尾部的 Host context 通道，而不是每轮向持久聊天记录再追加一份索引：每个 Root Turn 固定采样一次，最多 8 条、总计 1,536 UTF-8 字节；回查最近最多 4 页、每页 32 条持久记录。读取真实 Desktop MCP 的 structuredContent 回执，并核对原始轮次和规范任务关系。它不是路由决定或当前状态；不在近期片段内的旧工作仍须 find 检索，无法确定则询问用户。

原始记录没有随模型压缩被删除，因此引用可在压缩/重启后重建；不增加表、摘要调用或记忆服务。当前轮完整工具回包仍可正常多页读取，没有滑动窗口清理器。

### 主协调压缩

- WorkHub 输入 `/compact` 是本地命令，走专用固定目标 Host 操作 `workhub.coordination.compact`，不发给模型、不进入 Steering 或追问队列。忙碌时拒绝并保留草稿；附件也不悄悄丢弃。普通 Session 的 context.compact 仍不能冒用协调身份。
- 复用既有原生压缩、持久检查点和终态提示。主协调压缩不会停止、重启或压缩任务 Session。冷启动时通过请求 Desktop 的现有能力绑定构建原生后端，不绕过工具/权限边界。
- 输入栏新增“主协调上下文”设置。可选策略字段 workHubCompactionThreshold 仅覆盖协调后端的本次激活快照，观测使用同一覆盖规则；不写回模型目录，不改变任务默认设置。留空恢复继承模型配置；模型本身也未配置时依旧没有主动阈值，只保留手动压缩与原有溢出恢复。
- 不提供 AI 压缩工具，不替 AI 决定任务关联或 reuse/fresh。窗口与压缩目标分开显示，不将压缩目标当作模型最大窗口。

本轮 Client/Host 契约统一提升到 compatibility epoch 240；没有新增数据库迁移或恢复服务。压缩本身会改变后续请求前缀，可能需要重建供应商缓存，不能宣称压缩不影响缓存；本轮避免的是日常反复改写旧回包产生的额外失效。

### 当前本地验证（真实模型复测尚待补入）

- Core 全量 921 项通过；Desktop 全量 3,373 项通过；原生压缩/预算/回放回归另行记录。
- 首轮 Host 全量 2,520 通过、5 失败、12 跳过：五个集成夹具仍用旧通知前缀识别新反馈，已改为新格式，五项定向复跑全通过。之后的 Host 全量复跑结果需单独记录，不把失败轮次抹去。
- 原通知、真实纠正、队列/同轮 Steering、近期引用边界、独立阈值继承、固定协调入口和 UI 本地命令测试已补齐。额外对照原实例真实回执，修正了 MCP structuredContent 解析，而不是只依赖简化夹具。
- Desktop 类型检查、Renderer 构建及架构门禁通过；没有打开 GitHub CI。当前实例真实 coding 和压缩后旧任务关联/全文读取的证据与用量仍待本阶段实测，不以测试数量替代。
- 随后的 Host 全量复跑：2,537 项中 2,525 通过、0 失败、12 跳过；补充的真实 MCP 回执结构与协调入口测试 8 项通过。原生压缩/上下文预算/回放回归 179 项通过。
- 一次重复的受限 Desktop 全量命令未申请既有临时锁权限，在账户级 state-root-owners 的 chmod 处失败；未通过修改权限或锁算法绕开。上面的 3,373 通过来自已获准的全量运行，不将这次环境拒绝写成产品测试通过。

### 原实例探测发现并修正的接线缺口

新版启动后，原实例仍为 Command Code DeepSeek、bypass、并发 8、协调阈值未配置；四份原配置文件 hash 与重启前一致。Mac 锁屏期间通过真实 Owner SDK 探测固定压缩入口，返回 operation_unavailable，未产生压缩轮次或模型调用。

定位到 RootTurnCoordinator 的通用 prepare/admit 会提前拒绝协调 Session，单独的 ContextCoordinator 桩没有覆盖这一层。修复为仅供原生压缩协调器持有的窄接口，仍使用原保留/准入/重试机制，只接受 context_compact、空正文和空用户消息身份；普通 prepare/admit 与普通 context.compact 的 WorkHub 拒绝不变。补充真实 Root lane 的压缩启动、同身份重试、忙碌拒绝、Stop 与窄接口不可派发消息测试。没有放宽公开会话入口或任务权限。

该故障轮次保留在私有实测记录；不把它算作实机压缩通过。后续需在新构建上继续验证。

## 2026-10-22：原实例真实任务与原生压缩复测

### 方法与运行状态

运行功能版本 `362808a9d`（原开发 checkout 的等价 cherry-pick 为 `1fdc5fb30`），仍为唯一原 Baka 开发 App，沿用原数据和 Command Code DeepSeek。Mac 锁屏，CUA 不能操作；本轮使用产品既有的认证 Owner SDK、真实 Desktop 任务工具和原生 Host，不伪装 Desktop、不注入协调轮次/工具回执、不补充权限。UI 的本地 `/compact` 分流与 IPC 由自动化覆盖，未把原生 API 实测冒称鼠标/键盘或截图验证。

冷启动下无关联 Desktop 工具提供方的 Owner 压缩探测被正确拒绝；没有改用空的发起身份或新增注册来绕过。随后原生任务结果建立现有 Desktop 绑定，正常 Owner 协调输入与压缩可用。原始拒绝也保留，不计成功。

### 实际结果

| 用例 | 原生事实与独立复核 |
| --- | --- |
| 已有私有 coding 任务续作 | 对原 formatDuration 任务追加时长累计 CLI，使用实际 Node 子进程测试；不是 sleep、循环占位任务或外部测试集。首次工作由原侧栏任务输入 API 提交，明确与后面的 AI 路由验证区分。 |
| 执行中纠正 | 运行中补充 `duration-error:` 前缀。初始回执为 steering/queued，最终为 delivered；与编码输入的 Session、Turn、Run 完全相同，没有另起一轮。独立重跑 84/84 通过。 |
| 协调模型自主关联 | 只描述“已有的时长累计 CLI 加 --json，先方案再确认”，未提供 taskId/Session/container。真实模型调用 continue，选择原任务与 reuse，而非 start。 |
| 主协调原生压缩 | `context_compact` Root 完成并持久化检查点 `hcheckpoint-c15b851ecffe349478f4249c02c95d59`；没有压缩任务 Session，也没有配置任何数值阈值。 |
| 压缩后模糊追问 | 输入原文仅“继续，把方案落实并运行相关测试。”。真实协调模型仍调用同一任务的 continue/reuse，JSON 改造由原任务、原 Session 完成。最终独立重跑 98/98 通过。 |
| 旧任务按需回查 | 用“前几天那个只清理首尾普通空格的小函数”自然描述查询另一旧任务。模型按需调用 WorkHubRead(status/requirements)、find(trimSpaces)，没有新建、续办或停止任务；精简 find 真实回包 812 字节、1 候选、不含详细 context。 |
| 现有大回包归档 | 上述按需 status 大于普通预览，模型成功用本协调 Session 的原生 maka://read 续读；没有扩大普通文件读取范围，也没有 WorkHubRead/Read 的工具错误。 |
| 忙碌时压缩 | 在真实协调请求执行中压缩，Host 返回 session_busy；之后 turn.query 确认该压缩身份不存在，未隐藏排队。这个预期的 not_found 是拒绝准入证明，不是工具原文读取缺失。 |

原始六个 coding 文件 hash 全部不变；只在已授权的私有测试目录新增 CLI 与两份测试。原配置四文件 hash 全部不变，保持新任务权限 bypass、并发 8、协调阈值未配置。与压缩前数据库备份逐项比对：原协调 1,961 条、原任务 124 条 RuntimeEvent 的持久 JSON 全部原样保留。压缩改变模型回放，不删原对话/工具记录。

三个新通知实际为 956 / 672 / 676 UTF-8 字节，均为 version 2，没有重复长工具说明或正文内的 targetSessionId；精确来源仍保留在原生 origin。没有把这个小样本外推为所有历史通知的节省比例。

### 失败记录与评测边界

- JSON 编码首轮生成的测试为 97/98：一个“重复 --json、无时长参数”的测试误用有时长参数的期望值。Agent 修正新增测试的期望值后 98/98；独立复跑同样通过。此轮失败和修复用量均计入，没有把生成代码视作一次全对。
- 最后一次完整 Host 回归 2,539 项：2,527 通过、0 失败、12 原有跳过；此前另一完整运行在 cold/fresh 夹具关闭阶段记录一次 AggregateError，定向两分支与后续完整运行通过。根因未单独证明，本轮没有顺手修改生产关闭逻辑，也未删除失败记录。
- 官方 Desktop `test:dist` 入口（包括开发启动脚本）3,404 通过、0 失败/跳过。Core 921、原生压缩/预算/回放 179、基线诊断 5 项通过；Root lane 的 93 项为 Host 子集，不重复累加成总数。
- 类型检查、Renderer 构建、架构门禁、全仓 lint（4,182 文件）/format（2,374 文件）和 ASF 头检查均通过；GitHub CI 继续关闭，不查看。
- 没有重跑自然九天老化、全供应商效果、executor fresh 或真实价格评测。原生 API 与本地自动化通过不等于已完成锁屏下无法做的界面肉眼复核。

### 用量记录（含失败、修复与压缩）

本轮真实窗口内主协调与该任务合计 30 次供应商调用：29 main、1 history_compact，均有 reported 用量。输入 4,443,389、输出 30,118 token；账本归一化缓存读 3,444,608、缓存未命中输入 998,781。全部未定价，不换算美元，也不把代理的缓存字段解释为官方原生价格。

压缩本身使用输入 229,547、输出 2,061 token，缓存读为 0。压缩前最近一次主协调请求输入 398,259，压缩后首次输入 152,443（约下降 61.7%），首次缓存读也是 0；后续主协调读取恢复了明显缓存命中。它证明压缩会有重建缓存和额外模型调用的成本，不能宣称“压缩不影响缓存”。这只是同实例观测，前后用户输入不同，不是等价任务成本对照，也不能据此承诺净费用下降。

原生采集文件 SHA-256：`fdc1e4bbb718aa38548f1f516665c770bfc76db813c864d753f59cd4f09cfe55`。私有审计报告另核对同轮纠正、任务调用、原记录和配置不变；原始文本、凭据、完整轨迹与生成的 coding 文件不提交仓库。

## 2026-10-22：解锁后补做界面复核

用户解锁后，在原实例的专用 bundle 标识下完成实际操作。通用“Maka Dev”名称曾匹配到另一个窗口；仅观察、未操作该窗口，也未将它的渲染错误归到本次 Baka 构建。

- 打开输入栏“主协调上下文”，实际窗口显示模型窗口 1,000,000、压缩目标为空且占位为“继承模型配置”；说明明确仅影响协调会话。检查后关闭，未保存任何数值配置。
- 在 WorkHub 总输入框键入 `/compact` 并按 Return。实际观察到输入框清空、“正在压缩上下文…”进度，以及完成后的“已压缩较早的上下文。”分隔线；模型选择与空输入框恢复可用。
- 原生只读核对：该操作对应 `context_compact` Root，`userMessageId` / `normalizedInput` 均为 null，`sourceMessages` 为空；没有把命令当模型消息或任务输入。终态 completed，检查点为 `hcheckpoint-e101ed678d45c5f8552f83233872e4da`。
- 操作窗口内只有这一条压缩准入，没有新增任务或 worker 轮次；任务索引仍为 48 条。操作前的 2,042 条协调 RuntimeEvent 仍在；原配置四文件 hash 不变，权限 bypass、并发 8、协调阈值未配置。
- 这次原生检查点复用了上一次的摘要正文，未发现新的供应商调用账本行，不把界面复核计为第二次模型摘要或新增费用实测。前节 30 次调用的用量窗口保持不变。

此次只补足先前因锁屏延期的界面证据，没有重复编码任务、改动产品代码或重启其他实例。私有界面审计保留原生身份与聚合断言，不提交用户对话截图。

## 2026-10-22：补修结果预览的状态项保留

经用户确认，本轮仅修结果预览；压缩目标与模型窗口的合理性校验暂不处理，不修改权限、排队或压缩算法。

- 新通知复用现有 `readWorkHubWorkerStatus`，仅识别最终、顶层、未引用的有效 worker 状态块。完成、未完成 / 下一步、已验证及可选的需要用户决定分别占用独立的 128 字节 JSON 编码预算，合并结果仍不超过原来的 512 字节预算；超长单项保留自己的省略标记，不挤掉后续项。
- 没有有效状态块时，仍使用原正文开头摘录；严格一行输出、代码示例、引用、错误格式及非最终状态块不被误识别。worker 自述不覆盖真实 Host 的 completed / failed / cancelled 等状态，也不构成验收或授权。
- 解析提示只在新通知构建时传入，不加入持久通知字段；旧通知回放不重新解析状态块。精确任务 / 结果引用、全文按需读取和整体通知预算不变，没有新增模型摘要调用或协议版本。
- 新增回归在修复前出现两项预期失败：长正文遮住尾部状态块、超长前项遮住后续事项；修复后相关 48 项通过。Core 全量 937 通过；Host 全量 2,542 项中 2,530 通过、12 原有跳过、0 失败。
- 用原 R3 阶段二已持久化的 3,836 字节真实 worker 回复离线重放生产通知构建：原正文预览缺少状态项，新预览保留三项状态、JSON 编码 326 字节，Host 终态与重复回放不变。这是原始真实输出的离线回归，不冒称新一轮实机派发或供应商调用；原实例未重启，原记录未改写。
- 合并前架构检查发现此前提交将普通会话的私有压缩提示模块重新导出给 WorkHub，违反既有功能边界。只将该模块移到共享 application/contracts，改用既有公共提示词目录，并从功能调用方传入原错误格式化和目录错误文案；不改压缩、发送、权限或排队行为，不放宽架构规则。三语言对照曾发现共享目录的繁体错误标题措辞不同，已通过保留原调用方文案消除差异并补回归。
- 最新桌面官方 `test:dist` **3,406 / 3,406 通过**，全仓类型、lint、format、ASF 检查通过；全仓构建及最后桌面重建通过。Renderer 架构 165 项及相对原 main 的 `--strict-base` 门禁通过。一次沙箱内桌面全跑受本地端口 / 账户级临时锁目录限制而失败，未计为通过；正常审批后完整复跑通过，未改产品权限或原实例数据。
- 按用户本次授权，将此补修与上述最小边界整理推送到既有 PR #54，再按仓库正常规则合入 main；不启用或查询 GitHub Actions，不处理压缩目标合理性校验。

## 2026-10-23：修复主协调设置框无法键入

- 原因是设置 `Dialog` 被挂在 Composer 的 footer 内。点击文本框冒泡到共享 ChatComposer 的空白点击处理，触发原消息编辑器的 `focusEditableAtEnd`；浏览器的焦点仍显示在文本框，Selection 却回到背景消息编辑器，实际键盘输入无效。
- 仅分开设置按钮和受控弹窗：按钮保留原位置，弹窗在 WorkHubRoot 中作为 Composer 外的兄弟挂载；会话 / Host 切换时关闭旧设置。输入、保存、留空继承与原生压缩调用不变，不修改阈值算法、权限或排队，也不修改共享组件或依赖。
- 新 Storybook 回归使用原 WorkHubRoot、controller、Composer 和原生 Dialog，只替换 Host 传输。覆盖实际 Selection 不回到聊天编辑器、键入、保存重开、取消不保存、清空恢复继承、Enter 不误发主聊天和未发送草稿保持不变。旧版明暗主题均失败；附加原生 Chromium 键盘对照显示旧版仍停留在 `50000`，修复后得到预期 `42000`，且 Selection 不再进入背景 Composer。
- 桌面官方回归 **3,406 / 3,406** 通过；桌面构建、类型（含 stories）、lint、format、ASF、架构 165 项及相对 main 的 strict-base 检查通过。焦点 / Selection 在浏览器层验证，没有为此新增 Electron E2E 或启动第二个 Maka 实例。
- 当前原实例只热更新上述两个前端文件，并核对与测试版本逐字一致。实际首次点击后键入 `250000`，清空后改为 `300000` 均成功，Enter 未关闭弹窗或派发聊天；随后关闭取消，重开仍显示「继承模型配置」。没有保存测试数值、触发压缩、重启 App 或改变原配置。
- 最终定向浏览器检查为 4 个 Story、6 次明暗主题渲染，全部通过，包括本次设置框、原模型 / 并发选择、权限确认和用量入口；不是全量 Storybook。补强后曾有一次可见性断言早于弹窗淡入完成，改为在原有条件等待中确认实际可见后再测，未放宽超时或新增重试。其他既有场景仍记录 ResizeObserver 诊断，未在本轮处理。
