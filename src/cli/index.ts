#!/usr/bin/env node
import { Command, CommanderError, Option } from 'commander';
import { createInterface } from 'node:readline/promises';
import { stdin, stderr } from 'node:process';
import { SkillBuoy, selectInstallation } from '../core/engine.js';
import type { Source } from '../schemas/index.js';
import { BuoyError, errorMessage, sanitize } from '../infra/errors.js';

const program = new Command();
program
  .name('skillbuoy')
  .version('0.1.0')
  .description('Inspect and update installed Agent Skills')
  .option('--home <directory>', 'State directory (or SKILLBUOY_HOME)')
  .option('--json', 'Output JSON')
  .showHelpAfterError()
  .exitOverride();

const engine = () => new SkillBuoy({ home: program.opts().home as string | undefined });
const jsonMode = () => Boolean(program.opts().json);
const print = (value: unknown): void => {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
};
const line = (value: string): void => {
  process.stdout.write(`${sanitize(value)}\n`);
};
const review = (value: string): void => {
  stderr.write(`${sanitize(value)}\n`);
};
function table(rows: Record<string, string | number | boolean | null | undefined>[]): void {
  if (!rows.length) {
    line('No entries.');
    return;
  }
  const keys = Object.keys(rows[0]!);
  const cells = rows.map((row) => keys.map((key) => sanitize(String(row[key] ?? '—'))));
  const widths = keys.map((key, index) =>
    Math.min(60, Math.max(key.length, ...cells.map((row) => row[index]!.length))),
  );
  const render = (values: string[]) =>
    values
      .map((value, index) => value.padEnd(widths[index]!))
      .join('  ')
      .trimEnd();
  line(render(keys));
  for (const row of cells) line(render(row));
}

async function confirm(message: string, yes: boolean): Promise<void> {
  if (yes) return;
  if (!stdin.isTTY || !stderr.isTTY)
    throw new BuoyError('CONFIRMATION_REQUIRED', 'Review with --dry-run, then use --yes to apply');
  const input = createInterface({ input: stdin, output: stderr });
  try {
    if (!/^y(?:es)?$/i.test((await input.question(`${message} [y/N] `)).trim()))
      throw new BuoyError('CANCELLED', 'Cancelled');
  } finally {
    input.close();
  }
}

program
  .command('scan')
  .description('Discover installed Skills')
  .option('--root <directories...>', 'Additional Skill roots')
  .option('--projects-root <directories...>', 'Search project directories')
  .option('--no-defaults', 'Use only configured and explicit roots')
  .option('--depth <number>', 'Maximum scan depth', Number)
  .action(async (options) => {
    const result = await engine().scan({
      roots: options.root,
      projectsRoots: options.projectsRoot,
      defaults: options.defaults,
      maxDepth: options.depth,
    });
    if (jsonMode()) print(result);
    else {
      table(
        result.installations.map((i) => ({
          ID: i.id,
          NAME: i.name,
          OWNER: i.kind,
          SOURCE: i.source?.repo ?? 'unknown',
          PATH: i.realPath,
        })),
      );
      for (const entry of result.installations)
        for (const diagnostic of entry.diagnostics) review(`${entry.id}: ${diagnostic}`);
      for (const diagnostic of result.diagnostics)
        review(`${diagnostic.path}: ${diagnostic.message}`);
    }
    if (result.diagnostics.length || result.installations.some((i) => i.diagnostics.length))
      process.exitCode = 1;
  });

program
  .command('list')
  .description('List recorded installations')
  .action(async () => {
    const result = await engine().list();
    if (jsonMode()) print(result);
    else {
      table(
        result.installations.map((i) => ({
          ID: i.id,
          NAME: i.name,
          OWNER: i.managed ? 'skillbuoy' : i.kind,
          UPSTREAM: i.lastCheck?.upstream ?? 'unknown',
          LOCAL: i.lastCheck?.local ?? 'unverified',
          CHECKED: i.lastCheck?.at ?? 'never',
          PATH: i.realPath,
        })),
      );
      if (result.pendingRecovery)
        review(`${result.pendingRecovery} pending transaction(s); run skillbuoy recover`);
    }
  });

