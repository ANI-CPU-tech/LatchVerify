# Business model

## Positioning

**Socket.dev for agent tools.**

Socket did not win by adding another CVE database. It looked at what a package
version *does* (new install scripts, new network access, new filesystem access)
and flagged changes in behaviour, not changes in bytes. LatchVerify applies the
same idea to MCP tools. A tool's description and schema are its manifest. We pin
the capabilities they imply, and we gate changes to those capabilities in the
place where engineering teams already gate change: the pull request.

Who buys it:

- **Platform and security teams** rolling out coding agents (Claude Code, Cursor and
  others) who need to know which MCP tools developers' agents can reach, and to
  stop silent changes to them.
- **Regulated and air-gapped organizations** (finance, defense, healthcare,
  government) who cannot send tool definitions to a third-party cloud for scanning.
- **Teams publishing MCP servers** who want CI proof that a release did not widen
  their tools' capabilities.

## Open core

The core stays open source under MIT. The open-source product must be fully useful
on its own: a proxy that blocks rug pulls but sits behind a paywall protects nobody,
and nobody adopts it.

| | **OSS** | **Team** | **Enterprise** |
|---|---|---|---|
| Price | Free | ~$15–25 per developer per month | Annual contract |
| Stdio proxy, capability extraction, all detectors | ✓ | ✓ | ✓ |
| `latch.lock`, `latch verify` in CI, local review UI | ✓ | ✓ | ✓ |
| Optional LLM pass (bring your own key) | ✓ | ✓ | ✓ |
| Shared review queue across the team (no more "works on my machine" pending changes) | | ✓ | ✓ |
| GitHub/GitLab app: capability diff posted as a PR comment, required check | | ✓ | ✓ |
| Slack/Teams alerts on tier-3 events | | ✓ | ✓ |
| Curated registry of known-good server pins and known-bad patterns | | ✓ | ✓ |
| Org-wide policy (e.g. "no tool may gain exec without security approval") | | | ✓ |
| Central audit log export (SIEM), SSO/SCIM | | | ✓ |
| Self-hosted control plane, offline registry bundles for air-gapped networks | | | ✓ |
| HTTP/SSE transport proxying for remote MCP servers | | | ✓ |
| Support SLA | | | ✓ |

The dividing line: **anything one developer needs to be safe is free. What a team
needs to coordinate, and what an enterprise needs to prove compliance, is paid.**

### Why per-developer pricing

Value scales with the number of agents running tools, and that is roughly the number
of developers. It also matches how teams already budget for Snyk, Socket and GitHub
Advanced Security, so procurement already knows the shape. The $15–25 range sits
below full AppSec suites, because we are one focused control, not a platform.

## Competition

### Snyk Agent Scan / mcp-scan

The honest answer first: Snyk acquired Invariant Labs, the team behind mcp-scan, and
it has the brand, the distribution and an existing seat in most AppSec budgets. If a
buyer wants a single vendor for everything, Snyk wins that deal, and we should not
pretend otherwise.

Where we differ:

1. **Capability diffs, not hash diffs.** mcp-scan pins a hash and reports when it
   changes. Every reworded description becomes an alert, so teams tune it out.
   LatchVerify auto-passes tier-0 rewording and escalates only when capabilities
   move. Fewer, better alerts are the product.
2. **No cloud-token requirement.** Snyk's scanning requires a Snyk cloud token and
   depends on Snyk's backend. That rules out air-gapped customers, and many
   regulated ones, by design. LatchVerify's core analysis is deterministic
   and runs locally. The LLM pass is optional, off by default, and uses the
   customer's own key.
3. **A git-native workflow is a different product shape.** With Snyk, approval state
   lives in a vendor dashboard. With LatchVerify it lives in `latch.lock`, in the
   customer's repo, reviewed in pull requests, protected by their branch rules and
   CODEOWNERS, and auditable with `git log`. That fits teams who already run
   "everything as code", and the state stays with the customer if they stop paying.

So we do not position against Snyk on breadth. We position as the tool a
security-conscious platform team adds because it fits their git workflow and works
offline.

### MCP gateways and client-side allow-lists

Gateways (hosted MCP routers, enterprise agent platforms) can allow or deny servers,
but they usually trust a server's tools once it is allowed. Clients ask the user to
approve a tool once and rarely ask again. Neither diffs capabilities over time, and
that is exactly the gap a rug pull uses. LatchVerify can run alongside either.

## Go-to-market

1. **OSS first.** A launch post with the rug-pull demo (`docs/DEMO.md`), plus a
   `latch verify` GitHub Action that is easy to adopt.
2. **Bottom-up into teams.** One developer adds `latch.lock`, and the PR exposes it
   to the team. The shared-queue and PR-comment features of Team are the natural
   upgrade.
3. **Top-down for enterprise.** Lead with air-gapped and self-hosted deployment in
   regulated verticals, where the cloud-token requirement already rules out the
   incumbent.

## Risks

- **The MCP protocol could add signed or pinned tool definitions.** That would
  validate the category, and capability diffing still sits above signing: a validly
  signed update can still widen what a tool can do.
- **Clients could build this in.** Possible for single-user pinning. Team review,
  CI enforcement and cross-client coverage are harder for any one client vendor.
- **Heuristic false positives.** Pass 1 is name-based. That is why the deterministic
  table is documented and tunable, and why the LLM pass is advisory only.
