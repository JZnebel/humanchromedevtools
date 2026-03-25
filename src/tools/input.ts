/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {logger} from '../logger.js';
import type {McpContext} from '../McpContext.js';
import {zod} from '../third_party/index.js';
import type {ElementHandle, KeyInput} from '../third_party/index.js';
import type {TextSnapshotNode} from '../types.js';
import {parseKey} from '../utils/keyboard.js';

import {ToolCategory} from './categories.js';
import type {ContextPage} from './ToolDefinition.js';
import {definePageTool} from './ToolDefinition.js';

const dblClickSchema = zod
  .boolean()
  .optional()
  .describe('Set to true for double clicks. Default is false.');

const includeSnapshotSchema = zod
  .boolean()
  .optional()
  .describe('Whether to include a snapshot in the response. Default is false.');

const submitKeySchema = zod
  .string()
  .optional()
  .describe(
    'Optional key to press after typing. E.g., "Enter", "Tab", "Escape"',
  );

function handleActionError(error: unknown, uid: string) {
  logger('failed to act using a locator', error);
  throw new Error(
    `Failed to interact with the element with uid ${uid}. The element did not become interactive within the configured timeout.`,
    {
      cause: error,
    },
  );
}

// SVG cursor injection script — adds a fake cursor to the page for recordings.
// Exposes window.__mc(x,y) to move and window.__cp() to trigger click pulse.
const CURSOR_INJECT_JS = `(() => {
  if (document.getElementById('fake-cursor')) return;
  var s = document.createElement('style');
  s.textContent = '@keyframes click-ring { 0% { transform: translate(-50%,-50%) scale(0.3); opacity: 0.7; } 100% { transform: translate(-50%,-50%) scale(1.5); opacity: 0; } }';
  document.head.appendChild(s);
  const c = document.createElement('div');
  c.id = 'fake-cursor';
  c.innerHTML = '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M5.5 3.21V20.8c0 .45.54.67.85.35l4.86-4.86a.5.5 0 0 1 .35-.15h6.87c.45 0 .67-.54.35-.85L5.85 2.35a.5.5 0 0 0-.35.86z" fill="white" stroke="black" stroke-width="1.5"/></svg>';
  c.style.cssText = 'position:fixed;top:-50px;left:-50px;z-index:999999;pointer-events:none;transition:all 0.25s cubic-bezier(0.25,0.1,0.25,1);filter:drop-shadow(1px 2px 2px rgba(0,0,0,0.4));';
  document.body.appendChild(c);
  window.__mc = (x, y) => { c.style.left = x + 'px'; c.style.top = y + 'px'; };
  window.__cp = () => {
    c.style.transform = 'scale(0.8)';
    setTimeout(() => { c.style.transform = 'scale(1)'; }, 150);
    var ring = document.createElement('div');
    ring.style.cssText = 'position:fixed;left:' + c.style.left + ';top:' + c.style.top + ';width:40px;height:40px;border-radius:50%;border:2px solid rgba(59,130,246,0.7);pointer-events:none;z-index:999998;animation:click-ring 0.45s ease-out forwards;';
    document.body.appendChild(ring);
    setTimeout(() => ring.remove(), 500);
  };
})()`;

/**
 * In human mode, inject fake cursor, animate to element center, pulse, then click.
 */
async function animateCursorToElement(
  page: ContextPage,
  handle: ElementHandle,
) {
  // Ensure fake cursor is injected
  await page.pptrPage.evaluate(CURSOR_INJECT_JS).catch(() => {});

  // Get element bounding box
  const box = await handle.boundingBox();
  if (box) {
    const cx = Math.round(box.x + box.width / 2);
    const cy = Math.round(box.y + box.height / 2);
    // Move cursor
    await page.pptrPage.evaluate(
      (x: number, y: number) => {
        (window as any).__mc?.(x, y);
      },
      cx,
      cy,
    );
    // Wait for CSS transition
    await new Promise(resolve => setTimeout(resolve, 300));
    // Click pulse
    await page.pptrPage
      .evaluate(() => {
        (window as any).__cp?.();
      })
      .catch(() => {});
    await new Promise(resolve => setTimeout(resolve, 120));
  }
}

