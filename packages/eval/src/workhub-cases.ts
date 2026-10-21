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

export interface WorkHubEvalStep {
  readonly id: string;
  readonly text: string | null;
  readonly origin: 'user' | 'feedback';
  readonly surface: 'main' | 'task';
  readonly operation: 'start' | 'continue' | 'ask' | 'none';
  readonly target?: string;
  readonly mode?: 'steering' | 'queued_supplement' | 'continuation';
}

export interface WorkHubEvalCase {
  readonly id: string;
  readonly purpose: string;
  readonly setup: readonly string[];
  readonly bindings: readonly string[];
  readonly steps: readonly WorkHubEvalStep[];
}

const createA = '新开一件独立的工作：写一个清理字符串首尾空格的小函数，先保留字符串内部的空格。';
const createB = '再新开一件独立的工作：写一个把非负秒数转换为分秒显示的小函数。';
const followA = '回到刚才处理空格的那件事，再补上空字符串和连续空格的测试，保持原来的行为。';

/** Instructions for a human/Desktop driver, never a router or an SDK model impersonation. */
export const WORKHUB_EVAL_CASES: readonly WorkHubEvalCase[] = [
  {
    id: 'T01',
    purpose: '本轮 A → 无关 B → A 的自然追问，不能选历史同主题任务。',
    setup: [
      '隔离评测配置中准备一个历史同主题任务 old；可使用明确标记的历史夹具，不能改原配置或伪称自然老化九天。',
      '在总输入按顺序发送 create-a、create-b，每步等待执行结束后绑定实际不可变身份。',
      '任务标题由正常模型生成；不可把绑定 ID 或完整标题塞入后续输入。',
    ],
    bindings: ['old', 'a', 'b'],
    steps: [
      {
        id: 'create-a',
        text: createA,
        origin: 'user',
        surface: 'main',
        operation: 'start',
        target: 'a',
      },
      {
        id: 'create-b',
        text: createB,
        origin: 'user',
        surface: 'main',
        operation: 'start',
        target: 'b',
      },
      {
        id: 'follow-a',
        text: followA,
        origin: 'user',
        surface: 'main',
        operation: 'continue',
        target: 'a',
      },
    ],
  },
  {
    id: 'T02',
    purpose: '预览 A，总对话主题 B，总输入的“继续”仍指向 B。',
    setup: ['按顺序完成 create-a、create-b，然后仅在右栏预览 A。保存预览与主对话的实际 UI 观察。'],
    bindings: ['a', 'b'],
    steps: [
      {
        id: 'create-a',
        text: createA,
        origin: 'user',
        surface: 'main',
        operation: 'start',
        target: 'a',
      },
      {
        id: 'create-b',
        text: createB,
        origin: 'user',
        surface: 'main',
        operation: 'start',
        target: 'b',
      },
      {
        id: 'continue',
        text: '继续。',
        origin: 'user',
        surface: 'main',
        operation: 'continue',
        target: 'b',
      },
    ],
  },
  {
    id: 'T13',
    purpose: '停止轮次中未投递的旧追问不能在独立新请求或自动反馈中复活。',
    setup: [
      '通过正常总输入向已有任务 stale 发出一个追问，在投递前停止协调轮；保存原输入、已停止 Turn、未消费证明。',
      '历史夹具若用于复现中间状态，须只在隔离配置中使用并明确标记；原用户数据库不写入假历史。',
      '发送两个独立新请求，等待它们的自然结果通知，截取整个观察窗口内的全部写工具调用与持久事实。',
    ],
    bindings: ['stale', 'a', 'b'],
    steps: [
      {
        id: 'create-a',
        text: createA,
        origin: 'user',
        surface: 'main',
        operation: 'start',
        target: 'a',
      },
      { id: 'feedback-a', text: null, origin: 'feedback', surface: 'main', operation: 'none' },
      {
        id: 'create-b',
        text: createB,
        origin: 'user',
        surface: 'main',
        operation: 'start',
        target: 'b',
      },
      { id: 'feedback-b', text: null, origin: 'feedback', surface: 'main', operation: 'none' },
    ],
  },
  {
    id: 'J07',
    purpose: '没有先行词时询问任务选择，并提供新建任务。',
    setup: [
      '准备至少两个候选 a、b（已有 Work 或通过普通 Session UI 创建的手动 coding 对话）；使用全新的协调对话，不能有可确认的任务先行词。手动候选绑定 kind=session，不补造 Work/generation。原生选择保持未回答。',
    ],
    bindings: ['a', 'b'],
    steps: [
      { id: 'ask', text: '继续那个任务。', origin: 'user', surface: 'main', operation: 'ask' },
    ],
  },
  {
    id: 'J12',
    purpose: '有明确先行词时不靠标题关键词，继续正确任务。',
    setup: ['在总对话发 create-a 并等待结果；随后直接发送不含标题或 ID 的追问。'],
    bindings: ['a'],
    steps: [
      {
        id: 'create-a',
        text: createA,
        origin: 'user',
        surface: 'main',
        operation: 'start',
        target: 'a',
      },
      {
        id: 'continue',
        text: '接着做吧。',
        origin: 'user',
        surface: 'main',
        operation: 'continue',
        target: 'a',
      },
    ],
  },
  {
    id: 'T03-direct',
    purpose: '任务视图直接纠正在下一模型边界进入同一 Turn，不中断活动工具。',
    setup: [
      '准备正在执行、且工具尚未结束的任务 a；从任务视图发送输入，保存工具开始/结束与消费的时间和执行身份。',
    ],
    bindings: ['a'],
    steps: [
      {
        id: 'correct',
        text: '补充一下：保留原来的大小写，只修改空格处理。',
        origin: 'user',
        surface: 'task',
        operation: 'continue',
        target: 'a',
        mode: 'steering',
      },
    ],
  },
  {
    id: 'T03-queue',
    purpose: '排队补充原位保留身份、位置与 FIFO，随后取消不能波及活动任务。',
    setup: [
      '并发数为 1；a 占用执行名额，b 在队列中。保存队列补充前后的完整原生队列快照；补充后由 UI 取消 b，并记录 a 原执行仍在。',
    ],
    bindings: ['a', 'b'],
    steps: [
      {
        id: 'supplement',
        text: '再补充一个边界情况：零秒应显示为 0:00。',
        origin: 'user',
        surface: 'task',
        operation: 'continue',
        target: 'b',
        mode: 'queued_supplement',
      },
    ],
  },
  {
    id: 'T06-fresh',
    purpose: '新段同任务按需读回原要求、纠正、工具调用与结果，排除同 Session 的其他任务。',
    setup: [
      '准备已结束的任务 a 及其历史要求、纠正和成功工具结果；同 Session 存在无关任务 b。',
      '总对话的明确先行词为 a，再从总输入发送下列请求；右栏输入不隐式换段。',
      '通过正常工具循环请求新段，不强制模型选择；仅在实际选择 fresh 时检验新段。若模型选择 reuse，应单独报告未覆盖 fresh，不计通过。',
      '保存原生历史页、读取工具调用/结果、新段执行和旧段身份；ai-sdk/executor 分开记录。',
    ],
    bindings: ['a', 'b'],
    steps: [
      {
        id: 'fresh',
        text: '请换一段新的上下文继续这件事。先查清我原来的要求和后来的纠正，再核对之前工具的实际结果后继续。',
        origin: 'user',
        surface: 'main',
        operation: 'continue',
        target: 'a',
      },
    ],
  },
];

export function workHubEvalCase(id: string): WorkHubEvalCase {
  const result = WORKHUB_EVAL_CASES.find((entry) => entry.id === id);
  if (!result) throw new Error(`Unknown WorkHub case: ${id}`);
  return result;
}
