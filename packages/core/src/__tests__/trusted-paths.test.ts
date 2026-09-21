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
import { describe, it } from 'node:test';

import {
  compileTrustedPaths,
  consolidateTrustedPaths,
  MAX_TRUSTED_PATHS,
  parentDirectory,
  platformSupportsDenyEntries,
  suggestTrustedReadPaths,
} from '../trusted-paths.js';
import { normalizeSettings } from '../settings.js';
import {
  assessSandboxBoundaryExpansion,
  createGenesisExecutionBoundary,
} from '../sandbox-boundary.js';
import { canReadPath, canWritePath } from '../permission-profile.js';

const MATCH_CONTEXT = {
  root: '/repo',
  workspaceRoots: ['/repo'],
  tmpdir: '/tmp',
  slashTmp: '/tmp',
};

function managedProfile(readPaths: string[], denyPaths: string[] = [], denySupported = true) {
  const { entries } = compileTrustedPaths({ readPaths, denyPaths, denySupported });
  const boundary = createGenesisExecutionBoundary('ask', { trustedEntries: entries });
  assert.equal(boundary.kind, 'managed');
  if (boundary.kind !== 'managed') throw new Error('unreachable');
  return boundary.profile;
}

describe('compileTrustedPaths', () => {
  it('emits a read subtree entry per configured path', () => {
    const { entries, refusedReadPaths } = compileTrustedPaths({
      readPaths: ['/Users/me/Documents'],
      denyPaths: [],
      denySupported: true,
    });

    assert.deepEqual(entries, [
      { kind: 'path', access: 'read', path: '/Users/me/Documents', match: 'subtree' },
    ]);
    assert.deepEqual(refusedReadPaths, []);
  });

  it('emits deny entries ahead of read entries when the backend supports them', () => {
    const { entries, refusedReadPaths } = compileTrustedPaths({
      readPaths: ['/Users/me/Documents'],
      denyPaths: ['/Users/me/Documents/secrets'],
      denySupported: true,
    });

    assert.deepEqual(entries, [
      { kind: 'path', access: 'deny', path: '/Users/me/Documents/secrets', match: 'subtree' },
      { kind: 'path', access: 'read', path: '/Users/me/Documents', match: 'subtree' },
    ]);
    assert.deepEqual(refusedReadPaths, []);
  });

  it('refuses a read root whose carve-out the backend cannot express', () => {
    const { entries, refusedReadPaths } = compileTrustedPaths({
      readPaths: ['/Users/me/Documents', '/Users/me/Notes'],
      denyPaths: ['/Users/me/Documents/secrets'],
      denySupported: false,
    });

    // The unaffected root still lands; only the one needing a hole is dropped.
    assert.deepEqual(entries, [
      { kind: 'path', access: 'read', path: '/Users/me/Notes', match: 'subtree' },
    ]);
    assert.deepEqual(refusedReadPaths, ['/Users/me/Documents']);
  });

  it('drops a read root nested inside a deny root', () => {
    const { entries, refusedReadPaths } = compileTrustedPaths({
      readPaths: ['/Users/me/Documents/secrets/notes'],
      denyPaths: ['/Users/me/Documents/secrets'],
      denySupported: true,
    });

    assert.deepEqual(
      entries.filter((entry) => entry.access === 'read'),
      [],
    );
    assert.deepEqual(refusedReadPaths, ['/Users/me/Documents/secrets/notes']);
  });

  it('ignores paths that are not normalized absolute paths', () => {
    const { entries } = compileTrustedPaths({
      readPaths: ['relative/path', '/Users/me/../me/Docs', '/Users/me/Docs/', '/ok'],
      denyPaths: [],
      denySupported: true,
    });

    assert.deepEqual(entries, [{ kind: 'path', access: 'read', path: '/ok', match: 'subtree' }]);
  });

  it('reports deny support only on macOS', () => {
    assert.equal(platformSupportsDenyEntries('darwin'), true);
    assert.equal(platformSupportsDenyEntries('linux'), false);
    assert.equal(platformSupportsDenyEntries('win32'), false);
  });
});

