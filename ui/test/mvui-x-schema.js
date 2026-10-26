import { readFileSync } from 'node:fs';
export const intentSchema = JSON.parse(readFileSync(new URL('../../contracts/v0.2/ui_intent.schema.json', import.meta.url), 'utf8'));

// Deliberately bounded to the keywords in the checked-in contract. Unknown
// keywords fail the test harness rather than silently weakening validation.
const keywords = new Set(['$schema', '$id', 'title', 'oneOf', 'additionalProperties', 'properties', 'required', 'type', 'maxProperties', 'const', 'minLength', 'maxLength', 'pattern', 'minimum', 'maximum']);
export function validates(schema, value) {
  for (const key of Object.keys(schema)) {
    if (!keywords.has(key)) throw new Error(`Unsupported schema keyword: ${key}`);
  }
  if (schema.oneOf && schema.oneOf.filter(branch => validates(branch, value)).length !== 1) return false;
  if (Object.hasOwn(schema, 'const') && value !== schema.const) return false;
  if (schema.type === 'object') {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
    if (Object.keys(value).length > schema.maxProperties) return false;
    if (schema.required?.some(key => !Object.hasOwn(value, key))) return false;
    if (schema.additionalProperties === false && Object.keys(value).some(key => !Object.hasOwn(schema.properties, key))) return false;
    if (Object.entries(schema.properties ?? {}).some(([key, rule]) => Object.hasOwn(value, key) && !validates(rule, value[key]))) return false;
  }
  if (schema.type === 'string') {
    if (typeof value !== 'string') return false;
    const length = [...value].length;
    if (length < schema.minLength || length > schema.maxLength || (schema.pattern && !new RegExp(schema.pattern).test(value))) return false;
  }
  if (schema.type === 'boolean' && typeof value !== 'boolean') return false;
  if (schema.type === 'integer' && (!Number.isInteger(value) || value < schema.minimum || value > schema.maximum)) return false;
  return true;
}
