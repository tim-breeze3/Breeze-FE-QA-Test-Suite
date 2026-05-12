'use client';

import { useState, useRef, useEffect, useCallback } from 'react';
import type { RunConfig, TestResult, SSEEvent, SuiteFilter, VideoMode } from '@/lib/types';
import { ALL_TESTS } from '@/lib/types';

// ── Helpers ───────────────────────────────────────────────────────────────────
function ts() {
  const d = new Date();
  return [d.getHours(), d.getMinutes(), d.getSeconds()].map(n => String(n).padStart(2, '0')).join(':');
}

function filterTests(suite: SuiteFilter) {
  return suite === 'all' ? ALL_TESTS : ALL_TESTS.filter(t => t.suite === suite);
}

type LogEntry = { time: string; msg: string; level: string; testId?: string };

// ── Tag colors ────────────────────────────────────────────────────────────────
const TAG_STYLE: Record<string, { bg: string; color: string }> = {
  card:   { bg: 'var(--blue-dim)',   color: 'var(--blue)'   },
  '3DS':  { bg: 'var(--amber-dim)',  color: 'var(--amber)'  },
  payout: { bg: 'var(--accent-dim)', color: 'var(--accent)' },
  KYC:    { bg: 'var(--purple-dim)', color: 'var(--purple)' },
};

const LOG_COLOR: Record<string, string> = {
  info: 'var(--blue)',
  pass: 'var(--accent)',
  fail: 'var(--red)',
  warn: 'var(--amber)',
  dim:  'var(--text-3)',
};

// ── Components ────────────────────────────────────────────────────────────────

function StatusDot({ status }: { status: string }) {
  const styles: Record<string, React.CSSProperties> = {
    idle:    { background: 'var(--border-2)' },
    running: { background: 'var(--blue)', animation: 'pulse 1s infinite' },
    pass:    { background: 'var(--accent)' },
    fail:    { background: 'var(--red)' },
  };
  return (
    <span style={{
      display: 'inline-block', width: 8, height: 8, borderRadius: '50%',
      flexShrink: 0, ...styles[status] ?? styles.idle,
    }} />
  );
}

function TestRow({ test, result, isRunning }: {
  test: typeof ALL_TESTS[0];
  result?: TestResult;
  isRunning: boolean;
}) {
  const status = isRunning ? 'running' : result?.status ?? 'idle';
  const tag = TAG_STYLE[test.tag] ?? { bg: 'var(--border)', color: 'var(--text-2)' };
  const dur = result?.durationMs ? `${(result.durationMs / 1000).toFixed(1)}s` : '';

  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 10, padding: '9px 16px',
      borderBottom: '1px solid var(--border)',
      background: status === 'fail' ? 'var(--red-dim)' : status === 'pass' ? 'var(--accent-dim)' : 'transparent',
      transition: 'background 0.2s',
    }}>
      <StatusDot status={status} />
      <span style={{ flex: 1, color: 'var(--text)' }}>{test.name}</span>
      <span style={{
        fontSize: 10, padding: '2px 8px', borderRadius: 20, fontWeight: 500,
        background: tag.bg, color: tag.color,
      }}>{test.tag}</span>
      {result?.driveLink && (
        <a href={result.driveLink} target="_blank" rel="noreferrer" title="Watch recording in Drive"
          style={{ color: 'var(--text-3)', fontSize: 16, lineHeight: 1 }}>▶</a>
      )}
      <span style={{ color: 'var(--text-3)', minWidth: 36, textAlign: 'right' }}>{dur}</span>
    </div>
  );
}

