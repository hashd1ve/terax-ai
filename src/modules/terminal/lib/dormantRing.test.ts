import { describe, expect, it } from "vitest";

import { DormantRing } from "./dormantRing";

const enc = (s: string) => new TextEncoder().encode(s);

function drainToString(ring: DormantRing): string {
  let out = "";
  const dec = new TextDecoder();
  ring.drain((bytes) => {
    out += dec.decode(bytes);
  });
  return out;
}

describe("DormantRing", () => {
  it("replays buffered chunks in order when it has not overflowed", () => {
    const ring = new DormantRing();
    ring.push(enc("hello "));
    ring.push(enc("world"));
    expect(ring.overflowed()).toBe(false);
    expect(drainToString(ring)).toBe("hello world");
  });

  it("reports overflow once the byte cap is exceeded", () => {
    const ring = new DormantRing(8, 256);
    ring.push(enc("12345"));
    expect(ring.overflowed()).toBe(false);
    ring.push(enc("67890"));
    expect(ring.overflowed()).toBe(true);
  });

  it("reports overflow when a single chunk exceeds the byte cap", () => {
    const ring = new DormantRing(8, 256);
    ring.push(enc("0123456789ABCDEF"));
    expect(ring.overflowed()).toBe(true);
  });

  it("never injects a terminal-reset (RIS, \\x1bc) into the drained bytes", () => {
    const ring = new DormantRing(8, 256);
    ring.push(enc("0123456789ABCDEF"));
    expect(ring.overflowed()).toBe(true);
    // The caller discards the truncated tail and triggers a live repaint on
    // overflow; drain must never emit \x1bc, which would wipe the replayed
    // snapshot and reset the scroll region (the garbled-reattach bug).
    expect(drainToString(ring)).not.toContain("\x1bc");
  });

  it("resets overflow state after draining", () => {
    const ring = new DormantRing(8, 256);
    ring.push(enc("0123456789"));
    expect(ring.overflowed()).toBe(true);
    drainToString(ring);
    expect(ring.overflowed()).toBe(false);
    expect(drainToString(ring)).toBe("");
  });
});
