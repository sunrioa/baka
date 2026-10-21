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

import { deferred, nextId } from '@maka/core/test-only/async-primitives';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { LlmConnection } from '@maka/core/llm-connections';
import type { SessionEvent } from '@maka/core/events';
import type { SessionHeader, StoredMessage } from '@maka/core/session';
import type { ToolOutcomeCommit, ToolPreparedCommit } from '../runtime-commit-sink.js';
import { isRuntimeCommitBoundaryError, type MakaTool } from '../tool-runtime.js';
import { buildAskUserQuestionTool } from '../ask-user-question-tool.js';
import {
  bindRuntimeInteractionRun,
  RuntimeInteractionClosedError,
  RuntimeInteractionInvariantError,
  RuntimeInteractionFailStopError,
  type RuntimeUserQuestionContinuation,
} from '../interaction-authority.js';

import { createTestToolRuntime } from './execution-boundary-test-helpers.js';
import { waitFor as pollFor } from '@maka/core/test-only/async-primitives';

/**
 * #2253: a stop that lands while an AskUserQuestion is parked ends the turn
 * before the tool's own unwind runs. endTurn clears the per-turn durable
 * attempt map synchronously, and the question's rejection reaches the
 * executor a microtask later, so the synthetic error result used to be
 * written without its operation identity. A response for a dispatched
 * operation that carries no operationId is exactly what the tool ledger
 * rejects as identity_conflict, and that rejection latched the whole
 * RuntimeEvent store (the amplifier half of the issue, pinned in
 * session-manager-terminal-ledger.test.ts).
 */
