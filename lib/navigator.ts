// lib/navigator.ts
//
// Intelligent journey navigator — Phases 1 + 2.
// Drives the bot from landing page → login → lobby → shop → Breeze iframe.
//
// Key behaviours:
//   - Detects already-logged-in state before attempting login
//   - Falls back to Claude Vision when selectors fail
//   - Dismisses overlays (cookie banners, age gates, promo modals) automatically
//   - Records every nav step for the live UI

import type { Page, BrowserContext } from 'playwright-core';
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

// Login form selectors that indicate we need to log in
const LOGIN_FORM_INDICATORS = [
  'input[type="email"]', 'input[name="email"]',
  'input[name="username"]', 'input[placeholder*="email" i]',
].join(', ');

export interface JourneyResult {
  success:  boolean;
  navSteps: NavStep[];
  error?:   string;
  page?:    Page;   // the active page after navigation (may differ from input if new tab opened)
}

type LogFn = (msg: string, level?: 'info' | 'pass' | 'fail' | 'warn' | 'dim') => void;

// ── Check if already logged in ────────────────────────────────────────────────
// Strategy: check if the Login button is ABSENT (more reliable than looking
// for logged-in elements which vary wildly between sites).
// Also check for definitive logged-in indicators as a secondary signal.
async function isAlreadyLoggedIn(page: Page, profile: SiteProfile): Promise<boolean> {
  // If a custom post-login selector is provided, use that
  if (profile.postLoginSel) {
    try {
      await page.waitForSelector(profile.postLoginSel, { timeout: 3_000 });
      return true;
    } catch {
      return false;
    }
  }

  // Check if login/register buttons are visible — if so, definitely NOT logged in
  const loginButtonVisible = await page.locator(
    'a:has-text("Login"), button:has-text("Login"), a:has-text("Sign In"), button:has-text("Sign In"), a:has-text("Register"), button:has-text("Register")'
  ).first().isVisible({ timeout: 3_000 }).catch(() => false);

  if (loginButtonVisible) return false;

  // No login button visible — likely logged in. Double-check with a positive indicator.
  const loggedInVisible = await page.locator(
    '[class*="balance"], [class*="wallet"], [class*="coins"], [class*="user-menu"], [class*="avatar"], button:has-text("Deposit"), button:has-text("Buy")'
  ).first().isVisible({ timeout: 2_000 }).catch(() => false);

  return loggedInVisible;
}

