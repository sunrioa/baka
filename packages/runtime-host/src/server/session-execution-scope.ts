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

import type {
  OrderedSubscriptionFrame,
  SessionContinuitySnapshot,
  SessionExecutionScope,
} from '../protocol/session-continuity.js';
import { projectSharedSessionMessageContent } from './shared-session-transcript.js';

export function executionScopeMatches(
  scope: SessionExecutionScope | undefined,
  identity: { readonly turnId: string; readonly runId: string } | null | undefined,
): boolean {
  return (
    !scope || (!!identity && scope.turnId === identity.turnId && scope.runId === identity.runId)
  );
}

/** A read-only execution view cannot inherit another task's queue or Goal. */
export function projectExecutionSnapshot(
  snapshot: SessionContinuitySnapshot,
  scope: SessionExecutionScope | undefined,
): SessionContinuitySnapshot {
  if (!scope) return snapshot;
  return {
    ...snapshot,
    rootTurn: executionScopeMatches(scope, snapshot.rootTurn) ? snapshot.rootTurn : null,
    goal: null,
    queue: { ...snapshot.queue, steering: [], followup: [] },
    interactions: {
      // The admitted Session/Turn is unique. Handoffs retain that Turn, but
      // pending requests keep the physical Run needed for their real answers.
      pending: snapshot.interactions.pending.filter(
        (p) => p.sessionId === snapshot.session.sessionId && p.turnId === scope.turnId,
      ),
    },
  };
}

/** Filter before transport/sequence assignment, not in the renderer. */
export function projectExecutionFrame(
  frame: OrderedSubscriptionFrame,
  scope: SessionExecutionScope,
): OrderedSubscriptionFrame | undefined {
  switch (frame.kind) {
    case 'subscription.session_projection':
      return { ...frame, snapshot: projectExecutionSnapshot(frame.snapshot, scope) };
    case 'subscription.session_delta':
      return executionScopeMatches(scope, frame.delta) ? frame : undefined;
    case 'subscription.session_event':
      if (!executionScopeMatches(scope, { turnId: frame.event.turnId, runId: frame.runId }))
        return undefined;
      return frame.event.type === 'steering_message'
        ? {
            ...frame,
            event: {
              ...frame.event,
              content: projectSharedSessionMessageContent(frame.event.content, frame.sessionId),
            },
          }
        : frame;
    case 'subscription.transcript_advanced':
    case 'subscription.closed':
      return frame;
    // These domains are Session-wide, not execution-owned. Tool output still
    // travels on the exact execution's bounded session_event stream.
    case 'subscription.session_domain_changed':
    case 'subscription.agent_graph_changed':
      return undefined;
  }
}
