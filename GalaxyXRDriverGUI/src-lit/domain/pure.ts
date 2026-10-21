// Pure helper functions, ported from src/app/helpers.ts (Angular era).
// No framework dependencies; safe to import from tests and the browser.

export async function delay(ms: number = 1) {
  return new Promise<void>(done => {
    setTimeout(done, ms);
  })
}

export function cleanJsonComments(jsonString: string) {
  // Windows PowerShell 5.1 and some editors emit a UTF-8 BOM.
  // JSON.parse rejects it even though the remaining manifest/settings are valid.
  return jsonString.replace(/^\uFEFF/, '').replace(/\\"|"(?:\\"|[^"])*"|(\/\/.*|\/\*[\s\S]*?\*\/)/g, (m, g) => g ? "" : m)
}

/**
 * Deeply compares two values, specifically performing content comparison for arrays.
 * This is used to check for exclusion at the leaf level.
 *
 * @param val1 - The first value.
 * @param val2 - The second value.
 * @returns True if the values are equal (arrays are compared by content), false otherwise.
 */
const areValuesEqual = (val1: any, val2: any): boolean => {
  if (val1 === val2) {
    return true;
  }

  if (Array.isArray(val1) && Array.isArray(val2)) {
    if (val1.length !== val2.length) {
      return false;
    }
    for (let i = 0; i < val1.length; i++) {
      if (!areValuesEqual(val1[i], val2[i])) {
        return false;
      }
    }
    return true;
  }

  return false;
};


/**
 * Deep copies an object, excluding properties at the leaf level (non-object values)
 * if their values are equal to the corresponding values in a specified exclusion object.
 * Arrays are compared by content for exclusion. Intermediate objects are always copied,
 * even if all their children are excluded, resulting in an empty object for that property.
 * The second parameter excludeObj is optional. If not provided, a simple deep copy is performed.
 *
 * @template T - the type of the object to copy
 * @param obj - The source object to deep copy.
 * @param excludeObj - (Optional) the object used for exclusion. If a non-object property value
 * in the source object is equal to the corresponding property value in this object (arrays
 * are compared by content), that property will be excluded. Defaults to an empty object {}.
 * @returns The deep copied object, with leaf properties excluded if their values matched in excludeObj.
 */
export const deepCopy = <T>(obj: T, excludeObj: Partial<T> = {}): T => {
  if (typeof obj !== 'object' || obj === null) {
    if(areValuesEqual(obj, excludeObj)){
      return undefined as unknown as T;
    }
    return obj;
  }

  if (Array.isArray(obj)) {
    if (Array.isArray(excludeObj)) {
      if (areValuesEqual(obj, excludeObj)) {
        return undefined as unknown as T;
      }
      let outputArray = [];
      for (let i = 0; i < obj.length && i < excludeObj.length; i++) {
        outputArray.push(deepCopy(obj[i], excludeObj[i]));
      }
      return outputArray as unknown as T;
    }
    return obj;
  }

  const copy = {} as { [K in keyof T]: T[K] };
  Object.keys(obj).forEach(key => {
    const objValue = (obj as { [key: string]: any })[key];
    const excludeValue = (excludeObj as { [key: string]: any })[key];

    const relevantExcludeForValue = (typeof excludeValue === 'object' && excludeValue !== null && !Array.isArray(excludeValue))
      ? excludeValue
      : {};

    const copiedValue = deepCopy(objValue, relevantExcludeForValue);

    const isLeafValue = typeof objValue !== 'object' || objValue === null || Array.isArray(objValue);

    if (isLeafValue && Object.prototype.hasOwnProperty.call(excludeObj, key)) {
      if (areValuesEqual(objValue, excludeValue)) {
        return;
      }
    }

    copy[key as keyof T] = copiedValue;
  });

  return copy;
};

/**
 * Deep-copies a settings snapshot and removes default-valued leaves that the
 * stored document never contained. A save must not silently turn a value that
 * only came from load-time defaults into an explicit user setting; conversely,
 * once a key is present in stored (for example after materializing defaults on
 * reinstall), a later save keeps it even when it still equals its default.
 *
 * Arrays are leaves and compare by content. Objects are recursed into. Keys are
 * only ever removed, never added, and parents of removed leaves stay as empty
 * objects so the surrounding shape is preserved.
 *
 * @param snapshot - The effective settings to serialize.
 * @param defaults - The effective defaults, matched against snapshot leaves.
 * @param stored - The raw parsed settings document last read from disk.
 * @returns A deep copy of snapshot with unstored default leaves pruned.
 */
