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

/**
 * Compiles the user's trusted-path preferences into sandbox profile entries.
 *
 * Why this exists: a managed profile only ever carries `:workspace_roots`,
 * `:tmpdir` and `:slash_tmp`, so `assessSandboxBoundaryExpansion` can never
 * answer `noop` for a path outside the workspace. Every such read becomes a
 * prompt — one per file, per session. Pre-declaring the directories the user
 * already trusts lets the containment check succeed and the prompt never fire.
 *
 * This module is pure, matching `permission-profile.ts`: callers pass
 * already-normalized absolute paths, and the runtime owns realpath and
 * platform preprocessing.
 */

import { pathWithinRoot, isNormalizedAbsolutePath } from './absolute-path.js';
import type { FileSystemSandboxEntry } from './permission-profile.js';

/**
 * How many entries one trusted list may hold.
 *
 * The list is not only an audit surface, it is compiled into every new
 * session's profile: each entry becomes a seatbelt clause on macOS and a bind
 * argument under bubblewrap, and the whole boundary is capped at
 * `MAX_EXECUTION_BOUNDARY_SERIALIZED_BYTES`. An unbounded list eventually
 * fails session creation outright.
 *
 * 64 is well inside every backend's comfort and still more than a person will
 * read in one sitting — past that the list has stopped being reviewable, which
 * is the real limit.
 */
export const MAX_TRUSTED_PATHS = 64;

/**
 * Reduces a list to the paths that are not already covered by another one.
 *
 * Without this, clicking "always allow" around a deep tree accumulates
 * `/proj/src/a`, `/proj/src/b`, `/proj/tests/c` … forever, and adding the
 * obvious `/proj` later would leave all of them behind. Consolidation makes
 * broadening a path actually clean up: the children disappear.
 *
 * It never grants more than the input already did — an entry is dropped only
 * when a different entry in the same list contains it. Siblings are left
 * alone, because merging them would hand out a parent directory nobody
 * approved.
 */
export function consolidateTrustedPaths(paths: readonly string[]): string[] {
  const valid = [...new Set(paths.filter(isNormalizedAbsolutePath))].sort();
  const kept: string[] = [];
  for (const path of valid) {
    // `valid` is sorted, so any container is already in `kept`.
    if (kept.some((existing) => pathWithinRoot(path, existing))) continue;
    kept.push(path);
  }
  return kept;
}

export interface CompileTrustedPathsInput {
  /** Directories granted read access as subtrees. */
  readonly readPaths: readonly string[];
  /** Paths denied outright. Takes precedence over `readPaths`. */
  readonly denyPaths: readonly string[];
  /**
   * Whether the host's sandbox backend can express a deny entry.
   *
   * Only the macOS seatbelt backend can. `buildBubblewrapArgv` throws on any
   * deny entry, and the Windows profile builder throws as well, so emitting
   * one there does not merely lose the carve-out — it breaks every sandboxed
   * command in the session.
   */
  readonly denySupported: boolean;
}

export interface CompiledTrustedPaths {
  readonly entries: readonly FileSystemSandboxEntry[];
  /**
   * Read paths that were refused because a deny path sits at or under them and
   * the host cannot express the carve-out. Surfaced so the settings UI can say
   * why a configured directory is not in effect, instead of silently granting
   * it whole or silently dropping it.
   */
  readonly refusedReadPaths: readonly string[];
}

/**
 * Deny wins over read, always, and on a backend that cannot express deny the
 * whole read root is refused rather than granted without its carve-out.
 *
 * The alternative — granting `~/Documents` while quietly failing to seal
 * `~/Documents/secrets` — would hand out exactly the authority the deny entry
 * was written to withhold, on the two platforms least able to show that it
 * happened.
 */
export function compileTrustedPaths(input: CompileTrustedPathsInput): CompiledTrustedPaths {
  const denyPaths = input.denyPaths.filter(isNormalizedAbsolutePath);
  const readPaths = input.readPaths.filter(isNormalizedAbsolutePath);

  const entries: FileSystemSandboxEntry[] = [];
  const refusedReadPaths: string[] = [];

  if (input.denySupported) {
    for (const path of denyPaths) {
      entries.push({ kind: 'path', access: 'deny', path, match: 'subtree' });
    }
  }

  for (const readPath of readPaths) {
    // A read root nested inside a deny root is dead either way: `isDeniedPath`
    // short-circuits before any read entry is consulted. Drop it so the
    // compiled profile says what it means.
    if (denyPaths.some((denyPath) => pathWithinRoot(readPath, denyPath))) {
      refusedReadPaths.push(readPath);
      continue;
    }
    if (!input.denySupported && denyPaths.some((denyPath) => pathWithinRoot(denyPath, readPath))) {
      refusedReadPaths.push(readPath);
      continue;
    }
    entries.push({ kind: 'path', access: 'read', path: readPath, match: 'subtree' });
  }

  return { entries, refusedReadPaths };
}

/**
 * True when the running platform's sandbox backend can express deny entries.
 *
 * Kept next to the compiler so the one place that decides is the one place
 * that documents why. See `CompileTrustedPathsInput.denySupported`.
 */
export function platformSupportsDenyEntries(platform: NodeJS.Platform): boolean {
  return platform === 'darwin';
}

/** The containing directory, or `undefined` for a filesystem root. */
export function parentDirectory(path: string): string | undefined {
  if (!isNormalizedAbsolutePath(path)) return undefined;
  const separator = /^[A-Za-z]:\\/.test(path) ? '\\' : '/';
  const index = path.lastIndexOf(separator);
  if (index < 0) return undefined;
  if (separator === '/') {
    if (index === 0) return path === '/' ? undefined : '/';
    return path.slice(0, index);
  }
  // A Windows drive root is `C:\`, so anything at or before index 2 is the root.
  if (index <= 2) return path.length > 3 ? path.slice(0, 3) : undefined;
  return path.slice(0, index);
}

/**
 * The directories that would have to be trusted for this expansion to stop
 * prompting — the basis of the prompt's "always allow" offer.
 *
 * Returns nothing unless the request is read-only and offline. A write or a
 * network request must never be convertible into standing authority by one
 * click: trusted paths grant reads only, so remembering either one would
 * either not work or quietly mean more than the button says.
 *
 * A filesystem root is refused too. "Always allow `/`" is not a carve-out, it
 * is turning the sandbox off, and it should not be reachable by accident from
 * a prompt about one file.
 */
export function suggestTrustedReadPaths(expansion: {
  readonly filesystem?: {
    readonly entries: readonly {
      readonly path: string;
      readonly access: 'read' | 'write';
      readonly scope: 'exact' | 'subtree';
    }[];
  };
  readonly network?: { readonly enabled: true };
}): readonly string[] {
  if (expansion.network?.enabled) return [];
  const entries = expansion.filesystem?.entries ?? [];
  if (entries.length === 0) return [];
  if (entries.some((entry) => entry.access !== 'read')) return [];

  const suggested = new Set<string>();
  for (const entry of entries) {
    const path = entry.scope === 'subtree' ? entry.path : parentDirectory(entry.path);
    if (path === undefined || !isNormalizedAbsolutePath(path)) return [];
    if (path === '/' || /^[A-Za-z]:\\$/.test(path)) return [];
    suggested.add(path);
  }
  return [...suggested].sort();
}
