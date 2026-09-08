import path from 'node:path';
import { z } from 'zod';
import type { Installation, Source } from '../schemas/index.js';
import { readBounded, inside, relativePath } from '../infra/snapshot.js';
import { isMissing, errorMessage } from '../infra/errors.js';
import { validateSource } from '../infra/git.js';

const entrySchema = z
  .object({
    source: z.string(),
    sourceType: z.string(),
    sourceUrl: z.string().optional(),
    ref: z.string().optional(),
    skillPath: z.string().optional(),
    skillFolderHash: z.string().optional(),
    computedHash: z.string().optional(),
  })
  .passthrough();
const lockSchema = z
  .object({ version: z.number(), skills: z.record(z.string(), z.unknown()) })
  .passthrough();

export interface Diagnostic {
  path: string;
  message: string;
}

export async function importVercel(
  installations: Installation[],
  userHome: string,
  xdgStateHome: string | undefined,
): Promise<Diagnostic[]> {
  const diagnostics: Diagnostic[] = [];
  const files = new Map<string, { kind: 'vercel-global' | 'vercel-project'; roots: string[] }>();
  files.set(
    xdgStateHome
      ? path.join(xdgStateHome, 'skills/.skill-lock.json')
      : path.join(userHome, '.agents/.skill-lock.json'),
    {
      kind: 'vercel-global',
      roots: ['.agents', '.codex', '.claude'].map((agent) => path.join(userHome, agent, 'skills')),
    },
  );
  for (const installation of installations) {
    for (const location of installation.entries) {
      let parent = path.dirname(location);
      while (parent !== path.dirname(parent)) {
        if (
          path.basename(parent) === 'skills' &&
          ['.agents', '.codex', '.claude'].includes(path.basename(path.dirname(parent)))
        ) {
          const project = path.dirname(path.dirname(parent));
          if (project !== userHome)
            files.set(path.join(project, 'skills-lock.json'), {
              kind: 'vercel-project',
              roots: ['.agents', '.codex', '.claude'].map((agent) =>
                path.join(project, agent, 'skills'),
              ),
            });
          break;
        }
        parent = path.dirname(parent);
      }
    }
  }
  const candidates = new Map<string, Source[]>();
  for (const [file, scope] of files) {
    let lock: z.infer<typeof lockSchema>;
    try {
      lock = lockSchema.parse(
        JSON.parse((await readBounded(file, 8 * 1024 * 1024)).toString('utf8')),
      );
    } catch (error) {
      if (!isMissing(error)) diagnostics.push({ path: file, message: errorMessage(error) });
      continue;
    }
    if (lock.version !== (scope.kind === 'vercel-global' ? 3 : 1)) {
      diagnostics.push({ path: file, message: `Unsupported lock version: ${lock.version}` });
      continue;
    }
    for (const [name, raw] of Object.entries(lock.skills)) {
      const matching = installations.filter(
        (i) =>
          i.entries.some((entry) => scope.roots.some((root) => inside(root, entry))) &&
          path.basename(i.realPath) === name,
      );
      if (matching.length !== 1) {
        if (matching.length > 1)
          diagnostics.push({ path: file, message: `Ambiguous installation for ${name}` });
        continue;
      }
      const installation = matching[0]!;
      if (installation.source) continue;
      try {
        const entry = entrySchema.parse(raw);
        if (
          entry.sourceType !== 'github' ||
          !/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(entry.source)
        ) {
          throw new Error(`Unsupported source type for ${name}; bind a repository manually`);
        }
        if (!entry.skillPath)
          throw new Error(`Missing upstream path for ${name}; bind the Skill directory manually`);
        const skillPath =
          entry.skillPath === 'SKILL.md' ? '.' : entry.skillPath.replace(/\/SKILL\.md$/, '');
        relativePath(skillPath, true);
        const source: Source = {
          repo: `https://github.com/${entry.source.replace(/\.git$/, '')}.git`,
          path: skillPath,
          tracking: 'ref',
          ...(entry.ref ? { ref: entry.ref } : {}),
          provenance: scope.kind,
        };
        const importedHash =
          scope.kind === 'vercel-global' ? entry.skillFolderHash : entry.computedHash;
        if (importedHash && /^[a-f0-9]{40}([a-f0-9]{24})?$/.test(importedHash))
          source.importedHash = {
            kind: scope.kind === 'vercel-global' ? 'git-tree' : 'vercel-content',
            value: importedHash,
          };
        validateSource(source);
        candidates.set(installation.id, [...(candidates.get(installation.id) ?? []), source]);
      } catch (error) {
        installation.diagnostics.push(errorMessage(error));
        diagnostics.push({ path: file, message: errorMessage(error) });
      }
    }
  }
  for (const installation of installations) {
    const sources = candidates.get(installation.id) ?? [];
    const unique = [...new Map(sources.map((source) => [JSON.stringify(source), source])).values()];
    if (unique.length === 1) installation.source = unique[0];
    else if (unique.length > 1)
      installation.diagnostics.push('Conflicting installer source records; bind source manually');
  }
  return diagnostics;
}
