// lib/types.ts — shared types across API and frontend

export type TestStatus  = 'idle' | 'running' | 'pass' | 'fail' | 'skipped';
export type RunStatus   = 'pending' | 'running' | 'complete' | 'error';
export type SuiteFilter = 'all' | 'payin' | 'payout' | '3ds';
export type VideoMode   = 'always' | 'failures' | 'off';

export interface TestDefinition {
  id:          string;
  name:        string;
  tag:         string;
  suite:       SuiteFilter;
  description: string;
}

export interface TestResult {
  id:           string;
  name:         string;
  tag:          string;
  status:       TestStatus;
  durationMs?:  number;
  error?:       string;
  driveLink?:   string;   // Google Drive webViewLink for video
  driveFileId?: string;   // Drive file ID for inline embed
}

export interface RunConfig {
  /** Merchant checkout page — bot navigates here, Breeze iframe is already present */
  appUrl:        string;
  /** Optional separate URL for payout flows — defaults to appUrl */
  payoutUrl?:    string;
  suite:         SuiteFilter;
  videoMode:     VideoMode;
  siteUser?:     string;
  sitePassword?: string;
}

export interface RunResult {
  runId:            string;
  status:           RunStatus;
  config:           RunConfig;
  results:          TestResult[];
  startedAt:        string;
  completedAt?:     string;
  totalMs?:         number;
  passed:           number;
  failed:           number;
  driveFolderLink?: string;
}

// SSE event types streamed from /api/run to the browser
export type SSEEvent =
  | { type: 'run_start';  runId: string; total: number }
  | { type: 'test_start'; testId: string; name: string }
  | { type: 'log';        testId?: string; message: string; level: 'info' | 'pass' | 'fail' | 'warn' | 'dim' }
  | { type: 'test_end';   result: TestResult }
  | { type: 'run_end';    summary: RunResult }
  | { type: 'error';      message: string };

// ── Test catalog ──────────────────────────────────────────────────────────────
// Pure UI tests. The bot navigates to the merchant's URL, waits for the
// Breeze iframe that the merchant's own backend already loaded, and drives it.
// Zero Breeze API calls needed here.
export const ALL_TESTS: TestDefinition[] = [
  {
    id: 't1', tag: 'card', suite: 'payin',
    name: 'Visa success (US · 4000020000000000)',
    description: 'Successful US Visa — expects success state in merchant UI',
  },
  {
    id: 't2', tag: 'card', suite: 'payin',
    name: 'Visa declined (4539467987109256)',
    description: 'Always-declining Visa — expects error message in Breeze iframe',
  },
  {
    id: 't3', tag: 'card', suite: 'payin',
    name: 'Visa GB debit success (4659105569051157)',
    description: 'Successful GB Visa debit card',
  },
  {
    id: 't4', tag: 'card', suite: 'payin',
    name: 'Visa prepaid declined (4000148147058142)',
    description: 'Always-declining prepaid — expects error message',
  },
  {
    id: 't5', tag: '3DS', suite: '3ds',
    name: 'Mastercard 3DS2 challenge (5385308360135181)',
    description: 'Triggers 3DS simulator, enters Checkout1!, expects success',
  },
  {
    id: 't6', tag: '3DS', suite: '3ds',
    name: 'Amex 3DS2 challenge (372688581899681)',
    description: 'Amex 3DS flow, enters Checkout1!, expects success',
  },
  {
    id: 't7', tag: '3DS', suite: '3ds',
    name: 'Mastercard FR 3DS2 (5137210000000158)',
    description: 'Cartes Bancaires / Mastercard FR 3DS flow',
  },
  {
    id: 't8', tag: 'payout', suite: 'payout',
    name: 'Payout card · 4000 0566 5566 5556',
    description: 'Navigates to payout URL, fills payout card, expects completion state',
  },
];
