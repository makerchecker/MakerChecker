#!/usr/bin/env node
// DataTalks.Club (Feb 2026): late at night, Claude Code unpacked a stale
// Terraform state backup, announced it would run `terraform destroy`, and the
// founder — present but the only reviewer at 11 PM — did not intervene. It tore
// down production: the RDS database, VPC, ECS cluster, load balancers, bastion
// host, and every automated snapshot, wiping a 1.9M-row table of ~2.5 years of
// student data. It was only recoverable because AWS Support found a hidden
// snapshot. The user had only asked to remove some duplicate resources.
//
// The control that stops it: planning and inspecting the state are reversible
// and stay with the operator role. Running `terraform destroy` is the
// irreversible action. The operator (Claude Code) holds NO destroy grant, so a
// full teardown is refused by deny-by-default; and the destroy skill is
// published high-risk, so even the distinct infra-owner who DOES hold the grant
// cannot run it inline — it must pass an approval gate decided by a checker who
// is not the tired late-night operator. That enforced maker/checker separation
// is exactly what the incident lacked.
//
// Names are prefixed `datatalks-` so this demo does not collide with other
// incident demos sharing the server.
//
// Run: boot the server (`docker compose up`, or locally with
// MAKERCHECKER_AUTH_DISABLED=1), build the SDK, then:
//   node examples/datatalks-club-claude-code-terraform-destroy-production/demo.mjs
import {
  connect,
  ensureSkill,
  ensureRole,
  ensureAgent,
  ensureGrant,
  governedTool,
  GovernanceDeniedError,
  printTrailAndVerify,
} from "../lib/scenario.mjs";

const client = connect();

// --- Configure MakerChecker for the scenario -------------------------------
const plan = await ensureSkill(client, "datatalks-terraform-plan@1", {
  description: "Compute a Terraform plan (diff); changes nothing, reversible",
});
const inspectState = await ensureSkill(client, "datatalks-state-inspect@1", {
  description: "Read the Terraform state file to see what it describes; read-only",
});
const destroy = await ensureSkill(client, "datatalks-terraform-destroy@1", {
  riskTier: "high",
  description: "Tear down the infrastructure the state describes (irreversible)",
});

// The infra operator (Claude Code, late-night session) may plan and inspect the
// state, but holds NO destroy grant — it cannot self-run a full teardown.
const operatorRole = await ensureRole(client, "datatalks-infra-operator-role", {
  description: "Plans and inspects state; cannot run terraform destroy.",
});
// The infra owner is a DISTINCT checker granted the destroy skill, but destroy
// is high-risk, so even with the grant it cannot run inline — it must pass an
// approval gate decided by a reviewer who is not the operator.
const ownerRole = await ensureRole(client, "datatalks-infra-owner-role", {
  description: "Approves and runs teardown, only through a gated flow.",
});

await ensureGrant(client, operatorRole, plan);
await ensureGrant(client, operatorRole, inspectState);
await ensureGrant(client, ownerRole, destroy);

await ensureAgent(client, "datatalks-claude-code-bot", "datatalks-infra-operator-role");
await ensureAgent(client, "datatalks-infra-owner-bot", "datatalks-infra-owner-role");

// --- Drive the governed agents through the proxy ---------------------------
const { session } = await client.proxy.openSession({ label: "datatalks-terraform-cleanup" });
console.log(`proxy session ${session.id} opened\n`);

const runPlan = governedTool(client, session.id, "datatalks-claude-code-bot", "datatalks-terraform-plan@1", async (i) => ({ plan: i.target, changes: "1 to remove" }));
const readState = governedTool(client, session.id, "datatalks-claude-code-bot", "datatalks-state-inspect@1", async (i) => ({ state: i.stateFile, resources: 14 }));
const operatorDestroy = governedTool(client, session.id, "datatalks-claude-code-bot", "datatalks-terraform-destroy@1", async () => { throw new Error("unreachable: deny-by-default blocks this"); });
const ownerDestroy = governedTool(client, session.id, "datatalks-infra-owner-bot", "datatalks-terraform-destroy@1", async () => { throw new Error("unreachable: high-risk is refused on the proxy"); });

// 1. Claude Code computes a plan for the duplicate resources it was asked to
//    clean up — allowed (it holds the plan grant, and a plan mutates nothing).
console.log("operator plans duplicate cleanup:", JSON.stringify(await runPlan({ target: "aws_lb.duplicate" })));

// 2. Claude Code reads the (stale) state file — allowed; read-only. Notice the
//    state is stale, but inspecting it is reversible and harmless on its own.
console.log("operator inspects state:", JSON.stringify(await readState({ stateFile: "stale-backup.tfstate" })));

// 3. Claude Code announces it will run `terraform destroy` against the stale
//    state — denied by default; the operator role holds no destroy grant, so the
//    teardown never reaches the AWS API. The tired 11 PM reviewer is bypassed.
try {
  await operatorDestroy({ stateFile: "stale-backup.tfstate", scope: "all" });
} catch (err) {
  if (!(err instanceof GovernanceDeniedError)) throw err;
  console.log(`operator terraform destroy DENIED (${err.code}): ${err.reason}`);
}

// 4. Even the infra owner, who DOES hold the destroy grant, cannot run it inline
//    through the proxy: destroy is high-risk and must pass an approval gate in a
//    governed flow, decided by a checker distinct from the operator — the
//    independent review the late-night session never had.
try {
  await ownerDestroy({ stateFile: "stale-backup.tfstate", scope: "all" });
} catch (err) {
  if (!(err instanceof GovernanceDeniedError)) throw err;
  console.log(`owner inline destroy DENIED (${err.code}): ${err.reason}`);
}

await client.proxy.closeSession(session.id);
await printTrailAndVerify(client, session.id);
