import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';

export const NOUL_REDUCERS = ['max', 'mean', 'min', 'noisy_or'] as const;
export const CHOICE_REDUCERS = ['top_page', 'mean'] as const;
export const SCORE_REDUCERS = ['max', 'mean', 'min'] as const;

/** Jev accepts at most this number of labels in one choice. */
export const MAX_CHOICE_LABELS = 255;

const ask = z.string().min(1).optional();

const noulQuestion = z.strictObject({
  noul: z.string().min(1),
  yes: z.string().min(1).optional(),
  no: z.string().min(1).optional(),
  reduce: z.enum(NOUL_REDUCERS).default('max'),
});

const choiceQuestion = z
  .strictObject({
    choice: z.record(z.string().min(1), z.string().nullable()),
    ask,
    fallback: z.string().optional(),
    reduce: z.enum(CHOICE_REDUCERS).default('top_page'),
  })
  .superRefine((q, ctx) => {
    const labels = Object.keys(q.choice);
    if (labels.length < 2) {
      ctx.addIssue({ code: 'custom', message: 'a choice needs at least two labels' });
    }
    if (labels.length > MAX_CHOICE_LABELS) {
      ctx.addIssue({
        code: 'custom',
        message: `a choice allows at most ${MAX_CHOICE_LABELS} labels`,
      });
    }
    if (q.fallback !== undefined && !labels.includes(q.fallback)) {
      ctx.addIssue({
        code: 'custom',
        message: `fallback "${q.fallback}" is not one of the labels: ${labels.join(', ')}`,
      });
    }
  });

const scoreQuestion = z.strictObject({
  score: z.array(z.string().min(1)).min(2),
  ask,
  reduce: z.enum(SCORE_REDUCERS).default('max'),
});

