// Pure inspection helpers: never coerce "false" or a missing read into a boolean.
// The checker also reports every non-boolean leaf so Setup can show which saved
// values differ from their defaults (2026-10-30).
export type SettingSource = 'settings.json' | 'gui-settings.json';

export interface SettingCheckBase {
  key: string;
  source: SettingSource;
  origin: 'stored' | 'default';
  /** Stored and different from the authoritative default. */
  changed: boolean;
  /** False for runtime-only or legacy keys that have no generated default. */
  hasDefault: boolean;
}
export interface BooleanSettingCheck extends SettingCheckBase {
  kind: 'boolean';
  enabled: boolean;
  value: boolean;
  defaultValue?: boolean;
}
export interface ValueSettingCheck extends SettingCheckBase {
  kind: 'number' | 'string' | 'array' | 'object';
  value: unknown;
  defaultValue: unknown;
}
export type SettingCheck = BooleanSettingCheck | ValueSettingCheck;

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/** JSON-value equality: arrays and plain objects compare by content. */
function sameJsonValue(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right)
      && left.length === right.length
      && left.every((value, index) => sameJsonValue(value, right[index]));
  }
  if (!record(left) || !record(right)) return false;
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  return leftKeys.length === rightKeys.length
    && leftKeys.every(key => Object.hasOwn(right, key) && sameJsonValue(left[key], right[key]));
}

function valueKind(value: unknown): ValueSettingCheck['kind'] | 'boolean' {
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'number') return 'number';
  if (typeof value === 'boolean') return 'boolean';
  if (value !== null && typeof value === 'object') return 'object';
  return 'string';
}

export function validateBooleanSettings(stored: unknown, defaults: unknown, prefix = ''): void {
  if (!record(stored) || !record(defaults)) return;
  for (const [key, fallback] of Object.entries(defaults)) {
    if (!Object.hasOwn(stored, key)) continue;
    const value = stored[key];
    const path = prefix ? `${prefix}.${key}` : key;
    if (typeof fallback === 'boolean' && typeof value !== 'boolean') {
      throw new Error(`${path} must be a JSON boolean (true or false), not ${JSON.stringify(value)}`);
    }
    // Null/array parents must not hide an entire group of boolean settings.
    if (record(fallback)) {
      if (!record(value)) throw new Error(`${path} must be a JSON object`);
      validateBooleanSettings(value, fallback, path);
    }
  }
}

/**
 * Walk the union of defaults and effective values. Defaults define the
 * authoritative value and the `hasDefault` flag; stored values define the
 * file origin and whether the current value differs from the default.
 */
export function inspectSettings(
  effective: unknown, stored: unknown, defaults: unknown, source: SettingSource, prefix = '',
): SettingCheck[] {
  const effectiveRecord = record(effective) ? effective : undefined;
  const storedRecord = record(stored) ? stored : undefined;
  const defaultsRecord = record(defaults) ? defaults : undefined;
  const keys = new Set([
    ...Object.keys(defaultsRecord ?? {}),
    ...Object.keys(effectiveRecord ?? {}),
  ]);
  const checks: SettingCheck[] = [];
  for (const key of [...keys].sort()) {
    const path = prefix ? `${prefix}.${key}` : key;
    const defaultKnown = !!defaultsRecord && Object.hasOwn(defaultsRecord, key);
    const defaultValue = defaultKnown ? defaultsRecord![key] : undefined;
    const effectiveValue = effectiveRecord && Object.hasOwn(effectiveRecord, key)
      ? effectiveRecord[key] : undefined;
    const storedKnown = !!storedRecord && Object.hasOwn(storedRecord, key);
    const storedValue = storedKnown ? storedRecord![key] : undefined;
    const defaultObject = record(defaultValue);
    const effectiveObject = record(effectiveValue);

    if (defaultObject || effectiveObject) {
      if (!effectiveObject && defaultObject) {
        // A malformed stored value replaced a default object. Keep it visible
        // instead of hiding the whole subtree.
        checks.push({
          key: path, source, kind: 'object', value: effectiveValue, defaultValue,
          origin: storedKnown ? 'stored' : 'default',
          changed: storedKnown && !sameJsonValue(storedValue, defaultValue),
          hasDefault: defaultKnown,
        });
        continue;
      }
      checks.push(...inspectSettings(
        effectiveObject ? effectiveValue : undefined,
        storedKnown && record(storedValue) ? storedValue : undefined,
        defaultObject ? defaultValue : undefined,
        source,
        path,
      ));
      continue;
    }

    const kind = valueKind(defaultKnown ? defaultValue : effectiveValue);
    const value = effectiveValue === undefined ? defaultValue : effectiveValue;
    const base = {
      key: path, source,
      origin: (storedKnown ? 'stored' : 'default') as SettingCheckBase['origin'],
      changed: storedKnown && !sameJsonValue(storedValue, defaultValue),
      hasDefault: defaultKnown,
    };
    if (kind === 'boolean') {
      checks.push({
        ...base, kind: 'boolean', enabled: value === true, value: value === true,
        defaultValue: typeof defaultValue === 'boolean' ? defaultValue : undefined,
      });
    } else {
      checks.push({ ...base, kind, value, defaultValue });
    }
  }
  return checks;
}

/** Backward-compatible boolean-only view used by the presentation catalog. */
export function inspectBooleanSettings(
  effective: unknown, stored: unknown, source: SettingSource, prefix = '',
): BooleanSettingCheck[] {
  return inspectSettings(effective, stored, effective, source, prefix)
    .filter((check): check is BooleanSettingCheck => check.kind === 'boolean');
}
