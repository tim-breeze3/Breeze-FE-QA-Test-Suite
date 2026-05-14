// lib/navigator.ts
//
// The intelligent journey navigator.
// Drives the bot from the landing page through login → lobby → shop → Breeze iframe.
//
// Phase 1: Uses selector hints from the site profile
// Phase 2: Falls back to Claude vision when selectors fail
// Records every step as a NavStep for the live UI

import type { Page } from 'playwright-core';
import type { SiteProfile, NavStep, SSEEvent } from './types';
import { smartClick, smartFill, dismissOverlays, askVision } from './vision-navigator';

// ── Breeze iframe selectors ───────────────────────────────────────────────────
export const BREEZE_SEL = {
  iframe:      'iframe[src*="breeze"], iframe[src*="pay.breeze"], iframe[id*="breeze"]',
  cardNumber:  '[data-testid="card-number"], input[name="cardNumber"], input[placeholder*="card" i], input[placeholder*="1234" i]',
  expiry:      '[data-testid="expiry"], input[name="expiry"], input[placeholder*="MM" i]',
  cvv:         '[data-testid="cvv"], [data-testid="cvc"], input[name="cvv"], input[name="cvc"], input[placeholder*="CVV" i]',
  zip:         '[data-testid="zip"], input[name="zip"], input[name="postalCode"], input[placeholder*="zip" i]',
  submit:      '[data-testid="pay-button"], [data-testid="submit"], button[type="submit"]',
  threeds:     'iframe[src*="3ds"], iframe[src*="simulator"], iframe[src*="challenge"]',
  threedsPass: 'input[type="password"], input[name="password"]',
  success:     'text=/payment successful|thank you|order confirmed|order received|coins added|purchase complete/i',
  failure:     'text=/payment failed|declined|error|try again/i',
  payoutDone:  'text=/payout complete|withdrawal successful|funds sent|cash out complete/i',
};

export interface JourneyResult {
  success:    boolean;
  navSteps:   NavStep[];
  error?:     string;
}

