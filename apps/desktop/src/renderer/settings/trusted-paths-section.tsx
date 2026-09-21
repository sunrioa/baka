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

import { useState } from 'react';
import { Button, HStack, List, ListItem, Text, VStack } from '@astryxdesign/core';
import { TextInput, useMountedRef, useToast, useUiLocale } from '@maka/ui';
import { isNormalizedAbsolutePath, trimTrailingPathSeparators } from '@maka/core/absolute-path';
import { MAX_TRUSTED_PATHS } from '@maka/core/trusted-paths';
import type { AppSettings, UpdateAppSettingsResult } from '@maka/core/settings';

import { SettingsSection, SettingsField, SettingsRow } from './settings-section';
import { getPermissionCenterCopy } from '../locales/permission-center-copy';
import { settingsActionErrorMessage } from './settings-error-copy';
import { useActionGuard } from './use-action-guard';

type TrustedPathsCopy = ReturnType<typeof getPermissionCenterCopy>['trustedPaths'];
type UpdateSettings = (
  patch: Parameters<typeof window.maka.settings.update>[0],
) => Promise<UpdateAppSettingsResult>;

/**
 * Edits the directories that new sessions may read without prompting.
 *
 * Deliberately a plain list of absolute paths rather than a directory picker:
 * the value is compiled straight into a sandbox profile, where a path that is
 * not already normalized silently never matches. Showing the exact string the
 * boundary will carry is what makes a wrong entry visible.
 */
export function TrustedPathsSection(props: {
  settings: AppSettings;
  onUpdate: UpdateSettings;
}) {
  const locale = useUiLocale();
  const copy = getPermissionCenterCopy(locale).trustedPaths;
  const trustedPaths = props.settings.permissions.trustedPaths;

  return (
    <SettingsSection title={copy.section} description={copy.sectionHelp}>
      <PathListField
        copy={copy}
        locale={locale}
        label={copy.readLabel}
        description={copy.readHelp}
        emptyLabel={copy.empty}
        paths={trustedPaths.readPaths}
        onCommit={(readPaths) => props.onUpdate({ permissions: { trustedPaths: { readPaths } } })}
      />
      <PathListField
        copy={copy}
        locale={locale}
        label={copy.denyLabel}
        description={`${copy.denyHelp} ${copy.denyPlatformNote}`}
        emptyLabel={copy.denyEmpty}
        paths={trustedPaths.denyPaths}
        onCommit={(denyPaths) => props.onUpdate({ permissions: { trustedPaths: { denyPaths } } })}
      />
      <SettingsRow label={copy.appliesToNewSessions} />
    </SettingsSection>
  );
}

function PathListField(props: {
  copy: TrustedPathsCopy;
  locale: ReturnType<typeof useUiLocale>;
  label: string;
  description: string;
  emptyLabel: string;
  paths: readonly string[];
  onCommit(paths: string[]): Promise<UpdateAppSettingsResult>;
}) {
  const { copy } = props;
  const toast = useToast();
  const mountedRef = useMountedRef();
  const guard = useActionGuard<string>();
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // Mirrors the settings normalizer: trim, drop trailing separators, then
  // require the result to already be a normalized absolute path. Repairing it
  // here would store a path the user never saw.
  const candidate = trimTrailingPathSeparators(draft.trim());
  const full = props.paths.length >= MAX_TRUSTED_PATHS;
  const canAdd =
    candidate.length > 0 && !saving && !full && isNormalizedAbsolutePath(candidate);

  async function commit(paths: string[], actionKey: string): Promise<boolean> {
    if (!guard.begin(actionKey)) return false;
    setSaving(true);
    try {
      await props.onCommit(paths);
      return true;
    } catch (caught) {
      if (mountedRef.current) {
        toast.error(copy.saveFailed, settingsActionErrorMessage(caught, props.locale));
      }
      return false;
    } finally {
      guard.finish();
      if (mountedRef.current) setSaving(false);
    }
  }

  async function add(): Promise<void> {
    if (full) {
      setError(copy.listFull(MAX_TRUSTED_PATHS));
      return;
    }
    if (!isNormalizedAbsolutePath(candidate)) {
      setError(copy.invalidPath);
      return;
    }
    if (props.paths.includes(candidate)) {
      setError(copy.duplicatePath);
      return;
    }
    setError(null);
    if (await commit([...props.paths, candidate], `add:${candidate}`)) {
      if (mountedRef.current) setDraft('');
    }
  }

  async function remove(path: string): Promise<void> {
    await commit(
      props.paths.filter((entry) => entry !== path),
      `remove:${path}`,
    );
  }

  return (
    <SettingsField>
      <VStack>
        <Text>{props.label}</Text>
        <Text>{props.description}</Text>
        {props.paths.length > 0 ? (
          <Text type="supporting" size="sm" color="secondary">
            {copy.count(props.paths.length, MAX_TRUSTED_PATHS)}
          </Text>
        ) : null}
        {props.paths.length === 0 ? (
          <Text>{props.emptyLabel}</Text>
        ) : (
          <List aria-label={copy.listAria}>
            {props.paths.map((path) => (
              <ListItem
                key={path}
                label={<Text type="label" size="sm">{path}</Text>}
                endContent={
                  <Button
                    variant="secondary"
                    isDisabled={saving}
                    onClick={() => void remove(path)}
                    label={copy.remove}
                    aria-label={copy.removeAria(path)}
                  />
                }
              />
            ))}
          </List>
        )}
        <HStack>
          <TextInput
            value={draft}
            onChange={(value: string) => {
              setDraft(value);
              if (error) setError(null);
            }}
            label={props.label}
            isLabelHidden
            placeholder={copy.addPlaceholder}
            isDisabled={saving}
          />
          <Button
            variant="primary"
            isDisabled={!canAdd}
            onClick={() => void add()}
            label={copy.add}
          />
        </HStack>
        {error ? <Text>{error}</Text> : null}
      </VStack>
    </SettingsField>
  );
}
