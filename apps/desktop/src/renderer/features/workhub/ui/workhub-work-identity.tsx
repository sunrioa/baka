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

import { createContext, useContext, useMemo, useState, type ReactNode } from 'react';

import { allocateWorkHubHues } from '../model/identity-colors.js';
export interface SelectedWorkHubWork { sessionId: string; name: string; workId?: string }

export const WorkHubHighlightContext = createContext<{
  sessionId: string | undefined;
  highlight(sessionId: string | undefined): void;
  selectedWork?: SelectedWorkHubWork;
  toggleWork(work: SelectedWorkHubWork): void;
  selectWork(work: SelectedWorkHubWork | undefined): void;
}>({ sessionId: undefined, highlight: () => {}, selectWork: () => {}, toggleWork: () => {} });

/** Work identity hover and conversation filtering are local presentation state. */
export function useWorkHubHighlightState() {
  const [sessionId, highlight] = useState<string>();
  const [selectedWork, selectWork] = useState<SelectedWorkHubWork>();
  return { sessionId, highlight, selectedWork, selectWork, toggleWork: (work: SelectedWorkHubWork) => selectWork(
    selectedWork && (selectedWork.workId ?? selectedWork.sessionId) === (work.workId ?? work.sessionId) ? undefined : work,
  ) };
}

const WorkHubHueContext = createContext<ReadonlyMap<string, number> | undefined>(undefined);

export function WorkHubHueProvider({ sessionIds, children }: { sessionIds: readonly string[]; children: ReactNode }) {
  const [allocated, setAllocated] = useState<ReadonlyMap<string, number>>(() => allocateWorkHubHues(sessionIds));
  const next = allocateWorkHubHues(sessionIds, allocated);
  if (next !== allocated) setAllocated(next);
  return <WorkHubHueContext.Provider value={next}>{children}</WorkHubHueContext.Provider>;
}

export function useWorkHubIdentityHue(sessionIds: readonly string[]) {
  const hues = useContext(WorkHubHueContext);
  const palette = useMemo(() => hues ?? allocateWorkHubHues(sessionIds), [hues, sessionIds]);
  return useMemo(() => (id: string) => palette.get(id) ?? 250, [palette]);
}
