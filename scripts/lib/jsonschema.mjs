// A JSON Schema validator over the subset `spec/schemas/` uses, and nothing more.
//
// Plain JavaScript, no dependencies, and no imports from `src/`. Both the conformance suite and the
// repository's own tests validate against it, so the schemas are one source of truth for what a body
// is — which is the point of writing them down at all. A conformance suite that validated with the
// implementation's own types would be checking that the implementation agrees with itself.
//
// The subset is deliberate rather than partial. These keywords are what the protocol's bodies need:
//
//   type (including the union form), enum, const
//   properties, required, additionalProperties, patternProperties, propertyNames
//   items, minItems, prefixItems
//   minimum, maximum, minLength, maxLength, pattern
//   oneOf, anyOf, $ref (to `#/$defs/...` within the same document)
//
// Anything else in a schema is a keyword this validator does not implement, and it says so rather
// than ignoring it — a schema whose constraint is silently skipped is worse than no schema.

const KNOWN = new Set([
  "$schema", "$id", "$defs", "$ref", "title", "description", "examples", "deprecated",
  "type", "enum", "const",
  "properties", "required", "additionalProperties", "patternProperties", "propertyNames",
  "items", "minItems", "prefixItems",
  "minimum", "maximum", "minLength", "maxLength", "pattern",
  "oneOf", "anyOf",
]);

/**
 * Every problem with a value, as paths into it. Empty means it validates.
 *
 * `docs` maps a schema's file name to its contents, so `"common.json#/$defs/id"` resolves — which is
 * what lets one document define what a reference is and the rest point at it. Without it only local
 * refs resolve, and a cross-document one is an error rather than a silently skipped constraint.
 */
export function validate(schema, value, root = schema, at = "", docs = {}) {
  const bad = [];
  const say = (why) => bad.push(`${at || "<root>"}: ${why}`);

  for (const key of Object.keys(schema)) {
    if (!KNOWN.has(key)) throw new Error(`${at || "<root>"}: this validator does not implement "${key}"`);
  }

  if (schema.$ref !== undefined) {
    const [doc, pointer] = schema.$ref.split("#");
    if (doc === "") return validate(resolve(root, `#${pointer}`), value, root, at, docs);
    const other = docs[doc];
    if (other === undefined) throw new Error(`${at || "<root>"}: ${schema.$ref} names a document that was not supplied`);
    return validate(resolve(other, `#${pointer}`), value, other, at, docs);
  }

  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((t) => isType(t, value))) {
      say(`expected ${types.join(" or ")}, got ${nameOf(value)}`);
      return bad; // nothing below this is meaningful once the type is wrong
    }
  }
  if (schema.const !== undefined && JSON.stringify(value) !== JSON.stringify(schema.const)) {
    say(`expected ${JSON.stringify(schema.const)}`);
  }
  if (schema.enum !== undefined && !schema.enum.some((e) => JSON.stringify(e) === JSON.stringify(value))) {
    say(`expected one of ${schema.enum.map((e) => JSON.stringify(e)).join(", ")}`);
  }

  if (typeof value === "string") {
    if (schema.minLength !== undefined && value.length < schema.minLength) say(`shorter than ${schema.minLength}`);
    if (schema.maxLength !== undefined && value.length > schema.maxLength) say(`longer than ${schema.maxLength}`);
    if (schema.pattern !== undefined && !new RegExp(schema.pattern, "u").test(value)) {
      say(`does not match ${schema.pattern}`);
    }
  }

  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum) say(`below ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum) say(`above ${schema.maximum}`);
  }

  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) say(`fewer than ${schema.minItems} items`);
    for (const [i, item] of value.entries()) {
      const prefix = schema.prefixItems?.[i];
      if (prefix !== undefined) bad.push(...validate(prefix, item, root, `${at}[${i}]`, docs));
      else if (schema.items !== undefined) bad.push(...validate(schema.items, item, root, `${at}[${i}]`, docs));
    }
  }

  if (isObject(value)) {
    for (const name of schema.required ?? []) {
      if (!(name in value)) say(`is missing "${name}"`);
    }
    for (const [name, member] of Object.entries(value)) {
      const where = at === "" ? name : `${at}.${name}`;
      if (schema.propertyNames !== undefined) {
        const named = validate(schema.propertyNames, name, root, `${where} (as a name)`, docs);
        bad.push(...named);
      }
      const declared = schema.properties?.[name];
      if (declared !== undefined) {
        bad.push(...validate(declared, member, root, where, docs));
        continue;
      }
      let matched = false;
      for (const [pattern, sub] of Object.entries(schema.patternProperties ?? {})) {
        if (!new RegExp(pattern, "u").test(name)) continue;
        matched = true;
        bad.push(...validate(sub, member, root, where, docs));
      }
      if (matched) continue;
      if (schema.additionalProperties === false) say(`has an undeclared property "${name}"`);
      else if (isObject(schema.additionalProperties)) {
        bad.push(...validate(schema.additionalProperties, member, root, where, docs));
      }
    }
  }

  if (schema.oneOf !== undefined) {
    const passing = schema.oneOf.filter((s) => validate(s, value, root, at, docs).length === 0).length;
    if (passing !== 1) say(`matches ${passing} of ${schema.oneOf.length} alternatives, and must match exactly one`);
  }
  if (schema.anyOf !== undefined && !schema.anyOf.some((s) => validate(s, value, root, at, docs).length === 0)) {
    say(`matches none of ${schema.anyOf.length} alternatives`);
  }

  return bad;
}

function resolve(root, ref) {
  if (!ref.startsWith("#/")) throw new Error(`this validator resolves only local refs, got ${ref}`);
  let at = root;
  for (const part of ref.slice(2).split("/")) {
    at = at?.[part.replace(/~1/g, "/").replace(/~0/g, "~")];
    if (at === undefined) throw new Error(`${ref} resolves to nothing`);
  }
  return at;
}

const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

function isType(type, value) {
  switch (type) {
    case "object":
      return isObject(value);
    case "array":
      return Array.isArray(value);
    case "string":
      return typeof value === "string";
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "number":
      return typeof value === "number";
    case "boolean":
      return typeof value === "boolean";
    case "null":
      return value === null;
    default:
      throw new Error(`unknown type "${type}"`);
  }
}

const nameOf = (v) => (v === null ? "null" : Array.isArray(v) ? "array" : typeof v);

/** Loads every schema in a directory, keyed by file name, ready to pass as `docs`. */
export function load(dir, read) {
  const docs = {};
  for (const name of read.names(dir)) docs[name] = JSON.parse(read.text(`${dir}/${name}`));
  return docs;
}
