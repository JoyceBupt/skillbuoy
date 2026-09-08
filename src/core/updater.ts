import { chmod, lstat, readlink, realpath, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import lockfile from 'proper-lockfile';
import type { HistoryEntry, Installation, Journal, Snapshot, State } from '../schemas/index.js';
import { BuoyError, errorMessage, isMissing } from '../infra/errors.js';
import {
  disposeTemporary,
  hash,
  inside,
  materialize,
  readSnapshot,
  validateSkill,
} from '../infra/snapshot.js';
import { exists, Store, syncDirectory } from '../infra/store.js';
import { installationKind } from './scanner.js';

export type TransactionStage = 'prepared' | 'old-moved' | 'new-installed' | 'state-saved';
export interface TransactionHooks {
  onStage?: (stage: TransactionStage) => Promise<void>;
}

async function resolveEntry(entry: string, depth = 0): Promise<string> {
  if (depth > 32) throw new BuoyError('PATH_CHANGED', 'Installation link cycle');
  const parent = await realpath(path.dirname(entry));
  const target = path.join(parent, path.basename(entry));
  try {
    if ((await lstat(target)).isSymbolicLink())
      return resolveEntry(path.resolve(parent, await readlink(target)), depth + 1);
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
  return target;
}

export async function validateLocation(
  installation: Installation,
  store: Store,
  allowMissing = false,
): Promise<void> {
  const location = installation.realPath;
  if (
    !path.isAbsolute(location) ||
    path.dirname(location) === location ||
    hash(location).slice(0, 12) !== installation.id ||
    inside(location, store.home) ||
    inside(store.home, location)
  )
    throw new BuoyError(
      'UNSAFE_TARGET',
      'Installation overlaps state storage or has an invalid identity',
    );
  if ((await realpath(path.dirname(location))) !== path.dirname(location))
    throw new BuoyError('PATH_CHANGED', 'Installation parent changed');
  if (!allowMissing || (await exists(location))) {
    if (!(await lstat(location)).isDirectory() || (await realpath(location)) !== location)
      throw new BuoyError('PATH_CHANGED', 'Installation directory changed');
  }
  for (const entry of installation.entries) {
    if ((await resolveEntry(entry)) !== location)
      throw new BuoyError('PATH_CHANGED', `Installation entry changed: ${entry}`);
  }
}

export async function assertWritable(installation: Installation, store: Store): Promise<void> {
  await validateLocation(installation, store);
  const kind = await installationKind(installation.realPath, installation.entries);
  if (kind !== 'local' || installation.kind !== 'local')
    throw new BuoyError('EXTERNAL_OWNER', `Installation is ${kind}; direct updates are disabled`);
  if (!installation.managed)
    throw new BuoyError('NOT_ADOPTED', 'Adopt the installation before updating it');
}

function paths(journal: Journal): { staged: string; previous: string } {
  const parent = path.dirname(journal.realPath);
  return {
    staged: path.join(parent, `.skillbuoy-${journal.id}-next`),
    previous: path.join(parent, `.skillbuoy-${journal.id}-previous`),
  };
}

async function removeVerified(directory: string, expected: string): Promise<void> {
  if (!(await exists(directory))) return;
  const snapshot = await readSnapshot(directory);
  if (snapshot.fingerprint !== expected)
    throw new BuoyError(
      'RECOVERY_CONFLICT',
      `Files changed in recovery directory; preserved at ${directory}`,
    );
  // The verified content remains in the durable snapshot before this disposable copy is removed.
  await chmod(directory, 0o700);
  for (const file of snapshot.files
    .filter((f) => f.kind === 'directory')
    .sort((a, b) => a.path.split('/').length - b.path.split('/').length)) {
    await chmod(path.join(directory, file.path), 0o700);
  }
  await rm(directory, { recursive: true });
  await syncDirectory(path.dirname(directory));
}

export class Updater {
  constructor(
    private readonly store: Store,
    private readonly hooks: TransactionHooks = {},
  ) {}

  private async targetLock<T>(location: string, action: () => Promise<T>): Promise<T> {
    const lockPath = path.join(
      path.dirname(location),
      `.skillbuoy-${hash(location).slice(0, 12)}.lock`,
    );
    const release = await lockfile.lock(path.dirname(location), {
      lockfilePath: lockPath,
      stale: 10_000,
      update: 2000,
      retries: 0,
    });
    try {
      return await action();
    } finally {
      await release();
    }
  }

  async replace(
    state: State,
    installation: Installation,
    target: Snapshot,
    history: HistoryEntry,
  ): Promise<void> {
    await assertWritable(installation, this.store);
    await this.targetLock(installation.realPath, async () => {
      await assertWritable(installation, this.store);
      const before = await readSnapshot(installation.realPath);
      if (before.fingerprint !== history.before || target.fingerprint !== history.after)
        throw new BuoyError('STALE_PLAN', 'Local files changed; generate a new plan');
      validateSkill(target);
      await this.store.putSnapshot(before);
      await this.store.putSnapshot(target);
      const rootInfo = await lstat(installation.realPath);
      if (rootInfo.mode & 0o7000)
        throw new BuoyError(
          'UNSUPPORTED_MODE',
          'Special directory permission bits are not supported',
        );
      const journal: Journal = {
        id: history.id,
        installationId: installation.id,
        realPath: installation.realPath,
        entries: [...installation.entries],
        before: history.before,
        after: history.after,
        rootMode: rootInfo.mode & 0o777,
        history,
      };
      const { staged, previous } = paths(journal);
      if ((await exists(staged)) || (await exists(previous)))
        throw new BuoyError('RECOVERY_CONFLICT', 'Transaction directory already exists');
      let journalSaved = false;
      try {
        await materialize(target, staged);
        await chmod(staged, journal.rootMode);
        if ((await readSnapshot(staged)).fingerprint !== target.fingerprint)
          throw new BuoyError('INVALID_SNAPSHOT', 'Staged content mismatch');
        await this.store.saveJournal(journal);
        journalSaved = true;
        await this.hooks.onStage?.('prepared');
        await assertWritable(installation, this.store);
        if ((await readSnapshot(installation.realPath)).fingerprint !== history.before)
          throw new BuoyError('STALE_PLAN', 'Local files changed during staging');
        await rename(installation.realPath, previous);
        await syncDirectory(path.dirname(previous));
        await this.hooks.onStage?.('old-moved');
        await rename(staged, installation.realPath);
        await syncDirectory(path.dirname(previous));
        await this.hooks.onStage?.('new-installed');
        await validateLocation(installation, this.store);
        if (
          (await readSnapshot(previous)).fingerprint !== history.before ||
          (await readSnapshot(installation.realPath)).fingerprint !== history.after
        ) {
          throw new BuoyError('RECOVERY_CONFLICT', 'Files changed during directory replacement');
        }
        installation.baseline = history.nextBaseline;
        delete installation.lastCheck;
        state.history.push(history);
        await this.store.saveState(state);
        await this.hooks.onStage?.('state-saved');
        await removeVerified(previous, journal.before);
        await this.store.removeJournal(journal.id);
      } catch (error) {
        if (journalSaved) {
          try {
            if ((await this.recoverOne(journal, await this.store.loadState())) === 'completed')
              return;
          } catch (recoveryError) {
            throw new BuoyError(
              'RECOVERY_REQUIRED',
              `${errorMessage(error)}; recovery blocked: ${errorMessage(recoveryError)}`,
            );
          }
        } else if (await exists(staged)) {
          // This random, exclusively-created staging directory has never held installed content.
          await disposeTemporary(staged);
        }
        throw error;
      }
    });
  }

  private async recoverOne(journal: Journal, state: State): Promise<string> {
    const installation = state.installations.find((i) => i.id === journal.installationId);
    if (
      !installation ||
      installation.realPath !== journal.realPath ||
      journal.history.id !== journal.id ||
      journal.history.installationId !== installation.id ||
      journal.history.before !== journal.before ||
      journal.history.after !== journal.after
    ) {
      throw new BuoyError('INVALID_STATE', 'Recovery record does not match installation');
    }
    await validateLocation({ ...installation, entries: journal.entries }, this.store, true);
    await this.store.getSnapshot(journal.before);
    await this.store.getSnapshot(journal.after);
    const { staged, previous } = paths(journal);
    const current = (await exists(journal.realPath))
      ? (await readSnapshot(journal.realPath)).fingerprint
      : undefined;
    const old = (await exists(previous)) ? (await readSnapshot(previous)).fingerprint : undefined;
    const next = (await exists(staged)) ? (await readSnapshot(staged)).fingerprint : undefined;
    const committed = state.history.find((entry) => entry.id === journal.id);
    if (committed) {
      if (
        JSON.stringify(committed) !== JSON.stringify(journal.history) ||
        current !== journal.after ||
        (old && old !== journal.before) ||
        next
      ) {
        throw new BuoyError(
          'RECOVERY_CONFLICT',
          'Committed installation changed; recovery files were preserved',
        );
      }
      await removeVerified(previous, journal.before);
      await this.store.removeJournal(journal.id);
      return 'completed';
    }
    if ((old && old !== journal.before) || (next && next !== journal.after))
      throw new BuoyError('RECOVERY_CONFLICT', 'Recovery files changed; no files were removed');
    if (old === journal.before) {
      if (current && current !== journal.after)
        throw new BuoyError(
          'RECOVERY_CONFLICT',
          'Installed content changed; no files were overwritten',
        );
      if (current) {
        if (next)
          throw new BuoyError('RECOVERY_CONFLICT', 'Both staged and installed copies exist');
        await rename(journal.realPath, staged);
      }
      await rename(previous, journal.realPath);
      await syncDirectory(path.dirname(journal.realPath));
    } else if (current !== journal.before) {
      throw new BuoyError(
        'RECOVERY_CONFLICT',
        'Original installation is missing or changed; manual recovery is required',
      );
    }
    await removeVerified(staged, journal.after);
    await this.store.removeJournal(journal.id);
    return 'restored';
  }

  async recover(): Promise<{ id: string; installationId: string; status: string }[]> {
    const result = [];
    for (const journal of await this.store.journals()) {
      const state = await this.store.loadState();
      const installation = state.installations.find((i) => i.id === journal.installationId);
      if (!installation || installation.realPath !== journal.realPath)
        throw new BuoyError('INVALID_STATE', 'Unknown recovery target');
      await validateLocation(installation, this.store, true);
      const status = await this.targetLock(journal.realPath, () => this.recoverOne(journal, state));
      result.push({ id: journal.id, installationId: journal.installationId, status });
    }
    return result;
  }
}
