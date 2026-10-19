/**
 * A deliberately small JSON-Schema (draft 2020-12 / OpenAPI 3.1) validator for the conformance tests of finding R01-B05.
 *
 * It exists so that "the document says X" can be CHECKED against "the server does X" with code that shares nothing with the parsers under test
 * (no zod, no domain import). It implements exactly the keywords the GPR-2 contract uses and THROWS on any other validation keyword: a schema that
 * starts using something this validator does not understand fails the conformance tests loudly instead of being waved through.
 */
type Json = any;

const ANNOTATIONS = new Set(['description', 'title', 'summary', 'default', 'example', 'examples', 'deprecated', '$comment']);
const KEYWORDS = new Set(['$ref', 'type', 'enum', 'const', 'pattern', 'format', 'minLength', 'maxLength', 'minimum', 'maximum', 'minItems', 'maxItems', 'minProperties',
  'items', 'required', 'properties', 'additionalProperties', 'propertyNames', 'oneOf', 'allOf', 'not', 'if', 'then']);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// An independent calendar check (UTC round trip, year ≥ 1): the validator must not lean on packages/domain/gpr2/civil-date.ts.
function isDate(text: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (y < 1) return false;
  const t = new Date(Date.UTC(2000, 0, 1)); t.setUTCFullYear(y, mo - 1, d);
  return t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d;
}
const typeOf = (v: unknown) => v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v;
const isType = (v: unknown, t: string) => t === 'integer' ? typeof v === 'number' && Number.isInteger(v) : t === 'number' ? typeof v === 'number' && Number.isFinite(v) : typeOf(v) === t;
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

export function validate(schema: Json, value: unknown, doc: Json, at = '$'): string[] {
  if (schema === true || schema === undefined) return [];
  if (schema === false) return [`${at}: nothing is allowed here`];
  for (const key of Object.keys(schema)) if (!KEYWORDS.has(key) && !ANNOTATIONS.has(key) && !key.startsWith('x-')) throw new Error(`schema validator: unsupported keyword "${key}" at ${at}`);
  if (schema.$ref) {
    const m = /^#\/components\/schemas\/(.+)$/.exec(schema.$ref);
    if (!m || !doc.components?.schemas?.[m[1]]) throw new Error('schema validator: unresolved ' + schema.$ref);
    return validate(doc.components.schemas[m[1]], value, doc, at);
  }
  const errors: string[] = [];
  if (schema.type !== undefined) {
    const types: string[] = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some(t => isType(value, t))) return [`${at}: expected ${types.join('|')}, got ${typeOf(value)}`];
  }
  if (schema.enum && !schema.enum.some((e: unknown) => same(e, value))) errors.push(`${at}: not one of the allowed values`);
  if ('const' in schema && !same(schema.const, value)) errors.push(`${at}: not the constant`);
  if (typeof value === 'string') {
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) errors.push(`${at}: does not match ${schema.pattern}`);
    if (schema.minLength !== undefined && [...value].length < schema.minLength) errors.push(`${at}: shorter than ${schema.minLength}`);
    if (schema.maxLength !== undefined && [...value].length > schema.maxLength) errors.push(`${at}: longer than ${schema.maxLength}`);
    if (schema.format === 'uuid' && !UUID.test(value)) errors.push(`${at}: not a uuid`);
    else if (schema.format === 'date' && !isDate(value)) errors.push(`${at}: not a calendar date`);
    else if (schema.format !== undefined && schema.format !== 'uuid' && schema.format !== 'date') throw new Error('schema validator: unsupported format ' + schema.format);
  }
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) errors.push(`${at}: below ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum) errors.push(`${at}: above ${schema.maximum}`);
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) errors.push(`${at}: fewer than ${schema.minItems} items`);
    if (schema.maxItems !== undefined && value.length > schema.maxItems) errors.push(`${at}: more than ${schema.maxItems} items`);
    if (schema.items) value.forEach((item, i) => errors.push(...validate(schema.items, item, doc, `${at}[${i}]`)));
  }
  if (typeOf(value) === 'object') {
    const o = value as Record<string, unknown>, keys = Object.keys(o);
    for (const r of schema.required ?? []) if (!(r in o)) errors.push(`${at}: missing ${r}`);
    if (schema.minProperties !== undefined && keys.length < schema.minProperties) errors.push(`${at}: fewer than ${schema.minProperties} properties`);
    for (const k of keys) {
      if (schema.propertyNames) errors.push(...validate(schema.propertyNames, k, doc, `${at}.<name ${k.slice(0, 20)}>`));
      if (schema.properties && k in schema.properties) errors.push(...validate(schema.properties[k], o[k], doc, `${at}.${k}`));
      else if (schema.additionalProperties === false) errors.push(`${at}: property ${k.slice(0, 40)} is not allowed`);
      else if (schema.additionalProperties && schema.additionalProperties !== true) errors.push(...validate(schema.additionalProperties, o[k], doc, `${at}.${k}`));
    }
  }
  if (schema.allOf) for (const s of schema.allOf) errors.push(...validate(s, value, doc, at));
  if (schema.oneOf) {
    const matching = schema.oneOf.filter((s: Json) => validate(s, value, doc, at).length === 0).length;
    if (matching !== 1) errors.push(`${at}: matches ${matching} of the oneOf alternatives`);
  }
  if (schema.not && validate(schema.not, value, doc, at).length === 0) errors.push(`${at}: matches a forbidden schema`);
  if (schema.if && validate(schema.if, value, doc, at).length === 0 && schema.then) errors.push(...validate(schema.then, value, doc, at));
  return errors;
}
export const accepts = (schema: Json, value: unknown, doc: Json) => validate(schema, value, doc).length === 0;
