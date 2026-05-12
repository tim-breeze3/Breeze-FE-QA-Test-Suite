// app/api/run/route.ts
//
// POST /api/run
// Streams SSE events back to the browser as tests run.
// Railway has no function timeout — tests can run as long as needed.

import { NextRequest } from 'next/server';
import { runTests } from '@/lib/runner';
import type { RunConfig, SSEEvent } from '@/lib/types';

// Railway runs standard Node.js — no edge runtime, no maxDuration needed
export const runtime = 'nodejs';

export async function POST(req: NextRequest) {
  const config: RunConfig = await req.json();

  if (!config.appUrl) {
    return new Response(JSON.stringify({ error: 'appUrl is required' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      const emit = (event: SSEEvent) => {
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        } catch {
          // Client disconnected
        }
      };

      try {
        await runTests(config, emit);
      } catch (err) {
        emit({ type: 'error', message: (err as Error).message });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type':      'text/event-stream',
      'Cache-Control':     'no-cache, no-transform',
      'Connection':        'keep-alive',
      'X-Accel-Buffering': 'no',  // tells nginx/proxies not to buffer the stream
    },
  });
}
