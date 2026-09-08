import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  chmod,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SkillBuoy } from '../src/index.js';
import type { Source } from '../src/index.js';

const execute = promisify(execFile);
const cli = fileURLToPath(new URL('../dist/cli/index.js', import.meta.url));
const moduleUrl = new URL('../dist/index.js', import.meta.url).href;
let root: string;
let user: string;
let repo: string;
let skill: string;
let home: string;
let buoy: SkillBuoy;
const content = (body: string, name = 'review') =>
  `---\nname: ${name}\ndescription: Review changes.\n---\n${body}\n`;

async function write(file: string, data: string | Buffer) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, data);
}
async function git(...args: string[]) {
  return (
    await execute(
      'git',
      [
        '-c',
        'core.hooksPath=/dev/null',
        '-c',
        'commit.gpgsign=false',
        '-c',
        'user.name=SkillBuoy Test',
        '-c',
        'user.email=test@example.invalid',
        ...args,
      ],
      { cwd: repo },
    )
  ).stdout.trim();
}
async function commit() {
  await git('add', '.');
  await git('commit', '-qm', 'fixture');
  return git('rev-parse', 'HEAD');
}
async function setup(adopt = true) {
  const scanned = await buoy.scan();
  const installation = scanned.installations.find((i) => i.realPath === skill)!;
  expect(installation).toBeDefined();
  await buoy.track(installation.id, {
    repo,
    path: 'skills/review',
    tracking: 'branch',
    ref: 'trunk',
    provenance: 'manual',
  });
  if (adopt) await buoy.adopt(installation.id);
  return installation.id;
}
async function update(body = 'version two') {
  await write(path.join(repo, 'skills/review/SKILL.md'), content(body));
  return commit();
}
async function runCli(...args: string[]) {
  try {
    const result = await execute(process.execPath, [cli, '--home', home, '--json', ...args], {
      cwd: root,
    });
    return { ...result, code: 0, data: JSON.parse(result.stdout) };
  } catch (error) {
    const result = error as { stdout: string; stderr: string; code: number };
    return { ...result, data: JSON.parse(result.stdout) };
  }
}

