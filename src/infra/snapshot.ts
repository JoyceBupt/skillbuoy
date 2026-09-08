import { constants } from 'node:fs';
import {
  chmod,
  lstat,
  mkdir,
  open,
  readlink,
  readdir,
  realpath,
  rm,
  symlink,
} from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { parseDocument } from 'yaml';
import { z } from 'zod';
import type { Snapshot, SnapshotFile } from '../schemas/index.js';
import { BuoyError } from './errors.js';

export const LIMITS = {
  files: 2000,
  fileBytes: 8 * 1024 * 1024,
  totalBytes: 50 * 1024 * 1024,
  depth: 32,
};
export const hash = (value: string | Buffer): string =>
  createHash('sha256').update(value).digest('hex');
// oxlint-disable-next-line no-control-regex -- Reject control bytes and backslashes in untrusted paths.
const unsafePathCharacters = /[\\\x00-\x1f\x7f]/;

export function inside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return (
    relative === '' ||
    (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
  );
}

export function relativePath(value: string, allowRoot = false): string {
  if (allowRoot && value === '.') return value;
  if (
    !value ||
    value.startsWith('/') ||
    unsafePathCharacters.test(value) ||
    value.split('/').some((p) => !p || p === '.' || p === '..' || p.toLowerCase() === '.git') ||
    value.split('/').length > LIMITS.depth
  ) {
    throw new BuoyError('UNSAFE_PATH', `Unsafe Skill path: ${JSON.stringify(value)}`);
  }
  return value;
}

export async function readBounded(file: string, limit: number): Promise<Buffer> {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size > limit)
      throw new BuoyError('FILE_LIMIT', `Not a regular file or size limit exceeded: ${file}`);
    const output = Buffer.alloc(Math.min(before.size + 1, limit + 1));
    let length = 0;
    while (length < output.length) {
      const read = await handle.read(output, length, output.length - length, null);
      if (!read.bytesRead) break;
      length += read.bytesRead;
    }
    const after = await handle.stat();
    if (
      length !== before.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs
    ) {
      throw new BuoyError('LOCAL_CHANGED', `File changed while reading: ${file}`);
    }
    return output.subarray(0, length);
  } finally {
    await handle.close();
  }
}

export function skillName(content: Buffer): string {
  if (content.length > 256 * 1024) throw new BuoyError('INVALID_SKILL', 'SKILL.md exceeds 256 KiB');
  const match = content
    .toString('utf8')
    .replace(/^\uFEFF/, '')
    .match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) throw new BuoyError('INVALID_SKILL', 'SKILL.md needs YAML frontmatter');
  const document = parseDocument(match[1]!, { uniqueKeys: true });
  if (document.errors.length)
    throw new BuoyError('INVALID_SKILL', document.errors.map((e) => e.message).join('; '));
  const result = z
    .object({ name: z.string().min(1).max(64), description: z.string().min(1).max(1024) })
    .safeParse(document.toJS({ maxAliasCount: 0 }));
  if (!result.success)
    throw new BuoyError('INVALID_SKILL', 'SKILL.md needs a name and description');
  return result.data.name;
}

export function makeSnapshot(files: SnapshotFile[]): Snapshot {
  const sorted = [...files].sort((a, b) =>
    Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)),
  );
  const snapshot = { fingerprint: hash(JSON.stringify(sorted)), files: sorted };
  validateSnapshot(snapshot);
  return snapshot;
}

export function validateSnapshot(snapshot: Snapshot): void {
  if (snapshot.files.length > LIMITS.files)
    throw new BuoyError('FILE_LIMIT', 'Skill has too many entries');
  const entries = new Map<string, SnapshotFile>();
  let total = 0;
  for (const file of snapshot.files) {
    relativePath(file.path);
    if (entries.has(file.path)) throw new BuoyError('UNSAFE_PATH', `Duplicate path: ${file.path}`);
    entries.set(file.path, file);
    const bytes = Buffer.from(file.data, 'base64');
    if (bytes.toString('base64') !== file.data)
      throw new BuoyError('INVALID_SNAPSHOT', `Invalid content: ${file.path}`);
    if (file.kind === 'link' && !Buffer.from(bytes.toString('utf8'), 'utf8').equals(bytes))
      throw new BuoyError('UNSAFE_LINK', 'Non-UTF-8 link targets are not supported');
    total += bytes.length;
    if (bytes.length > LIMITS.fileBytes || total > LIMITS.totalBytes)
      throw new BuoyError('FILE_LIMIT', 'Skill exceeds content limits');
    if (file.kind === 'directory' && file.data !== '')
      throw new BuoyError('INVALID_SNAPSHOT', 'Directory contains file data');
    if (
      file.kind === 'file' &&
      bytes.subarray(0, 128).toString().startsWith('version https://git-lfs.github.com/spec/v1')
    ) {
      throw new BuoyError('UNSUPPORTED_LFS', `Git LFS is not supported: ${file.path}`);
    }
  }
  for (const file of snapshot.files) {
    let parent = path.posix.dirname(file.path);
    while (parent !== '.') {
      if (entries.get(parent)?.kind !== 'directory')
        throw new BuoyError('UNSAFE_PATH', `Missing or unsafe parent: ${file.path}`);
      parent = path.posix.dirname(parent);
    }
  }
  const resolveLink = (value: string, seen: Set<string>): void => {
    if (seen.size > LIMITS.depth)
      throw new BuoyError('UNSAFE_LINK', 'Symbolic link chain exceeds depth limit');
    const parts = value.split('/');
    for (let i = 0; i < parts.length; i++) {
      const prefix = parts.slice(0, i + 1).join('/');
      const file = entries.get(prefix);
      if (file?.kind !== 'link') continue;
      if (seen.has(prefix)) throw new BuoyError('UNSAFE_LINK', `Link cycle: ${prefix}`);
      const target = Buffer.from(file.data, 'base64').toString('utf8');
      if (
        !target ||
        path.posix.isAbsolute(target) ||
        target.includes('\\') ||
        target.includes('\0')
      )
        throw new BuoyError('UNSAFE_LINK', `Unsafe link: ${prefix}`);
      const destination = path.posix.normalize(
        path.posix.join(path.posix.dirname(prefix), target, ...parts.slice(i + 1)),
      );
      if (destination === '..' || destination.startsWith('../'))
        throw new BuoyError('UNSAFE_LINK', `Link escapes Skill: ${prefix}`);
      resolveLink(destination, new Set([...seen, prefix]));
      return;
    }
  };
  for (const file of snapshot.files) if (file.kind === 'link') resolveLink(file.path, new Set());
  const sorted = [...snapshot.files].sort((a, b) =>
    Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)),
  );
  if (hash(JSON.stringify(sorted)) !== snapshot.fingerprint)
    throw new BuoyError('INVALID_SNAPSHOT', 'Snapshot checksum mismatch');
}

