/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {execFile} from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {promisify} from 'node:util';

import {zod} from '../third_party/index.js';
import type {ScreenRecorder} from '../third_party/index.js';

import {ToolCategory} from './categories.js';
import {definePageTool} from './ToolDefinition.js';
import {ScreencastSegmentManager} from './screencast-segments.js';

const execFileAsync = promisify(execFile);

async function generateTempFilePath(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'chrome-devtools-mcp-'));
  return path.join(dir, `screencast.mp4`);
}

export const startScreencast = definePageTool({
  name: 'screencast_start',
  description:
    'Starts recording a screencast (video) of the selected page in mp4 format.',
  annotations: {
    category: ToolCategory.DEBUGGING,
    readOnlyHint: false,

    conditions: ['screencast'],
  },
  schema: {
    path: zod
      .string()
      .optional()
      .describe(
        'Output path. Uses mkdtemp to generate a unique path if not provided.',
      ),
  },
  handler: async (request, response, context) => {
    if (context.getScreenRecorder() !== null) {
      response.appendResponseLine(
        'Error: a screencast recording is already in progress. Use screencast_stop to stop it before starting a new one.',
      );
      return;
    }

    const filePath = request.params.path ?? (await generateTempFilePath());
    const resolvedPath = path.resolve(filePath);

    // Record as webm segments (stable with ffmpeg pipe)
    const basePath = resolvedPath.replace(/\.mp4$/i, '');
    const firstSegPath = `${basePath}-seg001.webm`;

    const page = request.page;

    let recorder: ScreenRecorder;
    try {
      recorder = await page.pptrPage.screencast({
        path: firstSegPath as `${string}.webm`,
        format: 'webm' as const,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes('ENOENT') && message.includes('ffmpeg')) {
        throw new Error(
          'ffmpeg is required for screencast recording but was not found. ' +
            'Install ffmpeg (https://ffmpeg.org/) and ensure it is available in your PATH.',
        );
      }
      throw err;
    }

    // Create segment manager for auto-pause/resume
    const segmentManager = new ScreencastSegmentManager(resolvedPath);
    await segmentManager.start(page, recorder);

    context.setScreenRecorder({
      recorder,
      filePath: resolvedPath,
      segmentManager,
    } as any);

    response.appendResponseLine(
      `Screencast recording started. The recording will be saved to ${resolvedPath}. Use ${stopScreencast.name} to stop recording.`,
    );
  },
});

export const stopScreencast = definePageTool({
  name: 'screencast_stop',
  description: 'Stops the active screencast recording on the selected page.',
  annotations: {
    category: ToolCategory.DEBUGGING,
    readOnlyHint: false,
    conditions: ['screencast'],
  },
  schema: {},
  handler: async (_request, response, context) => {
    const data = context.getScreenRecorder() as any;
    if (!data) {
      return;
    }
    try {
      const segmentManager: ScreencastSegmentManager | undefined =
        data.segmentManager;
      const mp4Path: string = data.filePath;

      let outputPath: string;

      if (segmentManager) {
        const segmentPaths = await segmentManager.stop();

        if (segmentPaths.length === 0) {
          response.appendResponseLine('No segments were recorded.');
          return;
        }

        if (segmentPaths.length === 1) {
          // Single segment — convert directly to mp4
          outputPath = await convertToMp4(segmentPaths[0], mp4Path);
          await fs.unlink(segmentPaths[0]).catch(() => {});
        } else {
          // Multiple segments — concat then convert
          outputPath = await concatAndConvert(segmentPaths, mp4Path);
          // Clean up segment files
          for (const seg of segmentPaths) {
            await fs.unlink(seg).catch(() => {});
          }
        }
      } else {
        // Fallback: legacy single-recorder path
        await data.recorder.stop();
        const webmPath = mp4Path.replace(/\.mp4$/i, '-seg001.webm');
        outputPath = await convertToMp4(webmPath, mp4Path);
        await fs.unlink(webmPath).catch(() => {});
      }

      response.appendResponseLine(
        `The screencast recording has been stopped and saved to ${outputPath}.` +
          (segmentManager
            ? ` (${segmentManager.getSegmentCount()} segment(s))`
            : ''),
      );
    } finally {
      context.setScreenRecorder(null);
    }
  },
});

async function convertToMp4(
  webmPath: string,
  mp4Path: string,
): Promise<string> {
  if (!mp4Path.endsWith('.mp4')) return webmPath;

  try {
    await execFileAsync('ffmpeg', [
      '-i',
      webmPath,
      '-c:v',
      'libx264',
      '-preset',
      'fast',
      '-crf',
      '23',
      '-pix_fmt',
      'yuv420p',
      '-vf',
      'scale=trunc(iw/2)*2:trunc(ih/2)*2',
      '-an',
      '-y',
      mp4Path,
    ]);
    return mp4Path;
  } catch {
    return webmPath;
  }
}

async function concatAndConvert(
  segmentPaths: string[],
  mp4Path: string,
): Promise<string> {
  // Build ffmpeg concat demuxer file
  const concatDir = path.dirname(segmentPaths[0]);
  const concatFile = path.join(concatDir, 'concat-list.txt');
  const concatContent = segmentPaths
    .map(p => `file '${p}'`)
    .join('\n');
  await fs.writeFile(concatFile, concatContent, 'utf8');

  const concatWebm = path.join(concatDir, 'concat-output.webm');

  try {
    // Concat webm segments
    await execFileAsync('ffmpeg', [
      '-f',
      'concat',
      '-safe',
      '0',
      '-i',
      concatFile,
      '-c',
      'copy',
      '-y',
      concatWebm,
    ]);

    // Convert to mp4
    const result = await convertToMp4(concatWebm, mp4Path);

    // Cleanup
    await fs.unlink(concatFile).catch(() => {});
    await fs.unlink(concatWebm).catch(() => {});

    return result;
  } catch {
    // Fallback: return first segment
    return segmentPaths[0];
  }
}
