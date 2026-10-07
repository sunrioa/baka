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

import { isWorkHubMaxConcurrentSessions } from '@maka/core/settings';

export interface WorkHubExecutionSlot {
  readonly ready: Promise<void>;
  readonly waiting: boolean;
  cancelWaiting(): void;
  release(): void;
}

/** Epoch-local dispatch gate, not a queue or execution authority. Durable roots own the work. */
export class WorkHubExecutionSlots {
  #limit: number;
  #running = 0;
  readonly #pending: Array<() => void> = [];

  constructor(limit: number) {
    this.#limit = limit;
    this.setLimit(limit);
  }

  setLimit(limit: number): void {
    if (!isWorkHubMaxConcurrentSessions(limit)) throw new Error('Invalid WorkHub concurrency');
    this.#limit = limit;
    this.flush();
  }

  acquire(): WorkHubExecutionSlot {
    let state: 'waiting' | 'running' | 'released' = 'waiting';
    let settle!: () => void;
    const ready = new Promise<void>((resolve) => {
      settle = resolve;
    });
    const grant = () => {
      state = 'running';
      this.#running += 1;
      settle();
    };
    const removePending = () => {
      const index = this.#pending.indexOf(grant);
      if (index >= 0) this.#pending.splice(index, 1);
      state = 'released';
      settle();
    };
    this.#pending.push(grant);
    this.flush();
    return {
      ready,
      get waiting() {
        return state === 'waiting';
      },
      cancelWaiting: () => {
        if (state === 'waiting') removePending();
      },
      release: () => {
        if (state === 'released') return;
        if (state === 'waiting') removePending();
        else {
          state = 'released';
          this.#running -= 1;
        }
        this.flush();
      },
    };
  }

  private flush(): void {
    while (this.#running < this.#limit && this.#pending.length > 0) this.#pending.shift()!();
  }
}
