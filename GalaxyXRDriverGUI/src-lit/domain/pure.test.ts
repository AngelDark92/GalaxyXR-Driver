// Unit tests for the framework-free helpers in domain/pure.ts.
// Node environment, no DOM. Run with `npm test` (vitest run).
import { describe, it, expect } from 'vitest';
import { cleanJsonComments, deepCopy, deepMerge, isObject, isNewVersion } from './pure';

describe('cleanJsonComments', () => {
  it('accepts a Windows UTF-8 BOM without altering string contents', () => {
    expect(JSON.parse(cleanJsonComments('\uFEFF{"flag": false, "text": "\uFEFFkept"}'))).toEqual({ flag: false, text: '\uFEFFkept' });
  });

  it('removes // line comments', () => {
    const json = '{\n  "a": 1, // trailing\n  "b": 2\n}';
    expect(JSON.parse(cleanJsonComments(json))).toEqual({ a: 1, b: 2 });
  });

  it('removes /* block comments */', () => {
    const json = '{ "a": /* inline */ 1 }';
    expect(JSON.parse(cleanJsonComments(json))).toEqual({ a: 1 });
  });

  it('keeps strings that contain comment-like text', () => {
    const json = '{ "url": "http://example.com//path", "s": "a /* b" }';
    expect(JSON.parse(cleanJsonComments(json))).toEqual({ url: 'http://example.com//path', s: 'a /* b' });
  });

  it('keeps escaped quotes inside strings', () => {
    const json = '{ "s": "say \\"hi\\" // not a comment" }';
    expect(JSON.parse(cleanJsonComments(json))).toEqual({ s: 'say "hi" // not a comment' });
  });

  it('returns plain JSON unchanged', () => {
    const json = '{"a":1,"b":[1,2,3]}';
    expect(cleanJsonComments(json)).toBe(json);
  });
});

describe('isObject', () => {
  it('accepts plain objects', () => {
    expect(isObject({})).toBe(true);
    expect(isObject({ a: 1 })).toBe(true);
  });
  it('rejects arrays, null and primitives', () => {
    expect(isObject([])).toBe(false);
    expect(isObject(null)).toBe(false);
    expect(isObject(5)).toBe(false);
    expect(isObject('s')).toBe(false);
  });
});

describe('deepCopy', () => {
  it('deep-copies nested objects without aliasing', () => {
    const src = { c: 'x', d: { e: { f: true } } };
    const copy = deepCopy(src);
    expect(copy).toEqual(src);
    expect(copy).not.toBe(src);
    expect(copy.d).not.toBe(src.d);
    expect(copy.d.e).not.toBe(src.d.e);
    // mutating the copy must not leak into the source
    (copy.d as any).e.f = false;
    expect(src.d.e.f).toBe(true);
  });

  it('shares nested array leaves by reference (ported contract)', () => {
    const src = { a: { b: [1, 2, 3] } };
    const copy = deepCopy(src);
    expect(copy.a.b).toBe(src.a.b);
    // but the surrounding object structure is a fresh copy
    expect(copy.a).not.toBe(src.a);
  });

  it('passes non-object values through', () => {
    expect(deepCopy(5)).toBe(5);
    expect(deepCopy('s')).toBe('s');
    expect(deepCopy(null as any)).toBe(null);
  });

  it('omits leaf values that match the exclusion object', () => {
    const copy = deepCopy({ a: 1, b: 2, c: 'same' }, { a: 1, c: 'same' });
    expect(copy).toEqual({ b: 2 });
  });

  it('compares array leaves by content', () => {
    expect(deepCopy({ list: [1, 2, 3] }, { list: [1, 2, 3] })).toEqual({});
    expect(deepCopy({ list: [1, 2, 4] }, { list: [1, 2, 3] })).toEqual({ list: [1, 2, 4] });
    // different length is not equal -> kept
    expect(deepCopy({ list: [1, 2] }, { list: [1, 2, 3] })).toEqual({ list: [1, 2] });
  });

  it('keeps intermediate objects even when all children are excluded', () => {
    const copy = deepCopy({ a: { b: 1, c: 2 } }, { a: { b: 1 } } as any);
    expect(copy).toEqual({ a: { c: 2 } });
    const empty = deepCopy({ a: { b: 1 } }, { a: { b: 1 } });
    expect(empty).toEqual({ a: {} });
  });

  it('excludes matching array elements positionally', () => {
    expect(deepCopy([1, 2, 3], [1, 'x', 'x'] as any)).toEqual([undefined, 2, 3]);
  });

  it('returns undefined for a non-object that equals the exclusion', () => {
    expect(deepCopy(5, 5 as any)).toBeUndefined();
  });
});

