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

import { useEffect, useState } from 'react';
import type { WorkHubServices } from '../ports.js';
import type { WorkHubPresentationSnapshot, WorkHubTaskSelection } from '../../../../shared/workhub-presentation.js';

/** The native coordinator and the shell workbar share one exact work selection. */
export function useWorkHubTaskSelection(services: WorkHubServices, owner: string | undefined) {
  const [state, setState] = useState<{ services: WorkHubServices; selection?: WorkHubTaskSelection; expanded?: boolean; error?: string }>({ services });
  useEffect(() => {
    let active = true;
    let notified = false;
    const accept = (snapshot: WorkHubPresentationSnapshot) => {
      if (active) setState({ services, selection: snapshot.taskSelection, expanded: snapshot.workbar?.collapsed === false });
    };
    const unsubscribe = services.presentation.subscribe(snapshot => { notified = true; accept(snapshot); });
    void services.presentation.getSnapshot().then(snapshot => { if (!notified) accept(snapshot); }, reason => {
      if (active && !notified) setState({ services, error: reason instanceof Error ? reason.message : String(reason) });
    });
    return () => { active = false; unsubscribe(); };
  }, [services]);
  const selected = state.services === services && state.selection?.ownerSessionId === owner ? state.selection?.work : undefined;
  return {
    selected,
    // Remember the task for its reader, but only mark visible previews as selected.
    highlighted: state.expanded ? selected : undefined,
    error: state.services === services ? state.error : undefined,
    select(work: WorkHubTaskSelection['work']) {
      if (!owner) return;
      void services.presentation.selectTask({ ownerSessionId: owner, ...(work ? { work } : {}) }).catch(reason => {
        setState(previous => ({ ...previous, services, error: reason instanceof Error ? reason.message : String(reason) }));
      });
    },
  };
}
