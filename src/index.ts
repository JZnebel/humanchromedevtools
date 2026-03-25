/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type fs from 'node:fs';
import path from 'node:path';

import type {parseArguments} from './bin/chrome-devtools-mcp-cli-options.js';
import type {Channel} from './browser.js';
import {ensureBrowserConnected, ensureBrowserLaunched} from './browser.js';
import {loadIssueDescriptions} from './issue-descriptions.js';
import {logger} from './logger.js';
import {McpContext} from './McpContext.js';
import {McpResponse} from './McpResponse.js';
import {Mutex} from './Mutex.js';
import {SlimMcpResponse} from './SlimMcpResponse.js';
import {ClearcutLogger} from './telemetry/ClearcutLogger.js';
import {bucketizeLatency} from './telemetry/metricUtils.js';
import {
  McpServer,
  type CallToolResult,
  SetLevelRequestSchema,
} from './third_party/index.js';
import {ToolCategory} from './tools/categories.js';
import type {DefinedPageTool, ToolDefinition} from './tools/ToolDefinition.js';
import {pageIdSchema} from './tools/ToolDefinition.js';
import type {ScreencastSegmentManager} from './tools/screencast-segments.js';
import {TimelineLogger} from './tools/timeline-logger.js';
import {createTools} from './tools/tools.js';
import {VERSION} from './version.js';

