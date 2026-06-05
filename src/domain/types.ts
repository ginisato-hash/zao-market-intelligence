import type { AVAILABILITY_STATUSES, CONFIDENCE_LEVELS } from "./constants";

export type Confidence = (typeof CONFIDENCE_LEVELS)[number];
export type AvailabilityStatus = (typeof AVAILABILITY_STATUSES)[number];
export type OtaSource =
  | "rakuten"
  | "jalan"
  | "yahoo_travel"
  | "booking"
  | "agoda"
  | "expedia"
  | "ikyu"
  | "google_hotels"
  | "official"
  | "other"
  | "mock";

export type PropertyType =
  | "ryokan"
  | "hotel"
  | "pension"
  | "minshuku"
  | "lodge"
  | "vacation_rental"
  | "apartment"
  | "guesthouse"
  | "unknown";

export type PriceSegment = "economy" | "midscale" | "upper_midscale" | "luxury" | "unknown";
export type MealStyle = "room_only" | "breakfast" | "half_board" | "mixed" | "unknown";
export type SkiAccess = "ski_in_out" | "walkable" | "shuttle" | "car" | "unknown";
export type TargetDatePriority = "S" | "A" | "B" | "C";

export interface FixedSearchCondition {
  adults: number;
  children: number;
  rooms: number;
  nights: number;
  currency: "JPY";
  priceBasisPreference: "total_tax_included";
}

export interface Property {
  id: string;
  name: string;
  postalCode: string;
  areaName: string;
  address?: string;
  lat?: number | null;
  lng?: number | null;
  propertyType: PropertyType;
  priceSegment: PriceSegment;
  mealStyle: MealStyle;
  hasOnsen: boolean | null;
  skiAccess: SkiAccess;
  roomCountEstimate?: number | null;
  maxCapacityEstimate?: number | null;
  active: boolean;
  notes?: string;
  createdAt: string;
  updatedAt: string;
}

export interface PropertyOtaLink {
  id: string;
  propertyId: string;
  ota: OtaSource;
  otaPropertyId?: string | null;
  url: string;
  propertyUrl?: string | null;
  active: boolean;
  lastVerifiedAt?: string | null;
  notes?: string;
  createdAt: string;
  updatedAt: string;
}

export interface CollectorRun {
  id: string;
  ota: OtaSource;
  startedAtJst: string;
  finishedAtJst?: string;
  status: "running" | "completed" | "failed";
  createdAt: string;
}

export interface RateSnapshot {
  id: string;
  runId: string;
  propertyId: string;
  ota: OtaSource;
  stayDate: string;
  guests: number;
  nights: number;
  priceJpy: number | null;
  priceTotalTaxIncluded: number | null;
  availabilityStatus: AvailabilityStatus;
  confidence: Confidence;
  checkedAtJst: string;
  screenshotKey?: string;
  rawTextExcerpt?: string;
  errorReason?: string;
  createdAt: string;
}

export interface InventorySnapshot {
  id: string;
  runId: string;
  propertyId: string;
  ota: OtaSource;
  stayDate: string;
  availabilityStatus: AvailabilityStatus;
  confidence: Confidence;
  checkedAtJst: string;
  createdAt: string;
}

export interface MarketDailySignal {
  id: string;
  stayDate: string;
  postalCode: string;
  medianPriceJpy: number | null;
  availableCount: number;
  soldOutCount: number;
  failedCount: number;
  confidence: Confidence;
  createdAt: string;
  updatedAt: string;
}

export interface PricingTarget {
  id: string;
  propertyId: string;
  name: string;
  createdAt: string;
  updatedAt: string;
}

export interface TargetInventorySnapshot {
  id: string;
  pricingTargetId: string;
  stayDate: string;
  roomsAvailable: number | null;
  checkedAtJst: string;
  createdAt: string;
}

export interface PricingRecommendation {
  id: string;
  pricingTargetId: string;
  stayDate: string;
  recommendedPriceJpy: number;
  reason: string;
  createdAt: string;
}

export interface CollectorInput {
  runId: string;
  propertyId: string;
  propertyName: string;
  ota: OtaSource;
  stayDate: string;
  guests: number;
  adults?: number;
  children?: number;
  rooms?: number;
  nights: number;
  propertyUrl?: string | null;
  jobId?: string;
}

export interface CollectorResult {
  rateSnapshot: RateSnapshot;
  inventorySnapshot: InventorySnapshot;
}

export type CollectionJobAttemptOutcome = "success" | "failed" | "skipped" | "blocked";

export interface CollectionJobAttempt {
  id: string;
  jobId: string;
  runId: string;
  propertyId: string;
  ota: OtaSource;
  stayDate: string;
  guests: number;
  nights: number;
  attemptedAtJst: string;
  outcome: CollectionJobAttemptOutcome;
  availabilityStatus?: AvailabilityStatus | null;
  priceTotalTaxIncluded?: number | null;
  errorReason?: string | null;
  screenshotPath?: string | null;
  debugJsonPath?: string | null;
  retryCount: number;
  createdAt?: string;
}
