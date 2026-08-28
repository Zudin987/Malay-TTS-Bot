import fs from 'node:fs';
import path from 'node:path';

function writeTempFile(targetPath, text) {
  const dir = path.dirname(targetPath);
  fs.mkdirSync(dir, { recursive: true });
  const tempPath = path.join(
    dir,
    `.${path.basename(targetPath)}.${process.pid}.${Date.now()}.tmp`
  );

  const fd = fs.openSync(tempPath, 'wx');
  try {
    fs.writeFileSync(fd, text, 'utf8');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  return tempPath;
}

function replaceFileAtomically(targetPath, tempPath) {
  try {
    fs.renameSync(tempPath, targetPath);
    return;
  } catch (firstError) {
    // Windows can refuse replacing an existing destination. Move the old file
    // aside first, then install the completed temp file. If anything fails,
    // restore the old file rather than leaving a partial JSON document.
    if (!fs.existsSync(targetPath)) throw firstError;

    const oldPath = `${targetPath}.${process.pid}.old`;
    try {
      try { fs.unlinkSync(oldPath); } catch {}
      fs.renameSync(targetPath, oldPath);
      try {
        fs.renameSync(tempPath, targetPath);
      } catch (error) {
        try {
          if (!fs.existsSync(targetPath) && fs.existsSync(oldPath)) {
            fs.renameSync(oldPath, targetPath);
          }
        } catch {}
        throw error;
      }
      try { fs.unlinkSync(oldPath); } catch {}
    } catch (error) {
      try { fs.unlinkSync(tempPath); } catch {}
      throw error;
    }
  }
}

export function writeTextAtomic(targetPath, text) {
  const tempPath = writeTempFile(targetPath, text);
  try {
    replaceFileAtomically(targetPath, tempPath);
  } finally {
    try { fs.unlinkSync(tempPath); } catch {}
  }
}

export function writeBackupText(backupPath, text) {
  if (typeof text !== 'string' || text.length === 0) return;
  // Backups are JSON too; never replace a known-good backup with invalid text.
  JSON.parse(text);
  writeTextAtomic(backupPath, text.endsWith('\n') ? text : `${text}\n`);
}

export function readJsonFile(filePath) {
  const text = fs.readFileSync(filePath, 'utf8');
  return { text, value: JSON.parse(text) };
}

export function readJsonWithBackup(filePath, fallbackValue) {
  try {
    const primary = readJsonFile(filePath);
    return { ...primary, source: 'primary' };
  } catch (primaryError) {
    const backupPath = `${filePath}.bak`;
    try {
      const backup = readJsonFile(backupPath);
      return { ...backup, source: 'backup', primaryError };
    } catch {
      return { value: fallbackValue, text: null, source: 'fallback', primaryError };
    }
  }
}

export function writeJsonAtomicWithBackup(filePath, value, previousValidText = null) {
  const rawText = `${JSON.stringify(value, null, 2)}\n`;
  // Verify the exact serialized payload before touching either destination.
  JSON.parse(rawText);

  const backupPath = `${filePath}.bak`;
  let backupText = previousValidText;

  if (!backupText) {
    try {
      const current = readJsonFile(filePath);
      backupText = current.text;
    } catch {}
  }

  if (backupText) writeBackupText(backupPath, backupText);
  writeTextAtomic(filePath, rawText);
  return rawText;
}
