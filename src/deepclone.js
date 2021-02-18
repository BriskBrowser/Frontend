export function deepClone(obj, hash = new WeakMap()) {
    // Do not try to clone primitives or functions
    if (Object(obj) !== obj) return obj;
    if (obj instanceof Function)
      return undefined;
    if (hash.has(obj)) return hash.get(obj); // Cyclic reference
    if (obj instanceof HTMLElement)
      return obj.sharable?obj:undefined;
    var result = new obj.constructor();
    // Register in hash    
    hash.set(obj, result);
    // Clone and assign enumerable own properties recursively
    return Object.assign(result, ...Object.keys(obj).map (
        key => ({ [key]: deepClone(obj[key], hash) }) ));
}