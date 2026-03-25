/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Screencast Segment Manager
 *
 * Auto-pauses recording after idle periods and resumes before the next
 * user action. Each active period becomes its own video segment file.
 * The pipeline stitches segments together, cutting dead wait time.
 *
 * Lifecycle:
 *   screencast_start → segment 001 begins
 *   [actions happen, keepalive runs]
 *   [30s idle] → segment 001 ends (auto-pause)
 *   [next action tool called] → segment 002 begins (auto-resume)
 *   [actions happen]
 *   screencast_stop → segment 002 ends, all finalized
 */

import path from 'node:path';
import type {ScreenRecorder} from '../third_party/index.js';
import {logger} from '../logger.js';

import type {ContextPage} from './ToolDefinition.js';

const IDLE_TIMEOUT_MS = 15_000; // Pause after 15s of no actions
const RESUME_LEAD_MS = 500; // Wait 500ms after resume before action

// Tools that count as "user action" and should keep recording alive
const ACTION_TOOLS = new Set([
  'click', 'fill', 'type_text', 'press_key', 'drag',
  'fill_form', 'hover', 'click_at', 'upload_file',
]);

// Tools that should trigger a resume if paused
const RESUME_TOOLS = new Set([
  ...ACTION_TOOLS,
  'wait_for', // wait_for resolving means something interesting happened
]);

export interface SegmentInfo {
  index: number;
  filePath: string;
  startedAt: number; // Date.now()
}

export class ScreencastSegmentManager {
  private basePath: string; // e.g. /path/to/recording (no extension)
  private page: ContextPage | null = null;
  private currentRecorder: ScreenRecorder | null = null;
  private segmentIndex = 0;
  private segments: SegmentInfo[] = [];
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private isPaused = false;
  private isActive = false; // true between screencast_start and screencast_stop
  private keepaliveInterval: ReturnType<typeof setInterval> | null = null;

  constructor(basePath: string) {
    // Strip extension to use as base for segment files
    this.basePath = basePath.replace(/\.(mp4|webm)$/i, '');
  }

  /** Start the segment manager. Call after screencast_start. */
  async start(page: ContextPage, firstRecorder: ScreenRecorder): Promise<void> {
    this.page = page;
    this.isActive = true;
    this.isPaused = false;
    this.segmentIndex = 1;

    // The first segment is already recording (started by screencast_start)
    const segPath = this.segmentPath(1);
    this.currentRecorder = firstRecorder;
    this.segments.push({
      index: 1,
      filePath: segPath,
      startedAt: Date.now(),
    });

    this.startKeepalive();
    this.resetIdleTimer();

    logger(`SegmentManager: started, segment 001`);
  }

  /** Called before each tool execution. Resumes recording if paused. */
  async beforeTool(toolName: string): Promise<void> {
    if (!this.isActive) return;

    if (this.isPaused && RESUME_TOOLS.has(toolName)) {
      await this.resumeRecording();
      // Small delay so the recorder captures the state before the action
      await new Promise(resolve => setTimeout(resolve, RESUME_LEAD_MS));
    }

    if (ACTION_TOOLS.has(toolName)) {
      this.resetIdleTimer();
    }
  }

  /** Called after each tool execution. Resumes if wait_for just completed, resets idle timer. */
  async afterTool(toolName: string): Promise<void> {
    if (!this.isActive) return;

    // wait_for completing means something interesting appeared — resume recording
    if (this.isPaused && (toolName === 'wait_for' || RESUME_TOOLS.has(toolName))) {
      await this.resumeRecording();
      // Give the recorder a moment to capture the new state
      await new Promise(resolve => setTimeout(resolve, RESUME_LEAD_MS));
    }

    if (ACTION_TOOLS.has(toolName) || toolName === 'wait_for') {
      this.resetIdleTimer();
    }
  }

  /** Stop everything. Call on screencast_stop. Returns list of segment files. */
  async stop(): Promise<string[]> {
    this.isActive = false;
    this.clearIdleTimer();
    this.stopKeepalive();

    if (this.currentRecorder && !this.isPaused) {
      try {
        await this.currentRecorder.stop();
      } catch (err) {
        logger(`SegmentManager: error stopping final segment: ${err}`);
      }
      this.currentRecorder = null;
    }

    logger(`SegmentManager: stopped, ${this.segments.length} segment(s)`);
    return this.segments.map(s => s.filePath);
  }

  /** Get all segment file paths recorded so far. */
  getSegmentPaths(): string[] {
    return this.segments.map(s => s.filePath);
  }

  /** Check if currently recording (not paused). */
  isRecording(): boolean {
    return this.isActive && !this.isPaused;
  }

  /** Get the current segment index. */
  getSegmentCount(): number {
    return this.segments.length;
  }

  // ── Internal ──────────────────────────────────────────────────────

  private segmentPath(index: number): string {
    const padded = String(index).padStart(3, '0');
    return `${this.basePath}-seg${padded}.webm`;
  }

  private resetIdleTimer(): void {
    this.clearIdleTimer();
    this.idleTimer = setTimeout(() => {
      void this.pauseRecording();
    }, IDLE_TIMEOUT_MS);
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  private async pauseRecording(): Promise<void> {
    if (this.isPaused || !this.currentRecorder) return;

    logger(`SegmentManager: pausing (idle timeout), segment ${this.segmentIndex} done`);
    this.stopKeepalive();

    try {
      await this.currentRecorder.stop();
    } catch (err) {
      logger(`SegmentManager: error pausing: ${err}`);
    }
    this.currentRecorder = null;
    this.isPaused = true;
  }

  private async resumeRecording(): Promise<void> {
    if (!this.isPaused || !this.page) return;

    this.segmentIndex++;
    const segPath = this.segmentPath(this.segmentIndex);

    logger(`SegmentManager: resuming, segment ${this.segmentIndex} → ${segPath}`);

    try {
      const recorder = await this.page.pptrPage.screencast({
        path: segPath as `${string}.webm`,
        format: 'webm' as const,
      });
      this.currentRecorder = recorder;
      this.segments.push({
        index: this.segmentIndex,
        filePath: segPath,
        startedAt: Date.now(),
      });
      this.isPaused = false;
      this.startKeepalive();
      this.resetIdleTimer();
    } catch (err) {
      logger(`SegmentManager: failed to resume: ${err}`);
    }
  }

  private startKeepalive(): void {
    this.stopKeepalive();
    this.keepaliveInterval = setInterval(async () => {
      if (!this.page || this.isPaused) return;
      try {
        await this.page.pptrPage.evaluate(() => {
          let el = document.getElementById('__screencast-keepalive');
          if (!el) {
            el = document.createElement('div');
            el.id = '__screencast-keepalive';
            el.style.cssText =
              'position:fixed;bottom:0;right:0;width:1px;height:1px;opacity:0.01;pointer-events:none;z-index:-1;';
            document.body.appendChild(el);
          }
          el.style.opacity = el.style.opacity === '0.01' ? '0.02' : '0.01';
        });
      } catch {
        // Page navigated — ignore
      }
    }, 2000);
  }

  private stopKeepalive(): void {
    if (this.keepaliveInterval) {
      clearInterval(this.keepaliveInterval);
      this.keepaliveInterval = null;
    }
  }
}
