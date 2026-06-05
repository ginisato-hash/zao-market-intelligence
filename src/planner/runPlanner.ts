import { createHash } from "node:crypto";
import type { FixedSearchCondition, TargetDatePriority } from "../domain/types";
import type { LocalDatabase } from "../db/client";
import { listActivePropertyOtaLinks } from "../db/repositories/plannerRepository";
import { listActiveTargetDates } from "../db/repositories/targetDatesRepository";

export interface PlannedCollectionJob {
  job_id: string;
  property_id: string;
  property_name: string;
  ota: string;
  ota_property_id?: string | null;
  property_url?: string | null;
  stay_date: string;
  priority: TargetDatePriority;
  reason: string;
  adults: number;
  children: number;
  rooms: number;
  nights: number;
  currency: "JPY";
  price_basis_preference: "total_tax_included";
}

export interface BuildPlannedCollectionJobsOptions {
  searchCondition?: FixedSearchCondition;
  maxJobs?: number;
  priorityFilter?: readonly TargetDatePriority[];
}

export const DEFAULT_FIXED_SEARCH_CONDITION: FixedSearchCondition = {
  adults: 2,
  children: 0,
  rooms: 1,
  nights: 1,
  currency: "JPY",
  priceBasisPreference: "total_tax_included"
};

const PRIORITY_ORDER: Record<TargetDatePriority, number> = {
  S: 0,
  A: 1,
  B: 2,
  C: 3
};

export function buildPlannedCollectionJobs(
  db: LocalDatabase,
  options: BuildPlannedCollectionJobsOptions = {}
): PlannedCollectionJob[] {
  const condition = options.searchCondition ?? DEFAULT_FIXED_SEARCH_CONDITION;
  const links = listActivePropertyOtaLinks(db);
  const targetDates = listActiveTargetDates(db, options.priorityFilter);

  const jobs = links.flatMap((link) =>
    targetDates.map((targetDate) => ({
      job_id: createJobId(link.propertyId, link.ota, targetDate.stayDate, condition),
      property_id: link.propertyId,
      property_name: link.propertyName,
      ota: link.ota,
      ota_property_id: link.otaPropertyId,
      property_url: link.propertyUrl,
      stay_date: targetDate.stayDate,
      priority: targetDate.priority,
      reason: targetDate.reason,
      adults: condition.adults,
      children: condition.children,
      rooms: condition.rooms,
      nights: condition.nights,
      currency: condition.currency,
      price_basis_preference: condition.priceBasisPreference
    }))
  );

  const ordered = jobs.sort(compareJobs);
  return options.maxJobs === undefined ? ordered : ordered.slice(0, options.maxJobs);
}

function compareJobs(left: PlannedCollectionJob, right: PlannedCollectionJob): number {
  return (
    PRIORITY_ORDER[left.priority] - PRIORITY_ORDER[right.priority] ||
    left.stay_date.localeCompare(right.stay_date) ||
    left.property_name.localeCompare(right.property_name) ||
    left.ota.localeCompare(right.ota)
  );
}

function createJobId(
  propertyId: string,
  ota: string,
  stayDate: string,
  condition: FixedSearchCondition
): string {
  const input = [
    propertyId,
    ota,
    stayDate,
    condition.adults,
    condition.children,
    condition.rooms,
    condition.nights,
    condition.currency,
    condition.priceBasisPreference
  ].join("|");

  return `job_${createHash("sha1").update(input).digest("hex").slice(0, 16)}`;
}
