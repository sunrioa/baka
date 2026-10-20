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

import type { StoredMessage } from '@maka/core/session';
import type { WorkHubTask } from '@maka/runtime-host/protocol';
import { useEffect, useRef, useState } from 'react';
import { workHubLinkedWork, workHubTaskReceipts, type WorkHubLinkedTarget } from '../model/linked-work.js';
import type { WorkHubServices } from '../ports.js';

type Services = Pick<WorkHubServices, 'readTask'>;
interface Targets {
  readonly services: Services;
  readonly owner: string;
  readonly items: Map<string, { signature: string; target: WorkHubLinkedTarget }>;
}

/** Display lookup only: the existing task view still establishes input authority. */
export function useWorkHubLinkedWork(
  services: Services, owner: string | undefined,
  messages: readonly StoredMessage[], sessions: readonly { id: string; name: string; cwd?: string }[],
  fallbackName: string, tasks: readonly WorkHubTask[], generation: number,
) {
  const receiptKey = JSON.stringify([...new Map(workHubTaskReceipts(messages).map(item =>
    [item.workId, JSON.stringify([item.coordinationTurnId, item.id])])).entries()]);
  const cache = useRef<Targets>(undefined);
  const [resolved, setResolved] = useState<{ services?: Services; owner?: string; targets: readonly WorkHubLinkedTarget[] }>({ targets: [] });
  useEffect(() => {
    if (!owner) return;
    let disposed = false;
    const current: Targets = cache.current?.services === services && cache.current.owner === owner
      ? cache.current : { services, owner, items: new Map() };
    cache.current = current;
    const references = new Map<string, string>(JSON.parse(receiptKey));
    // Retain only targets referenced by the loaded transcript, not a full task index.
    for (const id of current.items.keys()) if (!references.has(id)) current.items.delete(id);
    const publish = () => setResolved({ services, owner, targets: [...current.items.values()].map(item => item.target) });
    publish();
    void (async () => {
      for (const [workId, receipt] of references) {
        const signature = JSON.stringify([generation, receipt]);
        if (current.items.get(workId)?.signature === signature) continue;
        try {
          const { task } = await services.readTask(owner, { workId });
          if (disposed) return;
          if ((task.workId ?? task.actionId) !== workId) continue;
          current.items.set(workId, { signature, target: { workId, targetSessionId: task.targetSessionId, targetSessionName: task.targetSessionName, createdAt: task.createdAt } });
          publish();
        } catch { /* An unavailable task never permits guessing a Session from model output. */ }
        if (disposed) return;
      }
    })();
    return () => { disposed = true; };
  }, [services, owner, receiptKey, generation]);
  const targets = resolved.services === services && resolved.owner === owner ? resolved.targets : [];
  return workHubLinkedWork(messages, sessions, fallbackName, owner, tasks, targets);
}
