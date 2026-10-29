// Time and chance, as seams. Nothing in this system may read the wall clock or Math.random directly:
// a test that cannot control them cannot reproduce what it found, which is how an intermittent failure
// stays intermittent.

export interface Clock {
  /** Milliseconds. Monotonic within one runtime. */
  now(): number;
  sleep(ms: number): Promise<void>;
  /** Runs f once everything already runnable has run: a batching window's close. */
  defer(f: () => void): void;
  /** Resolves when nothing is left to run. */
  idle(): Promise<void>;
}

export interface Random {
  /** In [0, 1). */
  next(): number;
  /** In [0, n). */
  int(n: number): number;
  pick<T>(items: readonly T[]): T;
  /** True with the given probability. */
  chance(p: number): boolean;
  shuffle<T>(items: readonly T[]): T[];
}

export interface Runtime {
  clock: Clock;
  random: Random;
}

// ---- real time

export const systemClock: Clock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((done) => setTimeout(done, ms)),
  defer: (f) => {
    setTimeout(f, 0);
  },
  idle: () => new Promise((done) => setTimeout(done, 0)),
};

export const systemRandom: Random = makeRandom(() => Math.random());

export const systemRuntime: Runtime = { clock: systemClock, random: systemRandom };

// ---- deterministic

/** mulberry32: small, fast, and good enough to spread choices. Seeded, so a failure replays. */
export function seeded(seed: number): Random {
  let state = seed >>> 0;
  return makeRandom(() => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  });
}

function makeRandom(next: () => number): Random {
  const r: Random = {
    next,
    int: (n) => Math.floor(next() * n),
    pick: (items) => items[Math.floor(next() * items.length)],
    chance: (p) => next() < p,
    shuffle: (items) => {
      const out = [...items];
      for (let i = out.length - 1; i > 0; i--) {
        const j = Math.floor(next() * (i + 1));
        [out[i], out[j]] = [out[j], out[i]];
      }
      return out;
    },
  };
  return r;
}

/** A clock on virtual time. Timers fire in time order, and only once everything that can run without
 *  waiting has run, which a real setTimeout(0) marks. So a timeline is exact and repeatable, and a
 *  test waits for a five-second deadline without taking five seconds. */
export class VirtualClock implements Clock {
  #now = 0;
  #timers: { at: number; seq: number; fire: () => void }[] = [];
  #waiting: (() => void)[] = [];
  #ticking = false;
  #seq = 0;

  now(): number {
    return this.#now;
  }

  sleep(ms: number): Promise<void> {
    return new Promise((done) => this.#add(this.#now + Math.max(0, ms), done));
  }

  defer(f: () => void): void {
    this.#add(this.#now, f);
  }

  idle(): Promise<void> {
    return new Promise((done) => {
      if (this.#ticking) this.#waiting.push(done);
      else done();
    });
  }

  #add(at: number, fire: () => void): void {
    // seq keeps timers due at the same instant in the order they were set.
    this.#timers.push({ at, seq: this.#seq++, fire });
    if (!this.#ticking) {
      this.#ticking = true;
      setTimeout(() => this.#tick(), 0);
    }
  }

  #tick(): void {
    if (this.#timers.length === 0) {
      this.#ticking = false;
      for (const done of this.#waiting.splice(0)) done();
      return;
    }
    const at = Math.min(...this.#timers.map((t) => t.at));
    const due = this.#timers.filter((t) => t.at === at).sort((a, b) => a.seq - b.seq);
    this.#timers = this.#timers.filter((t) => t.at !== at);
    this.#now = at;
    for (const t of due) t.fire();
    setTimeout(() => this.#tick(), 0); // after the microtasks those timers set off
  }
}

export function deterministic(seed: number): Runtime {
  return { clock: new VirtualClock(), random: seeded(seed) };
}
