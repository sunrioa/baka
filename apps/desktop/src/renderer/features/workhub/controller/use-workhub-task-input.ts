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

import { useEffect, useMemo, useRef, useState } from 'react';
import type { SessionSummary } from '@maka/core/session';
import type { WorkHubServices } from '../ports.js';
import { createWorkHubTaskInputModel, workHubTaskInputSource } from '../model/task-input-model.js';
import type { useWorkHubTaskView } from './use-workhub-task-view.js';

type TaskInputServices = Pick<WorkHubServices, 'sendTaskInput' | 'readTaskInput' | 'getTaskSession' | 'subscribeSessions' | 'subscribeAvailability' | 'stop'>;
export function useWorkHubTaskInput(services: TaskInputServices, owner: string, workId: string, view: ReturnType<typeof useWorkHubTaskView>) {
  const props = useRef({ services, owner, workId, view }); props.current = { services, owner, workId, view };
  const active = useRef<ReturnType<typeof createWorkHubTaskInputModel>>(undefined);
  const [target, setTarget] = useState<{ services: TaskInputServices; id: string; session?: SessionSummary; ready: boolean }>();
  const targetRef = useRef(target); targetRef.current = target;
  const model: ReturnType<typeof createWorkHubTaskInputModel> = useMemo(() => createWorkHubTaskInputModel(services, owner, workId, () => {
    const live = props.current;
    if (active.current !== model || live.services !== services || live.owner !== owner || live.workId !== workId) return undefined;
    const source = workHubTaskInputSource(live.view.currentSnapshot());
    const task = targetRef.current;
    return source && task?.services === services && task.id === source.targetSessionId && task.ready &&
      task.session?.id === source.targetSessionId && !task.session.isArchived && task.session.backend !== 'plugin-executor' && task.session.model ? source : undefined;
  }), [services, owner, workId]);
  const [stored, setStored] = useState({ model, value: model.snapshot() });
  const state = stored.model === model ? stored.value : model.snapshot();
  useEffect(() => {
    active.current = model;
    const update = () => setStored({ model, value: model.snapshot() });
    const reconcile = () => { void model.reconcile(); };
    const unsubscribes = [model.subscribe(update), services.subscribeSessions(reconcile), services.subscribeAvailability(reconcile)];
    update(); reconcile();
    return () => {
      if (active.current === model) active.current = undefined;
      for (const unsubscribe of unsubscribes) unsubscribe();
      // A late command still updates only its captured recovery key. Do not
      // cancel/forget it when the user inspects another task or StrictMode remounts.
    };
  }, [services, model]);
  const targetId = view.assignment?.targetSessionId;
  useEffect(() => {
    if (!targetId) return;
    let closed = false, version = 0;
    const read = () => {
      const current = ++version;
      void services.getTaskSession(targetId).then(session => {
        if (!closed && current === version) setTarget({ services, id: targetId, session: session?.id === targetId ? session : undefined, ready: !!session && session.id === targetId });
      }, () => { if (!closed && current === version) setTarget({ services, id: targetId, ready: false }); });
    };
    const invalidate = () => { ++version; setTarget({ services, id: targetId, ready: false }); read(); };
    invalidate();
    const unsubscribes = [services.subscribeSessions(read), services.subscribeAvailability(invalidate)];
    return () => { closed = true; ++version; for (const unsubscribe of unsubscribes) unsubscribe(); };
  }, [services, targetId]);
  const session = target?.services === services && target.id === targetId && target.ready ? target.session : undefined;
  const source = workHubTaskInputSource(view);
  const native = !!source && !!session && session.id === source.targetSessionId && !session.isArchived && session.backend !== 'plugin-executor';
  const ready = native && !!session.model;
  const persistence = useMemo(() => ({
    read: (key: string | undefined) => key === model.key ? model.readDraft() : undefined,
    write: (key: string | undefined, text: string) => { if (key === model.key) model.writeDraft(text); },
  }), [model]);
  const [stop, setStop] = useState<{ model: typeof model; pending: boolean; failed?: boolean }>();
  const stopping = useRef(false);
  const latest = view.executions.at(-1);
  const canStop = native && source.state === 'owned' && !!latest && ['created', 'admitted', 'running', 'waiting_for_user'].includes(latest.status);
  return { model, state, session, source, ready, persistence, canStop, stopPending: stop?.model === model && stop.pending, stopFailed: stop?.model === model && stop.failed,
    send: (text: string) => ready && source ? model.send(source, text) : Promise.resolve(false),
    async stop() {
      if (active.current !== model || stopping.current) return;
      const current = props.current.view.currentSnapshot();
      const a = workHubTaskInputSource(current), execution = current.executions.at(-1);
      const task = targetRef.current;
      if (!a || a.state !== 'owned' || !execution || !['created', 'admitted', 'running', 'waiting_for_user'].includes(execution.status) ||
          task?.services !== services || !task.ready || task.id !== a.targetSessionId || task.session?.backend === 'plugin-executor' || !task.session || task.session.isArchived) return;
      stopping.current = true; setStop({ model, pending: true });
      let failed = false;
      try { failed = (await services.stop(a.targetSessionId, execution.turnId)) === undefined; }
      catch { failed = true; }
      finally {
        stopping.current = false;
        if (active.current === model) { setStop({ model, pending: false, failed }); void props.current.view.refresh(); }
      }
    },
  };
}
