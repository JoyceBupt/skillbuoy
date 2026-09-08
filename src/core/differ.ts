import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Snapshot } from '../schemas/index.js';
import { disposeTemporary, materialize } from '../infra/snapshot.js';
import { BuoyError } from '../infra/errors.js';

const execute = promisify(execFile);
export interface FileChange {
  path: string;
  change: 'added' | 'deleted' | 'modified';
  binary: boolean;
  oldMode?: number;
  newMode?: number;
}

export async function diffSnapshots(
  before: Snapshot,
  after: Snapshot,
): Promise<{ files: FileChange[]; patch: string }> {
  const left = new Map(before.files.map((file) => [file.path, file]));
  const right = new Map(after.files.map((file) => [file.path, file]));
  const files: FileChange[] = [];
  for (const name of [...new Set([...left.keys(), ...right.keys()])].sort()) {
    const oldFile = left.get(name);
    const newFile = right.get(name);
    if (JSON.stringify(oldFile) === JSON.stringify(newFile)) continue;
    files.push({
      path: name,
      change: !oldFile ? 'added' : !newFile ? 'deleted' : 'modified',
      binary: [oldFile, newFile].some(
        (file) => file?.kind === 'file' && Buffer.from(file.data, 'base64').includes(0),
      ),
      ...(oldFile ? { oldMode: oldFile.mode } : {}),
      ...(newFile ? { newMode: newFile.mode } : {}),
    });
  }
  if (!files.length) return { files, patch: '' };
  const temporary = await mkdtemp(path.join(tmpdir(), 'skillbuoy-diff-'));
  try {
    await materialize(before, path.join(temporary, 'before'));
    await materialize(after, path.join(temporary, 'after'));
    let patch = '';
    try {
      patch = (
        await execute(
          'git',
          [
            '-c',
            'core.hooksPath=/dev/null',
            'diff',
            '--no-index',
            '--no-ext-diff',
            '--no-textconv',
            '--no-color',
            '--',
            'before',
            'after',
          ],
          { cwd: temporary, encoding: 'utf8', timeout: 15_000, maxBuffer: 16 * 1024 * 1024 },
        )
      ).stdout;
    } catch (error) {
      const failure = error as Error & { code?: number; stdout?: string };
      if (failure.code !== 1) throw new BuoyError('DIFF_ERROR', failure.message);
      patch = failure.stdout ?? '';
    }
    return { files, patch };
  } finally {
    await disposeTemporary(temporary);
  }
}