// ── Main journey orchestrator ─────────────────────────────────────────────────
export async function navigateToBreeze(opts: {
  page:    Page;
  context: import('playwright-core').BrowserContext;
  profile: SiteProfile;
  flow:    'payin' | 'payout';
  testId:  string;
  emit:    (e: SSEEvent) => void;
}): Promise<JourneyResult> {
  const { page, context, profile, flow, testId, emit } = opts;
  const navSteps: NavStep[] = [];
  const useVision = profile.useVisionFallback;
  const log = (msg: string, level: 'info' | 'pass' | 'fail' | 'warn' | 'dim' = 'dim') =>
    emit({ type: 'log', testId, message: msg, level });

  const recordStep = (step: NavStep) => {
    navSteps.push(step);
    emit({ type: 'nav_step', testId, step });
  };

  try {
    // ── HTTP Basic Auth (server-level) ──────────────────────────────────────
    // Set credentials on the browser context before any navigation.
    // This handles staging/dev sites protected by a browser-level auth prompt.
    if (profile.httpUser && profile.httpPassword) {
      await context.setHTTPCredentials({
        username: profile.httpUser,
        password: profile.httpPassword,
      });
      log(`  → HTTP Basic Auth set for ${new URL(profile.url).hostname}`, 'dim');
    }

    // ── Step 1: Land on the site ────────────────────────────────────────────
    log(`  → navigating to ${profile.url}`, 'info');
    await page.goto(profile.url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await page.waitForTimeout(1500);

    // Dismiss any overlays (cookie banners, age gates, promo modals)
    log('  → checking for overlays…');
    await dismissOverlays(page, emit);

    // ── Step 2: Trigger login ───────────────────────────────────────────────
    // Only if credentials are provided
    if (profile.siteUser && profile.sitePassword) {
      log('  → looking for login trigger…', 'info');

      const loginStep = await smartClick({
        page,
        goal: 'Find and click the Sign In, Login, or Register button to open the login form',
        selector: profile.loginTriggerSel,
        testId, emit, useVision,
        stepName: 'login_trigger',
        context: 'Sweepstakes/social casino site. The login button may say "Sign In", "Login", "Play Now", "Join Now", or "Register".',
      });
      recordStep(loginStep);

      if (!loginStep.success) {
        // Maybe we're already on a login page or inline form
        log('  → login trigger not found — checking for inline login form…', 'warn');
      }

      // Wait for login form to appear (modal or page)
      await page.waitForTimeout(1000);
      await dismissOverlays(page, emit);

      // Fill email
      const emailStep = await smartFill({
        page,
        goal: 'Find the email or username input field in the login form',
        selector: profile.loginEmailSel ?? 'input[type="email"], input[name="email"], input[name="username"], input[placeholder*="email" i], input[placeholder*="user" i]',
        value: profile.siteUser,
        testId, emit, useVision,
        stepName: 'login_email',
      });
      recordStep(emailStep);

      // Fill password
      const passStep = await smartFill({
        page,
        goal: 'Find the password input field in the login form',
        selector: profile.loginPassSel ?? 'input[type="password"], input[name="password"]',
        value: profile.sitePassword,
        testId, emit, useVision,
        stepName: 'login_password',
      });
      recordStep(passStep);

      // Submit login
      const submitStep = await smartClick({
        page,
        goal: 'Click the submit or Sign In button to complete login',
        selector: profile.loginSubmitSel ?? 'button[type="submit"], button:has-text("Sign In"), button:has-text("Login"), button:has-text("Log In")',
        testId, emit, useVision,
        stepName: 'login_submit',
        context: 'After filling in email and password, click the submit button.',
      });
      recordStep(submitStep);

      // Wait for post-login state
      log('  → waiting for post-login state…');
      await page.waitForTimeout(2500);
      await dismissOverlays(page, emit);

      // Verify we're logged in
      const postLoginSel = profile.postLoginSel ?? '.user-avatar, .user-balance, [class*="balance"], [class*="coins"], nav [class*="user"], header [class*="profile"]';
      try {
        await page.waitForSelector(postLoginSel, { timeout: 8_000 });
        log('  ✓ logged in successfully', 'pass');
        recordStep({ step: 'post_login', method: 'selector', selector: postLoginSel, success: true });
      } catch {
        // Vision check — maybe logged in but selector doesn't match
        if (useVision) {
          const b64 = await page.screenshot({ type: 'png' }).then(b => b.toString('base64'));
        const check = await askVision({
            screenshotB64: b64,
            goal: 'Is the user currently logged in? Look for username, balance, avatar, or lobby state.',
            context: 'Sweepstakes/social casino site.',
          });
          log(`  🤖 Login check: ${check.reasoning}`, 'info');
          recordStep({ step: 'post_login', method: 'vision', success: check.confidence !== 'low', visionReasoning: check.reasoning, screenshotB64: b64 });
        } else {
          log('  ⚠ could not confirm login — proceeding anyway', 'warn');
          recordStep({ step: 'post_login', method: 'selector', selector: postLoginSel, success: false });
        }
      }
    }

    // ── Step 3: Navigate to purchase/payout flow ────────────────────────────
    if (flow === 'payout') {
      log('  → looking for payout/withdraw trigger…', 'info');
      const payoutStep = await smartClick({
        page,
        goal: 'Find and click the Withdraw, Cash Out, or Payout button',
        selector: profile.payoutTriggerSel,
        testId, emit, useVision,
        stepName: 'payout_trigger',
        context: 'Looking for a button to initiate a payout or withdrawal of coins/cash.',
      });
      recordStep(payoutStep);
    } else {
      log('  → looking for purchase/buy coins trigger…', 'info');
      const purchaseStep = await smartClick({
        page,
        goal: 'Find and click the Buy Coins, Add Funds, Shop, Purchase, or Get Tokens button',
        selector: profile.purchaseTriggerSel,
        testId, emit, useVision,
        stepName: 'purchase_trigger',
        context: 'Social casino/sweepstakes site. Button likely says "Buy Coins", "Get Coins", "Add Funds", "Shop", "Purchase", or similar.',
      });
      recordStep(purchaseStep);
    }

    await page.waitForTimeout(1500);
    await dismissOverlays(page, emit);

    // ── Step 4: Select a package (payin only) ───────────────────────────────
    if (flow === 'payin') {
      log('  → selecting coin package…');
      const packageSel = profile.packageSel ?? '.package:first-child, .bundle:first-child, .coin-package:first-child, [class*="package"]:first-child, [class*="bundle"]:first-child, [class*="offer"]:first-child';

      const packageStep = await smartClick({
        page,
        goal: 'Select the first or cheapest coin package or credit bundle available',
        selector: packageSel,
        testId, emit, useVision,
        stepName: 'package_select',
        context: 'Select any coin package, credit bundle, or purchase option. Choose the first or smallest one.',
      });
      recordStep(packageStep);

      await page.waitForTimeout(1500);
    }

    // ── Step 5: Wait for Breeze iframe ──────────────────────────────────────
    log('  → waiting for Breeze payment iframe…', 'info');
    const breezeSel = profile.breezeReadySel ?? BREEZE_SEL.iframe;

    try {
      await page.waitForSelector(breezeSel, { timeout: 15_000 });
      log('  ✓ Breeze iframe ready', 'pass');
      recordStep({ step: 'breeze_ready', method: 'selector', selector: breezeSel, success: true });
      return { success: true, navSteps };

    } catch {
      // Last resort — vision scan for the iframe
      if (useVision) {
        log('  → Breeze iframe not found via selector — running vision scan…', 'warn');
        const b64 = await page.screenshot({ type: 'png' }).then(b => b.toString('base64'));
        emit({ type: 'screenshot', testId, b64, caption: 'Scanning for Breeze payment form' });

        const result = await askVision({
          screenshotB64: b64,
          goal: 'Is there a credit card payment form or payment iframe visible on this page?',
          context: 'Looking for a Breeze payment form with card number, expiry, CVV fields.',
        });

        log(`  🤖 Vision scan: ${result.reasoning}`, 'info');
        recordStep({ step: 'breeze_ready', method: 'vision', success: result.action !== 'none', screenshotB64: b64, visionReasoning: result.reasoning });

        if (result.action !== 'none') {
          return { success: true, navSteps };
        }
      }

      return {
        success: false,
        navSteps,
        error: 'Could not locate Breeze payment iframe after full navigation journey',
      };
    }

  } catch (err) {
    return { success: false, navSteps, error: (err as Error).message };
  }
}
