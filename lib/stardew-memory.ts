import { kvGet, kvSet, registerDynamicPrefix } from "./kv-db";

export type StardewProjectionEntry = {
  id: string;
  timestamp: string;
  content: string;
  role: "user" | "assistant";
};

const STARDEW_EVENT_PREFIX = "ai_phone_stardew_events_";
const MAX_EVENTS_PER_CHARACTER = 120;

registerDynamicPrefix(STARDEW_EVENT_PREFIX);

function storageKey(characterId: string): string {
  return `${STARDEW_EVENT_PREFIX}${characterId}`;
}

function loadEventsByKey(key: string): StardewProjectionEntry[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = kvGet(key);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((entry): entry is StardewProjectionEntry =>
        entry
        && typeof entry.id === "string"
        && typeof entry.timestamp === "string"
        && typeof entry.content === "string"
        && (entry.role === "user" || entry.role === "assistant")
      )
      .sort((a, b) => String(a.timestamp ?? "").localeCompare(String(b.timestamp ?? "")));
  } catch {
    return [];
  }
}

function saveEventsByKey(key: string, events: StardewProjectionEntry[]): void {
  if (typeof window === "undefined") return;
  const compacted = [...events]
    .sort((a, b) => String(a.timestamp ?? "").localeCompare(String(b.timestamp ?? "")))
    .slice(-MAX_EVENTS_PER_CHARACTER);
  kvSet(key, JSON.stringify(compacted));
}

function upsertEvent(characterId: string, entry: StardewProjectionEntry): void {
  const key = storageKey(characterId);
  const events = loadEventsByKey(key);
  const next = events.filter(item => item.id !== entry.id);
  next.push(entry);
  saveEventsByKey(key, next);
}

export function recordStardewMessage(
  characterId: string,
  input: { content: string; role: "user" | "assistant"; timestamp?: string },
): void {
  if (!characterId) return;
  const content = String(input.content ?? "").replace(/\r\n?/g, "\n").trim();
  if (!content) return;
  upsertEvent(characterId, {
    id: typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `sdv_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    timestamp: input.timestamp ?? new Date().toISOString(),
    content,
    role: input.role,
  });
}

export function loadStardewProjectionEntries(
  characterId: string,
  options?: { afterTimestamp?: string },
): StardewProjectionEntry[] {
  const events = loadEventsByKey(storageKey(characterId));
  if (!options?.afterTimestamp) return events;
  return events.filter(entry => entry.timestamp > options.afterTimestamp!);
}

export function clearStardewProjections(characterId: string): void {
  if (typeof window === "undefined") return;
  kvSet(storageKey(characterId), "[]");
}
