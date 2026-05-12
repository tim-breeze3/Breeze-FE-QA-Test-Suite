// lib/drive.ts
// Handles all Google Drive interactions:
//   - creating dated run folders
//   - uploading .webm recordings
//   - returning shareable links
//
// Uses a Service Account for fully automated, OAuth-free uploads.
// The service account only has access to folders explicitly shared with it.

import { google, drive_v3 } from 'googleapis';
import { Readable } from 'stream';

function getDriveClient(): drive_v3.Drive {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!raw) throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON is not set');

  const credentials = JSON.parse(raw);

  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/drive.file'],
  });

  return google.drive({ version: 'v3', auth });
}

/**
 * Creates (or reuses) a dated subfolder inside the root recordings folder.
 * e.g. "2026-05-11" inside GOOGLE_DRIVE_FOLDER_ID
 */
export async function getOrCreateRunFolder(runDate: string): Promise<{ folderId: string; folderLink: string }> {
  const drive = getDriveClient();
  const rootFolderId = process.env.GOOGLE_DRIVE_FOLDER_ID;
  if (!rootFolderId) throw new Error('GOOGLE_DRIVE_FOLDER_ID is not set');

  const folderName = runDate; // e.g. "2026-05-11"

  // Check if a folder for today already exists
  const existing = await drive.files.list({
    q: `name='${folderName}' and mimeType='application/vnd.google-apps.folder' and '${rootFolderId}' in parents and trashed=false`,
    fields: 'files(id, webViewLink)',
  });

  if (existing.data.files && existing.data.files.length > 0) {
    const folder = existing.data.files[0];
    return { folderId: folder.id!, folderLink: folder.webViewLink! };
  }

  // Create new dated folder
  const created = await drive.files.create({
    requestBody: {
      name: folderName,
      mimeType: 'application/vnd.google-apps.folder',
      parents: [rootFolderId],
    },
    fields: 'id, webViewLink',
  });

  // Make it readable by anyone with the link (so you can share results easily)
  await drive.permissions.create({
    fileId: created.data.id!,
    requestBody: { role: 'reader', type: 'anyone' },
  });

  return { folderId: created.data.id!, folderLink: created.data.webViewLink! };
}

export interface UploadResult {
  fileId: string;
  webViewLink: string;    // opens in Drive's video player
  directLink: string;     // direct download link
}

/**
 * Uploads a .webm video buffer to a specific Drive folder.
 * Returns the file ID and shareable link.
 */
export async function uploadRecording(opts: {
  buffer: Buffer;
  filename: string;        // e.g. "t1-visa-success-14h32m.webm"
  folderId: string;
}): Promise<UploadResult> {
  const drive = getDriveClient();

  const res = await drive.files.create({
    requestBody: {
      name: opts.filename,
      parents: [opts.folderId],
      mimeType: 'video/webm',
    },
    media: {
      mimeType: 'video/webm',
      body: Readable.from(opts.buffer),
    },
    fields: 'id, webViewLink, webContentLink',
  });

  const fileId = res.data.id!;

  // Make the file readable by anyone with the link
  await drive.permissions.create({
    fileId,
    requestBody: { role: 'reader', type: 'anyone' },
  });

  return {
    fileId,
    webViewLink: res.data.webViewLink!,
    directLink: `https://drive.google.com/uc?export=download&id=${fileId}`,
  };
}

/**
 * Builds a Google Drive embed URL for inline video playback.
 * Use in an <iframe> with allow="autoplay".
 */
export function driveEmbedUrl(fileId: string): string {
  return `https://drive.google.com/file/d/${fileId}/preview`;
}
