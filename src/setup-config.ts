import type { PluginContext } from "@paperclipai/plugin-sdk";

/**
 * The company the plugin serves at setup, and its config. The host keeps
 * config per company and refuses `config.get` for a company the plugin has
 * not been configured for; on a workspace where nobody has connected Slack
 * yet that is every company. That is not a fault: the plugin starts with an
 * empty config, registers nothing that needs a token, and reports itself as
 * not connected, the same way it does when the token reference is missing.
 * Failing setup instead would leave the plugin in "error" and, on a hosted
 * workspace, hold up the workspace itself.
 */
export async function readSetupConfig<T extends object>(
  ctx: Pick<PluginContext, "companies" | "config" | "logger">,
): Promise<{ companyId: string | undefined; config: T; configured: boolean }> {
  let companyId: string | undefined;
  try {
    const companies = await ctx.companies.list({ limit: 1, offset: 0 });
    companyId = companies[0]?.id;
  } catch (err) {
    ctx.logger.warn("Slack plugin could not list companies at setup", { err: String(err) });
  }
  try {
    const config = (await ctx.config.get(companyId)) as unknown as T;
    return { companyId, config, configured: true };
  } catch (err) {
    ctx.logger.warn("Slack is not connected on this workspace yet; the plugin waits for a configuration", {
      err: String(err),
    });
    return { companyId, config: {} as T, configured: false };
  }
}