describe('createGenesisExecutionBoundary with trusted entries', () => {
  it('is byte-identical to the stock boundary when no entries are supplied', () => {
    assert.deepEqual(
      createGenesisExecutionBoundary('ask', { trustedEntries: [] }),
      createGenesisExecutionBoundary('ask'),
    );
  });

  it('leaves bypass alone', () => {
    const boundary = createGenesisExecutionBoundary('bypass', {
      trustedEntries: [{ kind: 'path', access: 'read', path: '/x', match: 'subtree' }],
    });
    assert.deepEqual(boundary, { kind: 'bypass', revision: 0 });
  });

  it('renames the profile so it is not mistaken for the canonical policy', () => {
    assert.equal(managedProfile(['/Users/me/Documents']).name, 'custom');
    assert.equal(createGenesisExecutionBoundary('ask').kind, 'managed');
  });

  it('keeps the stock entries alongside the trusted ones', () => {
    const profile = managedProfile(['/Users/me/Documents']);
    assert.ok(
      profile.fileSystem.entries.some(
        (entry) => entry.kind === 'special' && entry.special === ':workspace_roots',
      ),
      'workspace roots must survive',
    );
  });
});

describe('trusted read paths and the approval prompt', () => {
  it('grants read but never write on a trusted path', () => {
    const profile = managedProfile(['/Users/me/Documents']);

    assert.equal(canReadPath(profile, '/Users/me/Documents/a.md', MATCH_CONTEXT), true);
    assert.equal(canWritePath(profile, '/Users/me/Documents/a.md', MATCH_CONTEXT), false);
  });

  it('answers noop for a read inside a trusted path, which is what skips the prompt', () => {
    const profile = managedProfile(['/Users/me/Documents']);

    const assessment = assessSandboxBoundaryExpansion(
      profile,
      {
        filesystem: {
          entries: [{ path: '/Users/me/Documents/a.md', access: 'read', scope: 'exact' }],
        },
      },
      MATCH_CONTEXT,
    );

    assert.equal(assessment.outcome, 'noop');
  });

  it('still prompts for a read outside every trusted path', () => {
    const profile = managedProfile(['/Users/me/Documents']);

    const assessment = assessSandboxBoundaryExpansion(
      profile,
      { filesystem: { entries: [{ path: '/etc/hosts', access: 'read', scope: 'exact' }] } },
      MATCH_CONTEXT,
    );

    assert.equal(assessment.outcome, 'apply');
  });

  it('still prompts for a write inside a trusted path', () => {
    const profile = managedProfile(['/Users/me/Documents']);

    const assessment = assessSandboxBoundaryExpansion(
      profile,
      {
        filesystem: {
          entries: [{ path: '/Users/me/Documents/a.md', access: 'write', scope: 'exact' }],
        },
      },
      MATCH_CONTEXT,
    );

    assert.notEqual(assessment.outcome, 'noop');
  });

  it('reports a conflict for a read under a deny path instead of prompting', () => {
    const profile = managedProfile(['/Users/me/Documents'], ['/Users/me/Documents/secrets']);

    const assessment = assessSandboxBoundaryExpansion(
      profile,
      {
        filesystem: {
          entries: [
            { path: '/Users/me/Documents/secrets/key.pem', access: 'read', scope: 'exact' },
          ],
        },
      },
      MATCH_CONTEXT,
    );

    assert.equal(assessment.outcome, 'conflict');
  });

  it('keeps reading a denied path impossible', () => {
    const profile = managedProfile(['/Users/me/Documents'], ['/Users/me/Documents/secrets']);

    assert.equal(canReadPath(profile, '/Users/me/Documents/secrets/key.pem', MATCH_CONTEXT), false);
    assert.equal(canReadPath(profile, '/Users/me/Documents/ok.md', MATCH_CONTEXT), true);
  });
});

describe('parentDirectory', () => {
  it('returns the containing directory', () => {
    assert.equal(parentDirectory('/Users/me/Documents/a.md'), '/Users/me/Documents');
    assert.equal(parentDirectory('/Users'), '/');
    assert.equal(parentDirectory('C:\\Users\\me\\a.md'), 'C:\\Users\\me');
    assert.equal(parentDirectory('C:\\Users'), 'C:\\');
  });

  it('returns undefined at a filesystem root', () => {
    assert.equal(parentDirectory('/'), undefined);
    assert.equal(parentDirectory('C:\\'), undefined);
  });

  it('refuses a path that is not normalized', () => {
    assert.equal(parentDirectory('relative/a.md'), undefined);
    assert.equal(parentDirectory('/Users/me/../me/a.md'), undefined);
  });
});

