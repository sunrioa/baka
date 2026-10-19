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

# WorkHub 任务中心固定评测目录

此表是待执行的行为契约，不是通过记录。实测以 Host 的持久派活、Turn、工具、交互与请求用量为准；本地假供应商不计入真实模型质量或计费结果。

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
| T14 | 同 Session 内 A 执行、B/C 已排队；只停止 A，待 B 开始后重试旧 A 停止 | A 的未消费纠正不进入 B/C；B/C 不被连带撤回、仍按 FIFO；旧停止不影响 B；普通完整停止保持原规则 |

## 结果字段与限制

每次实测记录代码提交、用例、时间、模型 / 连接、执行器、有效窗口 / 输入上限、已配置的 `compactionThreshold`（缺失即未配置）、选择、任务 / 段 / Turn / action、准入及终态、耗时、输入 / 输出 / 缓存用量及字段来源。模型最大窗口不冒充主动压缩目标。测试在隔离目录进行，不复制业务内容到公开记录。

真实请求与工具序列同时满足才能计为通过；受理不是执行完成。缺失用量标未知。当前连接价格未核实则不换算费用；估算不是账单。单次测试不是统计质量结论，未实际比较的复用 / 换窗方案不报告成本收益。
