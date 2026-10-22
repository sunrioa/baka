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
