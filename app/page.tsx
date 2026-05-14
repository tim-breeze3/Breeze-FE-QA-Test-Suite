'use client';

import { useState, useRef, useEffect, useCallback } from 'react';
import type { SiteProfile, RunConfig, TestResult, SSEEvent, NavStep, SuiteFilter, VideoMode } from '@/lib/types';
import { ALL_TESTS } from '@/lib/types';

// ── Helpers ───────────────────────────────────────────────────────────────────
const ts = () => new Date().toLocaleTimeString('en-US', { hour12: false });
const filterTests = (suite: SuiteFilter) =>
  suite === 'all' ? ALL_TESTS : ALL_TESTS.filter(t => t.suite === suite);

const TAG: Record<string, { bg: string; color: string }> = {
  card:   { bg: '#1e3a5f', color: '#60a5fa' },
  '3DS':  { bg: '#3d2c00', color: '#fbbf24' },
  payout: { bg: '#064e3b', color: '#34d399' },
};
const LOG_COLOR: Record<string, string> = {
  info: '#60a5fa', pass: '#34d399', fail: '#f87171', warn: '#fbbf24', dim: '#4b5563',
};
const NAV_STEP_LABELS: Record<string, string> = {
  login_trigger: '🔐 Login trigger', post_login: '✅ Post-login',
  login_email: '📧 Email field', login_password: '🔒 Password field',
  login_submit: '▶ Submit login', purchase_trigger: '🛒 Buy Coins',
  package_select: '📦 Select package', breeze_ready: '💳 Breeze iframe',
  payout_trigger: '💸 Payout trigger', new_tab: '🗂 New tab',
};

type LogEntry = { time: string; msg: string; level: string; testId?: string };

// ── Blank profile ─────────────────────────────────────────────────────────────
const BLANK_PROFILE: Omit<SiteProfile, 'id' | 'createdAt'> = {
  name: '', url: '',
  httpUser: '', httpPassword: '',
  siteUser: '', sitePassword: '',
  loginTriggerSel: '', loginEmailSel: '', loginPassSel: '',
  loginSubmitSel: '', postLoginSel: '', purchaseTriggerSel: '',
  packageSel: '', breezeReadySel: '', payoutTriggerSel: '',
  useVisionFallback: true, requireConfirmation: false,
};

// ── Sub-components ────────────────────────────────────────────────────────────

function NavStepBadge({ step }: { step: NavStep }) {
  const color = step.success ? '#34d399' : '#f87171';
  const bg    = step.success ? '#064e3b' : '#450a0a';
  return (
    <div style={{
      display: 'inline-flex', alignItems: 'center', gap: 6,
      background: bg, border: `1px solid ${color}22`,
      borderRadius: 6, padding: '3px 8px', fontSize: 11, marginRight: 4, marginBottom: 4,
    }}>
      <span style={{ color, fontWeight: 500 }}>{NAV_STEP_LABELS[step.step] ?? step.step}</span>
      <span style={{ color: '#6b7280', fontSize: 10 }}>via {step.method}</span>
      {step.visionReasoning && (
        <span title={step.visionReasoning} style={{ cursor: 'help', color: '#a78bfa' }}>🤖</span>
      )}
    </div>
  );
}

