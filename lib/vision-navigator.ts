// lib/vision-navigator.ts
//
// Phase 2: Claude Vision fallback.
// When the bot can't find an element via CSS selector, it takes a screenshot
// and asks Claude (claude-sonnet-4-20250514 with vision) to identify
// what to click or fill next. Claude returns a CSS selector or text to click.
//
// This handles:
//   - Modal dialogs with non-standard structures
//   - Dynamic button labels ("Get Coins" vs "Buy Now" vs "Add Funds")
//   - Popups, overlays, cookie banners
//   - Anything a human can see but a fixed selector misses

import type { Page } from 'playwright-core';
import type { NavStep, SSEEvent } from './types';

interface VisionResult {
  action:    'click' | 'fill' | 'wait' | 'none';
  selector?: string;    // CSS selector to act on
  text?:     string;    // visible text to click (fallback if no selector)
  value?:    string;    // value to fill (for fill actions)
  reasoning: string;    // Claude's explanation
  confidence: 'high' | 'medium' | 'low';
}

// Ask Claude vision what to do next given a screenshot and a goal
export async function askVision(opts: {
  screenshotB64: string;
  goal: string;         // e.g. "Find and click the login button"
  context?: string;     // additional context about the site
}): Promise<VisionResult> {
  const { screenshotB64, goal, context } = opts;

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY ?? '',
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1000,
      messages: [{
        role: 'user',
        content: [
          {
            type: 'image',
            source: { type: 'base64', media_type: 'image/png', data: screenshotB64 },
          },
          {
            type: 'text',
            text: `You are a browser automation assistant analyzing a screenshot of a web page.

Goal: ${goal}
${context ? `Context: ${context}` : ''}

Analyze the screenshot and determine what action to take next.
This is likely a sweepstakes or social casino site.

Respond ONLY with a JSON object, no markdown, no explanation outside the JSON:
{
  "action": "click" | "fill" | "wait" | "none",
  "selector": "CSS selector for the target element (best option)",
  "text": "visible text of element to click (fallback)",
  "value": "value to type (only for fill actions)",
  "reasoning": "brief explanation of what you see and why",
  "confidence": "high" | "medium" | "low"
}

For selectors, prefer:
- button:has-text('...') for buttons
- [placeholder='...'] for inputs  
- a:has-text('...') for links
- .class-name for unique class names
If the goal cannot be achieved from this screen, use action: "none".`,
          },
        ],
      }],
    }),
  });

  const data = await response.json() as { content?: Array<{ type: string; text: string }> };
  const text = (data.content ?? []).find((c: any) => c.type === 'text')?.text ?? '{}';

  try {
    return JSON.parse(text) as VisionResult;
  } catch {
    return { action: 'none', reasoning: 'Failed to parse vision response', confidence: 'low' };
  }
}

// ── Smart click: try selector first, fall back to vision ──────────────────────
export async function smartClick(opts: {
  page: Page;
  goal: string;
  selector?: string;
  testId?: string;
  emit: (e: SSEEvent) => void;
  useVision: boolean;
  stepName: string;
  context?: string;
}): Promise<NavStep> {
  const { page, goal, selector, testId, emit, useVision, stepName, context } = opts;

  // ── Try CSS selector first ────────────────────────────────────────────────
  if (selector) {
    try {
      const el = page.locator(selector).first();
      await el.waitFor({ timeout: 6_000 });
      await el.click();
      const step: NavStep = { step: stepName, method: 'selector', selector, success: true };
      emit({ type: 'nav_step', testId, step });
      emit({ type: 'log', testId, message: `  ✓ ${stepName} via selector`, level: 'pass' });
      return step;
    } catch {
      emit({ type: 'log', testId, message: `  ⚠ selector failed for ${stepName}, trying vision…`, level: 'warn' });
    }
  }

  // ── Vision fallback ───────────────────────────────────────────────────────
  if (useVision) {
    const screenshotB64 = await page.screenshot({ type: 'png' }).then(b => b.toString('base64'));
    emit({ type: 'screenshot', testId, b64: screenshotB64, caption: `Vision analyzing: ${goal}` });

    const result = await askVision({ screenshotB64, goal, context });
    emit({ type: 'log', testId, message: `  🤖 Vision (${result.confidence}): ${result.reasoning}`, level: 'info' });

    const step: NavStep = {
      step: stepName, method: 'vision',
      selector: result.selector,
      success: false,
      screenshotB64,
      visionReasoning: result.reasoning,
    };

    if (result.action === 'none' || result.confidence === 'low') {
      emit({ type: 'log', testId, message: `  ✕ Vision couldn't find ${stepName}`, level: 'fail' });
      return { ...step, success: false };
    }

    try {
      if (result.selector) {
        await page.locator(result.selector).first().click({ timeout: 8_000 });
      } else if (result.text) {
        await page.getByText(result.text, { exact: false }).first().click({ timeout: 8_000 });
      }
      step.success = true;
      emit({ type: 'nav_step', testId, step });
      emit({ type: 'log', testId, message: `  ✓ ${stepName} via vision`, level: 'pass' });
      return step;
    } catch {
      emit({ type: 'log', testId, message: `  ✕ Vision click failed for ${stepName}`, level: 'fail' });
      return step;
    }
  }

  // No selector and no vision — fail
  const step: NavStep = { step: stepName, method: 'selector', selector, success: false };
  emit({ type: 'nav_step', testId, step });
  return step;
}