program
  .command('track <skill>')
  .description('Bind an upstream repository')
  .requiredOption('--repo <url>', 'HTTPS, SSH, or absolute local repository')
  .requiredOption('--path <directory>', 'Skill directory inside the repository')
  .option('--branch <name>', 'Track a branch (default: remote HEAD)')
  .option('--tag <name>', 'Pin a tag')
  .option('--commit <sha>', 'Pin a commit')
  .option('--yes', 'Confirm source replacement')
  .action(async (selector, options) => {
    if ([options.branch, options.tag, options.commit].filter(Boolean).length > 1)
      throw new BuoyError('INVALID_REF', 'Choose one branch, tag, or commit');
    const buoy = engine();
    const installation = selectInstallation((await buoy.list()).installations, selector);
    const source: Source = {
      repo: options.repo,
      path: options.path,
      tracking: options.commit ? 'commit' : options.tag ? 'tag' : 'branch',
      ref: options.commit ?? options.tag ?? options.branch,
      provenance: 'manual',
    };
    if (installation.source && JSON.stringify(installation.source) !== JSON.stringify(source)) {
      review(
        `${installation.id}  ${installation.realPath}\nSource: ${source.repo} / ${source.path}\nBaseline and adoption will be reset.`,
      );
      await confirm('Replace source?', options.yes);
    }
    const result = await buoy.track(selector, source);
    if (jsonMode()) print(result);
    else line(`Tracked ${result.id}: ${result.source!.repo} / ${result.source!.path}`);
  });

program
  .command('check [skill]')
  .description('Check upstream and local changes')
  .action(async (selector) => {
    const result = await engine().check(selector);
    if (jsonMode()) print(result);
    else
      table(
        result.map((i) => ({
          ID: i.id,
          NAME: i.name,
          UPSTREAM: i.upstream,
          LOCAL: i.local,
          ACTION: i.eligible ? 'upgrade available' : i.reason,
        })),
      );
    if (result.some((i) => i.upstream === 'error')) process.exitCode = 1;
  });

program
  .command('adopt <skill>')
  .description('Take ownership of an installation')
  .option('--yes', 'Confirm adoption')
  .action(async (selector, options) => {
    const buoy = engine();
    const installation = selectInstallation((await buoy.list()).installations, selector);
    review(
      `${installation.id}  ${installation.realPath}\nManager: SkillBuoy\nOriginal installer records will remain unchanged.`,
    );
    await confirm('Adopt installation?', options.yes);
    const result = await buoy.adopt(selector);
    if (jsonMode()) print(result);
    else line(`Adopted ${result.id}; baseline ${result.baseline ? 'verified' : 'unverified'}`);
  });

program
  .command('diff <skill>')
  .description('Review file changes')
  .addOption(
    new Option('--view <comparison>', 'Comparison')
      .choices(['update', 'upstream', 'local'])
      .default('update'),
  )
  .action(async (selector, options) => {
    const result = await engine().diff(selector, options.view);
    if (jsonMode()) print(result);
    else {
      table(
        result.files.map((file) => ({
          PATH: file.path,
          CHANGE: file.change,
          BINARY: file.binary,
          BEFORE: file.oldMode?.toString(8),
          AFTER: file.newMode?.toString(8),
        })),
      );
      line(result.patch);
    }
  });

