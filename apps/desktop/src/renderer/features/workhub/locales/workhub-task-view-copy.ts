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
import type { WorkHubTaskAssignment, TurnSnapshot } from '@maka/runtime-host/protocol';

interface TaskViewCopy {
  title: string; description: string; back: string; follow: string; refresh: string; loading: string;
  attempts: string; currentGeneration: string; earlierGeneration: string; loadEarlier: string;
  chooseExecution: string; executionNumber: string; superseded: string; lineagePending: string;
  noAssignments: string; livePending: string; noPublicOutput: string;
  coordinatorInput: string; pendingInteractions: string; open: string;
  state: Record<WorkHubTaskAssignment['state'], string>;
  status: Record<TurnSnapshot['status'], string>;
}
export const workHubTaskViewCopy = {
  en: {
    title: 'Task execution', description: 'Public worker execution, not a coordinator summary. Execution ending is not verified goal completion.',
    back: 'Back to WorkHub', follow: 'Follow latest execution', refresh: 'Refresh', loading: 'Refreshing task facts or waiting for the Host.',
    attempts: 'Assignments and executions', currentGeneration: 'Current generation', earlierGeneration: 'Earlier generation', loadEarlier: 'Load earlier assignments',
    chooseExecution: 'Choose execution', executionNumber: 'Execution {number}', superseded: 'Superseded', lineagePending: 'Reading execution lineage; the latest attempt is not confirmed yet.',
    noAssignments: 'No readable assignments for this work.', livePending: 'Live observation is not ready; previously read records are retained.', noPublicOutput: 'This execution has no public output yet.',
    coordinatorInput: 'Return to coordinator input',
    pendingInteractions: 'Pending questions and permissions', open: 'View task execution',
    state: { owned: 'Owned execution', queued: 'Queued', cancelled: 'Cancelled', shared: 'Shared Turn; not an exclusive task execution', unavailable: 'Execution ownership unavailable' },
    status: { created: 'Queued', admitted: 'Queued', running: 'Running', waiting_for_user: 'Needs your input', completed: 'Execution ended · Pending acceptance', failed: 'Failed', cancelled: 'Cancelled' },
  },
  'zh-CN': {
    title: '任务实时执行', description: '展示任务的真实公开执行记录；执行结束不代表目标已验收。',
    back: '返回 WorkHub', follow: '跟随最新执行', refresh: '刷新', loading: '任务事实正在刷新或暂不可用。',
    attempts: '派发与执行记录', currentGeneration: '当前阶段', earlierGeneration: '历史阶段', loadEarlier: '加载更早派发',
    chooseExecution: '选择执行尝试', executionNumber: '执行 {number}', superseded: '已替换', lineagePending: '正在读取执行沿革，尚不能确定最新尝试。',
    noAssignments: '此工作没有可读取的派发记录。', livePending: '实时连接暂未就绪；保留已读取的记录。', noPublicOutput: '该执行尚无公开输出。',
    coordinatorInput: '返回协调输入',
    pendingInteractions: '待处理的问题与权限', open: '查看任务执行',
    state: { owned: '独立执行', queued: '排队中', cancelled: '已取消', shared: '共享 Turn，不能作为独占执行展示', unavailable: '执行归属不可用' },
    status: { created: '排队中', admitted: '排队中', running: '执行中', waiting_for_user: '待你处理', completed: '执行结束 · 待验收', failed: '失败', cancelled: '已取消' },
  },
  'zh-TW': {
    title: '任務即時執行', description: '顯示任務的真實公開執行記錄；執行結束不代表目標已驗收。',
    back: '返回 WorkHub', follow: '跟隨最新執行', refresh: '重新整理', loading: '任務資訊正在更新或暫時無法取得。',
    attempts: '派發與執行記錄', currentGeneration: '目前階段', earlierGeneration: '歷史階段', loadEarlier: '載入更早派發',
    chooseExecution: '選擇執行嘗試', executionNumber: '執行 {number}', superseded: '已取代', lineagePending: '正在讀取執行沿革，尚無法確認最新嘗試。',
    noAssignments: '此工作沒有可讀取的派發記錄。', livePending: '即時連線尚未就緒；保留已讀取的記錄。', noPublicOutput: '此執行尚無公開輸出。',
    coordinatorInput: '返回協調輸入',
    pendingInteractions: '待處理的問題與權限', open: '檢視任務執行',
    state: { owned: '獨立執行', queued: '排隊中', cancelled: '已取消', shared: '共享 Turn，無法作為獨占執行顯示', unavailable: '執行歸屬無法取得' },
    status: { created: '排隊中', admitted: '排隊中', running: '執行中', waiting_for_user: '待你處理', completed: '執行結束 · 待驗收', failed: '失敗', cancelled: '已取消' },
  },
} satisfies UiCatalog<TaskViewCopy>;