// ── Smart fill: try selector, fall back to vision to find the field ───────────
export async function smartFill(opts: {
  page: Page;
  goal: string;
  selector?: string;
  value: string;
  testId?: string;
  emit: (e: SSEEvent) => void;
  useVision: boolean;
  stepName: string;
}): Promise<NavStep> {
  const { page, goal, selector, value, testId, emit, useVision, stepName } = opts;

  if (selector) {
    try {
      const el = page.locator(selector).first();
      await el.waitFor({ timeout: 6_000 });
      await el.fill(value);
      const step: NavStep = { step: stepName, method: 'selector', selector, success: true };
      emit({ type: 'nav_step', testId, step });
      emit({ type: 'log', testId, message: `  ✓ ${stepName} filled`, level: 'pass' });
      return step;
    } catch {
      emit({ type: 'log', testId, message: `  ⚠ fill selector failed for ${stepName}, trying vision…`, level: 'warn' });
    }
  }

  if (useVision) {
    const screenshotB64 = await page.screenshot({ type: 'png' }).then(b => b.toString('base64'));
    const result = await askVision({ screenshotB64, goal });
    emit({ type: 'log', testId, message: `  🤖 Vision: ${result.reasoning}`, level: 'info' });

    const step: NavStep = {
      step: stepName, method: 'vision',
      selector: result.selector, success: false, screenshotB64,
      visionReasoning: result.reasoning,
    };

    if (result.selector && result.action === 'fill') {
      try {
        await page.locator(result.selector).first().fill(value, );
        step.success = true;
        emit({ type: 'nav_step', testId, step });
        return step;
      } catch { /* fall through */ }
    }
    return step;
  }

  return { step: stepName, method: 'selector', selector, success: false };
}

// ── Dismiss common overlays (cookie banners, age gates, welcome modals) ────────
export async function dismissOverlays(page: Page, emit: (e: SSEEvent) => void): Promise<void> {
  const overlaySelectors = [
    // Cookie banners
    'button:has-text("Accept"), button:has-text("Accept All"), button:has-text("I Accept")',
    // Age gates
    'button:has-text("I am 18"), button:has-text("Enter"), button:has-text("Yes, I am")',
    // Welcome/promo modals
    'button:has-text("Close"), button[aria-label="Close"], .modal-close, [data-dismiss="modal"]',
    // Generic overlays
    '.cookie-accept, #accept-cookies, .gdpr-accept',
  ];

  for (const sel of overlaySelectors) {
    try {
      const el = page.locator(sel).first();
      const visible = await el.isVisible({ timeout: 1_500 }).catch(() => false);
      if (visible) {
        await el.click();
        emit({ type: 'log', message: `  → dismissed overlay: ${sel.split(',')[0]}`, level: 'dim' });
        await page.waitForTimeout(500);
      }
    } catch { /* not present — skip */ }
  }
}
