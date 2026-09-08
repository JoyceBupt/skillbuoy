import { z } from 'zod';

export const digestSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const objectIdSchema = z.string().regex(/^[a-f0-9]{40}([a-f0-9]{24})?$/);
export const idSchema = z.string().regex(/^[a-f0-9]{12}$/);
export const uuidSchema = z.string().uuid();

export const sourceSchema = z
  .object({
    repo: z.string().min(1),
    path: z.string().min(1),
    tracking: z.enum(['branch', 'tag', 'commit', 'ref']),
    ref: z.string().min(1).optional(),
    provenance: z.enum(['manual', 'vercel-global', 'vercel-project']),
    importedHash: z
      .object({
        kind: z.enum(['git-tree', 'vercel-content']),
        value: objectIdSchema,
      })
      .strict()
      .optional(),
  })
  .strict();
export type Source = z.infer<typeof sourceSchema>;

export const baselineSchema = z
  .object({
    snapshot: digestSchema,
    commit: objectIdSchema.optional(),
    tree: objectIdSchema.optional(),
  })
  .strict();

export const installationSchema = z
  .object({
    id: idSchema,
    name: z.string(),
    realPath: z.string(),
    entries: z.array(z.string()).min(1),
    kind: z.enum(['local', 'system', 'plugin', 'git']),
    managed: z.boolean(),
    source: sourceSchema.optional(),
    baseline: baselineSchema.optional(),
    observed: digestSchema.optional(),
    diagnostics: z.array(z.string()),
    lastCheck: z
      .object({
        at: z.string(),
        upstream: z.enum(['changed', 'current', 'unknown', 'error']),
        local: z.enum(['clean', 'modified', 'unverified', 'unavailable']),
        reason: z.string().optional(),
        commit: objectIdSchema.optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type Installation = z.infer<typeof installationSchema>;

export const historySchema = z
  .object({
    id: uuidSchema,
    installationId: idSchema,
    action: z.enum(['upgrade', 'rollback']),
    at: z.string(),
    before: digestSchema,
    after: digestSchema,
    source: sourceSchema,
    previousBaseline: baselineSchema.optional(),
    nextBaseline: baselineSchema.optional(),
    commit: objectIdSchema.optional(),
  })
  .strict();
export type HistoryEntry = z.infer<typeof historySchema>;

export const stateSchema = z
  .object({
    version: z.literal(1),
    installations: z.array(installationSchema),
    history: z.array(historySchema),
  })
  .strict();
export type State = z.infer<typeof stateSchema>;

export const fileSchema = z
  .object({
    path: z.string().min(1),
    kind: z.enum(['file', 'link', 'directory']),
    mode: z.number().int().min(0).max(0o777),
    data: z.string(),
  })
  .strict();
export type SnapshotFile = z.infer<typeof fileSchema>;
export const snapshotSchema = z
  .object({
    fingerprint: digestSchema,
    files: z.array(fileSchema),
  })
  .strict();
export type Snapshot = z.infer<typeof snapshotSchema>;

export const planItemSchema = z
  .object({
    installationId: idSchema,
    name: z.string(),
    realPath: z.string(),
    entries: z.array(z.string()),
    expected: digestSchema,
    target: digestSchema,
    source: sourceSchema,
    baseline: baselineSchema.optional(),
    commit: objectIdSchema,
    tree: objectIdSchema,
    initialSync: z.boolean(),
  })
  .strict();
export type PlanItem = z.infer<typeof planItemSchema>;
export const planSchema = z
  .object({
    id: uuidSchema,
    createdAt: z.string(),
    items: z.array(planItemSchema),
    skipped: z.array(
      z
        .object({
          id: idSchema,
          name: z.string(),
          reason: z.string(),
          error: z.boolean().optional(),
        })
        .strict(),
    ),
  })
  .strict();
export type UpgradePlan = z.infer<typeof planSchema>;

export const journalSchema = z
  .object({
    id: uuidSchema,
    installationId: idSchema,
    realPath: z.string(),
    entries: z.array(z.string()),
    before: digestSchema,
    after: digestSchema,
    rootMode: z.number().int().min(0).max(0o777),
    history: historySchema,
  })
  .strict();
export type Journal = z.infer<typeof journalSchema>;

export const configSchema = z
  .object({
    roots: z.array(z.string()).default([]),
    projectsRoots: z.array(z.string()).default([]),
    maxDepth: z.number().int().min(1).max(20).default(8),
    exclude: z.array(z.string()).default(['node_modules', '.git', 'dist', 'build', '.cache']),
  })
  .strict();
export type Config = z.infer<typeof configSchema>;

export interface CheckResult {
  id: string;
  name: string;
  upstream: 'changed' | 'current' | 'unknown' | 'error';
  local: 'clean' | 'modified' | 'unverified' | 'unavailable';
  managed: boolean;
  eligible: boolean;
  reason?: string;
  pinned?: boolean;
  current?: string;
  target?: string;
  commit?: string;
  tree?: string;
}
