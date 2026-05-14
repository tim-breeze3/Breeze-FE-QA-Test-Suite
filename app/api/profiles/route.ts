// app/api/profiles/route.ts
// GET  /api/profiles        — list all profiles
// POST /api/profiles        — create new profile
// PUT  /api/profiles?id=... — update profile
// DELETE /api/profiles?id=... — delete profile

import { NextRequest, NextResponse } from 'next/server';
import { loadProfiles, saveProfile, updateProfile, deleteProfile } from '@/lib/profiles';

export const runtime = 'nodejs';

export async function GET() {
  const profiles = loadProfiles();
  // Never return passwords in list
  const safe = profiles.map(p => ({ ...p, sitePassword: p.sitePassword ? '••••••••' : '' }));
  return NextResponse.json(safe);
}

export async function POST(req: NextRequest) {
  const body = await req.json();
  const profile = saveProfile(body);
  return NextResponse.json(profile);
}

export async function PUT(req: NextRequest) {
  const id = req.nextUrl.searchParams.get('id');
  if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 });
  const body = await req.json();
  const updated = updateProfile(id, body);
  if (!updated) return NextResponse.json({ error: 'not found' }, { status: 404 });
  return NextResponse.json(updated);
}

export async function DELETE(req: NextRequest) {
  const id = req.nextUrl.searchParams.get('id');
  if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 });
  const ok = deleteProfile(id);
  if (!ok) return NextResponse.json({ error: 'not found' }, { status: 404 });
  return NextResponse.json({ deleted: true });
}
