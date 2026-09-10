import type { PluginContext } from "@paperclipai/plugin-sdk";

/**
 * The company this worker serves, learned at setup and remembered.
 *
 * The host tells a proactive worker→host call — one made from a job, a
 * webhook or an event handler rather than from inside a host-issued
 * invocation — apart from an ordinary one, and admits it only when it names
 * a company the plugin may act on. `companies.list` names none, so from
 * those paths it is refused outright:
 *
 *   Plugin … is not allowed to perform "companies.list": the worker
 *   referenced a missing, expired, or unknown invocation scope
 *
 * which fails the job and answers a Slack delivery with a 502. Setup runs
 * inside an invocation and may ask; everything after it asks this instead.
 */
let knownCompanyId: string | undefined;

/** Remember the company setup resolved. */
export function rememberCompany(companyId: string | undefined): void {
  knownCompanyId = companyId;
}

type ScopeContext = Pick<PluginContext, "companies" | "logger">;

/**
 * The companies to act on. Where the host still answers `companies.list` —
 * a self-hosted instance serving several — that list is used as before;
 * where it refuses, the company from setup is the answer, which is the
 * whole truth on an instance that serves one.
 */
export async function companiesToAct(
  ctx: ScopeContext,
  limit = 100,
): Promise<Array<{ id: string }>> {
  try {
    const companies = await ctx.companies.list({ limit, offset: 0 });
    if (companies.length > 0) return companies;
  } catch (err) {
    ctx.logger.warn("Listing companies was refused; using the company this worker was set up for", {
      err: String(err),
    });
  }
  return knownCompanyId ? [{ id: knownCompanyId }] : [];
}

/** The one company to act on, for the paths that need exactly one. */
export async function companyToAct(ctx: ScopeContext): Promise<string | undefined> {
  return (await companiesToAct(ctx, 1))[0]?.id;
}
