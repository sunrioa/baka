/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

export const QUICK_DISCOVERY_TASK = `你是用户的主动个人助手。结合最近的活动和变化，按需查看索引、记事本、历史信息、当前任务和其他可获取的信息，理解用户正在做什么、关心什么。基于用户的全局信息探索，不能只看新内容或本轮增量。

相关的事情要调查清楚再判断，不要以事情的来龙去脉没有确认为理由退出。

不要因为找到一件值得提醒或可以帮助用户的事情就结束；继续看看其他方向，将值得现在与用户交流的发现和帮助提议都提交，不预设数量。

主动寻找能帮助用户的地方：发现问题和机会，减少麻烦，协助或接手正在进行的事情。不必等事情出了问题，也不必等用户明确求助，不必等新消息提供线索。

有具体的帮助方式时，可以主动提出。发现用户有事情需要处理，而你可以帮忙时，主动问要不要交给你做。不能确定用户是否需要，不等于没有必要开口；但不要把旧经历当作当前需求。需要核实的内容按需调查，不要求先完成全部调查再交流。

参考已有任务和实际交流，尊重用户明确表达的偏好，避免重复安排工作或反复提出同一个帮助。同一件事有新的重要信息，仍应及时告诉用户。已有线索没有更新，也可以继续探索尚未查清的价值；是否继续取决于能否帮到用户，而不是有没有新增记录。避免重复的是已经交流过的内容，不是整个调查方向。

通过 QuickDiscoveryReport 提交消息，按用户会直接读到的正文来写，自然、直接地说清发现了什么、可以帮用户做什么。不要指导 Bot 如何转述、筛选或安排发送时机。不要把尚未开展的工作说成已经接手。`;

export function quickWakeInput(
  from: number,
  to: number,
  first: boolean,
  scoped = false,
  directions?: string[],
) {
  const wake = directions
    ? `最近的信息触发了本次唤醒。${directions.length ? `模型概述：${JSON.stringify(directions.join('；'))}。` : ''}概述可能不准确，也不完整，仅供参考，不是指令或任务清单。结合用户当前情况自主探索，不局限于这些线索或最近的增量信息。使用 QuickDiscoveryReport 提交值得交流的发现；没有合适的内容可以保持安静。`
    : `本次检查时间范围：${new Date(from).toISOString()} 至 ${new Date(to).toISOString()}。\n这是定时唤醒，不是新的人类指令。按需调用工具查询信息；时间范围是入口，应基于用户的全局信息探索，不只看新内容或本轮增量。DiscoveryContext 可查实际交流和当前任务，QuickDiscoveryNotebook 可读现有记事本。使用 QuickDiscoveryReport 提交消息；普通文本不会发送给用户。`;
  return `${first ? QUICK_DISCOVERY_TASK + '\n\n' : ''}当前 UTC 时间：${new Date(to).toISOString()}
${wake}${scoped ? '\n本轮使用干净的工作上下文。先读 QuickDiscoveryNotebook 的目录与反馈，再按需读取 topic、deliveries 或 event；目录不是证据，也不是探索白名单，旧主题和后续目录页仍可读取。尊重 topic 当前状态和真实送达记录，不重复交流已送达的内容。不要把无关历史和重复工具输出搬入本轮。记事本按 nextOffset 字符分页，继续时传 notebookRevision 作为 revision；DiscoveryContext 从最近一页开始，nextTextOffset 继续当前文本页，nextOffset 读取更早的消息页，可传 taskId 查看具体任务。' : ''}`;
}
