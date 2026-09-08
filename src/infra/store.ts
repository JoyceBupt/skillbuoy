import { mkdir, lstat, realpath, open, rename, rm, readdir } from 'node:fs/promises';
import path from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import lockfile from 'proper-lockfile';
import { parseDocument } from 'yaml';
import { z } from 'zod';
import {
  configSchema,
  digestSchema,
  journalSchema,
  planSchema,
  snapshotSchema,
  stateSchema,
  uuidSchema,
} from '../schemas/index.js';
import type { Config, Journal, Snapshot, State, UpgradePlan } from '../schemas/index.js';
import { readBounded, validateSnapshot } from './snapshot.js';
import { BuoyError, isMissing } from './errors.js';

export const expandPath = (value: string): string =>
  path.resolve(
    value === '~'
      ? homedir()
      : value.startsWith('~/')
        ? path.join(homedir(), value.slice(2))
        : value,
  );

export async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function exists(file: string): Promise<boolean> {
  try {
    await lstat(file);
    return true;
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
}

export class Store {
  home: string;
  constructor(home = process.env.SKILLBUOY_HOME ?? path.join(homedir(), '.skillbuoy')) {
    this.home = expandPath(home);
  }

  async init(): Promise<void> {
    await mkdir(this.home, { recursive: true, mode: 0o700 });
    if ((await lstat(this.home)).isSymbolicLink())
      throw new BuoyError('UNSAFE_HOME', 'SKILLBUOY_HOME must be a real directory');
    this.home = await realpath(this.home);
    for (const name of ['snapshots', 'plans', 'transactions', 'cache', 'cache/repos']) {
      const directory = path.join(this.home, name);
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const info = await lstat(directory);
      if (!info.isDirectory() || (await realpath(directory)) !== directory)
        throw new BuoyError('UNSAFE_HOME', `Unsafe state directory: ${directory}`);
    }
  }

  async withLock<T>(action: () => Promise<T>): Promise<T> {
    await this.init();
    let release: () => Promise<void>;
    try {
      release = await lockfile.lock(this.home, {
        lockfilePath: path.join(this.home, '.write-lock'),
        stale: 10_000,
        update: 2000,
        retries: 0,
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ELOCKED')
        throw new BuoyError('BUSY', 'Another SkillBuoy operation is running');
      throw error;
    }
    try {
      return await action();
    } finally {
      await release();
    }
  }

  async read<T>(file: string, schema: z.ZodType<T>, limit = 16 * 1024 * 1024): Promise<T> {
    try {
      return schema.parse(JSON.parse((await readBounded(file, limit)).toString('utf8')));
    } catch (error) {
      if (isMissing(error)) throw error;
      throw new BuoyError(
        'INVALID_STATE',
        `Cannot read valid data from ${file}: ${error instanceof Error ? error.message : 'unknown error'}`,
      );
    }
  }

  async write(file: string, data: unknown, limit = 16 * 1024 * 1024): Promise<void> {
    if ((await realpath(path.dirname(file))) !== path.dirname(file))
      throw new BuoyError('UNSAFE_HOME', 'State directory changed');
    const content = `${JSON.stringify(data, null, 2)}\n`;
    if (Buffer.byteLength(content) > limit)
      throw new BuoyError('STATE_LIMIT', `State file exceeds its size limit: ${file}`);
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
      const handle = await open(temporary, 'wx', 0o600);
      try {
        await handle.writeFile(content);
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temporary, file);
      await syncDirectory(path.dirname(file));
    } finally {
      await rm(temporary, { force: true });
    }
  }

  async loadState(): Promise<State> {
    try {
      const state = await this.read(path.join(this.home, 'state.json'), stateSchema);
      if (
        new Set(state.installations.map((i) => i.id)).size !== state.installations.length ||
        new Set(state.installations.map((i) => i.realPath)).size !== state.installations.length
      ) {
        throw new BuoyError('INVALID_STATE', 'Duplicate installations in state');
      }
      return state;
    } catch (error) {
      if (isMissing(error)) return { version: 1, installations: [], history: [] };
      throw error;
    }
  }

  async saveState(state: State): Promise<void> {
    await this.write(path.join(this.home, 'state.json'), stateSchema.parse(state));
  }

  async config(): Promise<Config> {
    try {
      const file = path.join(this.home, 'config.yaml');
      const document = parseDocument((await readBounded(file, 256 * 1024)).toString('utf8'), {
        uniqueKeys: true,
      });
      if (document.errors.length)
        throw new BuoyError('INVALID_CONFIG', document.errors.map((e) => e.message).join('; '));
      return configSchema.parse(document.toJS({ maxAliasCount: 0 }) ?? {});
    } catch (error) {
      if (isMissing(error)) return configSchema.parse({});
      throw error;
    }
  }

  async putSnapshot(snapshot: Snapshot): Promise<string> {
    validateSnapshot(snapshot);
    const file = path.join(this.home, 'snapshots', `${snapshot.fingerprint}.json`);
    if (await exists(file)) await this.getSnapshot(snapshot.fingerprint);
    else await this.write(file, snapshot, 80 * 1024 * 1024);
    return snapshot.fingerprint;
  }

  async getSnapshot(id: string): Promise<Snapshot> {
    digestSchema.parse(id);
    const snapshot = await this.read(
      path.join(this.home, 'snapshots', `${id}.json`),
      snapshotSchema,
      80 * 1024 * 1024,
    );
    validateSnapshot(snapshot);
    if (snapshot.fingerprint !== id)
      throw new BuoyError('INVALID_SNAPSHOT', 'Snapshot ID does not match its content');
    return snapshot;
  }

  async savePlan(plan: UpgradePlan): Promise<void> {
    await this.write(
      path.join(this.home, 'plans', `${uuidSchema.parse(plan.id)}.json`),
      planSchema.parse(plan),
    );
  }
  async getPlan(id: string): Promise<UpgradePlan> {
    const plan = await this.read(
      path.join(this.home, 'plans', `${uuidSchema.parse(id)}.json`),
      planSchema,
    );
    if (plan.id !== id) throw new BuoyError('INVALID_STATE', 'Plan ID mismatch');
    return plan;
  }
  async saveJournal(journal: Journal): Promise<void> {
    await this.write(
      path.join(this.home, 'transactions', `${uuidSchema.parse(journal.id)}.json`),
      journalSchema.parse(journal),
    );
  }
  async removeJournal(id: string): Promise<void> {
    await rm(path.join(this.home, 'transactions', `${uuidSchema.parse(id)}.json`));
    await syncDirectory(path.join(this.home, 'transactions'));
  }
  async journals(): Promise<Journal[]> {
    const result: Journal[] = [];
    for (const name of await readdir(path.join(this.home, 'transactions'))) {
      if (!name.endsWith('.json')) continue;
      const id = uuidSchema.parse(name.slice(0, -5));
      const journal = await this.read(path.join(this.home, 'transactions', name), journalSchema);
      if (journal.id !== id) throw new BuoyError('INVALID_STATE', 'Transaction ID mismatch');
      result.push(journal);
    }
    return result;
  }

  async assertRecovered(): Promise<void> {
    const journals = await this.journals();
    if (journals.length)
      throw new BuoyError(
        'PENDING_RECOVERY',
        `${journals.length} interrupted transaction(s); run skillbuoy recover`,
      );
  }
}