export async function createMcpServer(
  serverArgs: ReturnType<typeof parseArguments>,
  options: {
    logFile?: fs.WriteStream;
  },
) {
  let clearcutLogger: ClearcutLogger | undefined;
  if (serverArgs.usageStatistics) {
    clearcutLogger = new ClearcutLogger({
      logFile: serverArgs.logFile,
      appVersion: VERSION,
      clearcutEndpoint: serverArgs.clearcutEndpoint,
      clearcutForceFlushIntervalMs: serverArgs.clearcutForceFlushIntervalMs,
      clearcutIncludePidHeader: serverArgs.clearcutIncludePidHeader,
    });
  }

  const server = new McpServer(
    {
      name: 'chrome_devtools',
      title: 'Chrome DevTools MCP server',
      version: VERSION,
    },
    {capabilities: {logging: {}}},
  );
  server.server.setRequestHandler(SetLevelRequestSchema, () => {
    return {};
  });

  server.server.oninitialized = () => {
    const clientName = server.server.getClientVersion()?.name;
    if (clientName) {
      clearcutLogger?.setClientName(clientName);
    }
  };

  let context: McpContext;
  async function getContext(): Promise<McpContext> {
    const chromeArgs: string[] = (serverArgs.chromeArg ?? []).map(String);
    const ignoreDefaultChromeArgs: string[] = (
      serverArgs.ignoreDefaultChromeArg ?? []
    ).map(String);
    if (serverArgs.proxyServer) {
      chromeArgs.push(`--proxy-server=${serverArgs.proxyServer}`);
    }
    const devtools = serverArgs.experimentalDevtools ?? false;
    const browser =
      serverArgs.browserUrl || serverArgs.wsEndpoint || serverArgs.autoConnect
        ? await ensureBrowserConnected({
            browserURL: serverArgs.browserUrl,
            wsEndpoint: serverArgs.wsEndpoint,
            wsHeaders: serverArgs.wsHeaders,
            // Important: only pass channel, if autoConnect is true.
            channel: serverArgs.autoConnect
              ? (serverArgs.channel as Channel)
              : undefined,
            userDataDir: serverArgs.userDataDir,
            devtools,
          })
        : await ensureBrowserLaunched({
            headless: serverArgs.headless,
            executablePath: serverArgs.executablePath,
            channel: serverArgs.channel as Channel,
            isolated: serverArgs.isolated ?? false,
            userDataDir: serverArgs.userDataDir,
            logFile: options.logFile,
            viewport: serverArgs.viewport,
            chromeArgs,
            ignoreDefaultChromeArgs,
            acceptInsecureCerts: serverArgs.acceptInsecureCerts,
            devtools,
            enableExtensions: serverArgs.categoryExtensions,
            viaCli: serverArgs.viaCli,
          });

    if (context?.browser !== browser) {
      context = await McpContext.from(browser, logger, {
        experimentalDevToolsDebugging: devtools,
        experimentalIncludeAllPages: serverArgs.experimentalIncludeAllPages,
        performanceCrux: serverArgs.performanceCrux,
      });
    }
    return context;
  }

  const toolMutex = new Mutex();

  // Timeline logger for human-mode screencast recordings.
  // Activated when screencast_start is called in human mode,
  // deactivated on screencast_stop.
  let timelineLogger: TimelineLogger | null = null;
  const humanMode = serverArgs.humanMode === true;

  function registerTool(tool: ToolDefinition | DefinedPageTool): void {
    if (
      tool.annotations.category === ToolCategory.EMULATION &&
      serverArgs.categoryEmulation === false
    ) {
      return;
    }
    if (
      tool.annotations.category === ToolCategory.PERFORMANCE &&
      serverArgs.categoryPerformance === false
    ) {
      return;
    }
    if (
      tool.annotations.category === ToolCategory.NETWORK &&
      serverArgs.categoryNetwork === false
    ) {
      return;
    }
    if (
      tool.annotations.category === ToolCategory.EXTENSIONS &&
      !serverArgs.categoryExtensions
    ) {
      return;
    }
    if (
      tool.annotations.conditions?.includes('computerVision') &&
      !serverArgs.experimentalVision
    ) {
      return;
    }
    if (
      tool.annotations.conditions?.includes('experimentalInteropTools') &&
      !serverArgs.experimentalInteropTools
    ) {
      return;
    }
    if (
      tool.annotations.conditions?.includes('screencast') &&
      !serverArgs.experimentalScreencast
    ) {
      return;
    }
    const schema =
      'pageScoped' in tool &&
      tool.pageScoped &&
      serverArgs.experimentalPageIdRouting &&
      !serverArgs.slim
        ? {...tool.schema, ...pageIdSchema}
        : tool.schema;

    server.registerTool(
      tool.name,
      {
        description: tool.description,
        inputSchema: schema,
        annotations: tool.annotations,
      },
      async (params): Promise<CallToolResult> => {
        const guard = await toolMutex.acquire();
        const startTime = Date.now();
        let success = false;
        let timelineEntryId = 0;
        try {
          // Timeline: log tool start if recording
          if (timelineLogger) {
            timelineEntryId = timelineLogger.logToolStart(
              tool.name,
              params as Record<string, unknown>,
            );
          }

          // Segment manager: resume recording before action tools
          if (humanMode) {
            const recData = (await getContext().catch(() => null))
              ?.getScreenRecorder?.() as any;
            const segMgr: ScreencastSegmentManager | undefined =
              recData?.segmentManager;
            if (segMgr) {
              await segMgr.beforeTool(tool.name);
            }
          }

          logger(`${tool.name} request: ${JSON.stringify(params, null, '  ')}`);
          const context = await getContext();
          logger(`${tool.name} context: resolved`);
          await context.detectOpenDevToolsWindows();
          const response = serverArgs.slim
            ? new SlimMcpResponse(serverArgs)
            : new McpResponse(serverArgs);
          if ('pageScoped' in tool && tool.pageScoped) {
            const page =
              serverArgs.experimentalPageIdRouting &&
              params.pageId &&
              !serverArgs.slim
                ? context.getPageById(params.pageId)
                : context.getSelectedMcpPage();
            response.setPage(page);
            await tool.handler(
              {
                params,
                page,
              },
              response,
              context,
            );
          } else {
            await tool.handler(
              // @ts-expect-error types do not match.
              {
                params,
              },
              response,
              context,
            );
          }
          const {content, structuredContent} = await response.handle(
            tool.name,
            context,
          );
          const result: CallToolResult & {
            structuredContent?: Record<string, unknown>;
          } = {
            content,
          };
          success = true;
          if (serverArgs.experimentalStructuredContent) {
            result.structuredContent = structuredContent as Record<
              string,
              unknown
            >;
          }
          return result;
        } catch (err) {
          logger(`${tool.name} error:`, err, err?.stack);
          let errorText = err && 'message' in err ? err.message : String(err);
          if ('cause' in err && err.cause) {
            errorText += `\nCause: ${err.cause.message}`;
          }
          return {
            content: [
              {
                type: 'text',
                text: errorText,
              },
            ],
            isError: true,
          };
        } finally {
          const durationMs = Date.now() - startTime;

          // Timeline: log tool end
          if (timelineLogger && timelineEntryId) {
            timelineLogger.logToolEnd(timelineEntryId, durationMs);
          }

          // Segment manager: notify after tool
          if (humanMode) {
            const recData = (await getContext().catch(() => null))
              ?.getScreenRecorder?.() as any;
            const segMgr: ScreencastSegmentManager | undefined =
              recData?.segmentManager;
            if (segMgr) {
              await segMgr.afterTool(tool.name);
            }
          }

          // Timeline: activate on screencast_start, deactivate on screencast_stop
          if (humanMode && tool.name === 'screencast_start' && success) {
            const recorderData = (await getContext()).getScreenRecorder() as any;
            if (recorderData?.filePath) {
              const timelinePath = recorderData.filePath.replace(
                /\.(mp4|webm)$/i,
                '.jsonl',
              );
              timelineLogger = new TimelineLogger(timelinePath);
              timelineLogger.start();
              logger(`Timeline logger started: ${timelinePath}`);
            }
          }
          if (tool.name === 'screencast_stop' && timelineLogger) {
            timelineLogger.close();
            logger('Timeline logger closed');
            timelineLogger = null;
          }

          void clearcutLogger?.logToolInvocation({
            toolName: tool.name,
            success,
            latencyMs: bucketizeLatency(durationMs),
          });
          guard.dispose();
        }
      },
    );
  }

  const tools = createTools(serverArgs);
  for (const tool of tools) {
    registerTool(tool);
  }

  await loadIssueDescriptions();

  return {server, clearcutLogger};
}

export const logDisclaimers = (args: ReturnType<typeof parseArguments>) => {
  console.error(
    `chrome-devtools-mcp exposes content of the browser instance to the MCP clients allowing them to inspect,
debug, and modify any data in the browser or DevTools.
Avoid sharing sensitive or personal information that you do not want to share with MCP clients.`,
  );

  if (!args.slim && args.performanceCrux) {
    console.error(
      `Performance tools may send trace URLs to the Google CrUX API to fetch real-user experience data. To disable, run with --no-performance-crux.`,
    );
  }

  if (!args.slim && args.usageStatistics) {
    console.error(
      `
Google collects usage statistics to improve Chrome DevTools MCP. To opt-out, run with --no-usage-statistics.
For more details, visit: https://github.com/ChromeDevTools/chrome-devtools-mcp#usage-statistics`,
    );
  }
};