export const click = definePageTool(args => {
  const humanMode = args?.humanMode === true;

  return {
    name: 'click',
    description: `Clicks on the provided element`,
    annotations: {
      category: ToolCategory.INPUT,
      readOnlyHint: false,
    },
    schema: {
      uid: zod
        .string()
        .describe(
          'The uid of an element on the page from the page content snapshot',
        ),
      dblClick: dblClickSchema,
      includeSnapshot: includeSnapshotSchema,
    },
    handler: async (request, response, context) => {
      const uid = request.params.uid;
      const handle = await request.page.getElementByUid(uid);
      try {
        // In human mode, animate fake cursor to the element before clicking
        if (humanMode) {
          await animateCursorToElement(request.page, handle).catch(() => {});
        }

        await context.waitForEventsAfterAction(async () => {
          await handle.asLocator().click({
            count: request.params.dblClick ? 2 : 1,
          });
        });
        response.appendResponseLine(
          request.params.dblClick
            ? `Successfully double clicked on the element`
            : `Successfully clicked on the element`,
        );
        if (request.params.includeSnapshot) {
          response.includeSnapshot();
        }
      } catch (error) {
        handleActionError(error, uid);
      } finally {
        void handle.dispose();
      }
    },
  };
});

export const clickAt = definePageTool({
  name: 'click_at',
  description: `Clicks at the provided coordinates`,
  annotations: {
    category: ToolCategory.INPUT,
    readOnlyHint: false,
    conditions: ['computerVision'],
  },
  schema: {
    x: zod.number().describe('The x coordinate'),
    y: zod.number().describe('The y coordinate'),
    dblClick: dblClickSchema,
    includeSnapshot: includeSnapshotSchema,
  },
  handler: async (request, response, context) => {
    const page = request.page;
    await context.waitForEventsAfterAction(async () => {
      await page.pptrPage.mouse.click(request.params.x, request.params.y, {
        clickCount: request.params.dblClick ? 2 : 1,
      });
    });
    response.appendResponseLine(
      request.params.dblClick
        ? `Successfully double clicked at the coordinates`
        : `Successfully clicked at the coordinates`,
    );
    if (request.params.includeSnapshot) {
      response.includeSnapshot();
    }
  },
});

export const hover = definePageTool({
  name: 'hover',
  description: `Hover over the provided element`,
  annotations: {
    category: ToolCategory.INPUT,
    readOnlyHint: false,
  },
  schema: {
    uid: zod
      .string()
      .describe(
        'The uid of an element on the page from the page content snapshot',
      ),
    includeSnapshot: includeSnapshotSchema,
  },
  handler: async (request, response, context) => {
    const uid = request.params.uid;
    const handle = await request.page.getElementByUid(uid);
    try {
      await context.waitForEventsAfterAction(async () => {
        await handle.asLocator().hover();
      });
      response.appendResponseLine(`Successfully hovered over the element`);
      if (request.params.includeSnapshot) {
        response.includeSnapshot();
      }
    } catch (error) {
      handleActionError(error, uid);
    } finally {
      void handle.dispose();
    }
  },
});

// The AXNode for an option doesn't contain its `value`. We set text content of the option as value.
// If the form is a combobox, we need to find the correct option by its text value.
// To do that, loop through the children while checking which child's text matches the requested value (requested value is actually the text content).
// When the correct option is found, use the element handle to get the real value.
async function selectOption(
  handle: ElementHandle,
  aXNode: TextSnapshotNode,
  value: string,
) {
  let optionFound = false;
  for (const child of aXNode.children) {
    if (child.role === 'option' && child.name === value && child.value) {
      optionFound = true;
      const childHandle = await child.elementHandle();
      if (childHandle) {
        try {
          const childValueHandle = await childHandle.getProperty('value');
          try {
            const childValue = await childValueHandle.jsonValue();
            if (childValue) {
              await handle.asLocator().fill(childValue.toString());
            }
          } finally {
            void childValueHandle.dispose();
          }
          break;
        } finally {
          void childHandle.dispose();
        }
      }
    }
  }
  if (!optionFound) {
    throw new Error(`Could not find option with text "${value}"`);
  }
}

