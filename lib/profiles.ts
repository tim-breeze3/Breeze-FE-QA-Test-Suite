// lib/profiles.ts
//
// Phase 3: Site profile persistence.
// Profiles are stored as a JSON file on the Railway volume.
// In production you could swap this for a database — the interface stays the same.

import * as fs from 'fs';
import * as path from 'path';
import { v4 as uuidv4 } from 'uuid';
import type { SiteProfile } from './types';

// Railway provides a persistent volume — store profiles there if available
// Falls back to /tmp for local dev (profiles won't survive restarts)
const DATA_DIR = process.env.RAILWAY_VOLUME_MOUNT_PATH
  ? path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH, 'breeze-bot')
  : path.join(process.cwd(), '.data');

const PROFILES_FILE = path.join(DATA_DIR, 'profiles.json');

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

export function loadProfiles(): SiteProfile[] {
  ensureDir();
  if (!fs.existsSync(PROFILES_FILE)) return [];
  try {
    return JSON.parse(fs.readFileSync(PROFILES_FILE, 'utf-8')) as SiteProfile[];
  } catch {
    return [];
  }
}

export function saveProfile(profile: Omit<SiteProfile, 'id' | 'createdAt'>): SiteProfile {
  ensureDir();
  const profiles = loadProfiles();
  const newProfile: SiteProfile = {
    ...profile,
    id: uuidv4(),
    createdAt: new Date().toISOString(),
  };
  profiles.push(newProfile);
  fs.writeFileSync(PROFILES_FILE, JSON.stringify(profiles, null, 2));
  return newProfile;
}

export function updateProfile(id: string, updates: Partial<SiteProfile>): SiteProfile | null {
  ensureDir();
  const profiles = loadProfiles();
  const idx = profiles.findIndex(p => p.id === id);
  if (idx === -1) return null;
  profiles[idx] = { ...profiles[idx], ...updates };
  fs.writeFileSync(PROFILES_FILE, JSON.stringify(profiles, null, 2));
  return profiles[idx];
}

export function deleteProfile(id: string): boolean {
  ensureDir();
  const profiles = loadProfiles();
  const filtered = profiles.filter(p => p.id !== id);
  if (filtered.length === profiles.length) return false;
  fs.writeFileSync(PROFILES_FILE, JSON.stringify(filtered, null, 2));
  return true;
}

export function getProfile(id: string): SiteProfile | null {
  return loadProfiles().find(p => p.id === id) ?? null;
}
