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
import { isAbsolute, normalize, relative, sep } from 'node:path';

interface WorkspaceSlot {
  readonly workspace?: string;
  readonly identity?: string;
  readonly unresolvedWorkspace: boolean;
  grant(): void;
}

function overlaps(left: WorkspaceSlot, right: WorkspaceSlot): boolean {
  if (left.unresolvedWorkspace || right.unresolvedWorkspace) return true;
  if (left.identity && right.identity && left.identity === right.identity) return true;
  if (!left.workspace || !right.workspace) return false;
  const contains = (parent: string, child: string) => {
    const path = relative(parent, child);
    return path === '' || (!isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`));
  };
  return contains(left.workspace, right.workspace) || contains(right.workspace, left.workspace);
}

export interface WorkHubExecutionSlot {
  readonly ready: Promise<void>;
  readonly waiting: boolean;
  cancelWaiting(): void;
  release(): void;
}

/** Epoch-local dispatch gate, not a queue or execution authority. Durable roots own the work. */
export class WorkHubExecutionSlots {
  #limit: number;
  readonly #running = new Set<WorkspaceSlot>();
  readonly #pending: WorkspaceSlot[] = [];

  constructor(limit: number) {
    this.#limit = limit;
    this.setLimit(limit);
  }

  setLimit(limit: number): void {
    if (!isWorkHubMaxConcurrentSessions(limit)) throw new Error('Invalid WorkHub concurrency');
    this.#limit = limit;
    this.flush();
  }

  /** The Host supplies a realpath-resolved cwd and, when available, its directory identity. */
  acquire(
    workspace?: string,
    identity?: string,
    unresolvedWorkspace = false,
  ): WorkHubExecutionSlot {
    if (workspace !== undefined && !isAbsolute(workspace))
      throw new Error('Invalid WorkHub workspace');
    let state: 'waiting' | 'running' | 'released' = 'waiting';
    let settle!: () => void;
    const ready = new Promise<void>((resolve) => {
      settle = resolve;
    });
    const slot: WorkspaceSlot = {
      unresolvedWorkspace,
      ...(workspace
        ? {
            workspace:
              process.platform === 'win32'
                ? normalize(workspace).toLowerCase()
                : normalize(workspace),
          }
        : {}),
      ...(identity ? { identity } : {}),
      grant: () => {
        state = 'running';
        this.#running.add(slot);
        settle();
      },
    };
    const removePending = () => {
      const index = this.#pending.indexOf(slot);
      if (index >= 0) this.#pending.splice(index, 1);
      state = 'released';
      settle();
    };
    this.#pending.push(slot);
    this.flush();
    return {
      ready,
      get waiting() {
        return state === 'waiting';
      },
      cancelWaiting: () => {
        if (state === 'waiting') {
          removePending();
          this.flush();
        }
      },
      release: () => {
        if (state === 'released') return;
        if (state === 'waiting') removePending();
        else {
          state = 'released';
          this.#running.delete(slot);
        }
        this.flush();
      },
    };
  }

  private flush(): void {
    for (let index = 0; index < this.#pending.length && this.#running.size < this.#limit; ) {
      const slot = this.#pending[index]!;
      if (
        [...this.#running].some((running) => overlaps(running, slot)) ||
        this.#pending.slice(0, index).some((earlier) => overlaps(earlier, slot))
      ) {
        index++;
        continue;
      }
      this.#pending.splice(index, 1);
      slot.grant();
    }
  }
}
