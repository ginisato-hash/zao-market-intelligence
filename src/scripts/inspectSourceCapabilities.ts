import {
  loadSourceCapabilities,
  listAllowedSources,
  listForbiddenSources,
  assertNoPaidSourcesEnabled
} from "../services/sourceCapabilityRegistry";

const capabilities = loadSourceCapabilities();

const active       = capabilities.filter((c) => c.status === "active");
const parked       = capabilities.filter((c) => c.status === "parked");
const feasibility  = capabilities.filter((c) => c.status === "feasibility_only");
const forbidden    = capabilities.filter((c) => c.status === "forbidden");
const allowed      = listAllowedSources(capabilities);
const notAllowed   = listForbiddenSources(capabilities);
const paidForbidden = notAllowed.filter((c) => c.paid_service_required);

let policyValid = true;
try {
  assertNoPaidSourcesEnabled(capabilities);
} catch {
  policyValid = false;
}

console.log(`active_sources=${active.map((c) => c.source).join(",") || "none"}`);
console.log(`parked_sources=${parked.map((c) => c.source).join(",") || "none"}`);
console.log(`feasibility_only_sources=${feasibility.map((c) => c.source).join(",") || "none"}`);
console.log(`forbidden_sources=${forbidden.map((c) => c.source).join(",") || "none"}`);
console.log(`paid_forbidden_count=${paidForbidden.length}`);
console.log(`allowed_sources=${allowed.map((c) => c.source).join(",") || "none"}`);
console.log(`free_only_policy_valid=${policyValid}`);
console.log("---");

for (const c of capabilities) {
  console.log(
    `source=${c.source}` +
    ` status=${c.status}` +
    ` source_type=${c.source_type}` +
    ` allowed=${c.allowed}` +
    ` confidence=${c.confidence}` +
    ` paid_service_required=${c.paid_service_required}`
  );
}
