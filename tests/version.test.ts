import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { PLUGIN_VERSION } from "../src/constants.js";

// The host records the manifest's version and the control plane compares it
// with package.json's; they must be one number.
describe("plugin version", () => {
  it("matches package.json", () => {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
    expect(PLUGIN_VERSION).toBe(pkg.version);
  });
});
