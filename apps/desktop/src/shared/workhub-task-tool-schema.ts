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

import { z } from 'zod';
import { WORKHUB_TASK_INPUT_TEXT_MAX_BYTES } from '@maka/core/workhub-task-input';

const identity = z.string().min(1).max(128);
const utf8 = (bytes: number) => z.string().min(1).max(bytes).refine(
  value => value.trim().length > 0 && new TextEncoder().encode(value).length <= bytes,
  'Text must be nonempty and within the Host UTF-8 budget',
);
const text = utf8(WORKHUB_TASK_INPUT_TEXT_MAX_BYTES);

/** Five flat model contracts; the sixth, WorkHubRead, is supplied by the Host. */
export const workHubTaskToolSchemas = {
  find: z.object({
    query: utf8(1024).trim().refine(value => Array.from(value).length <= 256).optional(),
    cwd: utf8(4096).optional(),
    cursor: utf8(2048).optional(),
  }).strict(),
  start: z.object({
    title: utf8(2048).trim().refine(value => Array.from(value).length <= 512 && !/[\u0000-\u001f\u007f]/u.test(value)),
    text,
    cwdHint: utf8(4096).optional().describe('Only an explicitly intended task working directory, not a file merely mentioned for reading. The Host applies existing directory admission; this does not grant filesystem permission. Omit for private isolated work.'),
    sessionRef: identity.optional().describe('An eligible manual Session reference returned by find, only when intentionally adopting it for independent work. Its existing persistent settings are retained.'),
  }).strict().refine(value => value.cwdHint === undefined || value.sessionRef === undefined, 'A manual Session retains its own directory'),
  continue: z.object({
    taskId: identity,
    text,
    container: z.enum(['reuse', 'fresh']).optional(),
  }).strict(),
  ask: z.object({
    question: utf8(2048).trim(),
    choices: z.array(z.object({ kind: z.enum(['task', 'session']), id: identity }).strict()).max(6),
  }).strict().refine(value => new Set(value.choices.map(choice => `${choice.kind}:${choice.id}`)).size === value.choices.length, 'Duplicate task choices'),
  stop: z.object({
    taskIds: z.array(identity).min(1).max(8),
  }).strict().refine(value => new Set(value.taskIds).size === value.taskIds.length, 'Duplicate stop targets'),
} as const;

export type WorkHubTaskToolName = keyof typeof workHubTaskToolSchemas;
export type WorkHubTaskToolRequest = {
  [Name in WorkHubTaskToolName]: { readonly kind: Name; readonly input: z.infer<(typeof workHubTaskToolSchemas)[Name]> }
}[WorkHubTaskToolName];

/** Preserve the discriminator without an open or nested model argument union. */
export function parseWorkHubTaskToolRequest(kind: WorkHubTaskToolName, input: unknown): WorkHubTaskToolRequest {
  switch (kind) {
    case 'find': return { kind, input: workHubTaskToolSchemas.find.parse(input) };
    case 'start': return { kind, input: workHubTaskToolSchemas.start.parse(input) };
    case 'continue': return { kind, input: workHubTaskToolSchemas.continue.parse(input) };
    case 'ask': return { kind, input: workHubTaskToolSchemas.ask.parse(input) };
    case 'stop': return { kind, input: workHubTaskToolSchemas.stop.parse(input) };
  }
}

export const workHubTaskToolDescriptions: Record<WorkHubTaskToolName, string> = {
  find: 'Find tasks and eligible manual Sessions, one bounded candidate page per call. Prefer meaningful keywords; no keywords lists open tasks then recently ended tasks. Keep query and cwd unchanged when following cursor. Read WorkHubRead view=status for the chosen task context and metering, and requirements/result for originals; candidate summaries are not original evidence or new authority. Use returned task ids for continue/read/stop, and manual Session references only for start. After three pages or unsuccessful reformulation, ask when an old task was intended; otherwise start independent work. Never poll to wait for execution.',
  start: 'Start one independent task with its own title and exact instructions. Creation settings come from current WorkHub defaults, never model-supplied permissions. Omit cwdHint for private isolated work; supply a known directory only when it is the intended working directory. A returned receipt means admission, not started execution or completion. Admit separate independent goals sequentially without waiting for workers.',
  continue: 'Continue the same task by taskId. Reuse supplements queued work in place, steers active work at its next consumable boundary without interrupting a tool, or admits a normal Turn after settlement. Unsupported active backends or attachment input are rejected, never silently queued for a later Turn. Admission is not consumption or successful correction. Choose fresh only for settled work; it retains task identity and current persistent settings without copying full history. Executor providers have no Host-native read bridge, so fresh executor history recovery is not fully supported. Busy, queued, stopping or unresolved work cannot fresh; no delayed switch is created. Read or ask on ambiguity, never substitute historical same-topic work.',
  ask: 'Ask the user which task or eligible manual Session is intended, using choices from find. The Host always adds a new-task option. This only records a selection: it does not delegate, steer or grant approval. After selection, act only within the user request; cancellation has no effect. Use AskUserQuestion for ordinary requirements, and the task approval interface for permissions.',
  stop: 'Stop or withdraw only the named tasks. The Host proves actual origin and execution, not natural-language intent. A user-started Turn may stop one distinct task directly; automatic feedback, a known multi-task set, or a second different target in the same Turn require the existing native confirmation. Bypass does not skip it. Results can be stopped, already terminal, not owned or recovering: report each exact outcome, never claim every target stopped. Do not retry an unknown outcome with a different identity or target.',
};