describe('suggestTrustedReadPaths', () => {
  it('suggests the parent directory of an exact read', () => {
    assert.deepEqual(
      suggestTrustedReadPaths({
        filesystem: { entries: [{ path: '/Users/me/Docs/a.md', access: 'read', scope: 'exact' }] },
      }),
      ['/Users/me/Docs'],
    );
  });

  it('suggests a subtree read as-is', () => {
    assert.deepEqual(
      suggestTrustedReadPaths({
        filesystem: { entries: [{ path: '/Users/me/Docs', access: 'read', scope: 'subtree' }] },
      }),
      ['/Users/me/Docs'],
    );
  });

  it('offers nothing when any entry is a write', () => {
    assert.deepEqual(
      suggestTrustedReadPaths({
        filesystem: {
          entries: [
            { path: '/Users/me/Docs/a.md', access: 'read', scope: 'exact' },
            { path: '/Users/me/Docs/b.md', access: 'write', scope: 'exact' },
          ],
        },
      }),
      [],
    );
  });

  it('offers nothing when the request wants network', () => {
    assert.deepEqual(
      suggestTrustedReadPaths({
        filesystem: { entries: [{ path: '/Users/me/Docs/a.md', access: 'read', scope: 'exact' }] },
        network: { enabled: true },
      }),
      [],
    );
  });

  it('refuses to suggest a filesystem root', () => {
    assert.deepEqual(
      suggestTrustedReadPaths({
        filesystem: { entries: [{ path: '/etc', access: 'read', scope: 'exact' }] },
      }),
      [],
    );
    assert.deepEqual(
      suggestTrustedReadPaths({
        filesystem: { entries: [{ path: '/', access: 'read', scope: 'subtree' }] },
      }),
      [],
    );
  });

  it('de-duplicates sibling files into one directory', () => {
    assert.deepEqual(
      suggestTrustedReadPaths({
        filesystem: {
          entries: [
            { path: '/Users/me/Docs/a.md', access: 'read', scope: 'exact' },
            { path: '/Users/me/Docs/b.md', access: 'read', scope: 'exact' },
          ],
        },
      }),
      ['/Users/me/Docs'],
    );
  });
});

describe('consolidateTrustedPaths', () => {
  it('drops a path another entry already covers', () => {
    assert.deepEqual(
      consolidateTrustedPaths(['/Users/me/proj', '/Users/me/proj/src', '/Users/me/proj/src/a']),
      ['/Users/me/proj'],
    );
  });

  it('adding a broader root collapses the children it subsumes', () => {
    const before = ['/Users/me/proj/src/a', '/Users/me/proj/src/b', '/Users/me/other'];
    assert.deepEqual(consolidateTrustedPaths(before), [
      '/Users/me/other',
      '/Users/me/proj/src/a',
      '/Users/me/proj/src/b',
    ]);
    assert.deepEqual(consolidateTrustedPaths([...before, '/Users/me/proj']), [
      '/Users/me/other',
      '/Users/me/proj',
    ]);
  });

  it('leaves siblings alone rather than inventing their parent', () => {
    // Merging these would grant /Users/me, which nobody approved.
    assert.deepEqual(consolidateTrustedPaths(['/Users/me/a', '/Users/me/b']), [
      '/Users/me/a',
      '/Users/me/b',
    ]);
  });

  it('is not fooled by a shared name prefix', () => {
    assert.deepEqual(consolidateTrustedPaths(['/Users/me/doc', '/Users/me/documents']), [
      '/Users/me/doc',
      '/Users/me/documents',
    ]);
  });

  it('drops entries that are not normalized absolute paths', () => {
    assert.deepEqual(consolidateTrustedPaths(['relative', '/a/../a', '/ok/', '/ok']), ['/ok']);
  });

  it('is idempotent and order-independent', () => {
    const once = consolidateTrustedPaths(['/b/x', '/a', '/a/y', '/b']);
    assert.deepEqual(once, consolidateTrustedPaths([...once].reverse()));
    assert.deepEqual(once, ['/a', '/b']);
  });
});

describe('trusted path list limits', () => {
  it('normalizeSettings consolidates and caps the stored lists', () => {
    const many = Array.from({ length: MAX_TRUSTED_PATHS + 20 }, (_, index) => `/root/p${index}`);
    const settings = normalizeSettings({
      permissions: { trustedPaths: { readPaths: [...many, '/root/p1/nested'], denyPaths: [] } },
    });
    const readPaths = settings.permissions.trustedPaths.readPaths;
    assert.equal(readPaths.length, MAX_TRUSTED_PATHS);
    assert.ok(!readPaths.includes('/root/p1/nested'), 'a covered path must not survive');
  });

  it('a single broad root collapses a full list back to one entry', () => {
    const many = Array.from({ length: 40 }, (_, index) => `/root/p${index}`);
    const settings = normalizeSettings({
      permissions: { trustedPaths: { readPaths: [...many, '/root'], denyPaths: [] } },
    });
    assert.deepEqual(settings.permissions.trustedPaths.readPaths, ['/root']);
  });
});