const useQuestion = z.strictObject({
  use: z.string().regex(/^[^#]+#[^#]+$/, 'expected "<pack>#<question>"'),
});

const question = z.union([noulQuestion, choiceQuestion, scoreQuestion]);
const questionOrUse = z.union([noulQuestion, choiceQuestion, scoreQuestion, useQuestion]);

const extractField = z.strictObject({
  keys: z.array(z.string().min(1)).min(1),
  verify: z.boolean().default(false),
});

const name = z.string().regex(/^[a-z][a-z0-9_]*$/, 'use lower_snake_case');

const inlinePack = z.strictObject({
  questions: z.record(name, questionOrUse).default({}),
  extract: z.record(name, extractField).default({}),
  get route() {
    return routeFile.optional();
  },
});

const routeTarget = z.union([z.string().min(1), inlinePack]);

const routeFile = z.strictObject({
  on: name,
  min_confidence: z.number().min(0).max(1).optional(),
  cases: z.record(z.string().min(1), routeTarget),
  default: routeTarget.optional(),
});

const parseMode = z.enum(['text', 'structure', 'understand', 'agentic']);

const packFile = z.strictObject({
  name: z.string().min(1),
  version: z.string().regex(/^\d+\.\d+\.\d+$/, 'use semver, for example 1.0.0'),
  description: z.string().optional(),
  mode: parseMode.optional(),
  questions: z.record(name, questionOrUse).default({}),
  extract: z.record(name, extractField).default({}),
  route: routeFile.optional(),
});

export type Question = z.infer<typeof question>;
export type ExtractField = z.infer<typeof extractField>;
export type ParseMode = z.infer<typeof parseMode>;

type PackBody = z.infer<typeof inlinePack>;

export interface RouteTarget {
  /** Prepended to the target's column names: `<prefix>.<question>`. */
  prefix: string;
  pack: Pack;
}

export interface Route {
  /** The choice question in this pack whose document answer selects the case. */
  on: string;
  minConfidence?: number;
  cases: Record<string, RouteTarget>;
  default?: RouteTarget;
}

export interface Pack {
  name: string;
  version: string;
  description?: string;
  /** A routed pack carries the root pack's mode: extraction runs once, before routing. */
  mode: ParseMode;
  questions: Record<string, Question>;
  extract: Record<string, ExtractField>;
  route?: Route;
}

const BUILT_IN_PACKS = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'packs');

export class PackError extends Error {
  constructor(path: string, detail: string) {
    super(`${path}: ${detail}`);
    this.name = 'PackError';
  }
}

interface LoadContext {
  useChain: readonly string[];
  routeChain: readonly string[];
  /** Undefined while loading the root pack. */
  rootMode: ParseMode | undefined;
  withRoute: boolean;
}

export async function loadPack(path: string): Promise<Pack> {
  return loadResolved(resolve(path), {
    useChain: [],
    routeChain: [],
    rootMode: undefined,
    withRoute: true,
  });
}

function resolvePackRef(ref: string, from: string): string {
  return ref.startsWith('.') || ref.startsWith('/')
    ? resolve(dirname(from), ref)
    : resolve(BUILT_IN_PACKS, `${ref}.yaml`);
}

async function loadResolved(path: string, ctx: LoadContext): Promise<Pack> {
  if (ctx.useChain.includes(path)) {
    throw new PackError(path, `circular "use" chain: ${[...ctx.useChain, path].join(' -> ')}`);
  }
  if (ctx.routeChain.includes(path)) {
    throw new PackError(path, `circular "route" chain: ${[...ctx.routeChain, path].join(' -> ')}`);
  }
  const raw = await readFile(path, 'utf8').catch((cause: unknown) => {
    throw new PackError(path, `cannot read pack (${(cause as Error).message})`);
  });
  const parsed = packFile.safeParse(parseYaml(raw));
  if (!parsed.success) {
    throw new PackError(path, z.prettifyError(parsed.error));
  }
  const file = parsed.data;
  if (ctx.rootMode !== undefined && file.mode !== undefined && file.mode !== ctx.rootMode) {
    throw new PackError(
      path,
      `mode "${file.mode}" differs from the root pack's mode "${ctx.rootMode}"; ` +
        'documents are extracted once, before routing, so a routed pack cannot change the mode',
    );
  }
  const mode = ctx.rootMode ?? file.mode ?? 'agentic';
  return buildPack(
    file,
    {
      name: file.name,
      version: file.version,
      ...(file.description !== undefined ? { description: file.description } : {}),
      mode,
    },
    path,
    { ...ctx, useChain: [...ctx.useChain, path], routeChain: [...ctx.routeChain, path] },
  );
}

async function buildPack(
  body: PackBody,
  identity: Pick<Pack, 'name' | 'version' | 'description' | 'mode'>,
  path: string,
  ctx: LoadContext,
): Promise<Pack> {
  const hasEntries =
    Object.keys(body.questions).length > 0 ||
    Object.keys(body.extract).length > 0 ||
    body.route !== undefined;
  if (!hasEntries) {
    throw new PackError(
      path,
      `${identity.name} needs at least one entry under "questions", "extract", or "route"`,
    );
  }

  const questions: Record<string, Question> = {};
  for (const [key, entry] of Object.entries(body.questions)) {
    questions[key] = 'use' in entry ? await resolveUse(entry.use, path, ctx.useChain) : entry;
  }

  const pack: Pack = { ...identity, questions, extract: body.extract };
  if (body.route !== undefined && ctx.withRoute) {
    pack.route = await buildRoute(body.route, pack, path, ctx);
  }
  return pack;
}

async function buildRoute(
  file: NonNullable<PackBody['route']>,
  parent: Pack,
  path: string,
  ctx: LoadContext,
): Promise<Route> {
  const on = parent.questions[file.on];
  if (on === undefined) {
    const known = Object.keys(parent.questions).join(', ') || 'none';
    throw new PackError(
      path,
      `route.on "${file.on}" is not a question in ${parent.name}; it defines: ${known}`,
    );
  }
  if (!('choice' in on)) {
    throw new PackError(path, `route.on "${file.on}" must be a choice question`);
  }
  const labels = Object.keys(on.choice);
  if (Object.keys(file.cases).length === 0) {
    throw new PackError(path, 'route.cases needs at least one case');
  }

  const owners = new Map<string, string>();
  const toTarget = async (
    label: string,
    slot: string,
    target: z.infer<typeof routeTarget>,
  ): Promise<RouteTarget> => {
    const linked = typeof target === 'string' ? resolvePackRef(target, path) : undefined;
    const pack =
      linked !== undefined
        ? await loadResolved(linked, { ...ctx, useChain: [], rootMode: parent.mode })
        : await buildPack(
            target as PackBody,
            { name: `${parent.name}/${label}`, version: parent.version, mode: parent.mode },
            path,
            ctx,
          );
    const prefix = linked !== undefined ? pack.name : label;
    if (!/^[a-z][a-z0-9_]*$/.test(prefix)) {
      throw new PackError(
        path,
        `route "${label}" gives the column prefix "${prefix}", which is not lower_snake_case; ` +
          (linked !== undefined ? `rename the pack in ${linked}` : 'link to a named pack instead'),
      );
    }
    const owner = linked ?? `${path} ${slot}`;
    const other = owners.get(prefix);
    if (other !== undefined && other !== owner) {
      throw new PackError(
        path,
        `two routed packs share the column prefix "${prefix}": ${other} and ${owner}`,
      );
    }
    owners.set(prefix, owner);
    return { prefix, pack };
  };

  const cases: Record<string, RouteTarget> = {};
  for (const [label, target] of Object.entries(file.cases)) {
    if (!labels.includes(label)) {
      throw new PackError(
        path,
        `route case "${label}" is not a label of "${file.on}": ${labels.join(', ')}`,
      );
    }
    cases[label] = await toTarget(label, `route.cases.${label}`, target);
  }
  return {
    on: file.on,
    ...(file.min_confidence !== undefined ? { minConfidence: file.min_confidence } : {}),
    cases,
    ...(file.default !== undefined
      ? { default: await toTarget('default', 'route.default', file.default) }
      : {}),
  };
}

async function resolveUse(ref: string, from: string, chain: readonly string[]): Promise<Question> {
  const [packRef, questionName] = ref.split('#') as [string, string];
  const target = resolvePackRef(packRef, from);
  const pack = await loadResolved(target, {
    useChain: chain,
    routeChain: [],
    rootMode: undefined,
    withRoute: false,
  });
  const found = pack.questions[questionName];
  if (found === undefined) {
    const known = Object.keys(pack.questions).join(', ');
    throw new PackError(from, `"${ref}" not found; ${target} defines: ${known}`);
  }
  return found;
}
