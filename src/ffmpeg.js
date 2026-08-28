import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function candidatePaths() {
  const configured = String(process.env.FFMPEG_PATH ?? '').trim();
  const localNames = process.platform === 'win32'
    ? [
        path.join(rootDir, 'runtime', 'ffmpeg', 'bin', 'ffmpeg.exe'),
        path.join(rootDir, 'runtime', 'ffmpeg.exe')
      ]
    : [
        path.join(rootDir, 'runtime', 'ffmpeg', 'bin', 'ffmpeg'),
        path.join(rootDir, 'runtime', 'ffmpeg')
      ];
  return [configured, ...localNames].filter(Boolean);
}

export function getFfmpegPath() {
  for (const candidate of candidatePaths()) {
    try {
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {}
  }
  return 'ffmpeg';
}

export const __test = { candidatePaths };
