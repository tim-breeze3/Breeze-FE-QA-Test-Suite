// lib/runner.ts
//
// Test runner — uses the intelligent navigator (Phases 1+2) to reach the
// Breeze iframe from any starting URL, then runs card/payout tests.

import { chromium } from 'playwright-core';
import { v4 as uuidv4 } from 'uuid';
import { getOrCreateRunFolder, uploadRecording } from './drive';
import { navigateToBreeze, BREEZE_SEL } from './navigator';
import type { RunConfig, RunResult, TestResult, SSEEvent, TestDefinition } from './types';
import { ALL_TESTS } from './types';

// ── Test cards ────────────────────────────────────────────────────────────────
const CARDS = {
  visaSuccessUS:  { number: '4000020000000000', cvv: '123', expiry: '12/29', zip: '10001' },
  visaDeclinedES: { number: '4539467987109256', cvv: '123', expiry: '12/29', zip: '10001' },
  visaDebitGB:    { number: '4659105569051157', cvv: '123', expiry: '12/29', zip: '10001' },
  visaPrepaid:    { number: '4000148147058142', cvv: '123', expiry: '12/29', zip: '10001' },
  mc3dsUS:        { number: '5385308360135181', cvv: '123', expiry: '12/29', zip: '10001' },
  amex3dsUS:      { number: '372688581899681',  cvv: '1234', expiry: '12/29', zip: '10001' },
  mcFR3ds:        { number: '5137210000000158', cvv: '123', expiry: '12/29', zip: '10001' },
  payoutVisa:     { number: '4000 0566 5566 5556' },
} as const;

const THREE_DS_PASSWORD = 'Checkout1!';

type LogFn = (msg: string, level?: 'info' | 'pass' | 'fail' | 'warn' | 'dim') => void;

function browserlessWsEndpoint(record: boolean): string {
  const token = process.env.BROWSERLESS_TOKEN;
  if (!token) throw new Error('BROWSERLESS_TOKEN is not set');
  const params = [`token=${token}`, 'headless=false', 'stealth'];
  if (record) params.push('record=true');
  return `wss://production-sfo.browserless.io?${params.join('&')}`;
}

function today() { return new Date().toISOString().split('T')[0]; }
function timeLabel() {
  const d = new Date();
  return `${String(d.getHours()).padStart(2,'0')}h${String(d.getMinutes()).padStart(2,'0')}m`;
}
function slugify(s: string) { return s.toLowerCase().replace(/[^a-z0-9]+/g,'-').slice(0,40); }
function getTests(suite: string): TestDefinition[] {
  return suite === 'all' ? ALL_TESTS : ALL_TESTS.filter(t => t.suite === suite);
}

