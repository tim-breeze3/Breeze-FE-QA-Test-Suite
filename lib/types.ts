// lib/types.ts

export type TestStatus  = 'idle' | 'running' | 'pass' | 'fail' | 'skipped';
export type RunStatus   = 'pending' | 'running' | 'complete' | 'error';
export type SuiteFilter = 'all' | 'payin' | 'payout' | '3ds';
export type VideoMode   = 'always' | 'failures' | 'off';

// ── Site Profile (Phase 3 — saved per merchant) ───────────────────────────────
export interface SiteProfile {
  id:        string;
  name:      string;
  url:       string;
  createdAt: string;

  // HTTP Basic Auth (server-level browser prompt — separate from login form)
  // Used when the site is behind staging/dev HTTP auth (e.g. staging2.site.com)
  httpUser?:     string;
  httpPassword?: string;

  // Login form credentials (UI-level — filled into the actual login form)
  siteUser?:     string;
  sitePassword?: string;

  // Phase 1: Navigation hint selectors
  loginTriggerSel?:    string;
  loginEmailSel?:      string;
  loginPassSel?:       string;
  loginSubmitSel?:     string;
  postLoginSel?:       string;
  purchaseTriggerSel?: string;
  packageSel?:         string;
  breezeReadySel?:     string;
  payoutTriggerSel?:   string;

  // Phase 2: AI assist flags
  useVisionFallback:   boolean;
  requireConfirmation: boolean;
}

// ── Navigation step (emitted live for UI display) ─────────────────────────────
export interface NavStep {
  step:             string;
  method:           'selector' | 'vision' | 'direct';
  selector?:        string;
  success:          boolean;
  screenshotB64?:   string;
  visionReasoning?: string;
}

// ── Run config ────────────────────────────────────────────────────────────────
export interface RunConfig {
  profile:   SiteProfile;
  suite:     SuiteFilter;
  videoMode: VideoMode;
}

// ── Test result ───────────────────────────────────────────────────────────────
export interface TestResult {
  id:           string;
  name:         string;
  tag:          string;
  status:       TestStatus;
  durationMs?:  number;
  error?:       string;
  driveLink?:   string;
  driveFileId?: string;
  navSteps?:    NavStep[];
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

// ── SSE events streamed from /api/run ─────────────────────────────────────────
export type SSEEvent =
  | { type: 'run_start';  runId: string; total: number }
  | { type: 'test_start'; testId: string; name: string }
  | { type: 'log';        testId?: string; message: string; level: 'info' | 'pass' | 'fail' | 'warn' | 'dim' }
  | { type: 'nav_step';   testId?: string; step: NavStep }
  | { type: 'screenshot'; testId?: string; b64: string; caption: string }
  | { type: 'test_end';   result: TestResult }
  | { type: 'run_end';    summary: RunResult }
  | { type: 'error';      message: string };

// ── Test catalog ──────────────────────────────────────────────────────────────
export interface TestDefinition {
  id: string; name: string; tag: string;
  suite: SuiteFilter; description: string;
}

export const ALL_TESTS: TestDefinition[] = [
  { id: 't1', tag: 'card',   suite: 'payin',  name: 'Visa success (US · 4000020000000000)',     description: 'Full purchase journey → Visa success' },
  { id: 't2', tag: 'card',   suite: 'payin',  name: 'Visa declined (4539467987109256)',         description: 'Full journey → card decline in iframe' },
  { id: 't3', tag: 'card',   suite: 'payin',  name: 'Visa GB debit (4659105569051157)',         description: 'Full journey → debit success' },
  { id: 't4', tag: 'card',   suite: 'payin',  name: 'Visa prepaid declined (4000148147058142)', description: 'Full journey → prepaid decline' },
  { id: 't5', tag: '3DS',    suite: '3ds',    name: 'Mastercard 3DS2 (5385308360135181)',       description: 'Full journey → 3DS challenge → success' },
  { id: 't6', tag: '3DS',    suite: '3ds',    name: 'Amex 3DS2 (372688581899681)',              description: 'Full journey → Amex 3DS → success' },
  { id: 't7', tag: '3DS',    suite: '3ds',    name: 'Mastercard FR 3DS2 (5137210000000158)',    description: 'Full journey → Cartes Bancaires 3DS' },
  { id: 't8', tag: 'payout', suite: 'payout', name: 'Payout · 4000 0566 5566 5556',            description: 'Full payout journey → push-to-card' },
];
