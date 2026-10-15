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

/** devChannel (Dev Updates on): a same-base pre-release ranks ABOVE its
 * stable release, so the stable is never an "update" for a dev build
 * (owner contract, 2026-10-15). Default false keeps strict semver:
 * stable above pre-release. Higher bases win in both orderings. */
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
