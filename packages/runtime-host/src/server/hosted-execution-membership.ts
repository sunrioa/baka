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

import { DURABLE_TOOL_RESULT_PROJECTION_MAX_BYTES } from '@maka/core/durable-tool-result-projection';
import { readLogicalRuntimeExecution } from '@maka/core/runtime-logical-execution';
import type { RuntimeInvocationRecord } from '@maka/core/runtime-invocation';
import type { ExecutionStoresWriter } from '@maka/storage/execution-stores';
import type { HostedExecutionRef } from './hosted-execution-authority.js';

/** Authenticated physical membership, without decoding the Run's transcript. */
export async function readHostedExecutionMembership(
  store: ExecutionStoresWriter<'interactive'>['runtimeEventStore'],
  ref: HostedExecutionRef,
  knownRun?: RuntimeInvocationRecord,
) {
  const run = knownRun ?? (await store.readRunInvocation(ref.sessionId, ref.runId));
  if (!run || run.turnId !== ref.turnId) return undefined;
  const rootRunId =
    run.opening.source.kind === 'handoff' ? run.opening.source.rootRunId : run.runId;
  return readLogicalRuntimeExecution(
    {
      readRunInvocation: store.readRunInvocation,
      listSessionInvocations: store.listSessionInvocations,
      readContinuationClaimStateByBoundary: store.readContinuationClaimStateByBoundary,
      readImmutableRuntimePrefixProof: (input) =>
        store.readImmutableRuntimePrefixProof(input, {
          maxEvents: 65536,
          maxBytes: 256 * 1024 * 1024,
          maxRecordBytes: DURABLE_TOOL_RESULT_PROJECTION_MAX_BYTES * 2 + 256 * 1024,
        }),
    },
    { ...ref, runId: rootRunId },
    rootRunId === run.runId ? run : undefined,
    { mode: 'membership' },
  );
}
