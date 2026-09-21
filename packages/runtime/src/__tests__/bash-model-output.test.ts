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

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { projectBashToolResultForModel } from '../bash-model-output.js';

function pipeResult(stdout: string, stderr = ''): unknown {
  return {
    kind: 'terminal',
    cwd: '/repo',
    cmd: 'cat .env',
    status: 'completed',
    exitCode: 0,
    output: {
      mode: 'pipes',
      stdout,
      stderr,
      stdoutTruncated: false,
      stderrTruncated: false,
      redacted: false,
    },
  };
}

describe('projectBashToolResultForModel', () => {
  test('redacts credential values captured on stdout and stderr', () => {
    const projected = projectBashToolResultForModel(
      pipeResult(
        'OPENAI_API_KEY=sk-abcdefghijklmnopqrstuvwx\n',
        'ghp_0123456789abcdefghijklmnopqrstuvwxyz\n',
      ),
    ) as { output: { stdout: string; stderr: string; redacted: boolean } };
    assert.equal(projected.output.stdout, 'OPENAI_API_KEY=[redacted]\n');
    assert.equal(projected.output.stderr, '[redacted]\n');
    assert.equal(projected.output.redacted, true);
  });

  test('leaves ordinary command output and its flag alone', () => {
    // Commit ids and identifier assignments are what Bash returns all day.
    // Redacting either would make the agent act on output that never existed.
    const stdout = 'commit 97c83e4fb0000000000000000000000000000000\nconst token = read();\n';
    const projected = projectBashToolResultForModel(pipeResult(stdout)) as {
      output: { stdout: string; redacted: boolean };
    };
    assert.equal(projected.output.stdout, stdout);
    assert.equal(projected.output.redacted, false);
  });

  test('redacts a PTY screen and its scrollback', () => {
    const projected = projectBashToolResultForModel({
      kind: 'terminal',
      cwd: '/repo',
      cmd: 'env',
      status: 'completed',
      output: {
        mode: 'pty',
        screen: 'AWS=AIzaSyA0123456789abcdefghijklmnopqrst',
        scrollback: 'slack xoxb-1234567890-abcdefghij',
        cols: 80,
        rows: 24,
        cursor: { x: 0, y: 0, visible: true },
        alternateScreen: false,
        truncated: false,
        redacted: false,
      },
    }) as { output: { screen: string; scrollback: string; redacted: boolean } };
    assert.equal(projected.output.screen, 'AWS=[redacted]');
    assert.equal(projected.output.scrollback, 'slack [redacted]');
    assert.equal(projected.output.redacted, true);
  });

  test('still drops the echoed command and passes non-terminal results through', () => {
    const projected = projectBashToolResultForModel(pipeResult('ok\n')) as Record<string, unknown>;
    assert.equal('cmd' in projected, false);
    assert.deepEqual(projectBashToolResultForModel({ kind: 'json', value: 1 }), {
      kind: 'json',
      value: 1,
    });
  });
});
