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

import type { OperationInput, OperationOutput, TurnSnapshot } from '@maka/runtime-host/protocol';
import type { AttachmentIngestBlockedCode } from '@maka/core/attachments';
import type { AttachmentRef } from '@maka/core/events';

/** A retry keeps the original Host epoch as well as the Turn and complete payload. */
export type WorkHubAnswerInput = OperationInput<'workhub.coordination.answer'> & {
  readonly originHostEpoch?: string;
};

export type WorkHubAnswerResult =
  | { readonly kind: 'admitted'; readonly turnId: string; readonly status?: TurnSnapshot['status'] }
  | { readonly kind: 'unknown'; readonly originHostEpoch: string }
  | { readonly kind: 'not_admitted' };

/** Unknown delivery retains the original task input ID and payload for reconciliation. */
export type WorkHubTaskSendResult =
  | { readonly kind: 'accepted'; readonly receipt: OperationOutput<'workhub.tasks.send'> }
  | { readonly kind: 'unknown' }
  | { readonly kind: 'rejected'; readonly code: string; readonly message: string };

/** Desktop presentation only: old read grants do not imply indexed discovery permission. */
export type WorkHubTaskListResult =
  | OperationOutput<'workhub.tasks.find'>
  | { readonly kind: 'recent_only'; readonly result: OperationOutput<'workhub.tasks.query'> }
  | { readonly kind: 'index_not_authorized' };

export type WorkHubCoordinationSessionResolution =
  | { readonly sessionId: string }
  | { readonly kind: 'model_required' };

export type WorkHubPrepareAttachmentsResult =
  | { readonly ok: true; readonly attachments: AttachmentRef[] }
  | { readonly ok: false; readonly code: AttachmentIngestBlockedCode };
