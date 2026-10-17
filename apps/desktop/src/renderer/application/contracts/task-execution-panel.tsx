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

import { createContext, useCallback, useContext, useMemo, useState, type ComponentType, type ReactNode } from 'react';

type Panel = ComponentType<{ owner: string; available?: boolean }>;
const Context = createContext<{
  Panel?: Panel;
  open(): void;
  register(panel: Panel): () => void;
}>({ open() {}, register: () => () => {} });

/** Per-shell composition slot. Neither feature imports the other's controller. */
export function TaskExecutionPanelProvider({ children, onOpen }: { children: ReactNode; onOpen(): void }) {
  const [Panel, setPanel] = useState<Panel>();
  const register = useCallback((panel: Panel) => {
    setPanel(() => panel);
    return () => setPanel((current: Panel | undefined) => current === panel ? undefined : current);
  }, []);
  const value = useMemo(() => ({ Panel, register, open: onOpen }), [Panel, register, onOpen]);
  return <Context.Provider value={value}>{children}</Context.Provider>;
}

export const useTaskExecutionPanel = () => useContext(Context);

export function TaskExecutionPanel({ owner, available }: { owner: string; available?: boolean }) {
  const { Panel } = useTaskExecutionPanel();
  return Panel ? <Panel owner={owner} available={available} /> : null;
}
