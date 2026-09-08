import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, lstat, readdir } from 'node:fs/promises';
import path from 'node:path';
import type { Snapshot, SnapshotFile, Source } from '../schemas/index.js';
import { objectIdSchema } from '../schemas/index.js';
import { BuoyError, isMissing, sanitize } from './errors.js';
import { hash, LIMITS, makeSnapshot, relativePath, validateSkill } from './snapshot.js';
import { exists } from './store.js';

const execute = promisify(execFile);
// oxlint-disable-next-line no-control-regex -- Repository addresses must not contain control bytes.
const repositoryControlCharacters = /[\x00-\x1f\x7f]/;
// oxlint-disable-next-line no-control-regex -- Reject Git ref metacharacters, whitespace and control bytes.
const unsafeRefCharacters = /[\x00-\x20\x7f~^:?*[\\]/;
const gitOptions = [
  '-c',
  'core.hooksPath=/dev/null',
  '-c',
  'protocol.allow=never',
  '-c',
  'protocol.https.allow=always',
  '-c',
  'protocol.ssh.allow=always',
  '-c',
  'protocol.file.allow=always',
  '-c',
  'fetch.fsckObjects=true',
  '-c',
  'transfer.fsckObjects=true',
  '-c',
  'core.quotePath=false',
];

export function validateRepo(repo: string): string {
  if (!repo || repositoryControlCharacters.test(repo) || repo.startsWith('-'))
    throw new BuoyError('INVALID_SOURCE', 'Invalid repository address');
  if (path.isAbsolute(repo)) return path.resolve(repo);
  if (repo.includes(' '))
    throw new BuoyError('INVALID_SOURCE', 'Repository URLs must encode spaces');
  if (/^[a-zA-Z0-9_]+@[a-zA-Z0-9.-]+:[a-zA-Z0-9_./-]+$/.test(repo)) return repo;
  let url: URL;
  try {
    url = new URL(repo);
  } catch {
    throw new BuoyError(
      'INVALID_SOURCE',
      'Use an HTTPS/SSH repository URL or an absolute local repository path',
    );
  }
  if (
    !['https:', 'ssh:'].includes(url.protocol) ||
    !url.hostname ||
    url.password ||
    url.search ||
    url.hash ||
    url.hostname.startsWith('-') ||
    (url.protocol === 'ssh:' &&
      url.username &&
      !/^[a-zA-Z0-9_][a-zA-Z0-9_.-]*$/.test(url.username)) ||
    (url.protocol === 'https:' && url.username)
  )
    throw new BuoyError(
      'INVALID_SOURCE',
      'Repository URL contains credentials or an unsupported transport',
    );
  return repo;
}

export function validateRef(ref: string): string {
  if (
    !ref ||
    ref.startsWith('-') ||
    unsafeRefCharacters.test(ref) ||
    ref.includes('..') ||
    ref.includes('@{') ||
    ref.startsWith('/') ||
    ref.endsWith('/') ||
    ref.endsWith('.') ||
    ref.split('/').some((p) => !p || p.startsWith('.') || p.endsWith('.lock'))
  ) {
    throw new BuoyError('INVALID_REF', `Invalid Git reference: ${JSON.stringify(ref)}`);
  }
  return ref;
}

export function validateSource(source: Source): Source {
  validateRepo(source.repo);
  relativePath(source.path, true);
  if (source.ref) validateRef(source.ref);
  if (source.tracking === 'commit') objectIdSchema.parse(source.ref);
  if (source.tracking === 'tag' && !source.ref)
    throw new BuoyError('INVALID_REF', 'A tag name is required');
  return source;
}

export async function runGit(
  args: string[],
  options: { cwd?: string; limit?: number; signal?: AbortSignal } = {},
): Promise<Buffer> {
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_')),
  );
  try {
    const result = await execute('git', [...gitOptions, ...args], {
      cwd: options.cwd,
      env: {
        ...environment,
        GIT_TERMINAL_PROMPT: '0',
        GCM_INTERACTIVE: 'never',
        GIT_SSH_COMMAND: 'ssh -oBatchMode=yes',
        GIT_CONFIG_COUNT: '0',
      },
      encoding: 'buffer',
      timeout: 60_000,
      maxBuffer: options.limit ?? 16 * 1024 * 1024,
      signal: options.signal,
    });
    return result.stdout;
  } catch (error) {
    const failure = error as Error & { stderr?: Buffer; code?: string | number };
    throw new BuoyError(
      'GIT_ERROR',
      `Git ${args.find((a) => !a.startsWith('-')) ?? 'operation'} failed (${failure.code ?? 'unknown'}): ${sanitize(failure.stderr?.toString() || failure.message).slice(0, 1000)}`,
    );
  }
}