function TestRow({ test, result, isRunning, navSteps, onVideo }: {
  test: typeof ALL_TESTS[0];
  result?: TestResult;
  isRunning: boolean;
  navSteps: NavStep[];
  onVideo: () => void;
}) {
  const status = isRunning ? 'running' : result?.status ?? 'idle';
  const statusColor = { pass: '#34d399', fail: '#f87171', running: '#60a5fa', idle: '#374151' }[status] ?? '#374151';
  const tag = TAG[test.tag] ?? { bg: '#1f2937', color: '#9ca3af' };
  const dur = result?.durationMs ? `${(result.durationMs/1000).toFixed(1)}s` : '';

  return (
    <div style={{
      borderBottom: '1px solid #1f2937',
      background: status === 'fail' ? '#1c0a0a' : status === 'pass' ? '#071a0f' : 'transparent',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 16px' }}>
        <div style={{
          width: 8, height: 8, borderRadius: '50%', flexShrink: 0,
          background: statusColor,
          animation: isRunning ? 'pulse 1s infinite' : 'none',
        }} />
        <span style={{ flex: 1, fontSize: 13, color: '#e5e7eb' }}>{test.name}</span>
        <span style={{ fontSize: 10, padding: '2px 8px', borderRadius: 20, background: tag.bg, color: tag.color, fontWeight: 500 }}>
          {test.tag}
        </span>
        {result?.driveFileId && (
          <button onClick={onVideo} title="Watch recording" style={{
            background: 'none', border: 'none', cursor: 'pointer',
            color: '#60a5fa', fontSize: 14, padding: '0 4px',
          }}>▶</button>
        )}
        <span style={{ color: '#4b5563', minWidth: 36, textAlign: 'right', fontSize: 11 }}>{dur}</span>
      </div>
      {navSteps.length > 0 && (
        <div style={{ padding: '0 16px 10px', display: 'flex', flexWrap: 'wrap' }}>
          {navSteps.map((s, i) => <NavStepBadge key={i} step={s} />)}
        </div>
      )}
      {result?.error && (
        <div style={{ padding: '0 16px 8px', fontSize: 11, color: '#f87171', fontFamily: 'monospace' }}>
          ✕ {result.error}
        </div>
      )}
    </div>
  );
}

function VideoModal({ result, onClose }: { result: TestResult; onClose: () => void }) {
  return (
    <div onClick={onClose} style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.9)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100,
    }}>
      <div onClick={e => e.stopPropagation()} style={{
        background: '#111417', border: '1px solid #1f2937',
        borderRadius: 12, width: 920, maxWidth: '95vw', overflow: 'hidden',
      }}>
        <div style={{
          padding: '10px 16px', borderBottom: '1px solid #1f2937',
          display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        }}>
          <span style={{ fontSize: 12, color: '#9ca3af' }}>{result.name}</span>
          <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
            {result.driveLink && (
              <a href={result.driveLink} target="_blank" rel="noreferrer" style={{ fontSize: 11, color: '#34d399' }}>
                Open in Drive ↗
              </a>
            )}
            <button onClick={onClose} style={{ background: 'none', border: 'none', color: '#6b7280', cursor: 'pointer', fontSize: 18 }}>✕</button>
          </div>
        </div>
        {result.driveFileId ? (
          <iframe src={`https://drive.google.com/file/d/${result.driveFileId}/preview`}
            allow="autoplay" style={{ width: '100%', height: 520, border: 'none', display: 'block' }} />
        ) : (
          <div style={{ padding: 40, textAlign: 'center', color: '#6b7280' }}>No recording available</div>
        )}
      </div>
    </div>
  );
}

