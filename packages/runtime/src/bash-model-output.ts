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

import { redactContextCredentials } from '@maka/core/redaction';

import type { ToolResultOutput } from './model-protocol.js';
import { toolResultOutput } from './tool-result-output.js';

/**
 * Keep the canonical Bash result intact for durable storage while removing the
 * command already present in the paired provider-visible Bash call.
 */
export function projectBashToolResultForModel(output: unknown): unknown {
  if (
    !output ||
    typeof output !== 'object' ||
    Array.isArray(output) ||
    (output as { kind?: unknown }).kind !== 'terminal'
  ) {
    return output;
  }
  const { cmd: _cmd, ...projected } = output as Record<string, unknown>;
  return {
    ...projected,
    ...(typeof projected.failureMessage === 'string'
      ? { failureMessage: redactContextCredentials(projected.failureMessage) }
      : {}),
    output: redactShellOutputForModel(projected.output),
  };
}

/**
 * Which fields of a `ShellOutput` carry command output, by mode.
 *
 * Listed rather than derived so a future field is redacted only once someone
 * has decided it should be. A new text field defaults to passing through,
 * which is the failure this list is meant to make visible in review — the
 * alternative, redacting every string, would eventually mangle a field that
 * has to survive intact.
 */
const SHELL_OUTPUT_TEXT_FIELDS: Readonly<Record<'pipes' | 'pty', readonly string[]>> = {
  pipes: ['stdout', 'stderr'],
  pty: ['screen', 'scrollback', 'lastAlternateScreen'],
};

/**
 * Redacts a shell result's captured output and records that it happened.
 *
 * `redacted` is already on the wire type and every producer hardcodes it to
 * `false`; the display stream is the only place that has ever computed it.
 * Setting it here is what lets a model tell an empty search from a redacted
 * one, instead of concluding a tree holds no credentials because their values
 * were removed before it looked.
 */
function redactShellOutputForModel(output: unknown): unknown {
  if (!output || typeof output !== 'object' || Array.isArray(output)) return output;
  const shell = output as Record<string, unknown>;
  const fields =
    shell.mode === 'pty' ? SHELL_OUTPUT_TEXT_FIELDS.pty : SHELL_OUTPUT_TEXT_FIELDS.pipes;
  const next: Record<string, unknown> = { ...shell };
  let changed = false;
  for (const field of fields) {
    const value = next[field];
    if (typeof value !== 'string') continue;
    const redacted = redactContextCredentials(value);
    if (redacted === value) continue;
    next[field] = redacted;
    changed = true;
  }
  if (!changed) return shell;
  return { ...next, redacted: true };
}

export function bashToolResultToModelOutput(output: unknown): ToolResultOutput {
  const isError =
    output !== null &&
    typeof output === 'object' &&
    'kind' in output &&
    output.kind === 'terminal' &&
    'status' in output &&
    output.status !== 'completed';
  return toolResultOutput(projectBashToolResultForModel(output), isError);
}