// ── Main journey orchestrator ─────────────────────────────────────────────────
export async function navigateToBreeze(opts: {
  page:    Page;
  context: BrowserContext;
  profile: SiteProfile;
  flow:    'payin' | 'payout';
  testId:  string;
  emit:    (e: SSEEvent) => void;
}): Promise<JourneyResult> {
  const { page, context, profile, flow, testId, emit } = opts;
  const navSteps: NavStep[] = [];
  const useVision = profile.useVisionFallback;

  const log: LogFn = (msg, level = 'dim') =>
    emit({ type: 'log', testId, message: msg, level });

  const recordStep = (step: NavStep) => {
    navSteps.push(step);
    emit({ type: 'nav_step', testId, step });
  };

  try {
    // ── HTTP Basic Auth ───────────────────────────────────────────────────────
    if (profile.httpUser && profile.httpPassword) {
      await context.setHTTPCredentials({
        username: profile.httpUser,
        password: profile.httpPassword,
      });
      log(`  → HTTP Basic Auth set for ${new URL(profile.url).hostname}`);
    }

    // ── Step 1: Navigate to site ──────────────────────────────────────────────
    log(`  → navigating to ${profile.url}`, 'info');
    await page.goto(profile.url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await page.waitForTimeout(2000);
    await dismissOverlays(page, emit);

    // ── Step 2: Login (only if credentials provided) ──────────────────────────
    if (profile.siteUser && profile.sitePassword) {

      // First check — are we already logged in? (session cookie from previous run)
      const alreadyIn = await isAlreadyLoggedIn(page, profile);
      if (alreadyIn) {
        log('  ✓ already logged in — skipping login step', 'pass');
        recordStep({ step: 'login_trigger', method: 'selector', success: true, selector: 'already authenticated' });

      } else {
        // Not logged in — look for login trigger button
        log('  → looking for login button…', 'info');

        // Check if login form is already visible (some sites show inline form)
        const formVisible = await page.locator(LOGIN_FORM_INDICATORS).first().isVisible({ timeout: 1_500 }).catch(() => false);

        if (!formVisible) {
          // Need to click something to open the login modal/page
          const loginStep = await smartClick({
            page,
            goal: 'Find and click the Login or Sign In button to open the login form',
            selector: profile.loginTriggerSel ?? 'a:has-text("Login"), button:has-text("Login"), a:has-text("Sign In"), button:has-text("Sign In")',
            testId, emit, useVision,
            stepName: 'login_trigger',
            context: 'Social casino/sweepstakes site. Login button is usually in the top-right navigation.',
          });
          recordStep(loginStep);

          // Wait for login modal/form to animate in
          log('  → waiting for login form to appear…');
          await page.waitForTimeout(2000);
          await dismissOverlays(page, emit);

          // Check if form actually appeared — if not, try clicking login again
          const formAppearedAfterClick = await page.locator(
            profile.loginEmailSel ?? 'input[type="email"], input[name="email"], input[name="username"], input[placeholder*="email" i]'
          ).first().isVisible({ timeout: 3_000 }).catch(() => false);

          if (!formAppearedAfterClick) {
            log('  → login form did not appear — retrying login trigger…', 'warn');
            // Take a screenshot to see current state
            if (useVision) {
              const b64 = await page.screenshot({ type: 'png' }).then(b => b.toString('base64'));
              emit({ type: 'screenshot', testId, b64, caption: 'Login form did not appear — retrying' });
            }
            // Try clicking again with a broader selector
            await smartClick({
              page,
              goal: 'Click the Login button to open the login modal — look specifically for a Login link in the top navigation bar',
              selector: 'a[href*="login"], button[data-action*="login"], [class*="login"]:not(input)',
              testId, emit, useVision,
              stepName: 'login_trigger',
              context: 'The login button in the top-right navigation. It may be an anchor tag with text "Login" or "Sign In". Do NOT click Register.',
            });
            await page.waitForTimeout(2000);
          }
        } else {
          log('  → login form already visible', 'dim');
          recordStep({ step: 'login_trigger', method: 'direct', success: true });
        }

        // Fill email — wait explicitly for the field to be visible first
        log('  → filling email…');
        const emailSel = profile.loginEmailSel ?? 'input[type="email"], input[name="email"], input[name="username"], input[placeholder*="email" i]';
        try {
          await page.waitForSelector(emailSel, { timeout: 8_000 });
        } catch {
          log('  ⚠ email field not found after waiting 8s', 'warn');
          if (useVision) {
            const b64 = await page.screenshot({ type: 'png' }).then(b => b.toString('base64'));
            emit({ type: 'screenshot', testId, b64, caption: 'Looking for email field' });
          }
        }
        const emailStep = await smartFill({
          page,
          goal: 'Find the email or username input field in the login form',
          selector: emailSel,
          value: profile.siteUser,
          testId, emit, useVision,
          stepName: 'login_email',
        });
        recordStep(emailStep);

        // Fill password
        const passStep = await smartFill({
          page,
          goal: 'Find the password input field',
          selector: profile.loginPassSel ?? 'input[type="password"]',
          value: profile.sitePassword,
          testId, emit, useVision,
          stepName: 'login_password',
        });
        recordStep(passStep);

        // Submit
        const submitStep = await smartClick({
          page,
          goal: 'Click the submit or Sign In button to complete login',
          selector: profile.loginSubmitSel ?? 'button[type="submit"], button:has-text("Sign In"), button:has-text("Login"), button:has-text("Log In")',
          testId, emit, useVision,
          stepName: 'login_submit',
          context: 'Click the button that submits the login form.',
        });
        recordStep(submitStep);

        // Wait for redirect / modal close
        await page.waitForTimeout(3000);
        await dismissOverlays(page, emit);

        // Confirm logged in
        const loggedIn = await isAlreadyLoggedIn(page, profile);
        if (loggedIn) {
          log('  ✓ login successful', 'pass');
          recordStep({ step: 'post_login', method: 'selector', success: true });
        } else if (useVision) {
          // Vision check as last resort
          const b64 = await page.screenshot({ type: 'png' }).then(b => b.toString('base64'));
          emit({ type: 'screenshot', testId, b64, caption: 'Checking login state' });
          const check = await askVision({
            screenshotB64: b64,
            goal: 'Is the user logged in? Look for a balance, avatar, username, or lobby/game content.',
            context: 'Social casino site. If a lobby or games are visible, user is logged in.',
          });
          log(`  🤖 Login check: ${check.reasoning}`, 'info');
          const loginOk = check.confidence !== 'low' && check.action !== 'none';
          recordStep({ step: 'post_login', method: 'vision', success: loginOk, screenshotB64: b64, visionReasoning: check.reasoning });
          if (!loginOk) {
            log('  ⚠ login may have failed — proceeding anyway', 'warn');
          }
        }
      }
    }

    // ── Step 3: Find purchase or payout trigger ───────────────────────────────
    if (flow === 'payout') {
      log('  → looking for withdraw/payout trigger…', 'info');
      const step = await smartClick({
        page,
        goal: 'Find and click the Withdraw, Cash Out, or Redeem button',
        selector: profile.payoutTriggerSel,
        testId, emit, useVision,
        stepName: 'payout_trigger',
        context: 'Social casino — looking for a withdrawal or cash-out button.',
      });
      recordStep(step);
    } else {
      log('  → looking for buy/purchase trigger…', 'info');
      const step = await smartClick({
        page,
        goal: 'Find and click a button to buy coins, add funds, or open the shop',
        selector: profile.purchaseTriggerSel,
        testId, emit, useVision,
        stepName: 'purchase_trigger',
        context: 'Social casino/sweepstakes site. Look for "Buy Coins", "Purchase Now", "Add Funds", "Get Coins", "Shop", or a banner CTA.',
      });
      recordStep(step);
    }

    await page.waitForTimeout(1500);
    await dismissOverlays(page, emit);

    // ── Step 4: Select a coin package (payin only) ────────────────────────────
    if (flow === 'payin') {
      log('  → selecting coin package…');
      const packageSel = profile.packageSel ??
        '[class*="package"]:first-child, [class*="bundle"]:first-child, [class*="offer"]:first-child, [class*="product"]:first-child';
      const step = await smartClick({
        page,
        goal: 'Select the first or cheapest coin package, bundle, or credit option shown',
        selector: packageSel,
        testId, emit, useVision,
        stepName: 'package_select',
        context: 'Choose any purchasable package — the first or cheapest one is fine.',
      });
      recordStep(step);
      await page.waitForTimeout(1500);
    }

    // ── Step 5: Wait for Breeze iframe ────────────────────────────────────────
    // Give the page a moment to settle after package click — some sites
    // open payment in a modal, others navigate or open a new tab.
    await page.waitForTimeout(2500);
    await dismissOverlays(page, emit);

    log('  → waiting for Breeze payment iframe…', 'info');
    const breezeSel = profile.breezeReadySel ?? BREEZE_SEL.iframe;

    // Check if payment opened in a new tab
    const allPages = context.pages();
    let targetPage = page;
    if (allPages.length > 1) {
      targetPage = allPages[allPages.length - 1];
      log(`  → new tab detected — switching to it`, 'info');
      await targetPage.waitForLoadState('domcontentloaded', { timeout: 15_000 }).catch(() => {});
      recordStep({ step: 'new_tab', method: 'direct', success: true });
    }

    try {
      await targetPage.waitForSelector(breezeSel, { timeout: 15_000 });
      log('  ✓ Breeze iframe ready', 'pass');
      recordStep({ step: 'breeze_ready', method: 'selector', selector: breezeSel, success: true });
      return { success: true, navSteps, page: targetPage };
    } catch {
      if (useVision) {
        log('  → iframe not found via selector — vision scanning…', 'warn');
        const b64 = await targetPage.screenshot({ type: 'png' }).then(b => b.toString('base64'));
        emit({ type: 'screenshot', testId, b64, caption: 'Scanning for Breeze payment form' });
        const result = await askVision({
          screenshotB64: b64,
          goal: 'Is there a credit card payment form visible? Look for card number, expiry, CVV fields.',
          context: 'This should be the Breeze payment iframe embedded in the page.',
        });
        log(`  🤖 Vision: ${result.reasoning}`, 'info');
        const found = result.action !== 'none' && result.confidence !== 'low';
        recordStep({ step: 'breeze_ready', method: 'vision', success: found, screenshotB64: b64, visionReasoning: result.reasoning });
        if (found) return { success: true, navSteps, page: targetPage };
      }
      return { success: false, navSteps, error: 'Could not locate Breeze payment iframe', page: targetPage };
    }

  } catch (err) {
    return { success: false, navSteps, error: (err as Error).message };
  }
}