function hasOptionChildren(aXNode: TextSnapshotNode) {
  return aXNode.children.some(child => child.role === 'option');
}

async function fillFormElement(
  uid: string,
  value: string,
  context: McpContext,
  page: ContextPage,
) {
  const handle = await page.getElementByUid(uid);
  try {
    const aXNode = context.getAXNodeByUid(uid);
    // We assume that combobox needs to be handled as select if it has
    // role='combobox' and option children.
    if (aXNode && aXNode.role === 'combobox' && hasOptionChildren(aXNode)) {
      await selectOption(handle, aXNode, value);
    } else {
      // Increase timeout for longer input values.
      const timeoutPerChar = 10; // ms
      const fillTimeout =
        page.pptrPage.getDefaultTimeout() + value.length * timeoutPerChar;
      await handle.asLocator().setTimeout(fillTimeout).fill(value);
    }
  } catch (error) {
    handleActionError(error, uid);
  } finally {
    void handle.dispose();
  }
}

export const fill = definePageTool(args => {
  const humanMode = args?.humanMode === true;

  return {
    name: 'fill',
    description: `Type text into a input, text area or select an option from a <select> element.`,
    annotations: {
      category: ToolCategory.INPUT,
      readOnlyHint: false,
    },
    schema: {
      uid: zod
        .string()
        .describe(
          'The uid of an element on the page from the page content snapshot',
        ),
      value: zod.string().describe('The value to fill in'),
      includeSnapshot: includeSnapshotSchema,
    },
    handler: async (request, response, context) => {
      const page = request.page;

      // In human mode, animate cursor to the field before filling
      if (humanMode) {
        const handle = await page.getElementByUid(request.params.uid);
        try {
          await animateCursorToElement(page, handle).catch(() => {});
        } finally {
          void handle.dispose();
        }
      }

      await context.waitForEventsAfterAction(async () => {
        await fillFormElement(
          request.params.uid,
          request.params.value,
          context as McpContext,
          page,
        );
      });
      response.appendResponseLine(`Successfully filled out the element`);
      if (request.params.includeSnapshot) {
        response.includeSnapshot();
      }
    },
  };
});

export const typeText = definePageTool({
  name: 'type_text',
  description: `Type text using keyboard into a previously focused input`,
  annotations: {
    category: ToolCategory.INPUT,
    readOnlyHint: false,
  },
  schema: {
    text: zod.string().describe('The text to type'),
    submitKey: submitKeySchema,
  },
  handler: async (request, response, context) => {
    const page = request.page;
    await context.waitForEventsAfterAction(async () => {
      await page.pptrPage.keyboard.type(request.params.text);
      if (request.params.submitKey) {
        await page.pptrPage.keyboard.press(
          request.params.submitKey as KeyInput,
        );
      }
    });
    response.appendResponseLine(
      `Typed text "${request.params.text}${request.params.submitKey ? ` + ${request.params.submitKey}` : ''}"`,
    );
  },
});

export const drag = definePageTool({
  name: 'drag',
  description: `Drag an element onto another element`,
  annotations: {
    category: ToolCategory.INPUT,
    readOnlyHint: false,
  },
  schema: {
    from_uid: zod.string().describe('The uid of the element to drag'),
    to_uid: zod.string().describe('The uid of the element to drop into'),
    includeSnapshot: includeSnapshotSchema,
  },
  handler: async (request, response, context) => {
    const fromHandle = await request.page.getElementByUid(
      request.params.from_uid,
    );
    const toHandle = await request.page.getElementByUid(request.params.to_uid);
    try {
      await context.waitForEventsAfterAction(async () => {
        await fromHandle.drag(toHandle);
        await new Promise(resolve => setTimeout(resolve, 50));
        await toHandle.drop(fromHandle);
      });
      response.appendResponseLine(`Successfully dragged an element`);
      if (request.params.includeSnapshot) {
        response.includeSnapshot();
      }
    } finally {
      void fromHandle.dispose();
      void toHandle.dispose();
    }
  },
});

