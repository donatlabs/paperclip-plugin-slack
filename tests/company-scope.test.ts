import { beforeEach, describe, expect, it } from "vitest";
import { companiesToAct, companyToAct, rememberCompany } from "../src/company-scope.js";

function ctx(list: () => Promise<Array<{ id: string }>>) {
  const warnings: string[] = [];
  return {
    warnings,
    ctx: {
      companies: { list },
      logger: { warn: (msg: string) => warnings.push(msg), info() {}, error() {}, debug() {} },
    } as never,
  };
}

const refused = async () => {
  throw new Error(
    'Plugin "x" is not allowed to perform "companies.list": the worker referenced a missing, expired, or unknown invocation scope',
  );
};

describe("which companies a proactive path acts on", () => {
  beforeEach(() => rememberCompany(undefined));

  it("uses the host's list where the host answers", async () => {
    const { ctx: c } = ctx(async () => [{ id: "co-1" }, { id: "co-2" }]);
    expect(await companiesToAct(c)).toEqual([{ id: "co-1" }, { id: "co-2" }]);
  });

  it("falls back to the company setup resolved when listing is refused", async () => {
    rememberCompany("co-setup");
    const { ctx: c, warnings } = ctx(refused);
    expect(await companiesToAct(c)).toEqual([{ id: "co-setup" }]);
    expect(warnings.join(" ")).toContain("refused");
  });

  it("acts on nothing rather than guessing when it never learned a company", async () => {
    const { ctx: c } = ctx(refused);
    expect(await companiesToAct(c)).toEqual([]);
    expect(await companyToAct(c)).toBeUndefined();
  });

  it("falls back on an empty list too, which a scoped host also returns", async () => {
    rememberCompany("co-setup");
    const { ctx: c } = ctx(async () => []);
    expect(await companyToAct(c)).toBe("co-setup");
  });
});
