import { env } from "./config/env";
import { MockCollector } from "./collectors/mockCollector";
import { logger } from "./services/logger";
import { createRunId } from "./utils/ids";

const collector = new MockCollector();
const runId = createRunId();

const results = await collector.collect({
  runId,
  propertyId: "property_mock_zao_001",
  propertyName: "Mock Zao Onsen Property",
  ota: "mock",
  stayDate: "2026-02-01",
  guests: 2,
  nights: 1
});

logger.info("Completed offline MVP collection", {
  runId,
  postalCode: env.ZAO_POSTAL_CODE,
  resultCount: results.length,
  statuses: results.map((result) => result.rateSnapshot.availabilityStatus)
});
