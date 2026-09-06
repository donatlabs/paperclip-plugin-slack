import { describe, expect, it } from "vitest";
import { readSetupConfig } from "../src/setup-config.js";

function ctx(opts: { companies?: Array<{ id: string }>; config?: Record<string, unknown>; deny?: boolean }) {
  const warnings: string[] = [];
  return {
    warnings,
    ctx: {
      companies: { list: async () => opts.companies ?? [{ id: "co-1" }] },
      config: {
        get: async (companyId?: string) => {
          if (opts.deny) throw new Error(`Plugin is not allowed to perform "config.get": company context is required (${companyId})`);
          return opts.config ?? {};
        },
      },
      logger: { warn: (msg: string) => warnings.push(msg), info() {}, error() {}, debug() {} },
    } as never,
  };
}

describe("readSetupConfig", () => {
  it("returns the first company's config", async () => {
    const { ctx: c } = ctx({ config: { slackTokenRef: "ref-1" } });
    expect(await readSetupConfig(c)).toEqual({ companyId: "co-1", config: { slackTokenRef: "ref-1" }, configured: true });
  });

  it("starts with an empty config when the host has none for the company", async () => {
    const { ctx: c, warnings } = ctx({ deny: true });
    const got = await readSetupConfig<{ slackTokenRef?: string }>(c);
    expect(got.configured).toBe(false);
    expect(got.config.slackTokenRef).toBeUndefined();
    expect(warnings.some((w) => /not connected/.test(w))).toBe(true);
  });

  it("survives a workspace with no company yet", async () => {
    const { ctx: c } = ctx({ companies: [], deny: true });
    expect((await readSetupConfig(c)).companyId).toBeUndefined();
  });
});
