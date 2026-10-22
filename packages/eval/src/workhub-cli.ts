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

import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { WORKHUB_EVAL_CASES, workHubEvalCase } from './workhub-cases.js';
import { checkWorkHubCapture, loadWorkHubCapture } from './workhub-evidence.js';

const USAGE = 'usage: node packages/eval/dist/workhub-cli.js plan [case-id] | check <capture.json>';

export async function runWorkHubEvalCli(
  argv: readonly string[],
  io: { readonly stdout: (s: string) => void; readonly stderr: (s: string) => void } = {
    stdout: (s: string) => process.stdout.write(s),
    stderr: (s: string) => process.stderr.write(s),
  },
): Promise<number> {
  try {
    if (argv.length === 1 && ['--help', '-h'].includes(argv[0])) {
      io.stdout(`${USAGE}\n`);
      return 0;
    }
    if (argv[0] === 'plan' && argv.length <= 2) {
      const cases = argv[1] ? [workHubEvalCase(argv[1])] : WORKHUB_EVAL_CASES;
      io.stdout(
        `${JSON.stringify({ schemaVersion: 1, status: 'pending_desktop_execution', cases }, null, 2)}\n`,
      );
      return 0;
    }
    if (argv[0] !== 'check' || argv.length !== 2 || !argv[1]) throw Error(USAGE);
    const loaded = await loadWorkHubCapture(resolve(argv[1]));
    const report = checkWorkHubCapture(loaded.capture, loaded);
    io.stdout(`${JSON.stringify(report, null, 2)}\n`);
    return report.verdict === 'pass' ? 0 : 1;
  } catch (error) {
    io.stderr(`workhub eval: ${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = await runWorkHubEvalCli(process.argv.slice(2));
}