export interface Target {
  commit: string;
  tree: string;
  snapshot: Snapshot;
  pinned: boolean;
}

export class GitCache {
  private fetched = new Map<
    string,
    Promise<{ directory: string; commit: string; pinned: boolean }>
  >();
  constructor(private readonly cacheRoot: string) {}

  private async repositoryBytes(directory: string): Promise<number> {
    let total = 0;
    for (const name of await readdir(directory)) {
      const entry = path.join(directory, name);
      try {
        const info = await lstat(entry);
        if (info.isSymbolicLink())
          throw new BuoyError('UNSAFE_CACHE', 'Repository cache contains a symbolic link');
        total += info.isDirectory() ? await this.repositoryBytes(entry) : info.size;
      } catch (error) {
        if (!isMissing(error)) throw error;
      }
    }
    return total;
  }

  private async fetch(
    source: Source,
  ): Promise<{ directory: string; commit: string; pinned: boolean }> {
    validateSource(source);
    const directory = path.join(this.cacheRoot, hash(source.repo));
    if (!(await exists(directory))) {
      await mkdir(directory, { mode: 0o700 });
      await runGit(['init', '--bare', '--template=', directory]);
    }
    if (!(await lstat(directory)).isDirectory())
      throw new BuoyError('UNSAFE_CACHE', 'Invalid repository cache');
    let ref = source.ref;
    let pinned = source.tracking === 'tag' || source.tracking === 'commit';
    if (!ref) {
      const output = (
        await runGit(['ls-remote', '--symref', '--', source.repo, 'HEAD'])
      ).toString();
      ref = output.match(/^ref: (refs\/heads\/[^\t\n]+)\tHEAD$/m)?.[1];
      if (!ref) throw new BuoyError('INVALID_REF', 'Remote has no resolvable default branch');
    } else if (source.tracking === 'branch')
      ref = `refs/heads/${ref.replace(/^refs\/heads\//, '')}`;
    else if (source.tracking === 'tag') ref = `refs/tags/${ref.replace(/^refs\/tags\//, '')}`;
    else if (source.tracking === 'ref') {
      if (ref.startsWith('refs/heads/') || ref.startsWith('refs/tags/'))
        pinned = ref.startsWith('refs/tags/');
      else if (/^[a-f0-9]{40}([a-f0-9]{24})?$/.test(ref)) pinned = true;
      else {
        const output = (
          await runGit([
            'ls-remote',
            '--refs',
            '--',
            source.repo,
            `refs/heads/${ref}`,
            `refs/tags/${ref}`,
          ])
        ).toString();
        const matches = output
          .trim()
          .split('\n')
          .filter(Boolean)
          .map((line) => line.split('\t')[1]!);
        if (matches.length !== 1)
          throw new BuoyError(
            'INVALID_REF',
            'Imported reference is missing or ambiguous; bind an explicit branch/tag',
          );
        ref = matches[0]!;
        pinned = ref.startsWith('refs/tags/');
      }
    }
    validateRef(ref);
    const controller = new AbortController();
    let monitorError: unknown;
    let checking: Promise<void> | undefined;
    const monitor = (): Promise<void> => {
      if (checking) return checking;
      checking = (async () => {
        try {
          if ((await this.repositoryBytes(directory)) > 512 * 1024 * 1024)
            throw new BuoyError('REPO_LIMIT', 'Repository cache exceeds 512 MiB');
        } catch (error) {
          monitorError = error;
          controller.abort();
        } finally {
          checking = undefined;
        }
      })();
      return checking;
    };
    await monitor();
    if (monitorError) throw monitorError;
    const interval = setInterval(() => {
      void monitor();
    }, 500);
    try {
      // No checkout, hooks, filters, submodule update, or Skill code execution.
      await runGit(
        [
          '--git-dir',
          directory,
          'fetch',
          '--no-tags',
          '--no-recurse-submodules',
          // The manager owns cache lifetime; fetch must not leave background writers behind.
          '--no-auto-maintenance',
          '--',
          source.repo,
          ref,
        ],
        { signal: controller.signal },
      );
      await monitor();
      if (monitorError) throw monitorError;
    } catch (error) {
      throw monitorError ?? error;
    } finally {
      clearInterval(interval);
    }
    const commit = (
      await runGit(['--git-dir', directory, 'rev-parse', '--verify', 'FETCH_HEAD^{commit}'])
    )
      .toString()
      .trim();
    objectIdSchema.parse(commit);
    return { directory, commit, pinned };
  }