program
  .command('upgrade [skill]')
  .alias('update')
  .description('Apply a reviewed upgrade')
  .option('--all', 'Select every eligible installation')
  .option('--plan <id>', 'Apply a saved immutable plan')
  .option('--initial-sync', 'Review first synchronization for one unverified installation')
  .option('--dry-run', 'Save and display the plan without updating Skills')
  .option('--yes', 'Confirm the displayed plan')
  .action(async (selector, options) => {
    if (options.plan && (selector || options.all || options.initialSync))
      throw new BuoyError('INVALID_SELECTION', '--plan cannot be combined with a new selection');
    const buoy = engine();
    const plan = options.plan
      ? (await buoy.inspectPlan(options.plan)).plan
      : await buoy.planUpgrade({ selector, all: options.all, initialSync: options.initialSync });
    const inspected = await buoy.inspectPlan(plan.id);
    if (options.dryRun) {
      if (jsonMode()) print(inspected);
      else {
        line(`Plan ${plan.id}`);
        table(
          plan.items.map((i) => ({ ID: i.installationId, COMMIT: i.commit, PATH: i.realPath })),
        );
        for (const change of inspected.changes) line(change.patch);
        for (const skip of plan.skipped) line(`${skip.id}: skipped — ${skip.reason}`);
      }
      if (plan.skipped.some((i) => i.error)) process.exitCode = 1;
      return;
    }
    for (const item of plan.items) {
      review(
        `${item.installationId}  ${item.realPath}\nCommit: ${item.commit}${item.initialSync ? '\nInitial sync: current files will be backed up and replaced.' : ''}`,
      );
      const changes = inspected.changes.find((change) => change.id === item.installationId)!;
      for (const file of changes.files) review(`  ${file.change}: ${file.path}`);
      if (item.initialSync) review(changes.patch);
    }
    if (plan.items.length) await confirm(`Apply ${plan.items.length} upgrade(s)?`, options.yes);
    const result = await buoy.applyUpgrade(plan.id);
    if (jsonMode()) print(result);
    else {
      table(
        result.results.map((i) => ({ ID: i.id, STATUS: i.status, DETAIL: i.message ?? i.commit })),
      );
      for (const skip of result.skipped) line(`${skip.id}: skipped — ${skip.reason}`);
    }
    if (result.results.some((i) => i.status === 'failed') || result.skipped.some((i) => i.error))
      process.exitCode = 1;
  });

program
  .command('history [skill]')
  .description('List upgrades and rollbacks')
  .action(async (selector) => {
    const result = await engine().history(selector);
    if (jsonMode()) print(result);
    else
      table(
        result.map((i) => ({
          ID: i.id,
          SKILL: i.installationId,
          ACTION: i.action,
          AT: i.at,
          COMMIT: i.commit,
        })),
      );
  });

program
  .command('rollback <skill>')
  .description('Restore the latest upgrade backup')
  .option('--yes', 'Confirm rollback')
  .action(async (selector, options) => {
    const buoy = engine();
    const installation = selectInstallation((await buoy.list()).installations, selector);
    const last = (await buoy.history(selector)).at(-1);
    if (!last || last.action !== 'upgrade')
      throw new BuoyError('NO_ROLLBACK', 'No latest upgrade to roll back');
    review(
      `${installation.id}  ${installation.realPath}\nRestore backup: ${last.before}\nUpgrade: ${last.id}`,
    );
    await confirm('Restore backup?', options.yes);
    const result = await buoy.rollback(selector, last.id);
    if (jsonMode()) print(result);
    else line(`Rolled back ${result.installationId}`);
  });

program
  .command('recover')
  .description('Recover interrupted updates')
  .action(async () => {
    const result = await engine().recover();
    if (jsonMode()) print(result);
    else table(result.map((i) => ({ ID: i.id, SKILL: i.installationId, STATUS: i.status })));
  });

try {
  await program.parseAsync();
} catch (error) {
  if (error instanceof CommanderError && error.exitCode === 0) process.exitCode = 0;
  else {
    const code =
      error instanceof BuoyError
        ? error.code
        : error instanceof CommanderError
          ? error.code
          : 'ERROR';
    const message = sanitize(errorMessage(error));
    if (jsonMode() || process.argv.includes('--json')) print({ error: { code, message } });
    else review(`${code}: ${message}`);
    process.exitCode = 1;
  }
}
