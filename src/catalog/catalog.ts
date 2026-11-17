// The catalog is the source of truth for object and edge types. People edit one file per domain with
// no integers in it; planning a change writes the lock, which assigns every entry its integer and the
// catalog a version. Every database applies the same lock, so integers match across environments.
//
// Integers are identity and are never reused. Names are labels.
//
// A host needs the whole catalog even though each product sees only its projection: the outbox writes
// inverses, and a delete applies every team's onDelete.

export type Scalar = "string" | "number" | "boolean" | "json";
export type FieldSpec = Scalar | { enum: string[] } | { id: string } | { optional: FieldSpec };

/** What an edge does to its targets when its source object is deleted. */
export type OnDelete = "cascade" | "detach" | "restrict";

/** One domain's hand-edited file: names only, no integers. */
export interface Domain {
  objects?: Record<string, { fields: Record<string, FieldSpec> }>;
  edges?: Record<string, EdgeDecl>;
}

export interface EdgeDecl {
  from: string;
  to: string;
  /** The paired type whose edges this one's writes maintain. Must name this edge's mirror. */
  inverse?: string;
  /** True on the half of a pair that is derived: its rows are written only by its inverse's writes,
   *  and a direct write to it is refused.
   *
   *  One side of every pair has to say this. A row written from both sides has two writers on two
   *  vshards, and the outbox orders each source against itself and not against the other — so a
   *  remove through one side and an add through the other land in whichever order delivery takes, and
   *  two adds with different times overwrite each other's sort key. Being safe to retry is not being
   *  safe to reorder, so idempotence does not reach it. One writer per row does. */
  maintained?: boolean;
  onDelete?: OnDelete;
  /** A field relationship: follows an id in the source payload. Nothing is stored, so it has no atype. */
  field?: string;
  unique?: boolean;
  /**
   * Targets MAY be in another database. Not that they are: one edge type holds both, which is the
   * whole premise — `issues.issue_owner → core.user` starts fully local, and one day some users live
   * in a shared identity database and some do not. The edge type should not change, and an
   * application should not have to declare two of everything (`docs/global-ids.md`).
   *
   * It is a static signal for the planner, which has to know a hop can leave this database even
   * though whether a given row does is only known at read time. Two refusals hang off it, both
   * below, and both better as plan-time errors than as discoveries in the outbox.
   */
  foreign?: boolean;
}

/** The planned, canonical form. Reviewed with the domain files and applied verbatim by every database. */
export interface Lock {
  version: number;
  objects: Record<string, { otype: number; fields: Record<string, FieldSpec> }>;
  edges: Record<string, EdgeDecl & { atype?: number }>;
  /** Names that once existed and must not be reused before a purge, since their values linger. */
  tombstones?: string[];
  /** A sum over everything above. Two teams planning on separate branches both write version N + 1,
   *  and because the version line is identical git merges it silently while both allocated integers
   *  from the same base. Apply would catch that, but only after review; a sum that differs makes it a
   *  merge conflict instead. It is a conflict detector, not a security boundary, which is why it can be
   *  computed synchronously everywhere rather than needing a crypto digest. */
  sum?: string;
}

/** JSON with every object's keys sorted, so the sum does not depend on the order a file happened to
 *  list things in. */
