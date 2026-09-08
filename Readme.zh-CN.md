# SkillBuoy

[English](Readme.md) | 简体中文

管理散落在不同目录里的 Agent Skills：检查上游更新、查看改动、升级和回滚，无需迁移已有安装。

## 安装

需要 Node.js 24、pnpm 11.18.0 和 Git。macOS 已测试，Linux 尚未验证。

```sh
git clone https://github.com/JoyceBupt/skillbuoy.git
cd skillbuoy
pnpm install --frozen-lockfile --ignore-scripts
pnpm build
```

## 使用

先扫描已有安装，再检查更新、查看差异：

```sh
pnpm start scan
pnpm start check
pnpm start diff SKILL_ID
```

`SKILL_ID` 使用扫描结果中的 ID，也可以填写唯一的 Skill 名称。

首次更新前，用 `adopt` 将该安装交给 SkillBuoy 管理。然后预览并执行更新计划：

```sh
pnpm start adopt SKILL_ID
pnpm start upgrade SKILL_ID --dry-run
pnpm start upgrade --plan PLAN_ID
```

`PLAN_ID` 来自预览结果。执行时使用计划中的版本；本地文件在预览后发生变化，更新会停止。

其它常用命令：

```sh
pnpm start upgrade --all --dry-run  # 预览批量更新，随后按 PLAN_ID 执行
pnpm start history SKILL_ID
pnpm start rollback SKILL_ID
pnpm start recover                # 恢复中断的更新
```

有本地修改、来源未知、基线未确认、版本固定或未接管的安装会跳过。系统自带、插件缓存和 Git 工作区中的 Skills 不支持接管。接管后，原安装器的锁文件不会同步，请避免两个工具同时更新同一目录。

无法确认安装时的原版时，状态会显示 `unverified`。需要首次同步可使用下面的命令预览，再执行对应计划；这会备份并替换现有内容，不会合并修改。

```sh
pnpm start upgrade SKILL_ID --initial-sync --dry-run
```

更新和回滚都建议在相关 Agent 空闲时进行。升级后的文件又被修改时，回滚会停止。

## 扫描范围与来源

默认扫描用户目录和当前目录下的 `.agents/skills`、`.codex/skills`、`.claude/skills`。也可以指定其它位置：

```sh
pnpm start scan --projects-root ~/code
pnpm start scan --root ~/my-skills
```

SkillBuoy 会读取 Vercel Skills 的来源记录。没有记录的安装可以手动绑定，仓库地址和路径需替换为实际值：

```sh
pnpm start track SKILL_ID --repo https://github.com/OWNER/REPO.git --path skills/NAME
```

`--path` 填仓库内的 Skill 目录。默认跟踪仓库的默认分支，也可用 `--branch`、`--tag` 或 `--commit` 指定引用。

本地数据保存在 `~/.skillbuoy/`，可用 `SKILLBUOY_HOME` 指定其它目录。其中 `snapshots/` 保存回滚备份，不要当作缓存清理。

完整参数见 `pnpm start --help`。脚本调用可使用 `node dist/cli/index.js check --json`；非交互更新需要显式加 `--yes`，其余更新限制仍然生效。

## 开发

```sh
pnpm check
```

运行格式检查、lint、类型检查、构建和测试。开发约定见 [AGENTS.md](AGENTS.md)。

## License

[MIT](LICENSE)。第三方 Skills 遵循各自的许可证。
