import { reverseMapLegacyCategory, buildSmartMetadata, stringifySmartMetadata } from "./smart-metadata.js";
import type { MemoryCategory } from "./memory-categories.js";

interface EntryLike {
  text: string;
  category: string;
  metadata?: string;
  importance?: number;
  timestamp?: number;
}

export interface MigrationResult {
  memory_category: MemoryCategory;
  changed: boolean;
  updatedMetadata?: string;
}

export function migrateCategoryForEntry(entry: EntryLike): MigrationResult {
  let parsed: Record<string, unknown>;
  try {
    parsed = entry.metadata ? JSON.parse(entry.metadata) : {};
  } catch {
    parsed = {};
  }

  if (parsed.memory_category && typeof parsed.memory_category === "string") {
    return { memory_category: parsed.memory_category, changed: false };
  }

  const derived = reverseMapLegacyCategory(entry.category as any, entry.text);
  const updated = buildSmartMetadata(entry as any, {
    ...parsed,
    memory_category: derived,
  });

  return {
    memory_category: derived,
    changed: true,
    updatedMetadata: stringifySmartMetadata(updated),
  };
}

export function batchMigrateCategories(
  entries: EntryLike[],
): Array<{ id: string; updatedMetadata: string }> {
  const updates: Array<{ id: string; updatedMetadata: string }> = [];
  for (const entry of entries) {
    const result = migrateCategoryForEntry(entry);
    if (result.changed && result.updatedMetadata) {
      updates.push({ id: (entry as any).id, updatedMetadata: result.updatedMetadata });
    }
  }
  return updates;
}
