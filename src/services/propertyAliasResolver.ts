export interface PropertyAlias {
  canonical_property_name: string;
  aliases: string[];
  status: "confirmed" | "needs_review" | "rejected";
  notes?: string | undefined;
}

export interface DuplicateCandidate {
  names: string[];
  status: "alias_resolved" | "unresolved";
}

export interface PropertyAliasResolution {
  inputName: string;
  canonicalName: string;
  status: "resolved" | "unchanged" | "ambiguous";
  matchedAliases: PropertyAlias[];
}

export function normalizePropertyName(name: string): string {
  return name
    .normalize("NFKC")
    .trim()
    .replace(/[－−–—ー]/gu, "")
    .replace(/[・･.,，、。'’"“”\s　]/gu, "")
    .replace(/[（）()[\]【】]/gu, "")
    .toLowerCase();
}

export function resolveCanonicalPropertyName(name: string, aliases: PropertyAlias[]): string {
  const resolution = resolveCanonicalPropertyNameDetailed(name, aliases);
  return resolution.status === "ambiguous" ? name : resolution.canonicalName;
}

export function resolveCanonicalPropertyNameDetailed(name: string, aliases: PropertyAlias[]): PropertyAliasResolution {
  const normalizedName = normalizePropertyName(name);
  const matches = aliases.filter((record) => {
    if (record.status === "rejected") {
      return false;
    }
    return [
      record.canonical_property_name,
      ...record.aliases
    ].some((candidate) => normalizePropertyName(candidate) === normalizedName);
  });

  const canonicalNames = [...new Set(matches.map((match) => match.canonical_property_name))];
  if (canonicalNames.length > 1 || matches.some((match) => match.status === "needs_review")) {
    return {
      inputName: name,
      canonicalName: name,
      status: "ambiguous",
      matchedAliases: matches
    };
  }
  if (canonicalNames.length === 1 && canonicalNames[0] !== name) {
    return {
      inputName: name,
      canonicalName: canonicalNames[0]!,
      status: "resolved",
      matchedAliases: matches
    };
  }
  return {
    inputName: name,
    canonicalName: name,
    status: "unchanged",
    matchedAliases: matches
  };
}

export function findPossibleDuplicateProperties(properties: string[], aliases: PropertyAlias[]): DuplicateCandidate[] {
  const uniqueNames = [...new Set(properties)];
  const groups: DuplicateCandidate[] = [];

  for (const name of uniqueNames) {
    const normalizedName = normalizePropertyName(name);
    const names = uniqueNames.filter((candidate) => isPossibleSameProperty(normalizedName, normalizePropertyName(candidate)));

    if (names.length <= 1 || groups.some((group) => names.some((candidate) => group.names.includes(candidate)))) {
      continue;
    }

    groups.push({
      names,
      status: isCoveredByConfirmedAlias(names, aliases) ? "alias_resolved" : "unresolved"
    });
  }

  return groups;
}

function isPossibleSameProperty(left: string, right: string): boolean {
  if (left === right) {
    return true;
  }
  return Math.min(left.length, right.length) >= 6 && (left.includes(right) || right.includes(left));
}

function isCoveredByConfirmedAlias(names: string[], aliases: PropertyAlias[]): boolean {
  return aliases.some((record) => {
    if (record.status !== "confirmed") {
      return false;
    }
    const covered = new Set([
      normalizePropertyName(record.canonical_property_name),
      ...record.aliases.map((alias) => normalizePropertyName(alias))
    ]);
    return names.every((name) => covered.has(normalizePropertyName(name)));
  });
}
