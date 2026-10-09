'use strict';

/**
 * Recursively freeze an object graph.
 *
 * `Object.freeze` is shallow, which is a poor fit for this library: the rule
 * tables ARE the product, and a shallow freeze leaves every nested rule object
 * writable. Any dependency in the process could set
 * `STATE_RULES.MD[0].windows[1] = { start: 0, end: 1440 }` and silently open
 * Maryland's Monday to round-the-clock sends everywhere, with nothing to show
 * for it in a diff.
 *
 * @template T
 * @param {T} value
 * @returns {Readonly<T>} the same reference, deeply frozen
 */
function deepFreeze(value) {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) {
    return value;
  }
  Object.freeze(value);
  for (const key of Object.getOwnPropertyNames(value)) {
    deepFreeze(value[key]);
  }
  return value;
}

module.exports = { deepFreeze };
