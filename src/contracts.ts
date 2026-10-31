/**
 * Parsers for the STABLE line contracts printed by server plugins over RCON:
 *   SB|v1|<kind>|{json}   — SurvivorsBridge (this repo, bridge-plugin/)
 *   RS|v1|<kind>|{json}   — RealisticSeasons (separate repo, optional)
 * See DESIGN.md "Contracts". Do not loosen/change without bumping the version.
 */
import { z } from 'zod';

export interface RawLine {
  source: 'SB' | 'RS';
  version: string;
  kind: string;
  data: unknown;
}

const LINE_RE = /(SB|RS)\|(v\d+)\|([a-z_]+)\|(\{.*\})\s*$/;

/** Finds the first contract line in (possibly multi-line, possibly colour-coded) RCON output. */
export function parseRawLine(output: string, source?: 'SB' | 'RS', kind?: string): RawLine | undefined {
  const clean = output.replace(/§[0-9a-fk-or]/gi, '');
  for (const line of clean.split(/\r?\n/)) {
    const m = LINE_RE.exec(line.trim());
    if (!m) continue;
    const [, src, version, k, json] = m;
    if (source && src !== source) continue;
    if (kind && k !== kind) continue;
    try {
      return { source: src as 'SB' | 'RS', version: version!, kind: k!, data: JSON.parse(json!) };
    } catch {
      continue;
    }
  }
  return undefined;
}

export const BedPosSchema = z.object({
  x: z.number().int(),
  y: z.number().int(),
  z: z.number().int(),
  world: z.string(),
});
export type BedPos = z.infer<typeof BedPosSchema>;

export const BedsSchema = z.object({
  beds: z.array(
    BedPosSchema.extend({
      owner: z.string().nullable(),
      valid: z.boolean(),
      reason: z.string(),
    }),
  ),
});
export type BedsResult = z.infer<typeof BedsSchema>;

export const CanSpawnSchema = z.object({
  canSpawn: z.boolean(),
  freeValidBed: BedPosSchema.nullable(),
  missing: z.array(z.string()),
  reason: z.string(),
});
export type CanSpawnResult = z.infer<typeof CanSpawnSchema>;

/** RS|v1|temp and RS|v1|room share one shape. */
export const SeasonsReadingSchema = z.object({
  inside: z.boolean(),
  sealed: z.boolean(),
  volume: z.number(),
  leaks: z.object({ small: z.number(), large: z.number() }),
  tempC: z.number(),
  outsideC: z.number(),
  season: z.string(),
  comfortable: z.boolean(),
  /** Only in `temp raw player <name>` (additive v1 fields): the player's core temperature and stage. */
  bodyC: z.number().optional(),
  stage: z.string().optional(),
});
export type SeasonsReading = z.infer<typeof SeasonsReadingSchema>;

export function parseCanSpawn(output: string): CanSpawnResult | undefined {
  const raw = parseRawLine(output, 'SB', 'canspawn');
  if (!raw || raw.version !== 'v1') return undefined;
  const r = CanSpawnSchema.safeParse(raw.data);
  return r.success ? r.data : undefined;
}

export function parseBeds(output: string): BedsResult | undefined {
  const raw = parseRawLine(output, 'SB', 'beds');
  if (!raw || raw.version !== 'v1') return undefined;
  const r = BedsSchema.safeParse(raw.data);
  return r.success ? r.data : undefined;
}

const AreasSchema = z.object({
  areas: z.array(z.object({ world: z.string(), x: z.number(), y: z.number(), z: z.number(), radius: z.number() })),
});
export type ProtectedArea = z.infer<typeof AreasSchema>['areas'][number];

/** SB|v1|areas|{"areas":[{world,x,y,z,radius}]} - places bots must not break blocks in. */
export function parseAreas(output: string): ProtectedArea[] | undefined {
  const raw = parseRawLine(output, 'SB', 'areas');
  if (!raw || raw.version !== 'v1') return undefined;
  const r = AreasSchema.safeParse(raw.data);
  return r.success ? r.data.areas : undefined;
}

export function parseSeasons(output: string, kind: 'temp' | 'room'): SeasonsReading | undefined {
  const raw = parseRawLine(output, 'RS', kind);
  if (!raw || raw.version !== 'v1') return undefined;
  const r = SeasonsReadingSchema.safeParse(raw.data);
  return r.success ? r.data : undefined;
}

/** Heuristic: did the server say the command does not exist (plugin not installed)? */
export function isUnknownCommand(output: string): boolean {
  return /unknown (or incomplete )?command|unknown command|incorrect argument for command/i.test(output);
}