export function validateSkill(snapshot: Snapshot): string {
  const file = snapshot.files.find((f) => f.path === 'SKILL.md');
  if (file?.kind !== 'file')
    throw new BuoyError('INVALID_SKILL', 'SKILL.md must be a regular file');
  return skillName(Buffer.from(file.data, 'base64'));
}

export async function readSnapshot(root: string): Promise<Snapshot> {
  if ((await lstat(root)).isSymbolicLink())
    throw new BuoyError('PATH_CHANGED', `Expected real directory: ${root}`);
  const canonical = await realpath(root);
  const files: SnapshotFile[] = [];
  let total = 0;
  const walk = async (directory: string, prefix: string): Promise<void> => {
    const before = await lstat(directory);
    if (!before.isDirectory() || (await realpath(directory)) !== directory)
      throw new BuoyError('PATH_CHANGED', `Directory changed: ${directory}`);
    for (const name of (await readdir(directory)).sort()) {
      const relative = prefix ? `${prefix}/${name}` : name;
      relativePath(relative);
      if (files.length >= LIMITS.files)
        throw new BuoyError('FILE_LIMIT', 'Skill has too many entries');
      const absolute = path.join(directory, name);
      const info = await lstat(absolute);
      if (!info.isSymbolicLink() && info.mode & 0o7000)
        throw new BuoyError(
          'UNSUPPORTED_MODE',
          `Special permission bits are not supported: ${absolute}`,
        );
      if (info.isSymbolicLink()) {
        files.push({
          path: relative,
          kind: 'link',
          mode: 0o777,
          data: (await readlink(absolute, { encoding: 'buffer' })).toString('base64'),
        });
      } else if (info.isDirectory()) {
        files.push({ path: relative, kind: 'directory', mode: info.mode & 0o777, data: '' });
        await walk(absolute, relative);
      } else if (info.isFile()) {
        const data = await readBounded(
          absolute,
          Math.min(LIMITS.fileBytes, LIMITS.totalBytes - total),
        );
        total += data.length;
        files.push({
          path: relative,
          kind: 'file',
          mode: info.mode & 0o777,
          data: data.toString('base64'),
        });
      } else throw new BuoyError('UNSUPPORTED_FILE', `Special file is not supported: ${absolute}`);
    }
    const after = await lstat(directory);
    if (before.ino !== after.ino || before.mtimeMs !== after.mtimeMs)
      throw new BuoyError('LOCAL_CHANGED', `Directory changed while reading: ${directory}`);
  };
  await walk(canonical, '');
  return makeSnapshot(files);
}

export async function materialize(snapshot: Snapshot, destination: string): Promise<void> {
  validateSnapshot(snapshot);
  await mkdir(destination, { mode: 0o700 });
  const directories = snapshot.files
    .filter((f) => f.kind === 'directory')
    .sort((a, b) => a.path.split('/').length - b.path.split('/').length);
  for (const file of directories) await mkdir(path.join(destination, file.path), { mode: 0o700 });
  for (const file of snapshot.files.filter((f) => f.kind === 'file')) {
    const handle = await open(path.join(destination, file.path), 'wx', 0o600);
    try {
      await handle.writeFile(Buffer.from(file.data, 'base64'));
      await handle.chmod(file.mode);
      await handle.sync();
    } finally {
      await handle.close();
    }
  }
  for (const file of snapshot.files.filter((f) => f.kind === 'link')) {
    await symlink(
      Buffer.from(file.data, 'base64').toString('utf8'),
      path.join(destination, file.path),
    );
  }
  for (const file of directories.reverse()) {
    const directory = path.join(destination, file.path);
    const handle = await open(directory, 'r');
    try {
      await handle.chmod(file.mode);
      await handle.sync();
    } finally {
      await handle.close();
    }
  }
  const handle = await open(destination, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

// Only call for a disposable, exclusively-created temporary directory.
export async function disposeTemporary(directory: string): Promise<void> {
  const unlock = async (entry: string): Promise<void> => {
    const info = await lstat(entry);
    if (!info.isDirectory()) return;
    await chmod(entry, 0o700);
    for (const name of await readdir(entry)) await unlock(path.join(entry, name));
  };
  await unlock(directory);
  await rm(directory, { recursive: true });
}