// ── Profile editor ────────────────────────────────────────────────────────────
function ProfileEditor({ profile, onChange, onSave, onCancel, saving }: {
  profile: Omit<SiteProfile, 'id' | 'createdAt'>;
  onChange: (p: Omit<SiteProfile, 'id' | 'createdAt'>) => void;
  onSave: () => void;
  onCancel: () => void;
  saving: boolean;
}) {
  const field = (label: string, key: keyof typeof BLANK_PROFILE, type = 'text', placeholder = '') => (
    <div style={{ marginBottom: 10 }}>
      <label style={{ fontSize: 11, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.5px', display: 'block', marginBottom: 4 }}>
        {label}
      </label>
      <input
        type={type}
        value={profile[key] as string ?? ''}
        onChange={e => onChange({ ...profile, [key]: e.target.value })}
        placeholder={placeholder}
        style={{
          width: '100%', background: '#0a0c0f', border: '1px solid #1f2937',
          borderRadius: 6, color: '#e5e7eb', fontFamily: 'monospace',
          fontSize: 12, padding: '6px 10px', height: 32,
        }}
      />
    </div>
  );

  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.85)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 50,
    }}>
      <div style={{
        background: '#111417', border: '1px solid #1f2937',
        borderRadius: 12, width: 640, maxWidth: '95vw',
        maxHeight: '90vh', overflowY: 'auto',
      }}>
        <div style={{ padding: '14px 20px', borderBottom: '1px solid #1f2937', display: 'flex', justifyContent: 'space-between' }}>
          <span style={{ fontWeight: 500, color: '#e5e7eb' }}>
            {profile.name ? `Edit: ${profile.name}` : 'New Site Profile'}
          </span>
          <button onClick={onCancel} style={{ background: 'none', border: 'none', color: '#6b7280', cursor: 'pointer', fontSize: 18 }}>✕</button>
        </div>

        <div style={{ padding: 20 }}>
          {/* Basic info */}
          <div style={{ marginBottom: 16, fontSize: 11, color: '#4b5563', textTransform: 'uppercase', letterSpacing: 1 }}>
            ── Basic Info
          </div>
          {field('Site Name', 'name', 'text', 'Lucky Coins Casino')}
          {field('Landing Page URL', 'url', 'url', 'https://luckycasino.com')}

          {/* HTTP Basic Auth */}
          <div style={{ margin: '16px 0 10px', fontSize: 11, color: '#f87171', textTransform: 'uppercase', letterSpacing: 1 }}>
            ── HTTP Basic Auth (optional)
          </div>
          <p style={{ fontSize: 11, color: '#6b7280', marginBottom: 10 }}>
            Server-level auth (browser popup prompt). Used for staging/dev environments.
            Separate from the login form credentials below.
          </p>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 10 }}>
            <div>
              {field('HTTP username', 'httpUser', 'text', 'staging')}
            </div>
            <div>
              {field('HTTP password', 'httpPassword', 'password', '••••••••')}
            </div>
          </div>

          {/* Login form credentials */}
          <div style={{ margin: '16px 0 10px', fontSize: 11, color: '#4b5563', textTransform: 'uppercase', letterSpacing: 1 }}>
            ── Login Form Credentials
          </div>
          <p style={{ fontSize: 11, color: '#6b7280', marginBottom: 10 }}>
            UI-level credentials filled into the site's actual login form.
          </p>
          {field('Username / Email', 'siteUser', 'text', 'bot@test.com')}
          {field('Password', 'sitePassword', 'password', '••••••••')}

          {/* Phase 1: Navigation hints */}
          <div style={{ margin: '16px 0 6px', fontSize: 11, color: '#60a5fa', textTransform: 'uppercase', letterSpacing: 1 }}>
            ── Phase 1: Navigation Hints
          </div>
          <p style={{ fontSize: 11, color: '#6b7280', marginBottom: 10 }}>
            CSS selectors for each step. Leave blank to let Vision AI figure it out.
          </p>
          {field('Login button selector', 'loginTriggerSel', 'text', 'button:has-text("Sign In")')}
          {field('Email field selector', 'loginEmailSel', 'text', 'input[name="email"]')}
          {field('Password field selector', 'loginPassSel', 'text', 'input[type="password"]')}
          {field('Login submit selector', 'loginSubmitSel', 'text', 'button[type="submit"]')}
          {field('Post-login confirmation selector', 'postLoginSel', 'text', '.user-balance, .user-avatar')}
          {field('Buy Coins / Shop button selector', 'purchaseTriggerSel', 'text', 'button:has-text("Buy Coins")')}
          {field('Coin package selector', 'packageSel', 'text', '.package-card:first-child')}
          {field('Breeze iframe ready selector', 'breezeReadySel', 'text', 'iframe[src*="breeze"]')}
          {field('Withdraw / Payout button selector', 'payoutTriggerSel', 'text', 'button:has-text("Withdraw")')}

          {/* Phase 2: AI assist */}
          <div style={{ margin: '16px 0 10px', fontSize: 11, color: '#a78bfa', textTransform: 'uppercase', letterSpacing: 1 }}>
            ── Phase 2: AI Vision Assist
          </div>
          <label style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer', marginBottom: 10 }}>
            <input type="checkbox" checked={profile.useVisionFallback}
              onChange={e => onChange({ ...profile, useVisionFallback: e.target.checked })}
              style={{ width: 14, height: 14, accentColor: '#a78bfa' }} />
            <span style={{ fontSize: 12, color: '#9ca3af' }}>
              Use Claude Vision when selectors fail
            </span>
          </label>
          <label style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer' }}>
            <input type="checkbox" checked={profile.requireConfirmation}
              onChange={e => onChange({ ...profile, requireConfirmation: e.target.checked })}
              style={{ width: 14, height: 14, accentColor: '#a78bfa' }} />
            <span style={{ fontSize: 12, color: '#9ca3af' }}>
              Emit screenshots at each major step (for review)
            </span>
          </label>
        </div>

        <div style={{ padding: '14px 20px', borderTop: '1px solid #1f2937', display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button onClick={onCancel} style={{
            height: 32, padding: '0 16px', background: 'none', border: '1px solid #374151',
            borderRadius: 6, color: '#9ca3af', cursor: 'pointer', fontSize: 12,
          }}>Cancel</button>
          <button onClick={onSave} disabled={!profile.name || !profile.url || saving} style={{
            height: 32, padding: '0 16px', background: '#34d399', border: 'none',
            borderRadius: 6, color: '#000', fontWeight: 500, cursor: 'pointer', fontSize: 12,
            opacity: (!profile.name || !profile.url || saving) ? 0.5 : 1,
          }}>{saving ? 'Saving…' : 'Save Profile'}</button>
        </div>
      </div>
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────
export default function Home() {
  const [profiles, setProfiles]     = useState<SiteProfile[]>([]);
  const [activeProfile, setActive]  = useState<SiteProfile | null>(null);
  const [editingProfile, setEditing] = useState<Omit<SiteProfile, 'id' | 'createdAt'> | null>(null);
  const [editingId, setEditingId]   = useState<string | null>(null);
  const [saving, setSaving]         = useState(false);

  const [suite, setSuite]           = useState<SuiteFilter>('all');
  const [videoMode, setVideoMode]   = useState<VideoMode>('always');
  const [running, setRunning]       = useState(false);

  const [logs, setLogs]             = useState<LogEntry[]>([{ time: ts(), msg: 'Ready. Create or select a site profile to begin.', level: 'dim' }]);
  const [results, setResults]       = useState<Record<string, TestResult>>({});
  const [runningId, setRunningId]   = useState<string | null>(null);
  const [navStepsMap, setNavSteps]  = useState<Record<string, NavStep[]>>({});
  const [screenshots, setScreenshots] = useState<{ b64: string; caption: string }[]>([]);
  const [summary, setSummary]       = useState<{ passed: number; failed: number; totalMs: number; driveFolder?: string } | null>(null);
  const [videoModal, setVideoModal] = useState<TestResult | null>(null);
  const [activeTab, setActiveTab]   = useState<'run' | 'screenshots'>('run');

  const termRef  = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    fetch('/api/profiles').then(r => r.json()).then(setProfiles).catch(() => {});
  }, []);

  useEffect(() => {
    if (termRef.current) termRef.current.scrollTop = termRef.current.scrollHeight;
  }, [logs]);

  const addLog = useCallback((msg: string, level: string, testId?: string) =>
    setLogs(prev => [...prev, { time: ts(), msg, level, testId }]), []);

  const tests = filterTests(suite);

  // ── Profile CRUD ────────────────────────────────────────────────────────────
  async function handleSaveProfile() {
    setSaving(true);
    try {
      if (editingId) {
        const res = await fetch(`/api/profiles?id=${editingId}`, {
          method: 'PUT', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(editingProfile),
        });
        const updated = await res.json();
        setProfiles(prev => prev.map(p => p.id === editingId ? updated : p));
        if (activeProfile?.id === editingId) setActive(updated);
      } else {
        const res = await fetch('/api/profiles', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(editingProfile),
        });
        const created = await res.json();
        setProfiles(prev => [...prev, created]);
        setActive(created);
      }
    } finally {
      setSaving(false);
      setEditing(null);
      setEditingId(null);
    }
  }

  async function handleDeleteProfile(id: string) {
    if (!confirm('Delete this profile?')) return;
    await fetch(`/api/profiles?id=${id}`, { method: 'DELETE' });
    setProfiles(prev => prev.filter(p => p.id !== id));
    if (activeProfile?.id === id) setActive(null);
  }

  // ── Run tests ───────────────────────────────────────────────────────────────
  async function startRun() {
    if (!activeProfile || running) return;
    setRunning(true);
    setResults({});
    setNavSteps({});
    setScreenshots([]);
    setSummary(null);
    setRunningId(null);
    setLogs([{ time: ts(), msg: `Starting: ${activeProfile.name}`, level: 'info' }]);

    const config: RunConfig = { profile: activeProfile, suite, videoMode };
    const abort = new AbortController();
    abortRef.current = abort;

    try {
      const res = await fetch('/api/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(config),
        signal: abort.signal,
      });
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let buf = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const parts = buf.split('\n\n');
        buf = parts.pop() ?? '';
        for (const part of parts) {
          const line = part.replace(/^data: /, '').trim();
          if (!line) continue;
          try { handleEvent(JSON.parse(line) as SSEEvent); } catch {}
        }
      }
    } catch (e: any) {
      if (e.name !== 'AbortError') addLog(`Connection error: ${e.message}`, 'fail');
    } finally {
      setRunning(false);
      setRunningId(null);
    }
  }

  function handleEvent(event: SSEEvent) {
    switch (event.type) {
      case 'log':
        addLog(event.message, event.level, event.testId);
        break;
      case 'test_start':
        setRunningId(event.testId);
        break;
      case 'nav_step':
        if (event.testId) {
          setNavSteps(prev => ({
            ...prev,
            [event.testId!]: [...(prev[event.testId!] ?? []), event.step],
          }));
        }
        break;
      case 'screenshot':
        setScreenshots(prev => [...prev, { b64: event.b64, caption: event.caption }]);
        setActiveTab('screenshots');
        break;
      case 'test_end':
        setRunningId(null);
        setResults(prev => ({ ...prev, [event.result.id]: event.result }));
        break;
      case 'run_end':
        setSummary({ passed: event.summary.passed, failed: event.summary.failed, totalMs: event.summary.totalMs ?? 0, driveFolder: event.summary.driveFolderLink });
        break;
      case 'error':
        addLog(`Error: ${event.message}`, 'fail');
        break;
    }
  }

  function stopRun() { abortRef.current?.abort(); addLog('Run cancelled.', 'warn'); }

  const passCount = Object.values(results).filter(r => r.status === 'pass').length;
  const failCount = Object.values(results).filter(r => r.status === 'fail').length;

  // ── Render ──────────────────────────────────────────────────────────────────
  return (
    <>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500&family=Syne:wght@500;700&display=swap');
        *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
        body { background: #0a0c0f; color: #e5e7eb; font-family: 'IBM Plex Mono', monospace; font-size: 13px; }
        @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.3} }
        @keyframes fadeIn { from{opacity:0;transform:translateY(6px)} to{opacity:1;transform:none} }
        .fade { animation: fadeIn 0.25s ease forwards; }
        input, select { background: #0a0c0f; border: 1px solid #1f2937; border-radius: 6px; color: #e5e7eb; font-family: 'IBM Plex Mono', monospace; font-size: 12px; padding: 0 10px; height: 32px; width: 100%; transition: border-color 0.15s; }
        input:focus, select:focus { outline: none; border-color: #34d399; }
        input::placeholder { color: #374151; }
        a { color: #34d399; text-decoration: none; }
        a:hover { text-decoration: underline; }
        ::-webkit-scrollbar { width: 4px; } ::-webkit-scrollbar-thumb { background: #1f2937; border-radius: 2px; }
      `}</style>

      <div style={{ display: 'grid', gridTemplateColumns: '260px 1fr', minHeight: '100vh' }}>

        {/* ── Sidebar: profiles ────────────────────────────────────────────── */}
        <div style={{ background: '#0d1117', borderRight: '1px solid #1f2937', display: 'flex', flexDirection: 'column' }}>
          <div style={{ padding: '16px 14px 12px', borderBottom: '1px solid #1f2937' }}>
            <div style={{ fontFamily: 'Syne, sans-serif', fontSize: 16, fontWeight: 700, color: '#e5e7eb', marginBottom: 2 }}>
              🤖 Breeze Bot
            </div>
            <div style={{ fontSize: 11, color: '#4b5563' }}>Frontend QA Automation</div>
          </div>

          <div style={{ padding: '10px 10px 6px', borderBottom: '1px solid #1f2937', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span style={{ fontSize: 11, color: '#4b5563', textTransform: 'uppercase', letterSpacing: 1 }}>Site Profiles</span>
            <button onClick={() => { setEditing({ ...BLANK_PROFILE }); setEditingId(null); }} style={{
              background: '#064e3b', border: '1px solid #34d39922', borderRadius: 4,
              color: '#34d399', fontSize: 11, padding: '3px 8px', cursor: 'pointer',
            }}>+ New</button>
          </div>

          <div style={{ flex: 1, overflowY: 'auto' }}>
            {profiles.length === 0 && (
              <div style={{ padding: '20px 14px', fontSize: 11, color: '#374151', textAlign: 'center', lineHeight: 1.8 }}>
                No profiles yet.<br />Click <strong style={{ color: '#34d399' }}>+ New</strong> to add a site.
              </div>
            )}
            {profiles.map(p => (
              <div key={p.id} onClick={() => setActive(p)} style={{
                padding: '10px 14px', cursor: 'pointer', borderBottom: '1px solid #1f2937',
                background: activeProfile?.id === p.id ? '#0f2015' : 'transparent',
                borderLeft: activeProfile?.id === p.id ? '2px solid #34d399' : '2px solid transparent',
                transition: 'background 0.1s',
              }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                  <div>
                    <div style={{ fontSize: 12, fontWeight: 500, color: activeProfile?.id === p.id ? '#34d399' : '#e5e7eb', marginBottom: 2 }}>
                      {p.name}
                    </div>
                    <div style={{ fontSize: 10, color: '#4b5563' }}>{new URL(p.url).hostname}</div>
                  </div>
                  <div style={{ display: 'flex', gap: 6 }}>
                    <button onClick={e => { e.stopPropagation(); setEditing({ ...p }); setEditingId(p.id); }} style={{
                      background: 'none', border: 'none', color: '#4b5563', cursor: 'pointer', fontSize: 12, padding: 2,
                    }}>✎</button>
                    <button onClick={e => { e.stopPropagation(); handleDeleteProfile(p.id); }} style={{
                      background: 'none', border: 'none', color: '#4b5563', cursor: 'pointer', fontSize: 12, padding: 2,
                    }}>✕</button>
                  </div>
                </div>
                <div style={{ marginTop: 4, display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                  {p.useVisionFallback && (
                    <span style={{ fontSize: 9, padding: '1px 5px', borderRadius: 10, background: '#1e1b4b', color: '#a78bfa' }}>AI Vision</span>
                  )}
                  {p.httpUser && (
                    <span style={{ fontSize: 9, padding: '1px 5px', borderRadius: 10, background: '#450a0a', color: '#f87171' }}>HTTP Auth</span>
                  )}
                  {p.siteUser && (
                    <span style={{ fontSize: 9, padding: '1px 5px', borderRadius: 10, background: '#1c1917', color: '#78716c' }}>Login</span>
                  )}
                </div>
              </div>
            ))}
          </div>

          {/* Config */}
          <div style={{ padding: '12px 14px', borderTop: '1px solid #1f2937' }}>
            <div style={{ marginBottom: 8 }}>
              <label style={{ fontSize: 10, color: '#4b5563', textTransform: 'uppercase', letterSpacing: 1, display: 'block', marginBottom: 4 }}>Suite</label>
              <select value={suite} onChange={e => setSuite(e.target.value as SuiteFilter)} disabled={running}>
                <option value="all">All flows</option>
                <option value="payin">Payin only</option>
                <option value="payout">Payout only</option>
                <option value="3ds">3DS only</option>
              </select>
            </div>
            <div style={{ marginBottom: 10 }}>
              <label style={{ fontSize: 10, color: '#4b5563', textTransform: 'uppercase', letterSpacing: 1, display: 'block', marginBottom: 4 }}>Recording</label>
              <select value={videoMode} onChange={e => setVideoMode(e.target.value as VideoMode)} disabled={running}>
                <option value="always">Always → Drive</option>
                <option value="failures">Failures only</option>
                <option value="off">Off</option>
              </select>
            </div>
            {!running ? (
              <button onClick={startRun} disabled={!activeProfile} style={{
                width: '100%', height: 36, background: activeProfile ? '#34d399' : '#1f2937',
                border: 'none', borderRadius: 6, color: '#000', fontWeight: 500,
                fontFamily: 'IBM Plex Mono, monospace', fontSize: 13, cursor: activeProfile ? 'pointer' : 'not-allowed',
                transition: 'opacity 0.15s',
              }}>
                {activeProfile ? `▶ Run ${filterTests(suite).length} tests` : 'Select a profile'}
              </button>
            ) : (
              <button onClick={stopRun} style={{
                width: '100%', height: 36, background: '#7f1d1d', border: 'none',
                borderRadius: 6, color: '#fca5a5', fontWeight: 500,
                fontFamily: 'IBM Plex Mono, monospace', fontSize: 13, cursor: 'pointer',
              }}>■ Stop</button>
            )}
          </div>
        </div>

        {/* ── Main content ─────────────────────────────────────────────────── */}
        <div style={{ display: 'flex', flexDirection: 'column', minHeight: '100vh', overflow: 'hidden' }}>

          {/* Active profile header */}
          <div style={{ padding: '12px 20px', borderBottom: '1px solid #1f2937', display: 'flex', alignItems: 'center', gap: 12, flexShrink: 0 }}>
            {activeProfile ? (
              <>
                <div>
                  <div style={{ fontFamily: 'Syne, sans-serif', fontSize: 15, fontWeight: 700 }}>{activeProfile.name}</div>
                  <div style={{ fontSize: 11, color: '#4b5563' }}>{activeProfile.url}</div>
                </div>
                <div style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
                  {activeProfile.useVisionFallback && (
                    <span style={{ fontSize: 11, padding: '3px 8px', borderRadius: 20, background: '#1e1b4b', color: '#a78bfa', border: '1px solid #a78bfa33' }}>
                      🤖 AI Vision ON
                    </span>
                  )}
                  {activeProfile.siteUser && (
                    <span style={{ fontSize: 11, padding: '3px 8px', borderRadius: 20, background: '#1c1917', color: '#78716c', border: '1px solid #78716c33' }}>
                      🔐 Auth
                    </span>
                  )}
                </div>
              </>
            ) : (
              <span style={{ color: '#374151', fontSize: 12 }}>← Select or create a site profile</span>
            )}
          </div>

          {/* Tabs */}
          <div style={{ display: 'flex', borderBottom: '1px solid #1f2937', flexShrink: 0 }}>
            {(['run', 'screenshots'] as const).map(tab => (
              <button key={tab} onClick={() => setActiveTab(tab)} style={{
                padding: '8px 16px', background: 'none', border: 'none', cursor: 'pointer',
                fontSize: 12, color: activeTab === tab ? '#34d399' : '#4b5563',
                borderBottom: activeTab === tab ? '2px solid #34d399' : '2px solid transparent',
                textTransform: 'capitalize', fontFamily: 'IBM Plex Mono, monospace',
              }}>
                {tab} {tab === 'screenshots' && screenshots.length > 0 && `(${screenshots.length})`}
              </button>
            ))}
          </div>

          <div style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column' }}>
            {activeTab === 'run' && (
              <>
                {/* Test list */}
                <div style={{ borderBottom: '1px solid #1f2937' }}>
                  <div style={{ padding: '8px 16px', borderBottom: '1px solid #1f2937', display: 'flex', justifyContent: 'space-between' }}>
                    <span style={{ fontSize: 11, color: '#4b5563' }}>Tests</span>
                    <span style={{ fontSize: 11, color: '#374151' }}>
                      {tests.length} tests · {running ? 'running…' : summary ? 'done' : 'idle'}
                    </span>
                  </div>
                  {tests.map(test => (
                    <TestRow
                      key={test.id}
                      test={test}
                      result={results[test.id]}
                      isRunning={running && runningId === test.id}
                      navSteps={navStepsMap[test.id] ?? []}
                      onVideo={() => setVideoModal(results[test.id])}
                    />
                  ))}
                </div>

                {/* Terminal */}
                <div ref={termRef} style={{
                  background: '#050708', padding: '12px 14px', fontFamily: 'IBM Plex Mono, monospace',
                  fontSize: 12, lineHeight: 1.7, minHeight: 160, maxHeight: 220,
                  overflowY: 'auto', flexShrink: 0,
                }}>
                  {logs.map((l, i) => (
                    <div key={i} style={{ display: 'flex', gap: 10 }}>
                      <span style={{ color: '#374151', flexShrink: 0 }}>{l.time}</span>
                      <span style={{ color: LOG_COLOR[l.level] ?? '#4b5563' }}>{l.msg}</span>
                    </div>
                  ))}
                </div>

                {/* Stats */}
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 8, padding: '12px 16px', flexShrink: 0 }}>
                  {[
                    { n: tests.length, l: 'total',    c: '#e5e7eb' },
                    { n: passCount,    l: 'passed',   c: '#34d399' },
                    { n: failCount,    l: 'failed',   c: failCount > 0 ? '#f87171' : '#374151' },
                    { n: summary ? `${(summary.totalMs/1000).toFixed(1)}s` : '—', l: 'duration', c: '#e5e7eb' },
                  ].map(({ n, l, c }) => (
                    <div key={l} style={{ background: '#0d1117', border: '1px solid #1f2937', borderRadius: 8, padding: '10px 14px' }}>
                      <div style={{ fontSize: 22, fontWeight: 500, color: c, lineHeight: 1 }}>{n || '—'}</div>
                      <div style={{ fontSize: 11, color: '#374151', marginTop: 4 }}>{l}</div>
                    </div>
                  ))}
                </div>

                {/* Drive folder banner */}
                {summary?.driveFolder && (
                  <div className="fade" style={{
                    margin: '0 16px 16px', padding: '10px 14px',
                    background: '#071a0f', border: '1px solid #34d39933', borderRadius: 8,
                    display: 'flex', gap: 10, alignItems: 'center',
                  }}>
                    <span>📁</span>
                    <div>
                      <div style={{ color: '#34d399', fontSize: 12, fontWeight: 500, marginBottom: 2 }}>
                        Recordings saved to Google Drive
                      </div>
                      <a href={summary.driveFolder} target="_blank" rel="noreferrer" style={{ fontSize: 11, color: '#4b5563' }}>
                        {summary.driveFolder}
                      </a>
                    </div>
                  </div>
                )}
              </>
            )}

            {activeTab === 'screenshots' && (
              <div style={{ padding: 16 }}>
                {screenshots.length === 0 ? (
                  <div style={{ textAlign: 'center', color: '#374151', padding: 40, fontSize: 12 }}>
                    Vision AI screenshots will appear here when selectors fail and the bot uses Claude to analyze the page.
                  </div>
                ) : (
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                    {screenshots.map((s, i) => (
                      <div key={i} style={{ background: '#0d1117', border: '1px solid #1f2937', borderRadius: 8, overflow: 'hidden' }}>
                        <div style={{ padding: '6px 10px', borderBottom: '1px solid #1f2937', fontSize: 11, color: '#6b7280' }}>
                          🤖 {s.caption}
                        </div>
                        <img src={`data:image/png;base64,${s.b64}`} alt={s.caption}
                          style={{ width: '100%', display: 'block' }} />
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Profile editor modal */}
      {editingProfile && (
        <ProfileEditor
          profile={editingProfile}
          onChange={setEditing}
          onSave={handleSaveProfile}
          onCancel={() => { setEditing(null); setEditingId(null); }}
          saving={saving}
        />
      )}

      {/* Video modal */}
      {videoModal && <VideoModal result={videoModal} onClose={() => setVideoModal(null)} />}
    </>
  );
}
