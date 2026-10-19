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

# WorkHub 任务中心改造：实施与验证记录

- 依据：[已确认 ADR](architecture/workhub-task-centric-adr.zh-CN.md)。
- 实施起点：`d43a4d317`，运行时代码基准 `a7f6925`。
- 开始日期：2026-10-19。
- 约束：AI 自主选择 reuse / fresh；不强制换窗、不全量复制上下文、不新增交接总结调用；保留现有权限、FIFO、并发和同目录串行。GitHub Actions 保持停用。

## 阶段进度

| 阶段 | 范围 | 状态 | 验证 / PR |
|---|---|---|---|
| 1 | 删除 Jev / 预路由，兼容旧策略、凭据、准入与用量，修正工具描述 | 已实现，待人工审阅 | [PR #35](https://github.com/sunrioa/baka/pull/35)，未合并 |
| 2 | 配置继承、目录、观测与估计、执行绑定及 stop | 未开始 | — |
| 3 | 可重建任务索引、六工具、统一输入与历史读取 | 未开始 | — |
| 4 | 删除旧纠正 / 候选快照 / 转发 / 任务授权 / 依赖等待 / peer 协议 | 未开始 | — |
| 5 | 有界任务说明、历史入口和可选状态块 | 未开始 | — |
| 6 | 任务界面、原审批、侧栏折叠、默认模型持久化 | 未开始 | — |
| 7 | 逐阶段回归、真实 coding、长上下文与成本实测 | 未开始 | 用例从阶段 1 开始整理 |

## 验证规则

- 每阶段单独记录提交、测试命令及结果；删除旧机制时列出删除测试与替代用例。
- 旧数据不只测试解码，还测试 Host 启动和未完成操作的幂等恢复。
- 实机沿用当前实例配置；测试工作文件在独立测试目录，不改业务文件或默认权限。涉及现有持久数据前先保留可恢复副本。
- 真实派发与执行按 Host 记录核对；受理、进入队列、Agent 消费、执行完成分别记录，不能混称成功。
- 未测试、未观测、未知费用均如实标记，不补零值，不用本地夹具代替真实供应商数据。

## 用量采样字段

真实模型用例按任务与请求关联记录：用例编号、时间、代码提交、连接 / 模型标识、执行器、有效窗口配置、reuse / fresh 选择、任务与阶段、派发及执行状态、请求耗时、输入 / 输出 token、供应商可区分的缓存读取 / 写入 / 未命中用量、压缩或重读历史情况、是否遵守用户纠正。

仅记录必要标识与归一化用量，不记录密钥、认证头或无关业务内容。保留字段来源，缺失值为未知；价格未核实不换算费用，费用估算不称供应商账单。未执行的替代方案没有“实际成本”。

## 当前实测状态

已开始阶段 1 真实采样，统一使用现有 Command Code 连接的 `deepseek/deepseek-v4.1-flash`。当前样本不用于声称全部改造完成或费用下降。

## 阶段 1 记录

- 已核对 `a7f6925..d43a4d317`：仅新增 ADR，实施基准有效。
- 目标：移除主动预分类 / recall / 强制路由绑定；旧 `jev` 字段读取后停用，凭据保留，旧 `routingDecision` 读取后丢弃，旧用量类型可读。
- 已删除：`workhub-routing.ts`、`jev-routing-model.ts`、Jev 设置组件与文案、旧分离适配器 replay 脚本，以及两份仅针对被删功能的测试文件。移除对应的 Intent / Recall 注入、准入绑定与旧提示。
- 替代覆盖：旧策略剥离、旧凭据保留、SQLite 中旧 `routingDecision` 恢复和重放不改变 Run；当前协调轮不再含预决策。原 replay 的十二个输入和历史结果仍保留，见[评测目录](workhub-task-centric-evaluation.zh-CN.md)，不是删掉失败场景。
- 局部回归：策略 / 存储兼容 104 项、Host 核心路径 252 项、新提示契约 5 项通过；Desktop 架构 165 项通过。lint、format、typecheck、许可证检查、Desktop / UI knip 均通过。
- 全量：首次并行运行失败，包含测试超时与系统 Python 3.9 不兼容；Python 3.12 原样运行 94 项通过（13 项原有平台 / 环境 skip），Runtime 单独 3,769 项无失败，先前超时涉及的四份 Host 测试 212 项通过。全部工作区顺序运行时，除 Host 外其余通过。固定编译产物的 Host 文件并发 4 运行有 1 项原有两秒等待超时（2,357 通过、12 跳过），该用例单独通过；文件并发 1 的完整运行 2,358 通过、12 原有跳过、0 失败，耗时 529 秒。失败与通过的完整日志均保留，不能把最初的失败运行改写成全绿；没有修改测试超时、断言或重试规则。
- 补充兼容核验：在临时数据库中实际写入旧 `routingDecision`，同时写入含 `jev` 的旧策略文件，然后完整恢复 Host。验证原 Turn / Run 不变、无关 Desktop 无法接管、缺少工具时不会执行、齐备后只执行一次；再次关闭并重建 Host，终态不重放。强化后完整模型组合测试文件 39/39 通过。夹具初次因默认策略未落盘而失败，修正夹具构造后通过，生产逻辑未变。
- 独立新审查会话只读审查提交 `0a0a5be13`，未发现新增可操作问题；指出旧磁盘记录尚缺完整 Host 跨重启证明，已用上述回归补齐。AI 审查不替代人工审阅；PR 暂不合并，GitHub Actions 仍停用。

### 实机与用量（2026-10-19）

- 使用原 profile；启动前正常退出 App / Host，数据库静态副本与原文件 SHA-256 一致，Node SQLite `quick_check=ok`；策略、模型目录、凭据及设置保留私有副本，未上传。系统自带旧版 SQLite 无法读取，不将失败的空备份当有效副本。
- 旧协调会话仍绑定已停用的直连 DeepSeek，首次准入在模型解析时失败、无任务派发。按用户指定，通过现有 Host 配置接口改用**已配置且已启用**的 Command Code DeepSeek；不改密钥、权限或并发。
- A「字段解析」和 B「统计」各新建独立任务、独立私有目录；实际供应商请求均为 Command Code DeepSeek。A 实际 `node --test` 13/13，B 19/19，均 exit 0。B 在 A 终态之后执行，现有并发 1 的排队顺序未改变。
- 不带任务名追问：“刚才按第一个等号拆开的那个……补一个 value 完全由空格和制表符组成的边界测试”。模型选择了本轮 A 的 workId / sourceActionId，但四次 `continue_work` 参数含多余 `status`（首个还缺 workId），均被 schema 拒绝，未产生新 assignment。为避免继续无效调用，手动停止了**该协调轮**，未停止或重跑 A/B。此例记失败，待六工具收敛后复测；不把“选对”说成“投递成功”。
- 首组 A/B（含两次结果通知）：17 个报告用量的请求；累计输入 1,369,881、输出 7,605、缓存读 1,182,592、未命中输入 187,289 token。含失败追问后：22 个已报告用量请求、1 个用量缺失请求；已报告累计输入 2,226,688、输出 11,816、缓存读 2,033,152、未命中输入 193,536。输入已含缓存部分，不相加重复计数；缺失请求不能补零。
- 当前有效窗口由现有配置读为 1,000,000（实测配置值，不是新阈值）。旧协调对话首请求约 159k 输入、后续多次命中缓存；这是**含大量既有历史的单次 smoke 样本**，不是新架构的干净基准、冷热对照或质量比例。该连接定价 `unpriced`，不换算费用、不称账单。
- 私有证据保存每次请求、任务 / action / Turn、终态、可见工具调用与测试输出，不导出密钥、推理内容或无关历史。ResizeObserver 警告仍可见，本轮不混入修改。
- 实机已重新启动，核对旧任务与对话、Command Code DeepSeek 配置、原权限和并发 1 均保留；设置页已无 Jev 入口。没有启动其他开发实例。