function VideoModal({ result, onClose }: { result: TestResult; onClose: () => void }) {
  const embedUrl = result.driveFileId
    ? `https://drive.google.com/file/d/${result.driveFileId}/preview`
    : null;

  return (
    <div onClick={onClose} style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.85)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100,
    }}>
      <div onClick={e => e.stopPropagation()} style={{
        background: 'var(--bg-2)', border: '1px solid var(--border-2)',
        borderRadius: var_radius_lg, width: 900, maxWidth: '95vw',
        overflow: 'hidden',
      }}>
        <div style={{
          padding: '12px 16px', borderBottom: '1px solid var(--border)',
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        }}>
          <span style={{ color: 'var(--text-2)', fontSize: 12 }}>{result.name}</span>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
            {result.driveLink && (
              <a href={result.driveLink} target="_blank" rel="noreferrer"
                style={{ fontSize: 11, color: 'var(--accent)' }}>
                Open in Drive ↗
              </a>
            )}
            <button onClick={onClose} style={{
              background: 'none', border: 'none', color: 'var(--text-3)',
              cursor: 'pointer', fontSize: 18, lineHeight: 1,
            }}>✕</button>
          </div>
        </div>
        {embedUrl ? (
          <iframe
            src={embedUrl}
            allow="autoplay"
            style={{ width: '100%', height: 520, border: 'none', display: 'block' }}
          />
        ) : (
          <div style={{ padding: 32, textAlign: 'center', color: 'var(--text-2)' }}>
            No recording available for this test.
          </div>
        )}
      </div>
    </div>
  );
}

// ── Hack: CSS var in JS ───────────────────────────────────────────────────────
const var_radius_lg = 'var(--radius-lg)' as unknown as number;

