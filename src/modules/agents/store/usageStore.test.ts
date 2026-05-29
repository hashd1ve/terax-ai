import { beforeEach, describe, expect, it } from "vitest";
import {
  CONTEXT_WARN_PCT,
  formatContextPct,
  formatCost,
  shortModelName,
  type UsageInfo,
  useUsageStore,
} from "./usageStore";

const reset = () => useUsageStore.setState({ byLeaf: {} });

const sample: UsageInfo = {
  model: "claude-opus-4-8[1m]",
  inputTokens: 2,
  outputTokens: 828,
  cacheReadTokens: 431884,
  cacheCreationTokens: 3334,
  contextTokens: 435220,
  contextWindow: 1_000_000,
  contextPct: 43.522,
  costUsdEst: 0.713,
};

describe("usageStore", () => {
  beforeEach(reset);

  it("set then drop a leaf's usage", () => {
    useUsageStore.getState().set("u1", sample);
    expect(useUsageStore.getState().byLeaf["u1"]).toEqual(sample);

    useUsageStore.getState().drop("u1");
    expect(useUsageStore.getState().byLeaf["u1"]).toBeUndefined();
  });

  it("drop of an unknown leaf is a no-op (same reference)", () => {
    const before = useUsageStore.getState().byLeaf;
    useUsageStore.getState().drop("missing");
    expect(useUsageStore.getState().byLeaf).toBe(before);
  });
});

describe("shortModelName", () => {
  it("strips vendor prefix and 1m suffix", () => {
    expect(shortModelName("claude-opus-4-8[1m]")).toBe("opus 4-8");
    expect(shortModelName("claude-sonnet-4-6")).toBe("sonnet 4-6");
    expect(shortModelName("claude-haiku-4-5-20251001")).toBe(
      "haiku 4-5-20251001",
    );
  });

  it("degrades gracefully for unknown shapes", () => {
    expect(shortModelName("some-future-model")).toBe("some-future-model");
  });
});

describe("formatCost", () => {
  it("formats by magnitude", () => {
    expect(formatCost(0.12)).toBe("$0.12");
    expect(formatCost(1.4)).toBe("$1.40");
    expect(formatCost(42)).toBe("$42");
    expect(formatCost(2300)).toBe("$2.3k");
    expect(formatCost(0)).toBe("$0.00");
    expect(formatCost(0.004)).toBe("<$0.01");
  });

  it("returns null for absent or invalid cost", () => {
    expect(formatCost(null)).toBeNull();
    expect(formatCost(Number.NaN)).toBeNull();
    expect(formatCost(-5)).toBeNull();
  });
});

describe("formatContextPct", () => {
  it("rounds and clamps", () => {
    expect(formatContextPct(43.522)).toBe(44);
    expect(formatContextPct(120)).toBe(100);
    expect(formatContextPct(-3)).toBe(0);
    expect(formatContextPct(Number.NaN)).toBe(0);
  });

  it("warning threshold is high enough to mean near-compact", () => {
    expect(formatContextPct(90) > CONTEXT_WARN_PCT).toBe(true);
    expect(formatContextPct(50) > CONTEXT_WARN_PCT).toBe(false);
  });
});