describe('deepMerge', () => {
  it('merges nested objects into the target and returns it', () => {
    const target: Record<string, any> = { a: 1, nested: { x: 1, y: 2 } };
    const result = deepMerge(target, { a: 9, nested: { y: 3, z: 4 } }, { extra: true });
    expect(result).toBe(target);
    expect(target).toEqual({ a: 9, nested: { x: 1, y: 3, z: 4 }, extra: true });
  });

  it('replaces scalar values from later sources', () => {
    const target: Record<string, any> = { a: 1 };
    deepMerge(target, { a: 2 });
    expect(target.a).toBe(2);
  });

  it('creates missing object targets', () => {
    const target: Record<string, any> = {};
    deepMerge(target, { nested: { deep: { v: 1 } } });
    expect(target).toEqual({ nested: { deep: { v: 1 } } });
  });

  it('merges arrays of strings via set union (order: target first)', () => {
    const target: Record<string, any> = { list: ['x', 'y'] };
    deepMerge(target, { list: ['y', 'z'] });
    expect(target.list).toEqual(['x', 'y', 'z']);
  });

  it('overwrites non-string arrays instead of merging', () => {
    const target: Record<string, any> = { nums: [1, 2, 3] };
    deepMerge(target, { nums: [9] });
    expect(target.nums).toEqual([9]);
  });

  it('returns the target untouched when there are no sources', () => {
    const target: Record<string, any> = { a: 1 };
    expect(deepMerge(target)).toBe(target);
  });
});

describe('isNewVersion', () => {
  it('detects newer patch/minor/major versions', () => {
    expect(isNewVersion('1.0.0', '1.0.1')).toBe(true);
    expect(isNewVersion('1.0.0', '1.1.0')).toBe(true);
    expect(isNewVersion('1.0.0', '2.0.0')).toBe(true);
  });
  it('reports equal versions as not new', () => {
    expect(isNewVersion('1.2.3', '1.2.3')).toBe(false);
  });
  it('reports older versions as not new', () => {
    expect(isNewVersion('1.0.1', '1.0.0')).toBe(false);
    expect(isNewVersion('2.0.0', '1.9.9')).toBe(false);
  });
  it('treats numbers numerically, not lexicographically', () => {
    expect(isNewVersion('1.2', '1.10')).toBe(true);
    expect(isNewVersion('1.10', '1.2')).toBe(false);
  });
  it('strips a leading v/V prefix', () => {
    expect(isNewVersion('v1.0.0', '1.0.1')).toBe(true);
    expect(isNewVersion('V1.0.1', '1.0.0')).toBe(false);
    expect(isNewVersion('v1.0.0', 'v1.0.0')).toBe(false);
  });
  it('compares pre-release text lexicographically', () => {
    expect(isNewVersion('1.0.0-alpha', '1.0.0-beta')).toBe(true);
    expect(isNewVersion('1.0.0-beta', '1.0.0-alpha')).toBe(false);
  });
  it('treats the stable release as newer than its pre-release', () => {
    expect(isNewVersion('1.0.0-beta', '1.0.0')).toBe(true);
    expect(isNewVersion('1.0.0', '1.0.0-beta')).toBe(false);
  });
});

describe('isNewVersion dev channel ordering', () => {
  it('ranks a same-base pre-release above its stable on the dev channel', () => {
    expect(isNewVersion('1.9.0', '1.9.0-dev.8', true)).toBe(true);
    expect(isNewVersion('1.9.0-dev.8', '1.9.0', true)).toBe(false);
  });
  it('keeps a higher base ahead of a lower-base pre-release', () => {
    expect(isNewVersion('1.8.0-dev.99', '1.8.1', true)).toBe(true);
    expect(isNewVersion('1.8.1', '1.8.0-dev.99', true)).toBe(false);
  });
  it('reports no update between equal versions on the dev channel', () => {
    expect(isNewVersion('1.9.0-dev.8', '1.9.0-dev.8', true)).toBe(false);
    expect(isNewVersion('1.9.0', '1.9.0', true)).toBe(false);
  });
  it('compares dev counters numerically on the dev channel', () => {
    expect(isNewVersion('1.9.0-dev.8', '1.9.0-dev.10', true)).toBe(true);
    expect(isNewVersion('1.9.0-dev.10', '1.9.0-dev.9', true)).toBe(false);
  });
  it('keeps strict semver with the channel off', () => {
    expect(isNewVersion('1.9.0-dev.8', '1.9.0', false)).toBe(true);
    expect(isNewVersion('1.9.0', '1.9.0-dev.8', false)).toBe(false);
  });
});
