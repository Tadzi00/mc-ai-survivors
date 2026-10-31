import { describe, expect, it } from 'vitest';
import { isUnknownCommand, parseBeds, parseCanSpawn, parseRawLine, parseSeasons } from '../src/contracts.js';

describe('raw line parsing', () => {
  it('parses SB|v1|canspawn', () => {
    const out = 'SB|v1|canspawn|{"canSpawn":true,"freeValidBed":{"x":2,"y":64,"z":0,"world":"world"},"missing":[],"reason":"ok"}';
    expect(parseCanSpawn(out)).toEqual({ canSpawn: true, freeValidBed: { x: 2, y: 64, z: 0, world: 'world' }, missing: [], reason: 'ok' });
  });
  it('parses SB|v1|beds with null owner', () => {
    const out = 'SB|v1|beds|{"beds":[{"x":1,"y":64,"z":1,"world":"world","owner":null,"valid":false,"reason":"not_sealed"}]}';
    expect(parseBeds(out)?.beds[0]).toMatchObject({ owner: null, valid: false, reason: 'not_sealed' });
  });
  it('finds the line among other output and strips colour codes', () => {
    const out = '§aSome header\n§fRS|v1|temp|{"inside":true,"sealed":true,"volume":27,"leaks":{"small":0,"large":0},"tempC":18.5,"outsideC":-4,"season":"WINTER","comfortable":true}\n';
    const r = parseSeasons(out, 'temp');
    expect(r).toMatchObject({ season: 'WINTER', tempC: 18.5, sealed: true, leaks: { small: 0, large: 0 } });
  });
  it('distinguishes kinds and sources', () => {
    const out = 'RS|v1|room|{"inside":false,"sealed":false,"volume":0,"leaks":{"small":0,"large":3},"tempC":1,"outsideC":1,"season":"AUTUMN","comfortable":false}';
    expect(parseSeasons(out, 'temp')).toBeUndefined();
    expect(parseSeasons(out, 'room')?.leaks.large).toBe(3);
    expect(parseRawLine(out, 'SB')).toBeUndefined();
  });
  it('rejects malformed json / wrong schema / other versions', () => {
    expect(parseCanSpawn('SB|v1|canspawn|{broken')).toBeUndefined();
    expect(parseCanSpawn('SB|v1|canspawn|{"canSpawn":"yes"}')).toBeUndefined();
    expect(parseCanSpawn('SB|v2|canspawn|{"canSpawn":true,"freeValidBed":null,"missing":[],"reason":"ok"}')).toBeUndefined();
  });
  it('detects unknown command responses', () => {
    expect(isUnknownCommand('Unknown or incomplete command, see below for error')).toBe(true);
    expect(isUnknownCommand('RS|v1|temp|{}')).toBe(false);
  });
});
