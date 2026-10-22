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

import { isDeepStrictEqual } from 'node:util';
import type { WorkHubDelegationAssignedMessage } from '@maka/core/session';
import { WORKHUB_COORDINATION_SESSION_ID } from '@maka/core/session';
import {
  workHubPeerSettlementId,
  type WorkHubPeerQuestionMessage,
  type WorkHubPeerSettlementMessage,
  type WorkHubPeerTaskRef,
} from '@maka/core/workhub-evidence';
import type { ExecutionStoresWriter } from '@maka/storage/execution-stores';
import type { SessionAdmissionGate } from './session-admission-gate.js';

export const workHubPeerTaskRef = (a: WorkHubDelegationAssignedMessage): WorkHubPeerTaskRef => ({
  workId: a.work?.id ?? a.actionId,
  generationId: a.work?.generationId ?? a.actionId,
  actionId: a.actionId,
  delegationId: a.delegationId,
  sessionId: a.targetSessionId,
  messageId: a.targetMessageId,
});

/** Compatibility cleanup only. No ask, inbox, reply, wait, prompt injection or wake producer. */
export function createWorkHubPeerRuntime(options: {
  stores: ExecutionStoresWriter<'interactive'>['sessionStore'];
  admission: SessionAdmissionGate;
  authenticate(question: WorkHubPeerQuestionMessage): Promise<boolean>;
  now(): number;
}) {
  async function record(sessionId: string, messageId: string) {
    return (
      await options.stores.readTranscriptMessagesSnapshot(sessionId, {
        messageIds: [messageId],
        throughSequence: await options.stores.readTranscriptHighWaterSnapshot(sessionId),
        maxMessages: 1,
        maxBytes: 32768,
      })
    )[0];
  }
  async function settled(question: WorkHubPeerQuestionMessage) {
    const previous = await record(
      question.recipient.sessionId,
      workHubPeerSettlementId(question.id),
    );
    if (!previous) return false;
    if (
      previous.type !== 'workhub_peer_settlement' ||
      previous.questionId !== question.id ||
      previous.requesterSessionId !== question.sender.sessionId
    )
      throw new Error('Peer retirement settlement identity conflict');
    return true;
  }
  return {
    async retireLegacy(question: WorkHubPeerQuestionMessage) {
      // A terminal fact never becomes a live question just because old runtime
      // ownership records are no longer available. No new write is needed.
      if (await settled(question)) return 'settled' as const;
      // The original sender's immutable root ownership is evidence, not a live
      // worker or coordinator invocation. Do not manufacture either identity.
      if (!(await options.authenticate(question))) return 'unavailable' as const;
      return options.admission.runMany(
        [WORKHUB_COORDINATION_SESSION_ID, question.sender.sessionId, question.recipient.sessionId],
        async () => {
          const original = await record(question.sender.sessionId, question.id);
          if (!isDeepStrictEqual(original, question)) return 'unavailable' as const;
          if (await settled(question)) return 'settled' as const;
          const settlement: WorkHubPeerSettlementMessage = {
            type: 'workhub_peer_settlement',
            schemaVersion: 1,
            id: workHubPeerSettlementId(question.id),
            origin: 'legacy_protocol_retirement',
            turnId: question.turnId,
            ts: options.now(),
            requesterSessionId: question.sender.sessionId,
            questionId: question.id,
            actor: question.sender,
            senderRunId: question.senderRunId,
            senderInvocationId: question.senderInvocationId,
            toolCallId: question.toolCallId,
            outcome: 'cancelled',
          };
          const committed = await options.stores.commitWorkHubPeerSettlement(settlement);
          return committed.origin === 'legacy_protocol_retirement'
            ? ('retired' as const)
            : ('settled' as const);
        },
      );
    },
  };
}
