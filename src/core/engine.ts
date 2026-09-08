import { homedir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import type {
  CheckResult,
  HistoryEntry,
  Installation,
  Source,
  State,
  UpgradePlan,
} from '../schemas/index.js';
import { sourceSchema } from '../schemas/index.js';
import { Store, expandPath } from '../infra/store.js';
import { BuoyError, errorMessage, isMissing } from '../infra/errors.js';
import { GitCache, validateSource } from '../infra/git.js';
import { readSnapshot, validateSkill } from '../infra/snapshot.js';
import { importVercel } from '../adapters/vercel.js';
import { discoverProjects, installationKind, scanDirectories } from './scanner.js';
import { diffSnapshots } from './differ.js';
import { assertWritable, Updater, validateLocation } from './updater.js';
import type { TransactionHooks } from './updater.js';

export interface EngineOptions {
  home?: string;
  userHome?: string;
  cwd?: string;
  xdgStateHome?: string;
  hooks?: TransactionHooks;
}
export interface ScanOptions {
  roots?: string[];
  projectsRoots?: string[];
  defaults?: boolean;
  maxDepth?: number;
}
export interface PlanOptions {
  selector?: string;
  all?: boolean;
  initialSync?: boolean;
}

export function selectInstallation(installations: Installation[], selector: string): Installation {
  const exactId = installations.find((i) => i.id === selector);
  if (exactId) return exactId;
  const matches = installations.filter(
    (i) => i.name === selector || (selector.length >= 4 && i.id.startsWith(selector)),
  );
  if (matches.length !== 1)
    throw new BuoyError(
      matches.length ? 'AMBIGUOUS_SKILL' : 'NOT_FOUND',
      matches.length
        ? `Multiple Skills match ${selector}; use the full ID`
        : `No installation matches ${selector}; run scan first`,
    );
  return matches[0]!;
}

export class SkillBuoy {
  readonly store: Store;
  private readonly userHome: string;
  private readonly cwd: string;
  private readonly options: EngineOptions;
  constructor(options: EngineOptions = {}) {
    this.options = options;
    this.store = new Store(options.home);
    this.userHome = expandPath(options.userHome ?? homedir());
    this.cwd = expandPath(options.cwd ?? process.cwd());
  }

  async scan(options: ScanOptions = {}) {
    return this.store.withLock(async () => {
      await this.store.assertRecovered();
      const state = await this.store.loadState();
      const config = await this.store.config();
      if (options.maxDepth !== undefined) {
        if (!Number.isInteger(options.maxDepth) || options.maxDepth < 1 || options.maxDepth > 20)
          throw new BuoyError('INVALID_CONFIG', 'maxDepth must be an integer between 1 and 20');
        config.maxDepth = options.maxDepth;
      }
      const projects = await discoverProjects(
        [...config.projectsRoots, ...(options.projectsRoots ?? [])],
        config,
      );
      const defaults =
        options.defaults === false
          ? []
          : [this.userHome, this.cwd].flatMap((root) =>
              ['.agents', '.codex', '.claude'].map((agent) => path.join(root, agent, 'skills')),
            );
      const scanned = await scanDirectories(
        [...defaults, ...config.roots, ...(options.roots ?? []), ...projects.roots],
        config,
      );
      for (const found of scanned.installations) {
        const previous = state.installations.find((i) => i.realPath === found.realPath);
        if (previous) {
          found.source = previous.source;
          found.baseline = previous.baseline;
          found.observed = previous.observed;
          found.lastCheck = previous.lastCheck;
          found.managed = previous.managed && found.kind === 'local';
          const preserved: string[] = [];
          for (const entry of previous.entries) {
            try {
              if ((await realpath(entry)) === found.realPath) preserved.push(entry);
            } catch (error) {
              if (!isMissing(error)) throw error;
            }
          }
          found.entries = [...new Set([...found.entries, ...preserved])].sort();
        }
      }
      const metadata = await importVercel(
        scanned.installations,
        this.userHome,
        this.options.xdgStateHome ?? process.env.XDG_STATE_HOME,
      );
      const foundPaths = new Set(scanned.installations.map((i) => i.realPath));
      state.installations = [
        ...state.installations.filter((i) => !foundPaths.has(i.realPath)),
        ...scanned.installations,
      ];
      await this.store.saveState(state);
      return {
        installations: scanned.installations,
        diagnostics: [...projects.diagnostics, ...scanned.diagnostics, ...metadata],
      };
    });
  }

  async list(): Promise<{ installations: Installation[]; pendingRecovery: number }> {
    return this.store.withLock(async () => ({
      installations: (await this.store.loadState()).installations,
      pendingRecovery: (await this.store.journals()).length,
    }));
  }

  async track(selector: string, source: Source): Promise<Installation> {
    const parsed = validateSource(sourceSchema.parse(source));
    return this.store.withLock(async () => {
      await this.store.assertRecovered();
      const state = await this.store.loadState();
      const installation = selectInstallation(state.installations, selector);
      if (JSON.stringify(installation.source) === JSON.stringify(parsed)) return installation;
      installation.source = parsed;
      delete installation.baseline;
      delete installation.observed;
      delete installation.lastCheck;
      installation.managed = false;
      await this.store.saveState(state);
      return installation;
    });
  }

  private async checkState(state: State, installations: Installation[]): Promise<CheckResult[]> {
    const git = new GitCache(path.join(this.store.home, 'cache/repos'));
    const results: CheckResult[] = [];
    // Serialized Git writes share the repository cache, including sources that track different refs.
    for (const installation of installations) {
      const result: CheckResult = {
        id: installation.id,
        name: installation.name,
        upstream: 'unknown',
        local: 'unverified',
        managed: installation.managed,
        eligible: false,
      };
      results.push(result);
      try {
        await validateLocation(installation, this.store);
        const local = await readSnapshot(installation.realPath);
        validateSkill(local);
        result.current = await this.store.putSnapshot(local);
        installation.observed ??= local.fingerprint;
        if (installation.baseline) {
          const baseline = await this.store.getSnapshot(installation.baseline.snapshot);
          result.local = baseline.fingerprint === local.fingerprint ? 'clean' : 'modified';
        }
        if (!installation.source) {
          result.reason = 'Source unknown; bind a repository';
          continue;
        }
        const target = await git.target(installation.source);
        result.target = await this.store.putSnapshot(target.snapshot);
        result.commit = target.commit;
        result.tree = target.tree;
        result.pinned = target.pinned;
        if (!installation.baseline) {
          const original = await git.original(installation.source);
          if (original)
            installation.baseline = {
              snapshot: await this.store.putSnapshot(original),
              tree: installation.source.importedHash!.value,
            };
          else if (local.fingerprint === target.snapshot.fingerprint)
            installation.baseline = {
              snapshot: result.target,
              commit: target.commit,
              tree: target.tree,
            };
        }
        if (installation.baseline) {
          const baseline = await this.store.getSnapshot(installation.baseline.snapshot);
          result.local = baseline.fingerprint === local.fingerprint ? 'clean' : 'modified';
          result.upstream =
            baseline.fingerprint === target.snapshot.fingerprint ? 'current' : 'changed';
        }
        installation.kind = await installationKind(installation.realPath, installation.entries);
        if (installation.kind !== 'local') result.reason = `External owner: ${installation.kind}`;
        else if (!installation.managed) result.reason = 'Not adopted';
        else if (target.pinned) result.reason = 'Version is pinned';
        else if (!installation.baseline)
          result.reason = 'Baseline unverified; review an explicit initial sync';
        else if (result.local === 'modified') result.reason = 'Local modifications';
        else if (local.fingerprint === target.snapshot.fingerprint)
          result.reason = 'Already current';
        else result.eligible = true;
      } catch (error) {
        result.upstream = 'error';
        if (!result.current) result.local = 'unavailable';
        result.reason = errorMessage(error);
      }
    }
    for (const result of results) {
      const installation = installations.find((i) => i.id === result.id)!;
      installation.lastCheck = {
        at: new Date().toISOString(),
        upstream: result.upstream,
        local: result.local,
        reason: result.reason,
        commit: result.commit,
      };
    }
    await this.store.saveState(state);
    return results;
  }

  async check(selector?: string): Promise<CheckResult[]> {
    return this.store.withLock(async () => {
      await this.store.assertRecovered();
      const state = await this.store.loadState();
      return this.checkState(
        state,
        selector ? [selectInstallation(state.installations, selector)] : state.installations,
      );
    });
  }

  async adopt(selector: string): Promise<Installation> {
    return this.store.withLock(async () => {
      await this.store.assertRecovered();
      const state = await this.store.loadState();
      const installation = selectInstallation(state.installations, selector);
      await validateLocation(installation, this.store);
      if ((await installationKind(installation.realPath, installation.entries)) !== 'local')
        throw new BuoyError(
          'EXTERNAL_OWNER',
          'System, plugin and Git worktree installations cannot be adopted',
        );
      if (!installation.source)
        throw new BuoyError('UNKNOWN_SOURCE', 'Bind a source before adopting');
      const [result] = await this.checkState(state, [installation]);
      if (result!.upstream === 'error') throw new BuoyError('CHECK_FAILED', result!.reason!);
      installation.managed = true;
      delete installation.lastCheck;
      await this.store.saveState(state);
      return installation;
    });
  }

  async diff(selector: string, view: 'update' | 'upstream' | 'local' = 'update') {
    return this.store.withLock(async () => {
      await this.store.assertRecovered();
      const state = await this.store.loadState();
      const installation = selectInstallation(state.installations, selector);
      const [result] = await this.checkState(state, [installation]);
      if (!result?.current || !result.target || result.upstream === 'error')
        throw new BuoyError('DIFF_UNAVAILABLE', result?.reason ?? 'Cannot load comparison');
      if (view !== 'update' && !installation.baseline)
        throw new BuoyError(
          'UNVERIFIED_BASELINE',
          'No verified upstream baseline; use the update comparison',
        );
      const before = view === 'update' ? result.current : installation.baseline!.snapshot;
      const after = view === 'local' ? result.current : result.target;
      return {
        id: installation.id,
        view,
        commit: result.commit,
        before,
        after,
        ...(await diffSnapshots(
          await this.store.getSnapshot(before),
          await this.store.getSnapshot(after),
        )),
      };
    });
  }

  async planUpgrade(options: PlanOptions): Promise<UpgradePlan> {
    if (Boolean(options.selector) === Boolean(options.all))
      throw new BuoyError('INVALID_SELECTION', 'Select one installation or --all');
    if (options.initialSync && !options.selector)
      throw new BuoyError('INVALID_SELECTION', 'Initial sync requires one explicit installation');
    return this.store.withLock(async () => {
      await this.store.assertRecovered();
      const state = await this.store.loadState();
      const installations = options.selector
        ? [selectInstallation(state.installations, options.selector)]
        : state.installations;
      const checked = await this.checkState(state, installations);
      const plan: UpgradePlan = {
        id: randomUUID(),
        createdAt: new Date().toISOString(),
        items: [],
        skipped: [],
      };
      for (const result of checked) {
        const installation = installations.find((i) => i.id === result.id)!;
        const initialSync = Boolean(
          options.initialSync &&
          !installation.baseline &&
          installation.managed &&
          installation.kind === 'local' &&
          !result.pinned &&
          result.target &&
          result.current &&
          result.upstream !== 'error',
        );
        if (!result.eligible && !initialSync) {
          plan.skipped.push({
            id: result.id,
            name: result.name,
            reason: result.reason ?? 'Not eligible',
            error: result.upstream === 'error',
          });
          continue;
        }
        plan.items.push({
          installationId: installation.id,
          name: installation.name,
          realPath: installation.realPath,
          entries: [...installation.entries],
          expected: result.current!,
          target: result.target!,
          source: installation.source!,
          baseline: installation.baseline,
          commit: result.commit!,
          tree: result.tree!,
          initialSync,
        });
      }
      await this.store.savePlan(plan);
      return plan;
    });
  }

  async inspectPlan(id: string) {
    return this.store.withLock(async () => {
      const plan = await this.store.getPlan(id);
      const changes = [];
      for (const item of plan.items)
        changes.push({
          id: item.installationId,
          ...(await diffSnapshots(
            await this.store.getSnapshot(item.expected),
            await this.store.getSnapshot(item.target),
          )),
        });
      return { plan, changes };
    });
  }

  async applyUpgrade(planId: string) {
    return this.store.withLock(async () => {
      await this.store.assertRecovered();
      const plan = await this.store.getPlan(planId);
      const results: {
        id: string;
        status: 'upgraded' | 'failed' | 'skipped';
        message?: string;
        commit?: string;
      }[] = [];
      for (const item of plan.items) {
        try {
          await this.store.assertRecovered();
          const state = await this.store.loadState();
          const installation = selectInstallation(state.installations, item.installationId);
          await assertWritable(installation, this.store);
          if (
            installation.realPath !== item.realPath ||
            JSON.stringify(installation.entries) !== JSON.stringify(item.entries) ||
            JSON.stringify(installation.source) !== JSON.stringify(item.source) ||
            JSON.stringify(installation.baseline) !== JSON.stringify(item.baseline)
          ) {
            throw new BuoyError('STALE_PLAN', 'Installation metadata changed; generate a new plan');
          }
          if (
            !item.initialSync &&
            (!installation.baseline || installation.baseline.snapshot !== item.expected)
          )
            throw new BuoyError(
              'STALE_PLAN',
              'Plan would overwrite unverified or modified content',
            );
          if (item.initialSync && installation.baseline)
            throw new BuoyError(
              'STALE_PLAN',
              'Initial sync is only valid without a verified baseline',
            );
          const target = await this.store.getSnapshot(item.target);
          const history: HistoryEntry = {
            id: randomUUID(),
            installationId: installation.id,
            action: 'upgrade',
            at: new Date().toISOString(),
            before: item.expected,
            after: item.target,
            source: item.source,
            previousBaseline: installation.baseline,
            nextBaseline: { snapshot: item.target, commit: item.commit, tree: item.tree },
            commit: item.commit,
          };
          await new Updater(this.store, this.options.hooks).replace(
            state,
            installation,
            target,
            history,
          );
          results.push({ id: installation.id, status: 'upgraded', commit: item.commit });
        } catch (error) {
          results.push({ id: item.installationId, status: 'failed', message: errorMessage(error) });
        }
      }
      return { planId, results, skipped: plan.skipped };
    });
  }

  async history(selector?: string): Promise<HistoryEntry[]> {
    return this.store.withLock(async () => {
      const state = await this.store.loadState();
      const installation = selector ? selectInstallation(state.installations, selector) : undefined;
      return state.history.filter(
        (entry) => !installation || entry.installationId === installation.id,
      );
    });
  }

  async rollback(selector: string, expectedHistoryId?: string): Promise<HistoryEntry> {
    return this.store.withLock(async () => {
      await this.store.assertRecovered();
      const state = await this.store.loadState();
      const installation = selectInstallation(state.installations, selector);
      await assertWritable(installation, this.store);
      const last = state.history.findLast((entry) => entry.installationId === installation.id);
      if (!last || last.action !== 'upgrade')
        throw new BuoyError('NO_ROLLBACK', 'No latest upgrade to roll back');
      if (expectedHistoryId && last.id !== expectedHistoryId)
        throw new BuoyError('STALE_PLAN', 'Upgrade history changed; review rollback again');
      if (JSON.stringify(last.source) !== JSON.stringify(installation.source))
        throw new BuoyError('SOURCE_CHANGED', 'Source changed since the upgrade');
      const current = await readSnapshot(installation.realPath);
      if (current.fingerprint !== last.after)
        throw new BuoyError(
          'LOCAL_MODIFIED',
          'Files changed after the upgrade; rollback was blocked',
        );
      const history: HistoryEntry = {
        id: randomUUID(),
        installationId: installation.id,
        action: 'rollback',
        at: new Date().toISOString(),
        before: current.fingerprint,
        after: last.before,
        source: installation.source!,
        previousBaseline: installation.baseline,
        nextBaseline: last.previousBaseline,
        commit: last.previousBaseline?.commit,
      };
      await new Updater(this.store, this.options.hooks).replace(
        state,
        installation,
        await this.store.getSnapshot(last.before),
        history,
      );
      return history;
    });
  }

  async recover() {
    return this.store.withLock(() => new Updater(this.store).recover());
  }
}