// ── Main entry point ──────────────────────────────────────────────────────────
export async function runTests(
  config: RunConfig,
  emit: (event: SSEEvent) => void,
): Promise<RunResult> {
  const runId     = uuidv4();
  const startedAt = new Date().toISOString();
  const tests     = getTests(config.suite);
  const results: TestResult[] = [];
  let passed = 0, failed = 0;

  emit({ type: 'run_start', runId, total: tests.length });
  emit({ type: 'log', message: `Run ${runId}`, level: 'info' });
  emit({ type: 'log', message: `Site: ${config.profile.name} (${config.profile.url})`, level: 'info' });
  emit({ type: 'log', message: `Suite: ${config.suite} · ${tests.length} tests`, level: 'dim' });
  emit({ type: 'log', message: `Vision AI: ${config.profile.useVisionFallback ? 'enabled' : 'disabled'}`, level: 'dim' });

  // ── Drive folder ──────────────────────────────────────────────────────────
  const shouldRecord = config.videoMode !== 'off';
  let runFolderId = '', driveFolderLink = '';
  if (shouldRecord) {
    try {
      emit({ type: 'log', message: 'Creating Drive folder…', level: 'dim' });
      const folder = await getOrCreateRunFolder(today());
      runFolderId = folder.folderId;
      driveFolderLink = folder.folderLink;
      emit({ type: 'log', message: 'Drive folder ready ✓', level: 'pass' });
    } catch (e) {
      emit({ type: 'log', message: `Drive setup failed: ${(e as Error).message}`, level: 'warn' });
    }
  }

  // ── Connect to Browserless ────────────────────────────────────────────────
  emit({ type: 'log', message: 'Connecting to Browserless…', level: 'dim' });
  const browser = await chromium.connectOverCDP(browserlessWsEndpoint(shouldRecord));
  const context = browser.contexts()[0];
  const page    = context.pages()[0];
  await page.setViewportSize({ width: 1280, height: 720 });
  emit({ type: 'log', message: 'Browser connected ✓', level: 'pass' });

  // ── Run each test ─────────────────────────────────────────────────────────
  for (const test of tests) {
    const testStart = Date.now();
    emit({ type: 'test_start', testId: test.id, name: test.name });
    emit({ type: 'log', testId: test.id, message: `▶ ${test.name}`, level: 'info' });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let cdpSession: any = null;
    let recording = false;

    try {
      // Start recording
      if (shouldRecord) {
        cdpSession = await context.newCDPSession(page);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await (cdpSession as any).send('Browserless.startRecording');
        recording = true;
      }

      // ── Phase 1+2: Navigate from landing page to Breeze iframe ────────────
      const flow = test.suite === 'payout' ? 'payout' : 'payin';
      const journey = await navigateToBreeze({
        page, context, profile: config.profile, flow, testId: test.id, emit,
      });

      if (!journey.success) {
        throw new Error(journey.error ?? 'Navigation failed — could not reach Breeze iframe');
      }

      // ── Run the card/payout test ───────────────────────────────────────────
      const log: LogFn = (msg, level = 'dim') =>
        emit({ type: 'log', testId: test.id, message: msg, level });

      await runCardTest({ testId: test.id, page, log });

      const durationMs = Date.now() - testStart;
      emit({ type: 'log', testId: test.id, message: `  ✓ PASSED (${(durationMs/1000).toFixed(1)}s)`, level: 'pass' });

      const { driveLink, driveFileId } = await stopAndUpload({
        recording, cdpSession, runFolderId,
        filename: `${test.id}-${slugify(test.name)}-${timeLabel()}.webm`,
        emit, testId: test.id,
      });

      results.push({
        id: test.id, name: test.name, tag: test.tag,
        status: 'pass', durationMs, driveLink, driveFileId,
        navSteps: journey.navSteps,
      });
      passed++;
      emit({ type: 'test_end', result: results[results.length - 1] });

    } catch (err) {
      const durationMs = Date.now() - testStart;
      const error = (err as Error).message;
      emit({ type: 'log', testId: test.id, message: `  ✕ FAILED: ${error}`, level: 'fail' });

      // Always save failure recording
      const { driveLink, driveFileId } = await stopAndUpload({
        recording, cdpSession, runFolderId,
        filename: `FAILED-${test.id}-${slugify(test.name)}-${timeLabel()}.webm`,
        emit, testId: test.id,
      });

      results.push({
        id: test.id, name: test.name, tag: test.tag,
        status: 'fail', durationMs, error, driveLink, driveFileId,
      });
      failed++;
      emit({ type: 'test_end', result: results[results.length - 1] });
    }

    // Reset between tests
    await page.waitForTimeout(1200);
  }

  await browser.close();

  const completedAt = new Date().toISOString();
  const totalMs = Date.now() - new Date(startedAt).getTime();
  const summary: RunResult = {
    runId, status: 'complete', config, results,
    startedAt, completedAt, totalMs, passed, failed, driveFolderLink,
  };

  emit({ type: 'log', message: `Finished: ${passed}/${tests.length} passed in ${(totalMs/1000).toFixed(1)}s`, level: passed === tests.length ? 'pass' : 'fail' });
  if (driveFolderLink) emit({ type: 'log', message: `Recordings: ${driveFolderLink}`, level: 'info' });
  emit({ type: 'run_end', summary });
  return summary;
}

