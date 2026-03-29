/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs';

type ToolClassification = 'action' | 'loading' | 'observe';

const ALLOWED_PARAM_KEYS = new Set([
  'uid',
  'value',
  'text',
  'url',
  'key',
  'type',
  'scrollY',
  'function',
]);

function classifyTool(toolName: string): ToolClassification {
  switch (toolName) {
    case 'click':
    case 'fill':
    case 'type_text':
    case 'press_key':
    case 'drag':
    case 'fill_form':
    case 'hover':
    case 'click_at':
      return 'action';
    case 'wait_for':
    case 'navigate_page':
    case 'new_page':
      return 'loading';
    default:
      return 'observe';
  }
}

function filterParams(
  params: Record<string, unknown>,
): Record<string, unknown> {
  const filtered: Record<string, unknown> = {};
  for (const key of Object.keys(params)) {
    if (ALLOWED_PARAM_KEYS.has(key)) {
      filtered[key] = params[key];
    }
  }
  return filtered;
}

export class TimelineLogger {
  private filePath: string;
  private recordingStartMs: number = 0;
  private entryId: number = 0;
  private stream: fs.WriteStream | null = null;

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  start(): void {
    this.stream = fs.createWriteStream(this.filePath, {flags: 'w'});
    this.recordingStartMs = Date.now();
    this.entryId = 0;
  }

  logToolStart(
    toolName: string,
    params: Record<string, unknown>,
  ): number {
    const id = ++this.entryId;
    const offsetMs = Date.now() - this.recordingStartMs;
    const entry = {
      id,
      tool: toolName,
      params: filterParams(params),
      offsetMs,
      classification: classifyTool(toolName),
      type: 'start' as const,
    };
    this.stream?.write(JSON.stringify(entry) + '\n');
    return id;
  }

  logToolEnd(id: number, durationMs: number, context?: Record<string, unknown>): void {
    const offsetMs = Date.now() - this.recordingStartMs;
    const entry: Record<string, unknown> = {
      id,
      offsetMs,
      durationMs,
      type: 'end' as const,
    };
    // Merge optional context (element label, selector, result info)
    if (context) {
      Object.assign(entry, context);
    }
    this.stream?.write(JSON.stringify(entry) + '\n');
  }

  logSegmentEvent(event: 'pause' | 'resume', segmentIndex: number): void {
    const offsetMs = Date.now() - this.recordingStartMs;
    const entry = {
      offsetMs,
      type: `segment_${event}` as const,
      segmentIndex,
    };
    this.stream?.write(JSON.stringify(entry) + '\n');
  }

  logMarker(name: string, metadata?: Record<string, unknown>): void {
    const offsetMs = Date.now() - this.recordingStartMs;
    const entry: Record<string, unknown> = {
      offsetMs,
      type: 'marker' as const,
      name,
    };
    if (metadata) {
      Object.assign(entry, metadata);
    }
    this.stream?.write(JSON.stringify(entry) + '\n');
  }

  getElapsedMs(): number {
    return Date.now() - this.recordingStartMs;
  }

  close(): void {
    if (this.stream) {
      this.stream.end();
      this.stream = null;
    }
  }
}
