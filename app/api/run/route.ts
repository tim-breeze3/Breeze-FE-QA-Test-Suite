import { NextRequest } from 'next/server';
import { runTests } from '@/lib/runner';
import type { RunConfig, SSEEvent } from '@/lib/types';

export const runtime = 'nodejs';

export async function POST(req: NextRequest) {
  const config: RunConfig = await req.json();
  if (!config.profile?.url) {
    return new Response(JSON.stringify({ error: 'profile.url is required' }), {
      status: 400, headers: { 'Content-Type': 'application/json' },
    });
  }
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const emit = (event: SSEEvent) => {
        try { controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`)); } catch {}
      };
      try { await runTests(config, emit); }
      catch (err) { emit({ type: 'error', message: (err as Error).message }); }
      finally { controller.close(); }
    },
  });
  return new Response(stream, {
    headers: {
      'Content-Type':      'text/event-stream',
      'Cache-Control':     'no-cache, no-transform',
      'Connection':        'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}
