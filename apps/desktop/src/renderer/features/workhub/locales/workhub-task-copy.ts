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
import type { WorkHubTaskStatus } from '@maka/runtime-host/protocol';
export const workHubTaskCopy = {
  "en": {
    "title": "Recent tasks",
    "progress": "In progress",
    "delivery": "Recent deliveries",
    "hint": "Execution ending is not verified goal or artifact completion.",
    "empty": "No delegated tasks yet.",
    "loading": "Loading task facts…",
    "unavailable": "Task facts unavailable. Refresh before acting.",
    "stale": "Showing the last known tasks. Actions are disabled until the Host refreshes them.",
    "refresh": "Refresh tasks",
    "details": "Details",
    "open": "Open underlying conversation",
    "continue": "Continue this task",
    "continuation": "New instruction for this task",
    "submit": "Send to this task",
    "retry": "Retry the same continuation",
    "source": "Execution source",
    "excerpt": "Committed assistant delivery",
    "unverified": "Paths and test claims below are assistant output, not independently verified artifacts or test evidence.",
    "truncated": "This recent-task window is limited; it does not represent every task.",
    "deliveryTruncated": "Delivery excerpt is truncated. Open the original conversation for the rest.",
    "concurrency": "Waiting for a direct-worker slot",
    "workspace": "Waiting for a shared workspace",
    "dependency": "Evidence request",
    "error": "The operation was not confirmed. Keep this text and retry the same submission.",
    "sent": "Continuation admitted to the original task's FIFO.",
    "status": {
      "queued": "Queued",
      "waiting_resource": "Waiting for resources",
      "running": "Running",
      "waiting_for_dependency": "Waiting for evidence",
      "waiting_for_user": "Needs your input",
      "pending_acceptance": "Execution ended · Pending acceptance",
      "failed": "Failed",
      "cancelled": "Cancelled",
      "stopping": "Stop requested · Awaiting confirmation",
      "stopped": "Stopped",
      "unavailable": "Execution unavailable"
    }
  },
  "zh-CN": {
    "title": "近期任务",
    "progress": "执行进度",
    "delivery": "最新交付",
    "hint": "执行结束不代表目标或产物已验证完成。",
    "empty": "尚无已派发任务。",
    "loading": "正在读取任务事实…",
    "unavailable": "任务事实不可用，请先刷新再操作。",
    "stale": "正在显示上次读取的任务，Host 刷新前不可操作。",
    "refresh": "刷新任务",
    "details": "展开详情",
    "open": "打开底层会话",
    "continue": "继续此任务",
    "continuation": "给此任务的新指令",
    "submit": "发送到此任务",
    "retry": "重试原续办",
    "source": "执行来源",
    "excerpt": "已持久化的助手交付",
    "unverified": "下方路径和测试结论来自助手输出，不是独立核验的产物或测试证据。",
    "truncated": "此处是有数量上限的近期任务窗口，不代表全部任务。",
    "deliveryTruncated": "交付摘要已截断，其余内容可在原会话查看。",
    "concurrency": "等待直接 worker 名额",
    "workspace": "等待共享工作目录",
    "dependency": "证据请求",
    "error": "操作尚未确认，请保留原文并重试同一次提交。",
    "sent": "续办已进入原任务会话的 FIFO 队列。",
    "status": {
      "queued": "排队中",
      "waiting_resource": "等待资源",
      "running": "执行中",
      "waiting_for_dependency": "等待证据",
      "waiting_for_user": "待你处理",
      "pending_acceptance": "执行结束 · 待验收",
      "failed": "失败",
      "cancelled": "已取消",
      "stopping": "停止处理中 · 等待确认",
      "stopped": "已停止",
      "unavailable": "执行信息不可用"
    }
  },
  "zh-TW": {
    "title": "近期任務",
    "progress": "執行進度",
    "delivery": "最新交付",
    "hint": "執行結束不代表目標或產物已驗證完成。",
    "empty": "尚無已派發任務。",
    "loading": "正在讀取任務事實…",
    "unavailable": "任務事實不可用，請先重新整理再操作。",
    "stale": "正在顯示上次讀取的任務，Host 重新整理前不可操作。",
    "refresh": "重新整理任務",
    "details": "展開詳情",
    "open": "開啟底層對話",
    "continue": "繼續此任務",
    "continuation": "給此任務的新指令",
    "submit": "傳送到此任務",
    "retry": "重試原續辦",
    "source": "執行來源",
    "excerpt": "已持久化的助手交付",
    "unverified": "下方路徑和測試結論來自助手輸出，不是獨立核驗的產物或測試證據。",
    "truncated": "此處是有數量上限的近期任務視窗，不代表全部任務。",
    "deliveryTruncated": "交付摘要已截斷，其餘內容可在原對話查看。",
    "concurrency": "等待直接 worker 名額",
    "workspace": "等待共用工作目錄",
    "dependency": "證據請求",
    "error": "操作尚未確認，請保留原文並重試同一次提交。",
    "sent": "續辦已進入原任務對話的 FIFO 佇列。",
    "status": {
      "queued": "排隊中",
      "waiting_resource": "等待資源",
      "running": "執行中",
      "waiting_for_dependency": "等待證據",
      "waiting_for_user": "待你處理",
      "pending_acceptance": "執行結束 · 待驗收",
      "failed": "失敗",
      "cancelled": "已取消",
      "stopping": "停止處理中 · 等待確認",
      "stopped": "已停止",
      "unavailable": "執行資訊不可用"
    }
  }
} satisfies UiCatalog<{title: string; progress: string; delivery: string; hint: string; empty: string; loading: string; unavailable: string; stale: string; refresh: string; details: string; open: string; continue: string; continuation: string; submit: string; retry: string; source: string; excerpt: string; unverified: string; truncated: string; deliveryTruncated: string; concurrency: string; workspace: string; dependency: string; error: string; sent: string; status: Record<WorkHubTaskStatus, string>}>;