export function canonical(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  const entries = Object.entries(v as Record<string, unknown>)
    .filter(([, x]) => x !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, x]) => `${JSON.stringify(k)}:${canonical(x)}`).join(",")}}`;
}

/** FNV-1a as two 32-bit halves, so it stays exact in JS. Not a security boundary; see Lock.sum. */
export function fnv(text: string): string {
  const halves = [0x811c9dc5, 0x01000193];
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    for (let h = 0; h < 2; h++) halves[h] = Math.imul(halves[h] ^ ((c >>> (h * 8)) & 0xff) ^ (c & 0xff), 0x01000193) >>> 0;
  }
  return halves.map((h) => h.toString(16).padStart(8, "0")).join("");
}

export function sumOf(lock: Lock): string {
  return fnv(canonical({ version: lock.version, objects: lock.objects, edges: lock.edges, tombstones: lock.tombstones }));
}

export interface ObjectType {
  name: string;
  otype: number;
  fields: Record<string, FieldSpec>;
}

export interface EdgeType {
  name: string;
  /** Absent for a field relationship, which stores nothing. */
  atype?: number;
  from: string;
  to: string;
  inverse?: string;
  /** The derived half of a pair: read and counted like any other, but written only by its inverse. */
  maintained: boolean;
  onDelete: OnDelete;
  field?: string;
  unique: boolean;
  /** Whether a target may be in another database. See `EdgeDecl.foreign`. */
  foreign: boolean;
}

/** An edge type that declares no onDelete drops its own edges and leaves the targets alone. Cascading
 *  by default would make an unrelated team's edge able to delete your objects. */
export const DEFAULT_ON_DELETE: OnDelete = "detach";

/** Whether a field spec declares an id, through however many `optional` wrappers.
 *
 *  Three places need this and would otherwise each decide it for themselves: the host checks a
 *  payload's references on the way in, the foreign client makes them absolute on the way back, and
 *  the request guard types a filter's value. */
export function isIdSpec(spec: FieldSpec): boolean {
  if (typeof spec !== "object") return false;
  if ("id" in spec) return true;
  return "optional" in spec ? isIdSpec(spec.optional) : false;
}

/** The fields of a type that hold ids. */
export const idFieldsOf = (fields: Record<string, FieldSpec>): string[] =>
  Object.entries(fields).filter(([, spec]) => isIdSpec(spec)).map(([name]) => name);

export class CatalogError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CatalogError";
  }
}

/** The compiled catalog: the lock indexed for the lookups a host and a client actually make. */
export class Catalog {
  readonly version: number;
  readonly lock: Lock;
  readonly #objectsByName = new Map<string, ObjectType>();
  readonly #objectsByType = new Map<number, ObjectType>();
  readonly #edgesByName = new Map<string, EdgeType>();
  readonly #edgesByType = new Map<number, EdgeType>();
  /** Stored edge types declared from each object type, for onDelete. */
  readonly #edgesFrom = new Map<number, EdgeType[]>();

  private constructor(lock: Lock) {
    this.lock = lock;
    this.version = lock.version;

    if (lock.sum !== undefined && lock.sum !== sumOf(lock)) {
      throw new CatalogError(
        `lock sum does not match its contents: expected ${sumOf(lock)}, found ${lock.sum}.` +
          " Two plans were probably merged; re-plan on the merged domain files.",
      );
    }

    const tombstoned = new Set(lock.tombstones ?? []);
    for (const [name, o] of Object.entries(lock.objects)) {
      if (tombstoned.has(name)) throw new CatalogError(`${name} is tombstoned and cannot be reused before a purge`);
      if (this.#objectsByType.has(o.otype)) {
        throw new CatalogError(`otype ${o.otype} is used by ${this.#objectsByType.get(o.otype)!.name} and ${name}`);
      }
      for (const field of Object.keys(o.fields)) {
        // A result carries id, $version and $edge alongside the payload. A field under one of those
        // names would be shadowed by it, so refuse the name rather than lose the field.
        if (field.startsWith("$") || field === "id") {
          throw new CatalogError(`${name}.${field} uses a reserved name: a result carries id, $version and $edge`);
        }
      }
      const t: ObjectType = { name, otype: o.otype, fields: o.fields };
      this.#objectsByName.set(name, t);
      this.#objectsByType.set(o.otype, t);
    }

    for (const [name, e] of Object.entries(lock.edges)) {
      if (tombstoned.has(name)) throw new CatalogError(`${name} is tombstoned and cannot be reused before a purge`);
      const stored = e.field === undefined;
      if (stored && e.atype === undefined) throw new CatalogError(`${name} is a stored edge and needs an atype`);
      if (!stored && e.atype !== undefined) throw new CatalogError(`${name} is a field relationship and must have no atype`);
      if (e.atype !== undefined && this.#edgesByType.has(e.atype)) {
        throw new CatalogError(`atype ${e.atype} is used by ${this.#edgesByType.get(e.atype)!.name} and ${name}`);
      }
      const t: EdgeType = {
        name,
        atype: e.atype,
        from: e.from,
        to: e.to,
        inverse: e.inverse,
        maintained: e.maintained ?? false,
        onDelete: e.onDelete ?? DEFAULT_ON_DELETE,
        field: e.field,
        unique: e.unique ?? false,
        foreign: e.foreign ?? false,
      };
      this.#edgesByName.set(name, t);
      if (t.atype !== undefined) this.#edgesByType.set(t.atype, t);
    }

    // Every reference resolves, and an inverse is a genuine mirror.
    for (const e of this.#edgesByName.values()) {
      for (const [role, ref] of [["from", e.from], ["to", e.to]] as const) {
        if (!this.#objectsByName.has(ref)) throw new CatalogError(`${e.name}.${role} names ${ref}, which is not a type`);
      }
      if (e.field !== undefined && !(e.field in this.#objectsByName.get(e.from)!.fields)) {
        throw new CatalogError(`${e.name} follows ${e.from}.${e.field}, which is not a field`);
      }
      if (e.foreign) {
        // Both of these are a remote write wearing a local name, and `docs/protocol.md` makes the
        // cross-database graph reads-only and one-sided. Refused when the lock is planned, because
        // the alternative is discovering it as an outbox row that retries forever.
        if (e.inverse !== undefined) {
          throw new CatalogError(
            `${e.name} permits foreign targets and names an inverse.` +
              " Delivery routes through the host's own client, which is scoped to one database and never gives up," +
              " so writing the other half would mean holding credentials to write into another database inside a" +
              " path with no give-up. A target database that wants a backlink subscribes; it does not get written into.",
          );
        }
        if (e.onDelete === "cascade") {
          throw new CatalogError(
            `${e.name} permits foreign targets and cascades on delete, which is a remote write.` +
              " Foreign references are allowed to dangle, which the read path already tolerates:" +
              " edges to missing objects are dropped at read time and a maintained count still counts them.",
          );
        }
      }
      if (e.inverse === undefined) continue;
      const back = this.#edgesByName.get(e.inverse);
      if (!back) throw new CatalogError(`${e.name} names inverse ${e.inverse}, which is not an edge type`);
      if (back.inverse !== e.name) throw new CatalogError(`${e.name} and ${e.inverse} do not name each other`);
      if (back.from !== e.to || back.to !== e.from) {
        throw new CatalogError(`${e.inverse} is not the mirror of ${e.name}: it runs ${back.from} to ${back.to}`);
      }
      if (back.field !== undefined || e.field !== undefined) {
        throw new CatalogError(`${e.name} and ${e.inverse}: a field relationship has no inverse`);
      }
      // One writer per row, named here rather than left to whoever calls first. Without it both
      // vshards maintain the same two rows and nothing orders them against each other.
      if (e.inverse === e.name) {
        throw new CatalogError(
          `${e.name} names itself as its inverse, so neither side can maintain the other.` +
            " Declare two edge types that name each other, and mark one maintained.",
        );
      }
      if (e.maintained === back.maintained) {
        throw new CatalogError(
          e.maintained
            ? `${e.name} and ${e.inverse} are both maintained, so neither can be written`
            : `${e.name} and ${e.inverse} are a pair and neither is maintained:` +
              " mark the derived one, whose rows the other's writes should write",
        );
      }
    }

    for (const e of this.#edgesByName.values()) {
      if (e.maintained && e.inverse === undefined) {
        throw new CatalogError(`${e.name} is maintained but names no inverse to be maintained by`);
      }
    }

    for (const e of this.#edgesByName.values()) {
      if (e.atype === undefined) continue;
      const from = this.#objectsByName.get(e.from)!;
      this.#edgesFrom.set(from.otype, [...(this.#edgesFrom.get(from.otype) ?? []), e]);
    }
  }

  static compile(lock: Lock): Catalog {
    return new Catalog(lock);
  }

  /** An empty catalog, for a database before any lock is applied. */
  static empty(): Catalog {
    return new Catalog({ version: 0, objects: {}, edges: {} });
  }

  object(otype: number): ObjectType | undefined {
    return this.#objectsByType.get(otype);
  }

  objectNamed(name: string): ObjectType | undefined {
    return this.#objectsByName.get(name);
  }

  edge(atype: number): EdgeType | undefined {
    return this.#edgesByType.get(atype);
  }

  edgeNamed(name: string): EdgeType | undefined {
    return this.#edgesByName.get(name);
  }

  /** The edge type whose writes maintain this one, if its rows are not its own to write. */
  maintainedBy(atype: number): EdgeType | undefined {
    const e = this.#edgesByType.get(atype);
    return e?.maintained ? this.#edgesByName.get(e.inverse!) : undefined;
  }

  /** The atype of the edge paired with this one, if it has an inverse. */
  inverseOf(atype: number): number | undefined {
    const back = this.#edgesByType.get(atype)?.inverse;
    return back === undefined ? undefined : this.#edgesByName.get(back)?.atype;
  }

  /** Stored edge types declared from an object type, in atype order, for applying onDelete. */
  edgesFrom(otype: number): readonly EdgeType[] {
    return [...(this.#edgesFrom.get(otype) ?? [])].sort((a, b) => a.atype! - b.atype!);
  }

  objectTypes(): readonly ObjectType[] {
    return [...this.#objectsByName.values()];
  }

  edgeTypes(): readonly EdgeType[] {
    return [...this.#edgesByName.values()];
  }
}

/** Plans a change: diffs the domain files against the previous lock, keeps every integer already
 *  assigned, and allocates the next free one for each new entry. The result is reviewed with the files
 *  and applied verbatim, so development, staging and production agree. */
export function plan(domains: Record<string, Domain>, previous?: Lock): Lock {
  const objects: Lock["objects"] = {};
  const edges: Lock["edges"] = {};
  const usedO = new Set<number>();
  const usedA = new Set<number>();
  for (const o of Object.values(previous?.objects ?? {})) usedO.add(o.otype);
  for (const e of Object.values(previous?.edges ?? {})) if (e.atype !== undefined) usedA.add(e.atype);

  const next = (used: Set<number>) => {
    let n = 1;
    while (used.has(n)) n++;
    used.add(n);
    return n;
  };

  for (const [domain, d] of Object.entries(domains)) {
    for (const [name, o] of Object.entries(d.objects ?? {})) {
      owns(domain, name);
      if (name in objects) throw new CatalogError(`${name} is defined twice`);
      objects[name] = { otype: previous?.objects[name]?.otype ?? next(usedO), fields: o.fields };
    }
    for (const [name, e] of Object.entries(d.edges ?? {})) {
      owns(domain, name);
      if (name in edges) throw new CatalogError(`${name} is defined twice`);
      const kept = previous?.edges[name]?.atype;
      const atype = e.field !== undefined ? undefined : (kept ?? next(usedA));
      edges[name] = { ...e, atype };
    }
  }

  // Removing an entry tombstones its name: its values linger in stored JSON, so re-adding it would
  // bring them back.
  const gone = [
    ...Object.keys(previous?.objects ?? {}).filter((n) => !(n in objects)),
    ...Object.keys(previous?.edges ?? {}).filter((n) => !(n in edges)),
  ];
  const lock: Lock = {
    version: (previous?.version ?? 0) + 1,
    objects,
    edges,
    tombstones: [...new Set([...(previous?.tombstones ?? []), ...gone])],
  };
  lock.sum = sumOf(lock);
  Catalog.compile(lock); // refuse to write a lock that would not apply
  return lock;
}

/** Every entry is named `<domain>.<name>`, and its domain owns it. Code review on that file is the
 *  ownership check. */
function owns(domain: string, name: string): void {
  if (!name.startsWith(`${domain}.`)) throw new CatalogError(`${name} is not ${domain}'s to define`);
}
