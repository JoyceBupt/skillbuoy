import { access, lstat, readdir, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import type { Installation, Config } from '../schemas/index.js';
import type { Diagnostic } from '../adapters/vercel.js';
import { BuoyError, errorMessage, isMissing } from '../infra/errors.js';
import { hash, readBounded, skillName } from '../infra/snapshot.js';
import { exists, expandPath } from '../infra/store.js';

export async function installationKind(
  real: string,
  entries: string[],
): Promise<Installation['kind']> {
  const paths = [real, ...entries];
  if (paths.some((p) => /\/(?:\.codex|\.claude)\/plugins\//.test(`${p}/`))) return 'plugin';
  if (paths.some((p) => p.split(path.sep).includes('.system'))) return 'system';
  let directory = real;
  while (true) {
    if (await exists(path.join(directory, '.git'))) return 'git';
    const parent = path.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  return 'local';
}

export async function scanDirectories(
  roots: string[],
  config: Config,
): Promise<{ installations: Installation[]; diagnostics: Diagnostic[] }> {
  const found = new Map<string, Installation>();
  const diagnostics: Diagnostic[] = [];
  let visited = 0;
  const walk = async (entry: string, ancestors: Set<string>, depth: number): Promise<void> => {
    if (++visited > 50_000)
      throw new BuoyError('SCAN_LIMIT', 'Scan exceeds 50,000 directories; narrow the roots');
    try {
      const real = await realpath(entry);
      if (ancestors.has(real)) {
        diagnostics.push({ path: entry, message: 'Symbolic link cycle' });
        return;
      }
      if (!(await lstat(real)).isDirectory()) return;
      const skillFile = path.join(entry, 'SKILL.md');
      if (await exists(skillFile)) {
        const existing = found.get(real);
        if (existing) {
          if (!existing.entries.includes(entry)) existing.entries.push(entry);
          return;
        }
        let name = path.basename(entry);
        const errors: string[] = [];
        try {
          name = skillName(await readBounded(skillFile, 256 * 1024));
        } catch (error) {
          errors.push(errorMessage(error));
        }
        try {
          await access(real, constants.R_OK | constants.W_OK);
          await access(path.dirname(real), constants.W_OK);
        } catch {
          errors.push('Installation or its parent is not writable');
        }
        found.set(real, {
          id: hash(real).slice(0, 12),
          name,
          realPath: real,
          entries: [entry],
          kind: 'local',
          managed: false,
          diagnostics: errors,
        });
        return;
      }
      if (depth >= config.maxDepth) {
        diagnostics.push({ path: entry, message: 'Scan depth limit reached' });
        return;
      }
      for (const child of (await readdir(entry, { withFileTypes: true })).sort((a, b) =>
        a.name.localeCompare(b.name),
      )) {
        if (
          config.exclude.includes(child.name) ||
          (child.name.startsWith('.') && child.name !== '.system')
        )
          continue;
        if (child.isDirectory() || child.isSymbolicLink())
          await walk(path.join(entry, child.name), new Set([...ancestors, real]), depth + 1);
      }
    } catch (error) {
      if (error instanceof BuoyError && error.code === 'SCAN_LIMIT') throw error;
      diagnostics.push({ path: entry, message: errorMessage(error) });
    }
  };
  for (const root of new Set(roots.map(expandPath))) {
    if (!(await exists(root))) continue;
    await walk(root, new Set(), 0);
  }
  for (const installation of found.values()) {
    installation.entries.sort();
    installation.kind = await installationKind(installation.realPath, installation.entries);
  }
  return {
    installations: [...found.values()].sort((a, b) => a.realPath.localeCompare(b.realPath)),
    diagnostics,
  };
}

export async function discoverProjects(
  roots: string[],
  config: Config,
): Promise<{ roots: string[]; diagnostics: Diagnostic[] }> {
  const result: string[] = [];
  const diagnostics: Diagnostic[] = [];
  let visited = 0;
  const walk = async (directory: string, depth: number): Promise<void> => {
    if (++visited > 50_000)
      throw new BuoyError('SCAN_LIMIT', 'Project search exceeds 50,000 directories');
    try {
      for (const agent of ['.agents', '.codex', '.claude']) {
        const candidate = path.join(directory, agent, 'skills');
        if (await exists(candidate)) result.push(candidate);
      }
      if (depth >= config.maxDepth) return;
      for (const child of await readdir(directory, { withFileTypes: true })) {
        if (
          child.isDirectory() &&
          !child.name.startsWith('.') &&
          !config.exclude.includes(child.name)
        )
          await walk(path.join(directory, child.name), depth + 1);
      }
    } catch (error) {
      if (error instanceof BuoyError && error.code === 'SCAN_LIMIT') throw error;
      diagnostics.push({
        path: directory,
        message: isMissing(error) ? 'Project root is missing' : errorMessage(error),
      });
    }
  };
  for (const root of roots) await walk(expandPath(root), 0);
  return { roots: result, diagnostics };
}
