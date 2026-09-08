# SkillBuoy

English | [简体中文](Readme.zh-CN.md)

Manage Agent Skills where they are installed: check upstream changes, review diffs, upgrade, and roll back.

## Install

Requires Node.js 24, pnpm 11.18.0, and Git. Tested on macOS; Linux has not been verified.

```sh
git clone https://github.com/JoyceBupt/skillbuoy.git
cd skillbuoy
pnpm install --frozen-lockfile --ignore-scripts
pnpm build
```

## Usage

Scan existing installations, check for updates, and review the changes:

```sh
pnpm start scan
pnpm start check
pnpm start diff SKILL_ID
```

Use an ID from the scan results for `SKILL_ID`, or a Skill name if it matches exactly one installation.

Before the first update, use `adopt` to let SkillBuoy manage the installation. Then preview and apply an update plan:

```sh
pnpm start adopt SKILL_ID
pnpm start upgrade SKILL_ID --dry-run
pnpm start upgrade --plan PLAN_ID
```

The preview returns a `PLAN_ID`. Applying it uses the version recorded in the plan and stops if local files have changed since the preview.

Other useful commands:

```sh
pnpm start upgrade --all --dry-run  # Preview batch updates, then apply by PLAN_ID
pnpm start history SKILL_ID
pnpm start rollback SKILL_ID
pnpm start recover                # Recover interrupted updates
```

Updates skip installations with local changes, unknown sources, unverified baselines, or pinned versions, and any you haven't adopted. Skills supplied by the system, stored in plugin caches, or located inside Git worktrees cannot be adopted. SkillBuoy leaves the original installer's lockfile unchanged; avoid using both tools to update the same directory.

When the original installed version cannot be confirmed, the status is `unverified`. To sync it for the first time, preview with the command below, then apply the resulting plan. This backs up and replaces the current contents without merging changes.

```sh
pnpm start upgrade SKILL_ID --initial-sync --dry-run
```

Run updates and rollbacks while the relevant agents are idle. Rollback stops if files have been edited since the upgrade.

## Scan locations and sources

By default, SkillBuoy scans `.agents/skills`, `.codex/skills`, and `.claude/skills` under your home and current directories. To scan other locations:

```sh
pnpm start scan --projects-root ~/code
pnpm start scan --root ~/my-skills
```

SkillBuoy reads source records from Vercel Skills. For installations without a record, bind the source manually, replacing the repository URL and path:

```sh
pnpm start track SKILL_ID --repo https://github.com/OWNER/REPO.git --path skills/NAME
```

`--path` is the Skill directory within the repository. SkillBuoy follows the repository's default branch unless you specify `--branch`, `--tag`, or `--commit`.

Local data lives in `~/.skillbuoy/`. Set `SKILLBUOY_HOME` to use another directory. The `snapshots/` directory holds rollback backups; do not delete it as part of cache cleanup.

See `pnpm start --help` for all options. For scripts, use `node dist/cli/index.js check --json`. Non-interactive updates require `--yes`; all other update checks still apply.

## Development

```sh
pnpm check
```

Runs formatting checks, lint, type checks, the build, and tests. See [AGENTS.md](AGENTS.md) for development conventions.

## License

[MIT](LICENSE). Third-party Skills retain their own licenses.
