/**
 * Return true only for plain-object payloads that can be safely used as
 * named parameter maps in prepared Cypher execution.
 *
 * Validation criteria:
 * - must be a JavaScript object (`typeof value === 'object'`)
 * - must not be `null`
 * - must not be an array
 * - must have a plain-object prototype
 * - values must be bindable values: scalar or arrays of scalar bind values
 *
 * Rationale: prepared-statement params are key/value maps; rejecting null/array
 * and non-plain objects keeps binding behavior predictable and avoids passing
 * complex host objects to Ladybug parameter binding. Arrays are allowed for
 * common prepared queries such as `WHERE n.id IN $ids`.
 */
const isBindableScalar = (value: unknown): value is string | number | boolean | null =>
  value === null || ['string', 'number', 'boolean'].includes(typeof value);

const isBindableValue = (value: unknown): boolean =>
  isBindableScalar(value) || (Array.isArray(value) && value.every(isBindableScalar));

export const isValidQueryParams = (value: unknown): value is Record<string, unknown> =>
  value !== null &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null) &&
  Object.values(value).every(isBindableValue);
