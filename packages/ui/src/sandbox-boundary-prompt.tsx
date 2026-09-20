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

import type { SandboxBoundaryRequestEvent } from '@maka/core/events';
import { useEffect, useId, useRef, useState } from 'react';

import { suggestTrustedReadPaths } from '@maka/core/trusted-paths';

import { getConversationCopy } from './conversation-copy.js';
import { useUiLocale } from './locale-context.js';
import { Button } from '@astryxdesign/core';
import { useMountedRef } from './use-mounted-ref.js';

export interface SandboxBoundaryPromptProps {
  request: SandboxBoundaryRequestEvent;
  onRespond(response: { requestId: string; decision: 'allow' | 'deny' }): void | Promise<void>;
  /**
   * Adds `paths` to the trusted read paths, then allows this request.
   *
   * Optional: a surface that cannot write settings simply does not show the
   * third button. The paths are computed here from the request, so what the
   * button remembers is always what the prompt is showing.
   */
  onAlwaysAllow?(paths: readonly string[]): void | Promise<void>;
}

export function SandboxBoundaryPrompt({
  request,
  onRespond,
  onAlwaysAllow,
}: SandboxBoundaryPromptProps) {
  const copy = getConversationCopy(useUiLocale()).sandboxBoundary;
  const titleId = useId();
  const hintId = useId();
  const [responsePending, setResponsePending] = useState(false);
  const responsePendingRef = useRef(false);
  const activeRequestIdRef = useRef(request.requestId);
  const rejectButtonRef = useRef<HTMLButtonElement>(null);
  const mountedRef = useMountedRef();

  useEffect(() => {
    activeRequestIdRef.current = request.requestId;
    responsePendingRef.current = false;
    setResponsePending(false);
    const frame = window.requestAnimationFrame(() => rejectButtonRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [request.requestId]);

  async function respond(decision: 'allow' | 'deny'): Promise<void> {
    if (responsePendingRef.current) return;
    const requestId = request.requestId;
    responsePendingRef.current = true;
    setResponsePending(true);
    try {
      await onRespond({ requestId, decision });
    } finally {
      if (activeRequestIdRef.current === requestId) {
        responsePendingRef.current = false;
        if (mountedRef.current) setResponsePending(false);
      }
    }
  }

  // Remember first, then allow. If persisting the path fails the user still
  // gets told, and this turn falls back to the one-task grant they would have
  // had anyway — rather than the request being allowed while the setting the
  // button promised silently never landed.
  async function alwaysAllow(paths: readonly string[]): Promise<void> {
    if (responsePendingRef.current || !onAlwaysAllow) return;
    const requestId = request.requestId;
    responsePendingRef.current = true;
    setResponsePending(true);
    try {
      await onAlwaysAllow(paths);
      await onRespond({ requestId, decision: 'allow' });
    } finally {
      if (activeRequestIdRef.current === requestId) {
        responsePendingRef.current = false;
        if (mountedRef.current) setResponsePending(false);
      }
    }
  }

  const entries = request.expansion.filesystem?.entries ?? [];
  const suggestedPaths = onAlwaysAllow ? suggestTrustedReadPaths(request.expansion) : [];
  return (
    <section
      className="maka-composer-interaction maka-sandbox-boundary-prompt composer"
      aria-labelledby={titleId}
    >
      <div className="maka-composer-interaction-inner maka-sandbox-boundary-prompt-inner">
        <div className="maka-sandbox-boundary-copy">
          <h2 id={titleId}>{copy.title}</h2>
          <p>{request.justification}</p>
        </div>
        <ul className="maka-sandbox-boundary-scopes">
          {entries.map((entry) => (
            <li key={`${entry.access}:${entry.scope}:${entry.path}`}>
              <code>{entry.path}</code>
              <span>
                {copy.access[entry.access]} · {copy.scope[entry.scope]}
              </span>
            </li>
          ))}
          {request.expansion.network?.enabled ? (
            <li>
              <code>{copy.network}</code>
              <span>{copy.enabled}</span>
            </li>
          ) : null}
        </ul>
        {suggestedPaths.length > 0 ? (
          <p className="maka-sandbox-boundary-always-hint" id={hintId}>
            {copy.allowAlwaysHint(suggestedPaths.join(' · '))}
          </p>
        ) : null}
        <div className="maka-sandbox-boundary-actions">
          <Button
            ref={rejectButtonRef}
            variant="secondary"
            isDisabled={responsePending}
            onClick={() => void respond('deny')}
            label={copy.reject}
          />
          <Button
            variant="primary"
            isDisabled={responsePending}
            onClick={() => void respond('allow')}
            label={copy.allowSession}
          />
          {suggestedPaths.length > 0 ? (
            <Button
              variant="secondary"
              isDisabled={responsePending}
              onClick={() => void alwaysAllow(suggestedPaths)}
              label={copy.allowAlways}
              aria-describedby={hintId}
            />
          ) : null}
        </div>
      </div>
    </section>
  );
}
