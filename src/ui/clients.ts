import { programName } from "../analyze/hash.js";
import { CLIENT_NAMES } from "../config/client-names.js";
import { detectClients, proxyLaunchOf, unwrapProxy, type ClientId } from "../config/clients.js";
import type { ClientReport, ClientsReport, LockFile, Settings } from "../schema/index.js";

/**
 * The clients found on this machine, per client, for GET /api/clients (ClientsReportSchema): the
 * user's answer, the config files, and per stdio server its program, whether it is linked and
 * its pin state. Built from detectClients, which keeps no env value; arguments are reduced here
 * to the program name. A client the machine does not have is not listed.
 */
export async function clientsReport(lock: LockFile, settings: Settings): Promise<ClientsReport> {
  const detection = await detectClients();
  const reports = new Map<ClientId, ClientReport>();
  const report = (id: ClientId): ClientReport => {
    let entry = reports.get(id);
    if (entry === undefined) {
      const answer = settings.clients[id];
      entry = { id, name: CLIENT_NAMES[id], answer: answer === true ? "connected" : answer === false ? "declined" : "unasked", files: [], servers: [], problems: [] };
      reports.set(id, entry);
    }
    return entry;
  };
  for (const config of detection.configs) {
    const entry = report(config.client);
    entry.files.push({ path: config.path, ...(config.scope === undefined ? {} : { scope: config.scope }) });
    for (const [id, server] of Object.entries(config.servers)) {
      const pinned = Object.hasOwn(lock.servers, id) ? lock.servers[id]! : undefined;
      entry.servers.push({
        id,
        program: programName(unwrapProxy(server).command),
        linked: proxyLaunchOf(server) !== undefined,
        pin: pinned === undefined ? "absent" : pinned.trustOnFirstUse === true ? "first_run" : "pinned",
        tools: pinned?.tools.length ?? 0,
      });
    }
  }
  for (const problem of detection.problems) report(problem.client).problems.push(`${problem.path} ${problem.message}`);
  return { clients: [...reports.values()] };
}
