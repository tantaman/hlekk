import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { PrivateAddress, isPublicAddress, privateAddressGuard } from "./guard.ts";

// A database URI is drawn by whoever writes the edge, so it is also an instruction to this process to
// make a request. These tests are about what that instruction may not be allowed to reach.

describe("which addresses a stranger's URI may send this process to", () => {
  it("allows a public address", () => {
    for (const a of ["1.1.1.1", "8.8.8.8", "93.184.216.34", "2606:2800:220:1:248:1893:25c8:1946", "2a00:1450::1"]) {
      assert.equal(isPublicAddress(a), true, a);
    }
  });

  it("refuses everything inside a network, the cloud metadata address included", () => {
    for (const a of [
      "127.0.0.1",
      "127.1.2.3",
      "10.0.0.5",
      "172.16.0.1",
      "172.31.255.255",
      "192.168.1.1",
      "169.254.169.254", // the one every SSRF write-up names
      "100.64.0.1",
      "0.0.0.0",
      "192.0.2.1",
      "198.18.0.1",
      "198.51.100.1",
      "203.0.113.1",
      "224.0.0.1",
      "255.255.255.255",
      "::1",
      "::",
      "fe80::1",
      "fc00::1",
      "fd12:3456::1",
      "ff02::1",
      "2001:db8::1",
    ]) {
      assert.equal(isPublicAddress(a), false, a);
    }
  });

  it("judges an IPv4-mapped address as the address it carries, not as a v6 one", () => {
    // Otherwise the mapping is the way past the check: `::ffff:169.254.169.254` is the metadata
    // service wearing a v6 hat.
    assert.equal(isPublicAddress("::ffff:169.254.169.254"), false);
    assert.equal(isPublicAddress("::ffff:10.0.0.1"), false);
    assert.equal(isPublicAddress("::ffff:1.1.1.1"), true);
    assert.equal(isPublicAddress("::10.0.0.1"), false);
  });

  it("refuses a malformed address rather than passing it", () => {
    for (const a of ["", "1.2.3", "1.2.3.4.5", "999.1.1.1", "not an address", "1.2.3.-1"]) {
      assert.equal(isPublicAddress(a), false, a);
    }
  });
});

describe("the guard", () => {
  const resolving = (addresses: string[]) => privateAddressGuard({ resolve: async () => addresses.map((address) => ({ address })) });

  it("refuses a name that resolves into this network", async () => {
    await assert.rejects(resolving(["10.0.0.5"])("https://inside.example/db"), PrivateAddress);
    await assert.doesNotReject(resolving(["93.184.216.34"])("https://outside.example/db"));
  });

  it("refuses a name with any private address, not just a first one", async () => {
    // A name with one public and one private record would otherwise pass the check and be reached at
    // whichever the connection picked.
    await assert.rejects(resolving(["93.184.216.34", "10.0.0.5"])("https://mixed.example/db"), PrivateAddress);
  });

  it("refuses a name that resolves to nothing", async () => {
    await assert.rejects(resolving([])("https://nowhere.example/db"), PrivateAddress);
  });

  it("judges an IP literal without asking a resolver", async () => {
    // `lookup` on a literal returns it unchanged, which would read as a confirmation rather than as
    // the check being skipped.
    let asked = 0;
    const guard = privateAddressGuard({
      resolve: async () => {
        asked++;
        return [{ address: "93.184.216.34" }];
      },
    });
    await assert.rejects(guard("https://127.0.0.1/db"), PrivateAddress);
    await assert.rejects(guard("https://[::1]/db"), PrivateAddress);
    assert.equal(asked, 0);
  });

  it("allows loopback only when it is asked to, which is a test's business and not a deployment's", async () => {
    await assert.doesNotReject(privateAddressGuard({ allowLoopback: true })("http://127.0.0.1:8080/db"));
    await assert.rejects(privateAddressGuard({ allowLoopback: true })("https://10.0.0.1/db"), PrivateAddress);
    await assert.rejects(privateAddressGuard()("http://127.0.0.1:8080/db"), PrivateAddress);
  });

  it("checks a database once and remembers the answer", async () => {
    let asked = 0;
    const guard = privateAddressGuard({
      resolve: async () => {
        asked++;
        return [{ address: "93.184.216.34" }];
      },
    });
    await Promise.all([guard("https://a.example/db"), guard("https://a.example/db")]);
    await guard("https://a.example/db");
    assert.equal(asked, 1);
  });

  it("refuses a URI that is not canonical, before it resolves anything", async () => {
    await assert.rejects(resolving(["93.184.216.34"])("https://A.example/db"), /canonical/);
  });
});