describe('ToolRuntime turn-close outcome identity', () => {
  it('keeps the operation identity on a result synthesized after endTurn', async () => {
    const prepared: ToolPreparedCommit[] = [];
    const outcomes: ToolOutcomeCommit[] = [];
    const events: SessionEvent[] = [];
    const messages: StoredMessage[] = [];
    const runtime = createTestToolRuntime({
      sessionId: 'session-1',
      header: header(),
      connection: connection(),
      modelId: 'model-1',
      appendMessage: async (message) => {
        messages.push(message);
      },
      newId: nextId(),
      now: nextNow(),
      getPermissionPauseTarget: () => null,
      runId: 'run-1',
      runtimeCommitSink: {
        commitToolPrepared: async (input) => {
          prepared.push(input);
          return { created: true, runtimeEventSeq: prepared.length };
        },
        commitToolOutcome: async (input) => {
          outcomes.push(input);
          return { created: true, runtimeEventSeq: 100 + outcomes.length };
        },
      },
    });

    const ask: MakaTool = {
      name: 'AskUserQuestion',
      description: 'ask',
      parameters: {},
      recoveryMode: 'never_auto_retry',
      impl: (_args, context) => {
        if (!context.askUserQuestion) throw new Error('askUserQuestion missing from context');
        return context.askUserQuestion([
          { question: 'q?', options: [{ label: 'a' }, { label: 'b' }] },
        ]);
      },
    };

    const settled = runtime.settleToolCall({
      tool: ask,
      turnId: 'turn-1',
      toolCallId: 'provider-call-1',
      input: {},
      abortSignal: new AbortController().signal,
      eventSink: {
        push: (event) => {
          events.push(event);
        },
        pushAndWaitUntilConsumed: async (event) => {
          events.push(event);
        },
      },
    });
    // The question is parked once T1 committed and the request event is out.
    await waitFor(
      () => prepared.length === 1 && events.some((event) => event.type === 'user_question_request'),
    );

    // The stop path: endTurn rejects the parked question and resets the
    // per-turn state in the same synchronous body. The tool's unwind runs
    // after both.
    await runtime.endTurn('aborted');
    // Ordering is part of the contract: the run's terminal fact is settled
    // right after the stop resolves, and the store keeps the terminal event
    // as the immutable ledger tail, so the aborted operation's outcome must
    // already be committed by the time endTurn hands back.
    assert.equal(outcomes.length, 1);
    await settled;

    const result = events.find(
      (event): event is Extract<SessionEvent, { type: 'tool_result' }> =>
        event.type === 'tool_result',
    );
    assert.ok(result, 'expected a synthesized tool_result for the closed question');
    assert.equal(result.isError, true);
    // The identity link is the whole point: a response for a dispatched
    // operation without its operationId is an identity_conflict to the
    // ledger, which then refuses the write.
    assert.equal(result.operationId, prepared[0]?.operationId);
    assert.equal(outcomes.length, 1);
    assert.equal(outcomes[0]?.operationId, prepared[0]?.operationId);
  });

  for (const [order, failOutcome, teardownFirst] of [
    ['closure_first', false, false],
    ['abort_first', false, false],
    ['closure_first', true, false],
    ['closure_first', false, true],
  ] as const) {
    it(`settles the original dispatched hosted question when ${order} wins${failOutcome ? ' and propagates a T2 failure' : teardownFirst ? ' after endTurn clears the lookup' : ' exactly once'}`, async () => {
      const prepared: ToolPreparedCommit[] = [];
      const outcomes: ToolOutcomeCommit[] = [];
      const outcomeInputs: ToolOutcomeCommit[] = [];
      const events: SessionEvent[] = [];
      const published = deferred<Extract<SessionEvent, { type: 'user_question_request' }>>();
      let question: RuntimeUserQuestionContinuation | undefined;
      let closeCalls = 0;
      let answerContinuations = 0;
      let implementationFailure: unknown;
      let outcomeAttempts = 0;
      const outcomeFailure = new Error('question cancellation T2 unavailable');
      const binding = await bindRuntimeInteractionRun(
        {
          bindRun: (identity) => ({
            ...identity,
            acceptUserQuestionRequest: async ({ continuation }) => {
              question = continuation;
            },
            acceptFormRequest: async () => {
              throw new Error('unexpected form');
            },
            acceptSandboxBoundaryRequest: async () => {
              throw new Error('unexpected sandbox request');
            },
            withdrawFormRequest: async () => {
              throw new Error('unexpected withdrawal');
            },
            close: async (reason) => {
              closeCalls++;
              assert.ok(question);
              await question.applyClosure(reason);
            },
            release: () => {},
          }),
        },
        { sessionId: 'session-1', turnId: 'turn-1', runId: 'run-1' },
      );
      const runtime = createTestToolRuntime({
        sessionId: 'session-1',
        header: header(),
        connection: connection(),
        modelId: 'model-1',
        newId: nextId(),
        now: nextNow(),
        getPermissionPauseTarget: () => null,
        invocationId: 'invocation-1',
        runId: 'run-1',
        hostedInteraction: binding,
        runtimeCommitSink: {
          commitToolPrepared: async (input) => {
            prepared.push(input);
            return { created: true, runtimeEventSeq: prepared.length };
          },
          commitToolOutcome: async (input) => {
            outcomeAttempts++;
            outcomeInputs.push(input);
            if (failOutcome) throw outcomeFailure;
            outcomes.push(input);
            return { created: true, runtimeEventSeq: 100 + outcomes.length };
          },
        },
      });
      const controller = new AbortController();
      const ask = buildAskUserQuestionTool();
      const askImplementation = ask.impl;
      ask.impl = async (args, context) => {
        try {
          return await askImplementation(args, context);
        } catch (error) {
          implementationFailure = error;
          throw error;
        }
      };
      const settled = runtime
        .settleToolCall({
          tool: ask,
          turnId: 'turn-1',
          toolCallId: 'provider-call-1',
          input: {
            questions: [{ question: 'Continue?', options: [{ label: 'Yes' }, { label: 'No' }] }],
          },
          abortSignal: controller.signal,
          eventSink: {
            push: (event) => {
              events.push(event);
              if (event.type === 'user_question_request') {
                binding.assertPendingAdmission(event);
                published.resolve(event);
              }
            },
            pushAndWaitUntilConsumed: async (event) => {
              events.push(event);
            },
          },
        })
        .then(
          (value) => {
            if (!value.providerError) answerContinuations++;
            return { value };
          },
          (error: unknown) => ({ error }),
        );
      const request = await published.promise;
      assert.equal(prepared.length, 1);
      const operationId = prepared[0].operationId;
      assert.equal(
        prepared[0].dispatchRuntimeEvent.actions?.toolDispatch?.operationId,
        operationId,
      );
      assert.equal(prepared[0].runtimeEvent.refs?.operationId, operationId);
      assert.equal(outcomes.length, 0);
      // Teardown clears the shared attempt lookup synchronously; only the
      // executor's captured original attempt can still settle the operation.
      const ending = teardownFirst ? runtime.endTurn('aborted') : undefined;

      if (order === 'closure_first') {
        await binding.close('turn_stopped');
        const result = await settled;
        assert.ok('error' in result);
        if (failOutcome) {
          assert.ok(isRuntimeCommitBoundaryError(result.error));
          assert.ok(result.error instanceof Error);
          assert.equal(result.error.cause, outcomeFailure);
          assert.match(result.error.message, /^T2 runtime commit failed:/);
        } else {
          assert.ok(result.error instanceof RuntimeInteractionClosedError);
          assert.equal(result.error, implementationFailure);
          assert.equal(result.error.reason, 'turn_stopped');
        }
        assert.equal(controller.signal.aborted, false);
        controller.abort(new DOMException('Stopped', 'AbortError'));
      } else {
        controller.abort(new DOMException('Stopped', 'AbortError'));
        const result = await settled;
        assert.ok('value' in result && result.value.providerError);
        await binding.close('turn_stopped');
      }
      await (ending ?? runtime.endTurn('aborted'));
      await binding.settleLocalClosures();

      // Duplicate stop and a late answer never create another T2 or an answer ACK.
      await binding.close('turn_stopped');
      await runtime.endTurn('aborted');
      assert.ok(question);
      await assert.rejects(
        question.applyAnswer({ answers: ['Yes'] }),
        RuntimeInteractionInvariantError,
      );
      assert.equal(
        runtime.respondToUserQuestion({ requestId: request.requestId, answers: ['Yes'] }),
        false,
      );
      binding.release();
      assert.equal(closeCalls, 1);
      assert.equal(answerContinuations, 0);
      assert.equal(outcomeAttempts, 1);
      assert.equal(outcomeInputs[0].operationId, operationId);
      assert.equal(outcomeInputs[0].runtimeEvent.content?.kind, 'function_response');
      const results = events.filter((event) => event.type === 'tool_result');
      if (failOutcome) {
        assert.equal(outcomes.length, 0);
        assert.equal(results.length, 0, 'a failed T2 must not publish a durable-looking result');
      } else {
        assert.equal(outcomes.length, 1, 'a dispatched question must have its original durable T2');
        assert.equal(outcomes[0].operationId, operationId);
        assert.equal(outcomes[0].runtimeEvent.refs?.operationId, operationId);
        assert.equal(outcomes[0].runtimeEvent.content?.kind, 'function_response');
        if (order === 'closure_first')
          assert.match(JSON.stringify(outcomes[0].runtimeEvent.content), /turn_stopped/);
        assert.ok(
          outcomes[0].runtimeEvent.content &&
            'isError' in outcomes[0].runtimeEvent.content &&
            outcomes[0].runtimeEvent.content.isError,
        );
        assert.equal(results.length, 1);
        assert.equal(results[0].operationId, operationId);
      }
      assert.equal(events.filter((event) => event.type === 'user_question_answer_ack').length, 0);
      assert.equal(runtime.pendingUserQuestionCount(), 0);
    });
  }

  for (const fatal of [
    new RuntimeInteractionInvariantError('question invariant failed'),
    new RuntimeInteractionFailStopError(
      'question authority failed',
      new Error('authority failure'),
    ),
  ]) {
    it(`does not synthesize cancellation for ${fatal.name}`, async () => {
      const prepared: ToolPreparedCommit[] = [];
      const outcomes: ToolOutcomeCommit[] = [];
      const events: SessionEvent[] = [];
      const runtime = createTestToolRuntime({
        sessionId: 'session-1',
        header: header(),
        connection: connection(),
        modelId: 'model-1',
        newId: nextId(),
        now: nextNow(),
        getPermissionPauseTarget: () => null,
        invocationId: 'invocation-1',
        runId: 'run-1',
        runtimeCommitSink: {
          commitToolPrepared: async (input) => {
            prepared.push(input);
            return { created: true, runtimeEventSeq: prepared.length };
          },
          commitToolOutcome: async (input) => {
            outcomes.push(input);
            return { created: true, runtimeEventSeq: 100 + outcomes.length };
          },
        },
      });
      const ask: MakaTool = {
        ...buildAskUserQuestionTool(),
        impl: () => {
          throw fatal;
        },
      };
      await assert.rejects(
        runtime.settleToolCall({
          tool: ask,
          turnId: 'turn-1',
          toolCallId: 'provider-call-1',
          input: {
            questions: [{ question: 'Continue?', options: [{ label: 'Yes' }, { label: 'No' }] }],
          },
          abortSignal: new AbortController().signal,
          eventSink: {
            push: (event) => {
              events.push(event);
            },
            pushAndWaitUntilConsumed: async (event) => {
              events.push(event);
            },
          },
        }),
        (error) => error === fatal,
      );
      await runtime.endTurn('aborted');
      assert.equal(prepared.length, 1);
      assert.equal(outcomes.length, 0);
      assert.equal(events.filter((event) => event.type === 'tool_result').length, 0);
    });
  }
});

async function waitFor(predicate: () => boolean): Promise<void> {
  await pollFor(predicate, {
    attempts: 500,
    pollMs: 2,
    message: 'condition never became true',
  });
}

function header(): SessionHeader {
  return {
    id: 'session-1',
    workspaceRoot: '/workspace/repo',
    cwd: '/workspace/repo',
    createdAt: 1,
    name: 'test',
    titleIsManual: false,
    isFlagged: false,
    labels: [],
    isArchived: false,
    status: 'active',
    statusUpdatedAt: 1,
    hasUnread: false,
    backend: 'ai-sdk',
    llmConnectionSlug: 'connection-1',
    connectionLocked: true,
    model: 'model-1',
    permissionMode: 'ask',
    schemaVersion: 1,
  };
}

function connection(): LlmConnection {
  return {
    slug: 'connection-1',
    name: 'test',
    providerType: 'openai',
    defaultModel: 'model-1',
    enabled: true,
    createdAt: 1,
    updatedAt: 1,
  };
}
function nextNow(): () => number {
  let value = 0;
  return () => ++value;
}