beforeEach(async () => {
  root = await realpath(await mkdtemp(path.join(tmpdir(), 'skillbuoy-test-')));
  user = path.join(root, 'user');
  repo = path.join(root, 'upstream');
  home = path.join(root, 'state');
  skill = path.join(user, '.agents/skills/review');
  await mkdir(repo);
  await git('init', '--initial-branch=trunk', '--template=');
  await write(path.join(repo, 'skills/review/SKILL.md'), content('version one'));
  await write(path.join(repo, 'skills/review/scripts/run.sh'), 'echo one\n');
  await write(path.join(repo, 'skills/other/SKILL.md'), content('other', 'other'));
  await commit();
  await mkdir(path.dirname(skill), { recursive: true });
  await cp(path.join(repo, 'skills/review'), skill, { recursive: true });
  buoy = new SkillBuoy({
    home,
    userHome: user,
    cwd: root,
    xdgStateHome: path.join(root, 'no-xdg'),
  });
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('discovery and metadata', () => {
  it('deduplicates aliases, keeps same-name copies, and reports invalid Skills and dangling links', async () => {
    const codex = path.join(user, '.codex/skills');
    await mkdir(codex, { recursive: true });
    await symlink(skill, path.join(codex, 'shared'));
    await cp(skill, path.join(codex, 'copy'), { recursive: true });
    await write(path.join(codex, 'invalid/SKILL.md'), 'missing frontmatter');
    await symlink(path.join(root, 'missing'), path.join(codex, 'broken'));
    const result = await buoy.scan();
    expect(result.installations).toHaveLength(3);
    expect(result.installations.find((i) => i.realPath === skill)!.entries).toHaveLength(2);
    expect(result.installations.find((i) => i.name === 'invalid')!.diagnostics).not.toHaveLength(0);
    expect(result.diagnostics.some((i) => i.path.endsWith('broken'))).toBe(true);
    await expect(buoy.check('review')).rejects.toThrow('Multiple');
  });

  it('imports global v3 SKILL.md paths and preserves the installer lock byte for byte', async () => {
    const lock = path.join(root, 'xdg/skills/.skill-lock.json');
    const hash = await git('rev-parse', 'HEAD:skills/review');
    const data = JSON.stringify({
      version: 3,
      skills: {
        review: {
          source: 'example/repository',
          sourceType: 'github',
          sourceUrl: 'https://github.com/example/repository/tree/trunk',
          ref: 'trunk',
          skillPath: 'skills/review/SKILL.md',
          skillFolderHash: hash,
        },
      },
    });
    await write(lock, data);
    const instance = new SkillBuoy({
      home,
      userHome: user,
      cwd: root,
      xdgStateHome: path.join(root, 'xdg'),
    });
    const result = await instance.scan();
    expect(result.installations[0]!.source).toMatchObject({
      path: 'skills/review',
      importedHash: { kind: 'git-tree', value: hash },
    });
    expect(await readFile(lock, 'utf8')).toBe(data);
  });

  it('imports a unique global installation directly under the Codex directory', async () => {
    const codex = path.join(user, '.codex/skills/review');
    await cp(skill, codex, { recursive: true });
    await rm(skill, { recursive: true });
    const lock = path.join(root, 'xdg/skills/.skill-lock.json');
    await write(
      lock,
      JSON.stringify({
        version: 3,
        skills: {
          review: {
            source: 'example/repo',
            sourceType: 'github',
            skillPath: 'skills/review/SKILL.md',
            skillFolderHash: 'a'.repeat(40),
          },
        },
      }),
    );
    const instance = new SkillBuoy({
      home,
      userHome: user,
      cwd: root,
      xdgStateHome: path.join(root, 'xdg'),
    });
    expect((await instance.scan()).installations[0]!.source!.provenance).toBe('vercel-global');
  });

  it('keeps project content hashes separate and does not guess a missing source path', async () => {
    const project = path.join(root, 'projects/a');
    await cp(skill, path.join(project, '.agents/skills/review'), { recursive: true });
    await write(
      path.join(project, 'skills-lock.json'),
      JSON.stringify({
        version: 1,
        skills: {
          review: { source: 'example/repo', sourceType: 'github', computedHash: 'a'.repeat(64) },
        },
      }),
    );
    const result = await buoy.scan({
      defaults: false,
      projectsRoots: [path.join(root, 'projects')],
    });
    expect(result.installations).toHaveLength(1);
    expect(result.installations[0]!.source).toBeUndefined();
    expect(result.diagnostics.some((i) => i.message.includes('Missing upstream path'))).toBe(true);
    await write(
      path.join(project, 'skills-lock.json'),
      JSON.stringify({
        version: 1,
        skills: {
          review: {
            source: 'example/repo',
            sourceType: 'github',
            skillPath: 'skills/review/SKILL.md',
            computedHash: 'a'.repeat(64),
          },
        },
      }),
    );
    const next = await buoy.scan({ defaults: false, projectsRoots: [path.join(root, 'projects')] });
    expect(next.installations[0]!.source!.importedHash!.kind).toBe('vercel-content');
  });

  it('blocks adoption of system, plugin, and Git worktree installations', async () => {
    const system = path.join(user, '.codex/skills/.system/review');
    const plugin = path.join(user, '.codex/plugins/cache/vendor/review');
    await cp(skill, system, { recursive: true });
    await cp(skill, plugin, { recursive: true });
    const result = await buoy.scan({ roots: [plugin, path.join(repo, 'skills')] });
    for (const target of result.installations.filter((i) => i.kind !== 'local')) {
      await expect(buoy.adopt(target.id)).rejects.toThrow('cannot be adopted');
    }
    expect(new Set(result.installations.map((i) => i.kind))).toEqual(
      new Set(['local', 'system', 'plugin', 'git']),
    );
  });
});

describe('checks, review, updates and rollback', () => {
  it('rebuilds a disposable Git cache while preserving the verified baseline', async () => {
    const id = await setup();
    const commit = await update();
    expect((await buoy.check(id))[0]).toMatchObject({
      upstream: 'changed',
      local: 'clean',
      commit,
    });
    await rm(path.join(home, 'cache'), { recursive: true });
    expect((await buoy.check(id))[0]).toMatchObject({
      upstream: 'changed',
      local: 'clean',
      commit,
    });
    expect(await readFile(path.join(skill, 'SKILL.md'), 'utf8')).toBe(content('version one'));
  });

  it('checks directory changes without touching installations and resolves the remote default branch', async () => {
    const id = await setup(false);
    await buoy.track(id, { repo, path: 'skills/review', tracking: 'branch', provenance: 'manual' });
    const initial = await buoy.check(id);
    expect(initial[0]).toMatchObject({ upstream: 'current', local: 'clean', eligible: false });
    const original = await readFile(path.join(skill, 'SKILL.md'));
    await write(path.join(repo, 'skills/other/SKILL.md'), content('other changed', 'other'));
    await commit();
    expect((await buoy.check(id))[0]!.upstream).toBe('current');
    await update();
    expect((await buoy.check(id))[0]!.upstream).toBe('changed');
    expect((await buoy.list()).installations[0]!.lastCheck).toMatchObject({
      upstream: 'changed',
      local: 'clean',
    });
    expect(await readFile(path.join(skill, 'SKILL.md'))).toEqual(original);
  });

  it('reviews full-directory changes, applies the saved commit, and rolls back', async () => {
    const id = await setup();
    await write(path.join(repo, 'skills/review/assets/data.bin'), Buffer.from([0, 1, 2]));
    await chmod(path.join(repo, 'skills/review/scripts/run.sh'), 0o755);
    const reviewedCommit = await update();
    const diff = await buoy.diff(id);
    expect(diff.files.some((f) => f.path === 'assets/data.bin' && f.binary)).toBe(true);
    expect(diff.files.some((f) => f.path === 'scripts/run.sh' && f.newMode === 0o755)).toBe(true);
    expect(diff.patch).toContain('+version two');
    const plan = await buoy.planUpgrade({ selector: id });
    expect(plan.items).toHaveLength(1);
    await update('version three');
    const result = await buoy.applyUpgrade(plan.id);
    expect(result.results[0]).toMatchObject({ status: 'upgraded', commit: reviewedCommit });
    expect(await readFile(path.join(skill, 'SKILL.md'), 'utf8')).toBe(content('version two'));
    expect((await lstat(path.join(skill, 'scripts/run.sh'))).mode & 0o777).toBe(0o755);
    await buoy.rollback(id);
    expect(await readFile(path.join(skill, 'SKILL.md'), 'utf8')).toBe(content('version one'));
    expect((await buoy.history(id)).map((i) => i.action)).toEqual(['upgrade', 'rollback']);
    expect(await readdir(path.dirname(skill))).toEqual(['review']);
  });

  it('skips modified installations and rejects a plan after local files change', async () => {
    const id = await setup();
    await update();
    const plan = await buoy.planUpgrade({ all: true });
    await write(path.join(skill, 'scripts/run.sh'), 'local customization\n');
    const result = await buoy.applyUpgrade(plan.id);
    expect(result.results[0]!.status).toBe('failed');
    expect(await readFile(path.join(skill, 'scripts/run.sh'), 'utf8')).toBe(
      'local customization\n',
    );
    const skipped = await buoy.planUpgrade({ all: true });
    expect(skipped.items).toHaveLength(0);
    expect(skipped.skipped[0]!.reason).toBe('Local modifications');
    expect((await buoy.check(id))[0]).toMatchObject({ upstream: 'changed', local: 'modified' });
  });

  it('blocks rollback after a user edits upgraded files', async () => {
    const id = await setup();
    await update();
    await buoy.applyUpgrade((await buoy.planUpgrade({ selector: id })).id);
    await write(path.join(skill, 'SKILL.md'), content('my new edits'));
    await expect(buoy.rollback(id)).rejects.toThrow('Files changed after');
    expect(await readFile(path.join(skill, 'SKILL.md'), 'utf8')).toBe(content('my new edits'));
  });

  it('requires explicit single-item initial sync and backs up an unverified installation', async () => {
    await write(path.join(skill, 'SKILL.md'), content('unknown old version'));
    const id = await setup();
    expect((await buoy.check(id))[0]!.local).toBe('unverified');
    expect((await buoy.planUpgrade({ all: true })).items).toHaveLength(0);
    await expect(buoy.planUpgrade({ all: true, initialSync: true })).rejects.toThrow(
      'one explicit',
    );
    const plan = await buoy.planUpgrade({ selector: id, initialSync: true });
    expect(plan.items[0]!.initialSync).toBe(true);
    expect((await buoy.applyUpgrade(plan.id)).results[0]!.status).toBe('upgraded');
    await buoy.rollback(id);
    expect(await readFile(path.join(skill, 'SKILL.md'), 'utf8')).toBe(
      content('unknown old version'),
    );
  });

  it('recovers the original Git tree baseline without assuming the local copy is pristine', async () => {
    const originalTree = await git('rev-parse', 'HEAD:skills/review');
    await update();
    const id = await setup(false);
    const source: Source = {
      repo,
      path: 'skills/review',
      tracking: 'branch',
      ref: 'trunk',
      provenance: 'vercel-global',
      importedHash: { kind: 'git-tree', value: originalTree },
    };
    await buoy.track(id, source);
    await buoy.adopt(id);
    expect((await buoy.check(id))[0]).toMatchObject({
      local: 'clean',
      upstream: 'changed',
      eligible: true,
    });
    await write(path.join(skill, 'scripts/run.sh'), 'local\n');
    expect((await buoy.check(id))[0]!.local).toBe('modified');
  });

  it('keeps pinned tags out of both single and batch updates even when the tag moves', async () => {
    const id = await setup();
    await git('tag', 'v1');
    await buoy.track(id, {
      repo,
      path: 'skills/review',
      tracking: 'tag',
      ref: 'v1',
      provenance: 'manual',
    });
    await buoy.adopt(id);
    await update();
    await git('tag', '-f', 'v1');
    const plan = await buoy.planUpgrade({ selector: id });
    expect(plan.items).toHaveLength(0);
    expect(plan.skipped[0]!.reason).toBe('Version is pinned');
  });

  it('updates a shared real directory once while preserving symlinks', async () => {
    const alias = path.join(user, '.codex/skills/shared');
    await mkdir(path.dirname(alias), { recursive: true });
    await symlink(skill, alias);
    await setup();
    await update();
    const plan = await buoy.planUpgrade({ all: true });
    expect(plan.items).toHaveLength(1);
    expect((await buoy.applyUpgrade(plan.id)).results[0]!.status).toBe('upgraded');
    expect((await lstat(alias)).isSymbolicLink()).toBe(true);
    expect(await readFile(path.join(alias, 'SKILL.md'), 'utf8')).toBe(content('version two'));
  });

  it('rejects a retargeted symlink and does not touch either destination', async () => {
    const alias = path.join(user, '.codex/skills/shared');
    await mkdir(path.dirname(alias), { recursive: true });
    await symlink(skill, alias);
    const id = await setup();
    await update();
    const plan = await buoy.planUpgrade({ selector: id });
    const other = path.join(root, 'other');
    await cp(skill, other, { recursive: true });
    await rm(alias);
    await symlink(other, alias);
    const result = await buoy.applyUpgrade(plan.id);
    expect(result.results[0]!.status).toBe('failed');
    expect(await readFile(path.join(skill, 'SKILL.md'), 'utf8')).toBe(content('version one'));
    expect(await readFile(path.join(other, 'SKILL.md'), 'utf8')).toBe(content('version one'));
  });

  it('refreshes removed aliases on rescan and retains local modification status when upstream is unavailable', async () => {
    const alias = path.join(user, '.codex/skills/shared');
    await mkdir(path.dirname(alias), { recursive: true });
    await symlink(skill, alias);
    const id = await setup();
    await rm(alias);
    await buoy.scan();
    expect((await buoy.check(id))[0]!.local).toBe('clean');
    expect((await buoy.list()).installations[0]!.entries).toEqual([skill]);
    await write(path.join(skill, 'scripts/run.sh'), 'local\n');
    await rm(path.join(repo, 'skills/review'), { recursive: true });
    await commit();
    expect((await buoy.check(id))[0]).toMatchObject({ upstream: 'error', local: 'modified' });
  });

  it('reports completion if an error happens after the committed state is recoverable', async () => {
    const id = await setup();
    await update();
    const plan = await buoy.planUpgrade({ selector: id });
    const instance = new SkillBuoy({
      home,
      hooks: {
        onStage: async (stage) => {
          if (stage === 'state-saved') throw new Error('post-commit interruption');
        },
      },
    });
    expect((await instance.applyUpgrade(plan.id)).results[0]!.status).toBe('upgraded');
    expect((await buoy.list()).pendingRecovery).toBe(0);
    expect(await readFile(path.join(skill, 'SKILL.md'), 'utf8')).toBe(content('version two'));
  });

  it('rejects a corrupted saved snapshot before modifying installed content', async () => {
    const id = await setup();
    await update();
    const plan = await buoy.planUpgrade({ selector: id });
    const snapshotPath = path.join(home, 'snapshots', `${plan.items[0]!.target}.json`);
    const snapshot = JSON.parse(await readFile(snapshotPath, 'utf8'));
    snapshot.files.find((file: { path: string }) => file.path === 'SKILL.md').data = Buffer.from(
      content('tampered'),
    ).toString('base64');
    await writeFile(snapshotPath, JSON.stringify(snapshot));
    expect((await buoy.applyUpgrade(plan.id)).results[0]!.status).toBe('failed');
    expect(await readFile(path.join(skill, 'SKILL.md'), 'utf8')).toBe(content('version one'));
  });

  it('supports repository paths with spaces and keeps empty local directories as modifications', async () => {
    const spaced = path.join(root, 'upstream with spaces');
    await cp(repo, spaced, { recursive: true });
    const id = await setup(false);
    await buoy.track(id, {
      repo: spaced,
      path: 'skills/review',
      tracking: 'branch',
      ref: 'trunk',
      provenance: 'manual',
    });
    await buoy.adopt(id);
    await mkdir(path.join(skill, 'local-empty'));
    expect((await buoy.check(id))[0]!.local).toBe('modified');
    expect((await buoy.diff(id, 'local')).files.some((file) => file.path === 'local-empty')).toBe(
      true,
    );
  });
});

describe('CLI and safety boundaries', () => {
  it('keeps --json machine readable, persists dry-run plans and never lets --yes override local changes', async () => {
    const id = await setup();
    await update();
    const dry = await runCli('upgrade', id, '--dry-run');
    expect(dry.code).toBe(0);
    expect(dry.data.plan.items).toHaveLength(1);
    const noConfirm = await runCli('upgrade', '--plan', dry.data.plan.id);
    expect(noConfirm.code).toBe(1);
    expect(noConfirm.data.error.code).toBe('CONFIRMATION_REQUIRED');
    await write(path.join(skill, 'SKILL.md'), content('local'));
    const result = await runCli('upgrade', '--plan', dry.data.plan.id, '--yes');
    expect(result.code).toBe(1);
    expect(result.data.results[0].status).toBe('failed');
    expect(await readFile(path.join(skill, 'SKILL.md'), 'utf8')).toBe(content('local'));
    expect((await runCli('list')).data.installations).toHaveLength(1);
  });

  it('rejects unsafe URLs, option-like refs and path traversal without running upstream commands', async () => {
    const id = await setup(false);
    for (const repoValue of [
      'ext::sh evil',
      'https://secret@example.com/repo',
      'file:///etc',
      '-upload-pack=evil',
    ]) {
      await expect(
        buoy.track(id, {
          repo: repoValue,
          path: 'skills/review',
          tracking: 'branch',
          provenance: 'manual',
        }),
      ).rejects.toThrow(/[Rr]epository/);
    }
    await expect(
      buoy.track(id, { repo, path: '../outside', tracking: 'branch', provenance: 'manual' }),
    ).rejects.toThrow('Unsafe Skill path');
    await expect(
      buoy.track(id, {
        repo,
        path: 'skills/review',
        tracking: 'branch',
        ref: '--upload-pack=evil',
        provenance: 'manual',
      }),
    ).rejects.toThrow('Invalid Git reference');
  });

  it('rejects escaping upstream links, LFS pointers and submodule trees', async () => {
    const id = await setup();
    await symlink('../../../outside', path.join(repo, 'skills/review/escape'));
    await commit();
    expect((await buoy.check(id))[0]!.reason).toContain('Link escapes');
    await rm(path.join(repo, 'skills/review/escape'));
    await write(
      path.join(repo, 'skills/review/large.bin'),
      'version https://git-lfs.github.com/spec/v1\noid sha256:123\nsize 2000\n',
    );
    await commit();
    expect((await buoy.check(id))[0]!.reason).toContain('LFS');
    await rm(path.join(repo, 'skills/review/large.bin'));
    await commit();
    const sha = await git('rev-parse', 'HEAD');
    await git('update-index', '--add', '--cacheinfo', `160000,${sha},skills/review/module`);
    await git('commit', '-qm', 'gitlink');
    expect((await buoy.check(id))[0]!.reason).toContain('Submodules');
  });

  it('preserves internal links and reports upstream directory deletion as an error', async () => {
    const id = await setup();
    await symlink('scripts/run.sh', path.join(repo, 'skills/review/run'));
    await commit();
    expect(
      (await buoy.applyUpgrade((await buoy.planUpgrade({ selector: id })).id)).results[0]!.status,
    ).toBe('upgraded');
    expect((await lstat(path.join(skill, 'run'))).isSymbolicLink()).toBe(true);
    await rm(path.join(repo, 'skills/review'), { recursive: true });
    await commit();
    expect((await buoy.check(id))[0]!.upstream).toBe('error');
    expect(await readFile(path.join(skill, 'SKILL.md'), 'utf8')).toBe(content('version one'));
  });

  it('does not silently overwrite corrupt state', async () => {
    await setup();
    const stateFile = path.join(home, 'state.json');
    await writeFile(stateFile, '{broken');
    await expect(buoy.scan()).rejects.toThrow('Cannot read valid data');
    expect(await readFile(stateFile, 'utf8')).toBe('{broken');
  });

  it('serializes two processes using the same manager home', async () => {
    await setup();
    await buoy.store.withLock(async () => {
      expect((await runCli('list')).data.error.code).toBe('BUSY');
    });
  });

  it('blocks concurrent updates from different manager homes to the same installation', async () => {
    const id = await setup();
    const other = new SkillBuoy({ home: path.join(root, 'state-two'), userHome: user, cwd: root });
    await other.scan();
    await other.track(id, {
      repo,
      path: 'skills/review',
      tracking: 'branch',
      ref: 'trunk',
      provenance: 'manual',
    });
    await other.adopt(id);
    await update();
    const firstPlan = await buoy.planUpgrade({ selector: id });
    const secondPlan = await other.planUpgrade({ selector: id });
    let announce!: () => void;
    let release!: () => void;
    const ready = new Promise<void>((resolve) => {
      announce = resolve;
    });
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = new SkillBuoy({
      home,
      hooks: {
        onStage: async (stage) => {
          if (stage === 'prepared') {
            announce();
            await hold;
          }
        },
      },
    });
    const operation = first.applyUpgrade(firstPlan.id);
    await ready;
    try {
      expect((await other.applyUpgrade(secondPlan.id)).results[0]!.status).toBe('failed');
    } finally {
      release();
    }
    expect((await operation).results[0]!.status).toBe('upgraded');
  });

  it('reports a FIFO SKILL.md instead of waiting for a writer', async () => {
    const fifo = path.join(user, '.agents/skills/fifo/SKILL.md');
    await mkdir(path.dirname(fifo));
    await execute('mkfifo', [fifo]);
    const scanned = await buoy.scan();
    expect(scanned.installations.find((i) => i.name === 'fifo')!.diagnostics[0]).toContain(
      'Not a regular file',
    );
  });

  it('rejects non-UTF-8 link targets without changing their bytes', async () => {
    const id = await setup();
    await symlink(Buffer.from([0xff]), path.join(repo, 'skills/review/invalid-link'));
    await commit();
    expect((await buoy.check(id))[0]!.reason).toContain('Non-UTF-8 link targets');
    expect(await readFile(path.join(skill, 'SKILL.md'), 'utf8')).toBe(content('version one'));
  });
});

describe('real process interruption recovery', () => {
  it('preserves new edits and all backup files when interrupted recovery has a conflict', async () => {
    const id = await setup();
    await update();
    const plan = await buoy.planUpgrade({ selector: id });
    const script = `import { SkillBuoy } from ${JSON.stringify(moduleUrl)}; const b = new SkillBuoy({home: ${JSON.stringify(home)}, hooks:{onStage: async stage => {if(stage === 'new-installed') process.kill(process.pid, 'SIGKILL')}}}); await b.applyUpgrade(${JSON.stringify(plan.id)});`;
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
      stdio: 'ignore',
    });
    expect(
      await new Promise((resolve) => child.on('close', (_code, signal) => resolve(signal))),
    ).toBe('SIGKILL');
    await utimes(path.join(home, '.write-lock'), new Date(0), new Date(0));
    for (const entry of await readdir(path.dirname(skill)))
      if (entry.endsWith('.lock'))
        await utimes(path.join(path.dirname(skill), entry), new Date(0), new Date(0));
    await write(path.join(skill, 'SKILL.md'), content('edited after crash'));
    await expect(buoy.recover()).rejects.toThrow('Installed content changed');
    expect(await readFile(path.join(skill, 'SKILL.md'), 'utf8')).toBe(
      content('edited after crash'),
    );
    expect((await buoy.list()).pendingRecovery).toBe(1);
    const backup = (await readdir(path.dirname(skill))).find((entry) =>
      entry.endsWith('-previous'),
    )!;
    expect(await readFile(path.join(path.dirname(skill), backup, 'SKILL.md'), 'utf8')).toBe(
      content('version one'),
    );
  });
  for (const stage of ['prepared', 'old-moved', 'new-installed', 'state-saved']) {
    it(`recovers after SIGKILL at ${stage}`, async () => {
      const id = await setup();
      await update();
      const plan = await buoy.planUpgrade({ selector: id });
      const script = `import { SkillBuoy } from ${JSON.stringify(moduleUrl)}; const b = new SkillBuoy({home: ${JSON.stringify(home)}, hooks:{onStage: async stage => {if(stage === ${JSON.stringify(stage)}) process.kill(process.pid, 'SIGKILL')}}}); await b.applyUpgrade(${JSON.stringify(plan.id)});`;
      const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
        stdio: 'pipe',
      });
      let errors = '';
      child.stderr.on('data', (chunk) => {
        errors += chunk;
      });
      const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
        (resolve) => child.on('close', (code, signal) => resolve({ code, signal })),
      );
      expect({ ...exit, errors }).toEqual({ code: null, signal: 'SIGKILL', errors: '' });
      // Advance dead-process lock mtimes, without replacing or mocking any transaction data.
      await utimes(path.join(home, '.write-lock'), new Date(0), new Date(0));
      for (const entry of await readdir(path.dirname(skill)))
        if (entry.endsWith('.lock'))
          await utimes(path.join(path.dirname(skill), entry), new Date(0), new Date(0));
      expect((await buoy.list()).pendingRecovery).toBe(1);
      const recovered = await buoy.recover();
      expect(recovered[0]!.status).toBe(stage === 'state-saved' ? 'completed' : 'restored');
      expect(await readFile(path.join(skill, 'SKILL.md'), 'utf8')).toBe(
        content(stage === 'state-saved' ? 'version two' : 'version one'),
      );
      expect((await buoy.list()).pendingRecovery).toBe(0);
      expect(await readdir(path.dirname(skill))).toEqual(['review']);
    });
  }
});