export const fillForm = definePageTool({
  name: 'fill_form',
  description: `Fill out multiple form elements at once`,
  annotations: {
    category: ToolCategory.INPUT,
    readOnlyHint: false,
  },
  schema: {
    elements: zod
      .array(
        zod.object({
          uid: zod.string().describe('The uid of the element to fill out'),
          value: zod.string().describe('Value for the element'),
        }),
      )
      .describe('Elements from snapshot to fill out.'),
    includeSnapshot: includeSnapshotSchema,
  },
  handler: async (request, response, context) => {
    const page = request.page;
    for (const element of request.params.elements) {
      await context.waitForEventsAfterAction(async () => {
        await fillFormElement(
          element.uid,
          element.value,
          context as McpContext,
          page,
        );
      });
    }
    response.appendResponseLine(`Successfully filled out the form`);
    if (request.params.includeSnapshot) {
      response.includeSnapshot();
    }
  },
});

export const uploadFile = definePageTool({
  name: 'upload_file',
  description: 'Upload a file through a provided element.',
  annotations: {
    category: ToolCategory.INPUT,
    readOnlyHint: false,
  },
  schema: {
    uid: zod
      .string()
      .describe(
        'The uid of the file input element or an element that will open file chooser on the page from the page content snapshot',
      ),
    filePath: zod.string().describe('The local path of the file to upload'),
    includeSnapshot: includeSnapshotSchema,
  },
  handler: async (request, response) => {
    const {uid, filePath} = request.params;
    const handle = (await request.page.getElementByUid(
      uid,
    )) as ElementHandle<HTMLInputElement>;
    try {
      try {
        await handle.uploadFile(filePath);
      } catch {
        // Some sites use a proxy element to trigger file upload instead of
        // a type=file element. In this case, we want to default to
        // Page.waitForFileChooser() and upload the file this way.
        try {
          const [fileChooser] = await Promise.all([
            request.page.pptrPage.waitForFileChooser({timeout: 3000}),
            handle.asLocator().click(),
          ]);
          await fileChooser.accept([filePath]);
        } catch {
          throw new Error(
            `Failed to upload file. The element could not accept the file directly, and clicking it did not trigger a file chooser.`,
          );
        }
      }
      if (request.params.includeSnapshot) {
        response.includeSnapshot();
      }
      response.appendResponseLine(`File uploaded from ${filePath}.`);
    } finally {
      void handle.dispose();
    }
  },
});

export const pressKey = definePageTool({
  name: 'press_key',
  description: `Press a key or key combination. Use this when other input methods like fill() cannot be used (e.g., keyboard shortcuts, navigation keys, or special key combinations).`,
  annotations: {
    category: ToolCategory.INPUT,
    readOnlyHint: false,
  },
  schema: {
    key: zod
      .string()
      .describe(
        'A key or a combination (e.g., "Enter", "Control+A", "Control++", "Control+Shift+R"). Modifiers: Control, Shift, Alt, Meta',
      ),
    includeSnapshot: includeSnapshotSchema,
  },
  handler: async (request, response, context) => {
    const page = request.page;
    const tokens = parseKey(request.params.key);
    const [key, ...modifiers] = tokens;

    await context.waitForEventsAfterAction(async () => {
      for (const modifier of modifiers) {
        await page.pptrPage.keyboard.down(modifier);
      }
      await page.pptrPage.keyboard.press(key);
      for (const modifier of modifiers.toReversed()) {
        await page.pptrPage.keyboard.up(modifier);
      }
    });

    response.appendResponseLine(
      `Successfully pressed key: ${request.params.key}`,
    );
    if (request.params.includeSnapshot) {
      response.includeSnapshot();
    }
  },
});
