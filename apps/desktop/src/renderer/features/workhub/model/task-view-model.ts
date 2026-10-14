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

import type { WorkHubTaskAssignment, TurnSnapshot, SessionExecutionScope } from '@maka/runtime-host/protocol';
import type { WorkHubServices } from '../ports.js';

export interface WorkHubTaskViewSnapshot {
  readonly assignments: readonly WorkHubTaskAssignment[];
  readonly historyCursor: string | null;
  readonly ready: boolean;
  readonly loadingEarlier: boolean;
  readonly assignment?: WorkHubTaskAssignment;
  readonly executions: readonly TurnSnapshot[];
  readonly execution?: SessionExecutionScope;
  readonly executionsReady: boolean;
  readonly error?: string;
}

/** Presentation only: every selection is resolved from canonical assignment/lineage facts. */
export function createWorkHubTaskViewModel(
  services: Pick<WorkHubServices, 'taskHistory' | 'taskExecutions'>,
  owner: string,
  workId: string,
) {
  let state: WorkHubTaskViewSnapshot = { assignments: [], historyCursor: null, ready: false, loadingEarlier: false, executions: [], executionsReady: false };
  const listeners = new Set<() => void>();
  let closed = false;
  let version = 0;
  let executionVersion = 0;
  let manualAction: string | undefined;
  let manualTurn: string | undefined;
  let reading: Promise<void> | undefined;
  let dirty = false;
  const publish = (patch: Partial<WorkHubTaskViewSnapshot>) => {
    if (closed) return;
    state = { ...state, ...patch };
    for (const listener of listeners) listener();
  };
  const fail = (reason: unknown) => publish({ error: reason instanceof Error ? reason.message : String(reason) });

  async function readExecutions(assignment: WorkHubTaskAssignment | undefined) {
    const generation = ++executionVersion;
    if (state.assignment?.actionId !== assignment?.actionId) {
      manualTurn = undefined;
      publish({ assignment, executions: [], execution: undefined });
    } else publish({ assignment });
    if (!assignment?.execution || assignment.state !== 'owned') {
      publish({ executions: [], execution: undefined, executionsReady: true });
      return;
    }
    publish({ executionsReady: false });
    const executions: TurnSnapshot[] = [];
    const cursors = new Set<string>();
    let cursor: string | undefined;
    try {
      do {
        const page = await services.taskExecutions(owner, { actionId: assignment.actionId, delegationId: assignment.delegationId, ...(cursor ? { cursor } : {}) });
        if (closed || generation !== executionVersion) return;
        if (page.actionId !== assignment.actionId || page.delegationId !== assignment.delegationId || page.targetSessionId !== assignment.targetSessionId ||
            (!cursor && (page.executions[0]?.turnId !== assignment.execution.turnId || page.executions[0]?.runId !== assignment.execution.runId)) ||
            page.executions.some(item => item.sessionId !== assignment.targetSessionId || executions.some(previous => previous.turnId === item.turnId))) {
          throw new Error('Task execution history changed identity');
        }
        executions.push(...page.executions);
        cursor = page.nextCursor ?? undefined;
        if (cursor && cursors.has(cursor)) throw new Error('Task execution history did not advance');
        if (cursor) cursors.add(cursor);
        // These are small status records, never transcript payloads. Do not
        // label an intermediate page as the latest execution.
        publish({ executions: [...executions] });
      } while (cursor);
      const selected = executions.find(item => item.turnId === manualTurn) ?? executions.at(-1);
      publish({ execution: selected ? { turnId: selected.turnId, runId: selected.runId } : undefined, executionsReady: true });
    } catch (reason) {
      if (closed || generation !== executionVersion) return;
      publish({ executionsReady: false });
      fail(reason);
    }
  }

  async function history(cursor?: string) {
    const rows: WorkHubTaskAssignment[] = [];
    const seen = new Set<string>();
    let next = cursor;
    do {
      const page = await services.taskHistory(owner, { workId, ...(next ? { cursor: next } : {}) });
      if (page.workId !== workId || page.assignments.some(item => item.workId !== workId)) throw new Error('Task history changed work');
      rows.push(...page.assignments);
      next = page.nextCursor ?? undefined;
      if (next && seen.has(next)) throw new Error('Task history did not advance');
      if (next) seen.add(next);
      // Sparse global pages may contain only assignments belonging to other
      // works. Continue metadata paging until there is something to display.
    } while (!closed && !rows.length && next);
    return { rows, cursor: next ?? null };
  }

  function refresh(): Promise<void> {
    if (closed) return Promise.resolve();
    dirty = true;
    if (reading) return reading;
    const task = (async () => {
      while (dirty && !closed) {
        dirty = false;
        const generation = ++version;
        try {
          const page = await history();
          if (closed) return;
          if (generation !== version) continue;
          const ids = new Set(page.rows.map(item => item.actionId));
          let assignments = [...page.rows, ...state.assignments.filter(item => !ids.has(item.actionId))];
          const selected = manualAction;
          if (selected && !ids.has(selected)) {
            let exact: Awaited<ReturnType<typeof services.taskHistory>>;
            try { exact = await services.taskHistory(owner, { workId, actionId: selected }); }
            catch (reason) {
              if (closed) return;
              if (generation !== version || manualAction !== selected) { dirty = true; continue; }
              throw reason;
            }
            if (closed) return;
            if (generation !== version || manualAction !== selected) { dirty = true; continue; }
            const row = exact.assignments[0];
            const known = assignments.find(item => item.actionId === selected);
            if (exact.workId !== workId || exact.assignments.length !== 1 || exact.nextCursor !== null ||
                row?.workId !== workId || row.actionId !== selected || !known || row.delegationId !== known.delegationId) {
              throw new Error('Selected task assignment changed identity');
            }
            assignments = assignments.map(item => item.actionId === selected ? row : item);
          }
          const assignment = assignments.find(item => item.actionId === manualAction) ??
            page.rows.find(item => item.generationId === page.rows[0]?.generationId && !item.superseded && item.state === 'owned') ?? page.rows[0];
          publish({ assignments, historyCursor: page.cursor, ready: true, loadingEarlier: false, error: undefined });
          await readExecutions(assignment);
        } catch (reason) { if (!closed && generation === version) { publish({ ready: false }); fail(reason); } }
      }
    })().finally(() => { if (reading === task) reading = undefined; });
    reading = task;
    return task;
  }
  return {
    snapshot: () => state,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    refresh,
    invalidate() { ++version; ++executionVersion; publish({ ready: false, executionsReady: false }); void refresh(); },
    async loadEarlier() {
      if (closed || state.loadingEarlier || !state.historyCursor) return;
      const generation = version, cursor = state.historyCursor;
      publish({ loadingEarlier: true });
      try {
        const page = await history(cursor);
        if (closed || generation !== version) return;
        const ids = new Set(state.assignments.map(item => item.actionId));
        const refreshed = new Map(page.rows.map(item => [item.actionId, item]));
        publish({ assignments: [...state.assignments.map(item => refreshed.get(item.actionId) ?? item), ...page.rows.filter(item => !ids.has(item.actionId))], historyCursor: page.cursor });
        const selected = state.assignment && refreshed.get(state.assignment.actionId);
        if (selected) await readExecutions(selected);
      } catch (reason) { if (!closed && generation === version) fail(reason); }
      finally { if (!closed && generation === version) publish({ loadingEarlier: false }); }
    },
    selectAssignment(actionId: string) {
      const assignment = state.assignments.find(item => item.actionId === actionId);
      if (!assignment || closed) return;
      manualAction = actionId;
      void readExecutions(assignment);
    },
    selectExecution(turnId: string) {
      const execution = state.executions.find(item => item.turnId === turnId);
      if (!execution || closed) return;
      manualTurn = turnId;
      publish({ execution: { turnId, runId: execution.runId } });
    },
    followLatest() { manualAction = undefined; manualTurn = undefined; void refresh(); },
    close() { closed = true; ++version; ++executionVersion; listeners.clear(); },
  };
}
