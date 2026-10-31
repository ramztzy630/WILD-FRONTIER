import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  angleDelta,
  clamp,
  damp,
  inverseLerp,
  lerp,
  moveTowards,
  remapClamped,
  smoothstep,
  wrapAngle,
} from "../src/core/math.ts";
import { Random, hashInts, hashString } from "../src/core/Random.ts";
import { EventBus } from "../src/core/EventBus.ts";

describe("math", () => {
  it("clamp / lerp / inverseLerp / remap", () => {
    assert.equal(clamp(5, 0, 3), 3);
    assert.equal(clamp(-1, 0, 3), 0);
    assert.equal(lerp(10, 20, 0.25), 12.5);
    assert.equal(inverseLerp(10, 20, 15), 0.5);
    assert.equal(inverseLerp(4, 4, 9), 0);
    assert.equal(remapClamped(30, 0, 20, 0, 1), 1);
  });

  it("smoothstep has the right endpoints and midpoint", () => {
    assert.equal(smoothstep(0, 1, -1), 0);
    assert.equal(smoothstep(0, 1, 2), 1);
    assert.equal(smoothstep(0, 1, 0.5), 0.5);
  });

  it("damp is frame-rate independent", () => {
    // One 1/30 s step must equal two 1/60 s steps.
    const one = damp(0, 10, 5, 1 / 30);
    const two = damp(damp(0, 10, 5, 1 / 60), 10, 5, 1 / 60);
    assert.ok(Math.abs(one - two) < 1e-9, `${one} vs ${two}`);
  });

  it("wrapAngle and angleDelta take the short way round", () => {
    assert.ok(Math.abs(wrapAngle(3 * Math.PI) - Math.PI) < 1e-9);
    assert.ok(Math.abs(wrapAngle(-Math.PI / 2) + Math.PI / 2) < 1e-9);
    const d = angleDelta(Math.PI - 0.1, -Math.PI + 0.1);
    assert.ok(Math.abs(d - 0.2) < 1e-9, `delta ${d}`);
  });

  it("moveTowards never overshoots", () => {
    assert.equal(moveTowards(0, 1, 0.3), 0.3);
    assert.equal(moveTowards(0.9, 1, 0.3), 1);
    assert.equal(moveTowards(0, -1, 0.5), -0.5);
  });
});

describe("Random", () => {
  it("is deterministic for the same seed", () => {
    const a = new Random(12345);
    const b = new Random(12345);
    for (let i = 0; i < 1000; i++) assert.equal(a.next(), b.next());
  });

  it("differs for different seeds", () => {
    const a = new Random(1);
    const b = new Random(2);
    let same = 0;
    for (let i = 0; i < 100; i++) if (a.next() === b.next()) same++;
    assert.ok(same < 2);
  });

  it("stays in range and is roughly uniform", () => {
    const r = new Random(99);
    const buckets = new Array<number>(10).fill(0);
    const n = 20000;
    for (let i = 0; i < n; i++) {
      const v = r.next();
      assert.ok(v >= 0 && v < 1);
      const idx = Math.floor(v * 10);
      buckets[idx] = (buckets[idx] ?? 0) + 1;
    }
    for (const count of buckets) assert.ok(Math.abs(count - n / 10) < n / 10 * 0.1, `bucket ${count}`);
  });

  it("int() covers both inclusive bounds", () => {
    const r = new Random(7);
    const seen = new Set<number>();
    for (let i = 0; i < 500; i++) {
      const v = r.int(1, 3);
      assert.ok(v >= 1 && v <= 3 && Number.isInteger(v));
      seen.add(v);
    }
    assert.deepEqual([...seen].sort(), [1, 2, 3]);
  });

  it("state can be saved and restored", () => {
    const r = new Random(42);
    r.next();
    const s = r.getState();
    const x = [r.next(), r.next()];
    r.setState(s);
    assert.deepEqual([r.next(), r.next()], x);
  });

  it("shuffle is a deterministic permutation", () => {
    const a = new Random(5).shuffle([1, 2, 3, 4, 5, 6, 7, 8]);
    const b = new Random(5).shuffle([1, 2, 3, 4, 5, 6, 7, 8]);
    assert.deepEqual(a, b);
    assert.deepEqual([...a].sort(), [1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it("pick throws on empty input", () => {
    assert.throws(() => new Random(1).pick([]));
  });

  it("hash helpers are stable uint32", () => {
    assert.equal(hashString("wild-frontier"), hashString("wild-frontier"));
    assert.notEqual(hashString("a"), hashString("b"));
    const h = hashInts(3, -4, 5);
    assert.ok(Number.isInteger(h) && h >= 0 && h <= 0xffffffff);
    assert.notEqual(hashInts(1, 2), hashInts(2, 1));
  });
});

describe("EventBus", () => {
  interface Events {
    ping: { n: number };
    done: undefined;
  }

  it("delivers payloads and unsubscribes", () => {
    const bus = new EventBus<Events>();
    const got: number[] = [];
    const off = bus.on("ping", (p) => got.push(p.n));
    bus.emit("ping", { n: 1 });
    off();
    bus.emit("ping", { n: 2 });
    assert.deepEqual(got, [1]);
    assert.equal(bus.listenerCount("ping"), 0);
  });

  it("once fires a single time", () => {
    const bus = new EventBus<Events>();
    let count = 0;
    bus.once("done", () => count++);
    bus.emit("done", undefined);
    bus.emit("done", undefined);
    assert.equal(count, 1);
  });

  it("a throwing listener does not block the others, and the error still surfaces", () => {
    const bus = new EventBus<Events>();
    let reached = false;
    bus.on("ping", () => {
      throw new Error("boom");
    });
    bus.on("ping", () => {
      reached = true;
    });
    assert.throws(() => bus.emit("ping", { n: 0 }), /boom/);
    assert.ok(reached);
  });

  it("listeners may unsubscribe during delivery", () => {
    const bus = new EventBus<Events>();
    const calls: string[] = [];
    const offA = bus.on("ping", () => {
      calls.push("a");
      offA();
    });
    bus.on("ping", () => calls.push("b"));
    bus.emit("ping", { n: 0 });
    bus.emit("ping", { n: 0 });
    assert.deepEqual(calls, ["a", "b", "b"]);
  });
});