export function pruneUnstoredDefaults<T>(snapshot: T, defaults: Partial<T> | undefined, stored: unknown): T {
  if (snapshot === null || typeof snapshot !== 'object' || Array.isArray(snapshot)) return snapshot;
  const copy = structuredClone(snapshot);
  const isPlainContainer = (value: unknown): boolean =>
    !!value && typeof value === 'object' && !Array.isArray(value);
  const hasKey = (value: unknown, key: string): boolean =>
    isPlainContainer(value) && Object.prototype.hasOwnProperty.call(value, key);
  const prune = (target: Record<string, any>, defaultValues: unknown, storedValues: unknown) => {
    for (const key of Object.keys(target)) {
      const value = target[key];
      const defaultKnown = hasKey(defaultValues, key);
      const defaultValue = defaultKnown ? (defaultValues as Record<string, any>)[key] : undefined;
      const storedKnown = hasKey(storedValues, key);
      if (isPlainContainer(value)) {
        const nestedDefault = isPlainContainer(defaultValue) ? defaultValue : undefined;
        const nestedStored = storedKnown && isPlainContainer((storedValues as Record<string, any>)[key])
          ? (storedValues as Record<string, any>)[key]
          : undefined;
        prune(value as Record<string, any>, nestedDefault, nestedStored);
      } else if (!storedKnown && defaultKnown && areValuesEqual(value, defaultValue)) {
        delete target[key];
      }
    }
  };
  prune(copy as Record<string, any>, defaults, stored);
  return copy;
}

/**
 * Deep-copies a stored settings document and fills only the keys it does not
 * contain with their defaults. Unlike a general merge, arrays and scalars from
 * the stored document win outright; existing values are never replaced.
 */
export function fillMissingDefaults<T>(stored: T, defaults: Partial<T> | undefined): T {
  const isPlainContainer = (value: unknown): value is Record<string, any> =>
    !!value && typeof value === 'object' && !Array.isArray(value);
  const copy = structuredClone(stored);
  if (!isPlainContainer(copy) || !isPlainContainer(defaults)) return copy;
  const fill = (target: Record<string, any>, source: Record<string, any>) => {
    for (const key of Object.keys(source)) {
      if (!Object.prototype.hasOwnProperty.call(target, key)) {
        target[key] = structuredClone(source[key]);
      } else if (isPlainContainer(target[key]) && isPlainContainer(source[key])) {
        fill(target[key], source[key]);
      }
    }
  };
  fill(copy, defaults);
  return copy;
}

/**
 * @description Defines an interface to check if an item is an object.
 */
interface IIsObject {
  (item: any): boolean;
}

/**
 * @description Defines an interface that constrains the generic type parameter to objects.
 */
interface IObject {
  [key: string]: any;
}

/**
 * @description A method to check whether an item is an object. Date and Function are considered
 * objects, so if you need to exclude them, update this method accordingly.
 * @param item - the item to check
 * @return {Boolean} whether the item is an object
 */
export const isObject: IIsObject = (item: any): boolean => {
  return (item === Object(item) && !Array.isArray(item));
};

/**
 * @description A method that performs a deep merge of objects.
 *
 * @template TX the type of the target object.
 * @template TY the type of the elements in the source object array.
 * @template TR the type of the merged object, defaults to the intersection of TX and TY (TX & TY) representing the combined type.
 *
 * @param target - the target object to be updated with the specified @sources
 * @param sources - the source(s) to be used to update the @target object
 * @return {TR} the final merged object (the modified target object)
 */