// ── Main Page ─────────────────────────────────────────────────────────────────
export default function Home() {
  const [appUrl, setAppUrl]       = useState('');
  const [payoutUrl, setPayoutUrl] = useState('');
  const [suite, setSuite]         = useState<SuiteFilter>('all');
  const [videoMode, setVideoMode] = useState<VideoMode>('always');
  const [authOn, setAuthOn]       = useState(false);
  const [siteUser, setSiteUser]   = useState('');
  const [sitePass, setSitePass]   = useState('');
  const [showPass, setShowPass]   = useState(false);

  const [running, setRunning]     = useState(false);
  const [logs, setLogs]           = useState<LogEntry[]>([
    { time: ts(), msg: 'Breeze Bot Tester ready. Paste a URL and hit Run.', level: 'dim' },
  ]);
  const [results, setResults]     = useState<Record<string, TestResult>>({});
  const [runningId, setRunningId] = useState<string | null>(null);
  const [summary, setSummary]     = useState<{ passed: number; failed: number; totalMs: number; driveFolder?: string } | null>(null);
  const [videoModal, setVideoModal] = useState<TestResult | null>(null);

  const termRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (termRef.current) termRef.current.scrollTop = termRef.current.scrollHeight;
  }, [logs]);

  const addLog = useCallback((msg: string, level: string, testId?: string) => {
    setLogs(prev => [...prev, { time: ts(), msg, level, testId }]);
  }, []);

  const tests = filterTests(suite);

  async function startRun() {
    if (!appUrl.trim()) return;
    if (authOn && (!siteUser || !sitePass)) {
      addLog('Auth enabled — please fill in both username and password.', 'warn');
      return;
    }

    setRunning(true);
    setResults({});
    setSummary(null);
    setRunningId(null);
    setLogs([{ time: ts(), msg: `Starting run → ${appUrl}`, level: 'info' }]);

    const config: RunConfig = {
      appUrl: appUrl.trim(),
      ...(payoutUrl.trim() ? { payoutUrl: payoutUrl.trim() } : {}),
      suite, videoMode,
      ...(authOn && siteUser ? { siteUser, sitePassword: sitePass } : {}),
    };

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
          try {
            const event: SSEEvent = JSON.parse(line);
            handleEvent(event);
          } catch { /* malformed line */ }
        }
      }
    } catch (err: unknown) {
      if ((err as Error).name !== 'AbortError') {
        addLog(`Connection error: ${(err as Error).message}`, 'fail');
      }
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
      case 'test_end':
        setRunningId(null);
        setResults(prev => ({ ...prev, [event.result.id]: event.result }));
        break;
      case 'run_end':
        setSummary({
          passed: event.summary.passed,
          failed: event.summary.failed,
          totalMs: event.summary.totalMs ?? 0,
          driveFolder: event.summary.driveFolderLink,
        });
        break;
      case 'error':
        addLog(`Error: ${event.message}`, 'fail');
        break;
    }
  }

  function stopRun() {
    abortRef.current?.abort();
    setRunning(false);
    addLog('Run cancelled.', 'warn');
  }

  const totalTests = tests.length;
  const passCount  = Object.values(results).filter(r => r.status === 'pass').length;
  const failCount  = Object.values(results).filter(r => r.status === 'fail').length;

  // ── Render ──────────────────────────────────────────────────────────────────
  return (
    <>
      <style>{`
        @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.3} }
        @keyframes spin   { to{transform:rotate(360deg)} }
        .fade-in { animation: fadeIn 0.3s ease forwards; }
        @keyframes fadeIn { from{opacity:0;transform:translateY(4px)} to{opacity:1;transform:none} }
        input, select {
          background: var(--bg-3); border: 1px solid var(--border);
          border-radius: var(--radius); color: var(--text);
          font-family: var(--mono); font-size: 13px;
          padding: 0 10px; height: 34px; width: 100%;
          transition: border-color 0.15s;
        }
        input:focus, select:focus { outline: none; border-color: var(--accent); }
        input::placeholder { color: var(--text-3); }
        label { font-size: 11px; color: var(--text-3); text-transform: uppercase;
                letter-spacing: 0.6px; display: block; margin-bottom: 5px; }
        .btn {
          height: 34px; padding: 0 16px; border-radius: var(--radius);
          font-family: var(--mono); font-size: 12px; font-weight: 500;
          cursor: pointer; display: inline-flex; align-items: center; gap: 6px;
          transition: opacity 0.15s, background 0.15s; border: none;
        }
        .btn-primary { background: var(--accent); color: #000; }
        .btn-primary:hover { opacity: 0.85; }
        .btn-danger  { background: var(--red);   color: #fff; }
        .btn-danger:hover { opacity: 0.85; }
        .btn-ghost { background: transparent; border: 1px solid var(--border-2); color: var(--text-2); }
        .btn-ghost:hover { border-color: var(--accent); color: var(--accent); }
        .btn:disabled { opacity: 0.4; cursor: not-allowed; }
        .card {
          background: var(--bg-2); border: 1px solid var(--border);
          border-radius: var(--radius-lg); overflow: hidden;
        }
      `}</style>

      <div style={{ maxWidth: 860, margin: '0 auto', padding: '2rem 1.5rem 4rem' }}>

        {/* Header */}
        <div style={{ marginBottom: '2rem' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
            <span style={{ fontSize: 22 }}>🤖</span>
            <h1 style={{ fontFamily: 'var(--sans)', fontSize: 22, fontWeight: 700, color: 'var(--text)' }}>
              Breeze Bot Tester
            </h1>
            <span style={{
              fontSize: 10, padding: '2px 8px', borderRadius: 20,
              background: 'var(--accent-dim)', color: 'var(--accent)', fontWeight: 500,
            }}>LIVE</span>
          </div>
          <p style={{ color: 'var(--text-2)', fontSize: 12 }}>
            Automated end-to-end testing for Breeze Payments API integrations —
            recordings saved directly to Google Drive.
          </p>
        </div>

        {/* URL bar */}
        <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
          <div style={{ flex: 1 }}>
            <input
              type="url"
              value={appUrl}
              onChange={e => setAppUrl(e.target.value)}
              placeholder="https://your-app.com/checkout"
              onKeyDown={e => e.key === 'Enter' && !running && startRun()}
              disabled={running}
              style={{ fontFamily: 'var(--mono)' }}
            />
          </div>
          {!running ? (
            <button className="btn btn-primary" onClick={startRun} disabled={!appUrl.trim()}>
              ▶ Run tests
            </button>
          ) : (
            <button className="btn btn-danger" onClick={stopRun}>
              ■ Stop
            </button>
          )}
        </div>

        {/* Auth toggle */}
        <label style={{
          display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer',
          marginBottom: 12, width: 'fit-content', textTransform: 'none', letterSpacing: 0,
        }}>
          <input
            type="checkbox"
            checked={authOn}
            onChange={e => setAuthOn(e.target.checked)}
            style={{ width: 14, height: 14, accentColor: 'var(--accent)', cursor: 'pointer' }}
          />
          <span style={{ color: 'var(--text-2)', fontSize: 12 }}>
            🔒 Site requires login
          </span>
        </label>

        {/* Auth fields */}
        {authOn && (
          <div className="fade-in" style={{
            display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 12,
          }}>
            <div style={{ background: 'var(--bg-2)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', padding: '10px 12px' }}>
              <label>Username / Email</label>
              <input type="text" value={siteUser} onChange={e => setSiteUser(e.target.value)}
                placeholder="user@example.com" autoComplete="off" />
            </div>
            <div style={{ background: 'var(--bg-2)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', padding: '10px 12px' }}>
              <label>Password</label>
              <div style={{ display: 'flex', gap: 6 }}>
                <input type={showPass ? 'text' : 'password'} value={sitePass}
                  onChange={e => setSitePass(e.target.value)} placeholder="••••••••" autoComplete="off" />
                <button onClick={() => setShowPass(p => !p)} style={{
                  background: 'none', border: 'none', color: 'var(--text-3)',
                  cursor: 'pointer', flexShrink: 0, fontSize: 14,
                }}>{showPass ? '🙈' : '👁'}</button>
              </div>
            </div>
            <div style={{ gridColumn: '1/-1', fontSize: 11, color: 'var(--text-3)', display: 'flex', gap: 5, alignItems: 'center' }}>
              🛡 Credentials are used only to fill the login form before tests run. Never logged or stored.
            </div>
          </div>
        )}

        {/* Payout URL — optional, only shown when payout suite selected */}
        {(suite === 'all' || suite === 'payout') && (
          <div className="fade-in" style={{ marginBottom: 8 }}>
            <input
              type="url"
              value={payoutUrl}
              onChange={e => setPayoutUrl(e.target.value)}
              placeholder="Payout page URL (optional — defaults to checkout URL)"
              disabled={running}
              style={{ fontFamily: 'var(--mono)' }}
            />
          </div>
        )}

        {/* Config grid */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8, marginBottom: '1.5rem' }}>
          <div style={{ background: 'var(--bg-2)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', padding: '10px 12px' }}>
            <label>Test suite</label>
            <select value={suite} onChange={e => setSuite(e.target.value as SuiteFilter)} disabled={running}>
              <option value="all">All flows</option>
              <option value="payin">Payin only</option>
              <option value="payout">Payout only</option>
              <option value="3ds">3DS flows only</option>
            </select>
          </div>
          <div style={{ background: 'var(--bg-2)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', padding: '10px 12px' }}>
            <label>Recording</label>
            <select value={videoMode} onChange={e => setVideoMode(e.target.value as VideoMode)} disabled={running}>
              <option value="always">Always record → Drive</option>
              <option value="failures">Failures only → Drive</option>
              <option value="off">No recording</option>
            </select>
          </div>
          <div style={{ background: 'var(--bg-2)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', padding: '10px 12px' }}>
            <label>Payout card</label>
            <input type="text" value="4000 0566 5566 5556" readOnly
              style={{ color: 'var(--accent)', cursor: 'default' }} />
          </div>
        </div>

        {/* Test list */}
        <div className="card" style={{ marginBottom: '1.5rem' }}>
          <div style={{
            padding: '8px 16px', borderBottom: '1px solid var(--border)',
            display: 'flex', justifyContent: 'space-between', alignItems: 'center',
          }}>
            <span style={{ color: 'var(--text-2)', fontWeight: 500 }}>Test runs</span>
            <span style={{ color: 'var(--text-3)', fontSize: 11 }}>
              {totalTests} tests · {running ? 'running…' : summary ? 'done' : 'idle'}
            </span>
          </div>
          {tests.map(test => (
            <TestRow
              key={test.id}
              test={test}
              result={results[test.id]}
              isRunning={running && runningId === test.id}
            />
          ))}
        </div>

        {/* Terminal */}
        <div ref={termRef} style={{
          background: '#050708', border: '1px solid var(--border)',
          borderRadius: 'var(--radius-lg)', padding: 14,
          fontFamily: 'var(--mono)', fontSize: 12, lineHeight: 1.7,
          minHeight: 140, maxHeight: 220, overflowY: 'auto',
          marginBottom: '1.5rem',
        }}>
          {logs.map((log, i) => (
            <div key={i} style={{ display: 'flex', gap: 10 }}>
              <span style={{ color: 'var(--text-3)', flexShrink: 0 }}>{log.time}</span>
              <span style={{ color: LOG_COLOR[log.level] ?? 'var(--text-3)' }}>{log.msg}</span>
            </div>
          ))}
        </div>

        {/* Summary stats */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 8, marginBottom: '1.5rem' }}>
          {[
            { n: totalTests,   l: 'total',    c: 'var(--text)' },
            { n: passCount,    l: 'passed',   c: 'var(--accent)' },
            { n: failCount,    l: 'failed',   c: failCount > 0 ? 'var(--red)' : 'var(--text-3)' },
            { n: summary ? `${(summary.totalMs/1000).toFixed(1)}s` : '—', l: 'duration', c: 'var(--text)' },
          ].map(({ n, l, c }) => (
            <div key={l} style={{
              background: 'var(--bg-2)', border: '1px solid var(--border)',
              borderRadius: 'var(--radius)', padding: '10px 14px',
            }}>
              <div style={{ fontSize: 24, fontWeight: 500, color: c, lineHeight: 1 }}>{n || '—'}</div>
              <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 4 }}>{l}</div>
            </div>
          ))}
        </div>

        {/* Action bar */}
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          {summary?.driveFolder && (
            <a href={summary.driveFolder} target="_blank" rel="noreferrer">
              <button className="btn btn-ghost">
                📁 Open Drive folder
              </button>
            </a>
          )}

          {/* Per-test video buttons for results with recordings */}
          {Object.values(results)
            .filter(r => r.driveFileId)
            .slice(0, 3)
            .map(r => (
              <button key={r.id} className="btn btn-ghost"
                onClick={() => setVideoModal(r)}
                style={{ color: r.status === 'fail' ? 'var(--red)' : 'var(--accent)' }}>
                ▶ {r.name.split('·')[0].trim().slice(0, 22)}…
              </button>
            ))
          }

          {videoModal && (
            <VideoModal result={videoModal} onClose={() => setVideoModal(null)} />
          )}
        </div>

        {/* Drive folder banner */}
        {summary?.driveFolder && (
          <div className="fade-in" style={{
            marginTop: '1.5rem', padding: '12px 16px',
            background: 'var(--accent-dim)', border: '1px solid var(--accent)',
            borderRadius: 'var(--radius)', display: 'flex', gap: 10, alignItems: 'center',
          }}>
            <span style={{ fontSize: 16 }}>📁</span>
            <div>
              <div style={{ color: 'var(--accent)', fontWeight: 500, fontSize: 12, marginBottom: 2 }}>
                Recordings saved to Google Drive
              </div>
              <a href={summary.driveFolder} target="_blank" rel="noreferrer"
                style={{ fontSize: 11, color: 'var(--text-2)' }}>
                {summary.driveFolder}
              </a>
            </div>
          </div>
        )}

      </div>
    </>
  );
}
