import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { VSHARD_CAP } from "../directory/allocator.ts";
import { DEFAULT_THRESHOLDS } from "../directory/placement.ts";
import { MAX_PAYLOAD } from "../host/schema.ts";
import { CLOUDFLARE, PLATFORM, shedBytes, vshardCap } from "./platform.ts";

// Collecting these figures into one module had to change no behaviour: every one of them was measured
// or argued against Cloudflare's limits in design.md, and a port is the only thing entitled to move
// them. So this pins the derived values rather than the limits.
describe("platform limits", () => {
  it("derives exactly the figures design.md settled on", () => {
    assert.equal(PLATFORM, CLOUDFLARE);
    assert.equal(VSHARD_CAP, 9_000_000_000);
    assert.equal(DEFAULT_THRESHOLDS.bytes, 8_000_000_000);
    assert.equal(DEFAULT_THRESHOLDS.requests, 500_000);
    assert.equal(MAX_PAYLOAD, 2 * 1024 * 1024);
  });

  it("re-derives both thresholds for a host that is not a Durable Object", () => {
    const box = { hostBytes: 2_000_000_000_000, hostRequests: 50_000, rowBytes: 1_000_000_000 };
    assert.equal(vshardCap(box), 1_999_000_000_000);
    assert.equal(shedBytes(box), 1_998_000_000_000);

    // The shed threshold stays below the vshard cap, which is the relationship `pickRun` depends on:
    // a lone vshard between the two trips the threshold with nothing it can shed.
    assert.ok(shedBytes(box) < vshardCap(box));
    assert.ok(shedBytes() < vshardCap());
  });
});
