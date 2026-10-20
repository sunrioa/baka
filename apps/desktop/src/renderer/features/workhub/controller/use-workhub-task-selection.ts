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

import { useEffect, useRef, useState } from 'react';
import type { OperationInput } from '@maka/runtime-host/protocol';
import type { WorkHubServices } from '../ports.js';
import type { WorkHubTaskSelection } from '../../../../shared/workhub-presentation.js';
import { workHubTaskTitle } from '../model/task-presentation.js';

/** The native coordinator and the shell workbar share one exact work selection. */
export function useWorkHubTaskSelection(services: WorkHubServices, owner: string | undefined, available = true) {
  const [state, setState] = useState<{ services: WorkHubServices; selection?: WorkHubTaskSelection; error?: string }>({ services });
  const request = useRef(0);
  const selectionSignature = useRef<string>(undefined);
  const current = useRef({ services, owner, available }); current.current = { services, owner, available };
  useEffect(() => {
    let active = true;
    let notified = false;
    const accept = (selection: WorkHubTaskSelection | undefined) => {
      if (!active) return;
      const signature = JSON.stringify(selection ?? null);
      if (selectionSignature.current !== undefined && selectionSignature.current !== signature) ++request.current;
      selectionSignature.current = signature;
      setState({ services, selection });
    };
    const unsubscribe = services.presentation.subscribe(snapshot => { notified = true; accept(snapshot.taskSelection); });
    void services.presentation.getSnapshot().then(snapshot => { if (!notified) accept(snapshot.taskSelection); }, reason => {
      if (active && !notified) setState({ services, error: reason instanceof Error ? reason.message : String(reason) });
    });
    return () => { active = false; unsubscribe(); };
  }, [services]);
  const selected = state.services === services && state.selection?.ownerSessionId === owner ? state.selection?.work : undefined;
  return {
    selected,
    error: state.services === services ? state.error : undefined,
    select(work: WorkHubTaskSelection['work']) {
      ++request.current;
      if (!owner) return;
      void services.presentation.selectTask({ ownerSessionId: owner, ...(work ? { work } : {}) }).catch(reason => {
        setState(previous => ({ ...previous, services, error: reason instanceof Error ? reason.message : String(reason) }));
      });
    },
    async open(ref: OperationInput<'workhub.tasks.read'>, name?: string) {
      const revision = ++request.current;
      const active = () => request.current === revision && current.current.services === services && current.current.owner === owner && current.current.available;
      if (!owner || !available) return;
      try {
        const { task } = await services.readTask(owner, ref);
        if (!active()) return;
        if ('workId' in ref ? (task.workId ?? task.actionId) !== ref.workId : task.actionId !== ref.actionId || task.delegationId !== ref.delegationId)
          throw new Error('The task changed identity');
        await services.presentation.selectTask({ ownerSessionId: owner, work: { sessionId: task.targetSessionId,
          name: (task as typeof task & { title?: string }).title || name || workHubTaskTitle(task), workId: task.workId ?? task.actionId } });
      } catch (reason) {
        if (!active()) return;
        throw reason;
      }
    },
  };
}
