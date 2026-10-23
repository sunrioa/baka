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

import { useEffect, useState } from 'react';
import { Button, HStack, IconButton, TextInput } from '@astryxdesign/core';
import { Dialog, DialogHeader } from '@astryxdesign/core/Dialog';
import { Layout, LayoutContent, LayoutFooter } from '@astryxdesign/core/Layout';
import { Settings } from '@maka/ui/icons';
import { useUiLocale } from '@maka/ui';
import { useWorkHubServices } from '../services.js';

const copy = {
  en: { title: 'Coordinator context', threshold: 'Compaction target (tokens)',
    hint: 'Coordinator only. Leave empty to inherit the model setting; an unconfigured model has no proactive target. Tasks keep their own context and permissions.',
    inherit: 'Inherit model setting', save: 'Save', compact: 'Compact now',
    window: 'Model window', unknown: 'Not configured', failed: 'Could not update context settings' },
  'zh-CN': { title: '主协调上下文', threshold: '压缩目标（token）',
    hint: '仅作用于主协调会话。留空继承模型配置；模型也未配置时，不主动触发压缩。任务的上下文与权限不变。',
    inherit: '继承模型配置', save: '保存', compact: '立即压缩',
    window: '模型窗口', unknown: '未配置', failed: '无法更新上下文设置' },
  'zh-TW': { title: '主協調上下文', threshold: '壓縮目標（token）',
    hint: '僅作用於主協調會話。留空繼承模型設定；模型也未設定時，不主動觸發壓縮。任務的上下文與權限不變。',
    inherit: '繼承模型設定', save: '儲存', compact: '立即壓縮',
    window: '模型視窗', unknown: '未設定', failed: '無法更新上下文設定' },
};

export function WorkHubContextSettingsButton(props: { onOpen(): void }) {
  const t = copy[useUiLocale()];
  return <IconButton type="button" size="sm" variant="ghost" icon={<Settings size={14} />}
    label={t.title} onClick={props.onOpen} />;
}

/** Mount beside the Composer, not in its footer: its click-to-focus owns Selection. */
export function WorkHubContextSettings(props: {
  sessionId: string;
  open: boolean;
  onOpenChange(open: boolean): void;
  busy: boolean;
  modelWindow?: number;
  modelThreshold?: number;
  onCompact(): Promise<boolean>;
}) {
  const services = useWorkHubServices();
  const t = copy[useUiLocale()];
  const { open, onOpenChange: setOpen } = props;
  const [value, setValue] = useState('');
  const [ready, setReady] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  useEffect(() => {
    if (!open) return;
    let disposed = false;
    setReady(false); setError(undefined);
    void services.getCompactionThreshold(props.sessionId).then(threshold => {
      if (!disposed) { setValue(threshold?.toString() ?? ''); setReady(true); }
    }).catch(reason => { if (!disposed) setError(reason instanceof Error ? reason.message : t.failed); });
    return () => { disposed = true; };
  }, [services, props.sessionId, open, t.failed]);
  const trimmed = value.trim();
  const valid = !trimmed || (/^\d+$/.test(trimmed) && Number.isSafeInteger(Number(trimmed)) && Number(trimmed) > 0);
  return open ? <Dialog isOpen purpose="form" width={460} onOpenChange={setOpen}>
      <Layout header={<DialogHeader title={t.title} onOpenChange={setOpen} />}
        content={<LayoutContent>
          <p>{t.window}: {props.modelWindow?.toLocaleString() ?? t.unknown}</p>
          <TextInput label={t.threshold} description={t.hint} value={value}
            placeholder={`${t.inherit}${props.modelThreshold ? ` (${props.modelThreshold.toLocaleString()})` : ''}`}
            onChange={setValue} isDisabled={!ready || saving} width="100%" />
          {error && <p role="alert">{error}</p>}
        </LayoutContent>}
        footer={<LayoutFooter><HStack gap={2} hAlign="end">
          <Button label={t.compact} variant="secondary" isDisabled={props.busy || saving}
            onClick={async () => { if (await props.onCompact()) setOpen(false); }} />
          <Button label={t.save} variant="primary" isDisabled={!ready || !valid || saving}
            onClick={async () => {
              setSaving(true); setError(undefined);
              try { await services.setCompactionThreshold(props.sessionId, trimmed ? Number(trimmed) : null); setOpen(false); }
              catch (reason) { setError(reason instanceof Error ? reason.message : t.failed); }
              finally { setSaving(false); }
            }} />
        </HStack></LayoutFooter>} />
    </Dialog> : null;
}