export const deepMerge = <TX extends IObject, TY extends IObject, TR = TX & TY>(target: TX, ...sources: Array<TY>): TR => {
  if (!sources.length) {
    return target as any as TR;
  }

  const result: IObject = target;

  if (isObject(result)) {
    const len: number = sources.length;
    for (let i = 0; i < len; i += 1) {
      const elm: any = sources[i];
      if (isObject(elm)) {
        for (const key in elm) {
          if (Object.prototype.hasOwnProperty.call(elm, key)) {
            if (isObject(elm[key])) {
              if (!result[key] || !isObject(result[key])) {
                result[key] = {};
              }
              deepMerge(result[key], elm[key]);
            } else {
              if (Array.isArray(result[key]) && Array.isArray(elm[key])) {
                if(typeof elm[key][0] === 'string'){
                  // merge arrays of strings
                  result[key] = Array.from(new Set(result[key].concat(elm[key])));
                }else{
                  // overwrite if the array otherwise as numbers likely won't merge
                  result[key] = elm[key];
                }
              } else {
                result[key] = elm[key];
              }
            }
          }
        }
      }
    }
  }
  return result as TR;
};

/** Parse `[v]X.Y.Z[-pre]`. Used by isDevUpdate to compare release bases. */
const versionShape = /^[vV]?(\d+)\.(\d+)\.(\d+)(?:-(.+))?$/;

/** Dev Updates update decision (owner report, 2026-10-21).
 *
 * isNewVersion's dev ordering is deliberately symmetric on one point: a
 * same-base pre-release outranks its stable, which keeps a promoted stable
 * from displacing the newest dev build in the releases list. That symmetry
 * must NOT decide "an update exists": x.y.z stable ships after the
 * x.y.z-dev.* builds that feed it, so dev.18 is older than 1.13.0 and must
 * never be offered to someone running 1.13.0. Only a higher base (the next
 * dev line, 1.14.0-dev.*) or a higher pre-release counter is an update.
 * Same-base pre-release current vs its stable stays false: the dev build
 * already carries that content. */
export function isDevUpdate(current: string, latest: string): boolean {
  if (!isNewVersion(current, latest, true)) return false;
  const c = versionShape.exec(current);
  const l = versionShape.exec(latest);
  if (!c || !l) return true;
  const sameBase = Number(c[1]) === Number(l[1]) && Number(c[2]) === Number(l[2]) && Number(c[3]) === Number(l[3]);
  // Stable current, same-base pre-release candidate: the candidate is older.
  return !(sameBase && !c[4] && l[4]);
}

/** devChannel (Dev Updates on): a same-base pre-release ranks ABOVE its
 * stable release, so the stable is never an "update" for a dev build
 * (owner contract, 2026-10-15). Default false keeps strict semver:
 * stable above pre-release. Higher bases win in both orderings.
 * This is the release-ordering primitive; the Dev Updates update decision
 * goes through isDevUpdate, which also rejects a same-base pre-release
 * offered to a stable install (2026-10-21). With the channel OFF the strict
 * semver above still governs: a dev build is offered the promoted stable of
 * its own base, because that is its promotion path and /releases/latest
 * returns exactly that stable. */
export function isNewVersion(current: string, latest: string, devChannel = false): boolean {
  if(current.startsWith('v') || current.startsWith('V')){
    current = current.substring(1);
  }
  if(latest.startsWith('v') || latest.startsWith('V')){
    latest = latest.substring(1);
  }
  const cParts = current.split(/[.-]/g);
  const lParts = latest.split(/[.-]/g);
  const maxLength = Math.max(cParts.length, lParts.length);
  for (let i = 0; i < maxLength; i++) {
    const cNum = parseInt(cParts[i] || '0', 10);
    const lNum = parseInt(lParts[i] || '0', 10);
    if(isNaN(parseInt(cParts[i])) && cParts[i] || isNaN(parseInt(lParts[i])) && lParts[i]){
      // compare strings
      if (!lParts[i]){
        // The latest dropped the pre-release text. Strict semver: the stable
        // is newer. Dev channel: the same-base pre-release ranks above it.
        return !devChannel;
      }
      if (!cParts[i]){
        // Mirror image: the latest carries pre-release text the current lacks.
        // Strict semver: an older pre-release. Dev channel: an update.
        return devChannel;
      }
      if (lParts[i] > cParts[i]) {
        return true;
      }
      if (cParts[i] > lParts[i]) {
        return false;
      }
      continue
    }
    
    if (lNum > cNum) {
      return true;
    }
    if (cNum > lNum) {
      return false;
    }
  }
  return false;
}
