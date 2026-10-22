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

import type { RuntimeExecutionConnection } from '@maka/core/llm-connections';
import type { RuntimePolicy } from '@maka/core/runtime-policy';
import { WORKHUB_COORDINATION_SESSION_ID } from '@maka/core/session';

/** An activation-local override, not a catalog mutation or a task switch rule. */
export function workHubContextConnection<
  T extends Pick<RuntimeExecutionConnection, 'slug' | 'modelOverrides'>,
>(
  connection: T,
  sessionId: string,
  modelId: string,
  defaults: Pick<RuntimePolicy['chatDefaults'], 'workHubCompactionThreshold'>,
): T {
  const threshold = defaults.workHubCompactionThreshold;
  if (sessionId !== WORKHUB_COORDINATION_SESSION_ID || threshold === undefined) return connection;
  return {
    ...connection,
    modelOverrides: {
      ...connection.modelOverrides,
      [modelId]: { ...connection.modelOverrides?.[modelId], compactionThreshold: threshold },
    },
  };
}