// ── Card/payout test scenarios ────────────────────────────────────────────────
// By the time these run, the bot is already on the page with the Breeze iframe.
async function runCardTest(opts: {
  testId: string;
  page:   import('playwright-core').Page;
  log:    LogFn;
}): Promise<void> {
  const { testId, page, log } = opts;

  switch (testId) {
    case 't1': {
      await fillBreezeCard(page, CARDS.visaSuccessUS, log);
      await page.waitForSelector(BREEZE_SEL.success, { timeout: 25_000 });
      log('  ✓ success state confirmed', 'pass');
      break;
    }
    case 't2': {
      await fillBreezeCard(page, CARDS.visaDeclinedES, log);
      await page.frameLocator(BREEZE_SEL.iframe).getByText(/payment failed|declined/i).waitFor({ timeout: 15_000 });
      log('  ✓ decline confirmed in iframe', 'pass');
      break;
    }
    case 't3': {
      await fillBreezeCard(page, CARDS.visaDebitGB, log);
      await page.waitForSelector(BREEZE_SEL.success, { timeout: 25_000 });
      log('  ✓ debit success confirmed', 'pass');
      break;
    }
    case 't4': {
      await fillBreezeCard(page, CARDS.visaPrepaid, log);
      await page.frameLocator(BREEZE_SEL.iframe).getByText(/payment failed|declined/i).waitFor({ timeout: 15_000 });
      log('  ✓ prepaid decline confirmed', 'pass');
      break;
    }
    case 't5': {
      await fillBreezeCard(page, CARDS.mc3dsUS, log);
      await complete3DS(page, log);
      await page.waitForSelector(BREEZE_SEL.success, { timeout: 30_000 });
      log('  ✓ Mastercard 3DS success', 'pass');
      break;
    }
    case 't6': {
      await fillBreezeCard(page, CARDS.amex3dsUS, log);
      await complete3DS(page, log);
      await page.waitForSelector(BREEZE_SEL.success, { timeout: 30_000 });
      log('  ✓ Amex 3DS success', 'pass');
      break;
    }
    case 't7': {
      await fillBreezeCard(page, CARDS.mcFR3ds, log);
      await complete3DS(page, log);
      await page.waitForSelector(BREEZE_SEL.success, { timeout: 30_000 });
      log('  ✓ Mastercard FR 3DS success', 'pass');
      break;
    }
    case 't8': {
      log(`  → filling payout card ${CARDS.payoutVisa.number}`);
      const frame = page.frameLocator(BREEZE_SEL.iframe);
      await frame.locator(BREEZE_SEL.cardNumber).waitFor({ timeout: 20_000 });
      await frame.locator(BREEZE_SEL.cardNumber).fill(CARDS.payoutVisa.number);
      const expiryField = frame.locator(BREEZE_SEL.expiry);
      if (await expiryField.count() > 0) await expiryField.first().fill('12/29');
      await frame.locator(BREEZE_SEL.submit).click();
      await page.waitForSelector(BREEZE_SEL.payoutDone, { timeout: 30_000 });
      log('  ✓ payout complete', 'pass');
      break;
    }
    default:
      throw new Error(`Unknown test ID: ${testId}`);
  }
}

// ── Shared helpers ────────────────────────────────────────────────────────────
async function fillBreezeCard(
  page: import('playwright-core').Page,
  card: { number: string; cvv: string; expiry: string; zip: string },
  log: LogFn,
): Promise<void> {
  const frame = page.frameLocator(BREEZE_SEL.iframe);
  await frame.locator(BREEZE_SEL.cardNumber).waitFor({ timeout: 20_000 });
  log(`  → filling card ${card.number}`);
  await frame.locator(BREEZE_SEL.cardNumber).fill(card.number);
  await frame.locator(BREEZE_SEL.expiry).fill(card.expiry);
  await frame.locator(BREEZE_SEL.cvv).fill(card.cvv);
  const zip = frame.locator(BREEZE_SEL.zip);
  if (await zip.count() > 0) await zip.first().fill(card.zip);
  log('  → submitting payment…');
  await frame.locator(BREEZE_SEL.submit).click();
}

async function complete3DS(page: import('playwright-core').Page, log: LogFn): Promise<void> {
  log('  → waiting for 3DS simulator…');
  const f = page.frameLocator(BREEZE_SEL.threeds);
  await f.locator(BREEZE_SEL.threedsPass).waitFor({ timeout: 20_000 });
  await f.locator(BREEZE_SEL.threedsPass).fill(THREE_DS_PASSWORD);
  await f.locator('button[type="submit"]').click();
  log(`  → 3DS entered (${THREE_DS_PASSWORD})`);
}

async function stopAndUpload(opts: {
  recording:    boolean;
  cdpSession:   any;
  runFolderId:  string;
  filename:     string;
  emit:         (e: SSEEvent) => void;
  testId:       string;
}): Promise<{ driveLink?: string; driveFileId?: string }> {
  const { recording, cdpSession, runFolderId, filename, emit, testId } = opts;
  if (!recording || !cdpSession || !runFolderId) return {};
  try {
    const res = await (cdpSession as any).send('Browserless.stopRecording') as { value?: string };

    // Guard: recording may be empty if test failed too fast for any frames to capture
    if (!res?.value) {
      emit({ type: 'log', testId, message: '  → no recording data (test was too short)', level: 'dim' });
      return {};
    }

    const buf = Buffer.from(res.value, 'binary');
    if (buf.length < 1024) {
      emit({ type: 'log', testId, message: '  → recording too small to upload (skipping)', level: 'dim' });
      return {};
    }

    emit({ type: 'log', testId, message: `  → uploading ${(buf.length/1024/1024).toFixed(1)}MB to Drive…`, level: 'dim' });
    const upload = await uploadRecording({ buffer: buf, filename, folderId: runFolderId });
    emit({ type: 'log', testId, message: '  → Drive upload complete ✓', level: 'pass' });
    return { driveLink: upload.webViewLink, driveFileId: upload.fileId };
  } catch (e) {
    emit({ type: 'log', testId, message: `  ⚠ Drive upload failed: ${(e as Error).message}`, level: 'warn' });
    return {};
  }
}
