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

import type { UiCatalog } from '@maka/core/ui-locale';
import type { WorkHubTaskInputResult } from '@maka/runtime-host/protocol';
interface Copy {
  address: string; placeholder: string; history: string; unavailable: string; sessionUnavailable: string; unsupported: string;
  unknownModel: string; original: string; pending: string; check: string; retry: string; stopFailed: string;
  delivery: Record<WorkHubTaskInputResult['delivery'], string>;
  error: Record<'storage' | 'length' | 'unknown' | 'identity', string>;
}
export const workHubTaskInputCopy = {
  en: {
    address: 'Send directly to “{name}”', placeholder: 'Message this task…', history: 'This is an earlier source or execution. Follow the latest source before sending a new input.',
    unavailable: 'The owning Host or task facts are not ready. Your draft stays with this task.', sessionUnavailable: 'The target Session or its native model is unavailable.',
    unsupported: 'Direct task input currently requires a native executor.', unknownModel: 'Model unavailable', original: 'Original submitted input · Not delivery proof',
    pending: 'Keep the original input ID and text until its outcome is confirmed. A retry resends only that original input, not the edited draft.', check: 'Check receipt', retry: 'Retry original input',
    stopFailed: 'Stop was not confirmed for this exact execution. Refresh its status; no other execution was targeted.',
    delivery: { queued: 'Accepted · Queued for this task', delivered: 'Delivered into execution · Not proof of model compliance', cancelled: 'Accepted input was cancelled before delivery', unproven: 'Accepted · Execution delivery is not proven' },
    error: { storage: 'Recovery data could not be safely preserved or read. New sends require recovery storage; existing receipts remain valid. Keep this window open.', length: 'Task input must be non-empty and at most 48 KiB of UTF-8 text.', unknown: 'The send outcome is not confirmed. Check its receipt or retry the same input.', identity: 'The input receipt or source changed identity. No new input will replace it.' },
  },
  'zh-CN': {
    address: '直接发送给「{name}」', placeholder: '给此任务发送消息…', history: '当前查看的是历史来源或执行，请先跟随最新来源再发送新输入。',
    unavailable: '所属 Host 或任务事实尚未就绪；草稿仍保留在此任务。', sessionUnavailable: '目标 Session 或其原生模型暂不可用。',
    unsupported: '直接任务输入目前需要原生执行器。', unknownModel: '模型不可用', original: '原提交内容 · 不是投递证明',
    pending: '结果确认前保留原输入 ID 和正文。重试只发送原输入，不会发送新编辑的草稿。', check: '查询回执', retry: '重试原输入',
    stopFailed: '尚未确认停止此执行；请刷新状态。没有改为停止其他执行。',
    delivery: { queued: '已受理 · 正在此任务中排队', delivered: '已进入执行 · 不代表模型已遵从', cancelled: '受理的输入已在投递前取消', unproven: '已受理 · 尚无进入执行的证明' },
    error: { storage: '无法安全保存或读取恢复数据；新发送需要先恢复此能力，已有回执仍然有效。请保留此窗口。', length: '任务输入不能为空，UTF-8 大小不能超过 48 KiB。', unknown: '尚不能确认发送结果，请查询回执或使用同一输入重试。', identity: '输入回执或来源身份发生变化，不会用新输入替换它。' },
  },
  'zh-TW': {
    address: '直接傳送給「{name}」', placeholder: '傳送訊息給此任務…', history: '目前檢視的是歷史來源或執行，請先跟隨最新來源再傳送新輸入。',
    unavailable: '所屬 Host 或任務資訊尚未就緒；草稿仍保留在此任務。', sessionUnavailable: '目標 Session 或其原生模型暫時無法使用。',
    unsupported: '直接任務輸入目前需要原生執行器。', unknownModel: '模型無法使用', original: '原提交內容 · 不是投遞證明',
    pending: '結果確認前保留原輸入 ID 與內容。重試只傳送原輸入，不會傳送新編輯的草稿。', check: '查詢回執', retry: '重試原輸入',
    stopFailed: '尚未確認停止此執行；請重新整理狀態。沒有改為停止其他執行。',
    delivery: { queued: '已受理 · 正在此任務中排隊', delivered: '已進入執行 · 不代表模型已遵從', cancelled: '受理的輸入已在投遞前取消', unproven: '已受理 · 尚無進入執行的證明' },
    error: { storage: '無法安全儲存或讀取恢復資料；新傳送需要先恢復此能力，已有回執仍然有效。請保留此視窗。', length: '任務輸入不能為空，UTF-8 大小不能超過 48 KiB。', unknown: '尚無法確認傳送結果，請查詢回執或使用相同輸入重試。', identity: '輸入回執或來源身分發生變化，不會用新輸入取代它。' },
  },
} satisfies UiCatalog<Copy>;
