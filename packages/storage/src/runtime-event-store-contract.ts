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

import type { RuntimeEvent, ToolRecoveryMode } from '@maka/core/runtime-event';

/** A bounded historical observation, never the next request's remaining capacity. */
export type SessionRequestObservation =
  | {
      readonly status: 'unknown';
      readonly reason:
        | 'not_observed'
        | 'scan_limit'
        | 'record_limit'
        | 'unknown_route'
        | 'invalid_observation';
    }
  | {
      readonly status: 'observed';
      readonly eventId: string;
      readonly runId: string;
      readonly observedAt: number;
      readonly modelId: string;
      readonly connectionId: string;
      readonly connectionSlug: string;
      readonly inputTokens: number;
      readonly outputTokens?: number;
      readonly requestedAt?: number;
      readonly latestRequestAt?: number;
      readonly usageScope?: 'last_completed_request';
      readonly cacheReadInputTokens?: number;
      readonly cacheWriteInputTokens?: number;
      readonly cacheMissInputTokens?: number;
      readonly cacheReadInputSource?: 'reported';
      readonly cacheWriteInputSource?: 'reported';
      readonly cacheMissInputSource?: 'explicit' | 'derived';
    };

export interface ImmutableRuntimePrefixProofReadBudget {
  readonly maxEvents: number;
  readonly maxBytes: number;
  readonly maxRecordBytes: number;
}

/** T1/T2 transactions keep their runtime fact and recovery journal inseparable. */
export interface CommitToolPreparedInput {
  operationId: string;
  journalEventId: string;
  runtimeEvent: RuntimeEvent;
  dispatchRuntimeEvent: RuntimeEvent;
  providerToolCallId: string;
  toolName: string;
  canonicalArgsHash: string;
  recoveryMode: ToolRecoveryMode;
  committedAt: number;
}

export interface CommitToolOutcomeInput {
  operationId: string;
  journalEventId: string;
  runtimeEvent: RuntimeEvent;
  committedAt: number;
}

export interface ToolCommitResult {
  created: boolean;
  runtimeEventSeq: number;
}

/** Storage-owned, immutable append position for an Event within one Session. */
export interface SessionRuntimeEventEntry {
  readonly ordinal: number;
  readonly event: RuntimeEvent;
}

export interface ToolOperationRecord {
  operationId: string;
  invocationId: string;
  runId: string;
  turnId: string;
  providerToolCallId: string;
  toolName: string;
  canonicalArgsHash: string;
  recoveryMode: ToolRecoveryMode;
  currentState:
    | 'prepared'
    | 'outcome_committed'
    | 'recovery_completed'
    | 'recovery_parked'
    | 'abandoned'
    | 'interrupted_unknown';
  callEventId: string;
  dispatchEventId?: string;
  resultEventId?: string;
  version: number;
}

export interface UnsettledToolOperationRecord extends ToolOperationRecord {
  sessionId: string;
}