  private repo(source: Source): Promise<{ directory: string; commit: string; pinned: boolean }> {
    const key = JSON.stringify([source.repo, source.tracking, source.ref]);
    let promise = this.fetched.get(key);
    if (!promise) {
      promise = this.fetch(source);
      this.fetched.set(key, promise);
    }
    return promise;
  }

  async target(source: Source): Promise<Target> {
    const { directory, commit, pinned } = await this.repo(source);
    const tree = (
      await runGit([
        '--git-dir',
        directory,
        'rev-parse',
        '--verify',
        `${commit}:${source.path === '.' ? '' : source.path}`,
      ])
    )
      .toString()
      .trim();
    objectIdSchema.parse(tree);
    const snapshot = await this.readTree(directory, tree);
    validateSkill(snapshot);
    return { commit, tree, snapshot, pinned };
  }

  async original(source: Source): Promise<Snapshot | undefined> {
    if (source.importedHash?.kind !== 'git-tree') return undefined;
    const { directory } = await this.repo(source);
    const tree = source.importedHash.value;
    // A missing historical tree leaves the installation unverified; transport errors remain errors.
    try {
      const type = (await runGit(['--git-dir', directory, 'cat-file', '-t', tree]))
        .toString()
        .trim();
      if (type !== 'tree') return undefined;
    } catch (error) {
      if (
        error instanceof BuoyError &&
        /could not get object info|Not a valid object name|bad file/i.test(error.message)
      )
        return undefined;
      throw error;
    }
    const snapshot = await this.readTree(directory, tree);
    validateSkill(snapshot);
    return snapshot;
  }

  private async readTree(directory: string, tree: string): Promise<Snapshot> {
    const output = await runGit(['--git-dir', directory, 'ls-tree', '-r', '-t', '-l', '-z', tree]);
    if (!Buffer.from(output.toString('utf8'), 'utf8').equals(output))
      throw new BuoyError('INVALID_TREE', 'Non-UTF-8 paths are not supported');
    const files: SnapshotFile[] = [];
    let total = 0;
    for (const record of output.toString('utf8').split('\0').filter(Boolean)) {
      const match = record.match(/^(\d{6}) (\w+) ([a-f0-9]+)\s+(-|\d+)\t([\s\S]+)$/);
      if (!match) throw new BuoyError('INVALID_TREE', 'Invalid Git tree entry');
      const [, mode, type, object, size, name] = match as [
        string,
        string,
        string,
        string,
        string,
        string,
      ];
      relativePath(name);
      if (files.length >= LIMITS.files)
        throw new BuoyError('FILE_LIMIT', 'Skill has too many entries');
      if (type === 'commit' || mode === '160000')
        throw new BuoyError('UNSUPPORTED_SUBMODULE', `Submodules are not supported: ${name}`);
      if (type === 'tree') {
        files.push({ path: name, kind: 'directory', mode: 0o755, data: '' });
        continue;
      }
      if (!['100644', '100755', '120000'].includes(mode) || type !== 'blob')
        throw new BuoyError('INVALID_TREE', `Unsupported entry: ${name}`);
      total += Number(size);
      if (Number(size) > LIMITS.fileBytes || total > LIMITS.totalBytes)
        throw new BuoyError('FILE_LIMIT', 'Upstream Skill exceeds content limits');
      const data = await runGit(['--git-dir', directory, 'cat-file', 'blob', object], {
        limit: LIMITS.fileBytes + 1,
      });
      files.push({
        path: name,
        kind: mode === '120000' ? 'link' : 'file',
        mode: mode === '120000' ? 0o777 : mode === '100755' ? 0o755 : 0o644,
        data: data.toString('base64'),
      });
    }
    return makeSnapshot(files);
  }
}
