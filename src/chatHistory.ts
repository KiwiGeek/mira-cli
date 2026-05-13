import fs from "node:fs";
import path from "node:path";
import { chatHistoryPath } from "./paths.js";
import { parseChatConversationUrl } from "./selectors.js";

export type ChatHistoryRecord = {
  /** Lowercase ChatGPT `/c/<id>` segment for prefix matching */
  conversationId: string;
  /** Canonical thread URL */
  url: string;
  title: string | null;
  /** ISO 8601 timestamp when this row was last archived into history */
  recordedAt: string;
};

type HistoryFileV1 = {
  version: 1;
  conversations: ChatHistoryRecord[];
};

function emptyFile(): HistoryFileV1 {
  return { version: 1, conversations: [] };
}

export function conversationIdFromChatUrl(pageUrl: string): string | null {
  const canonical = parseChatConversationUrl(pageUrl);
  if (!canonical) return null;
  try {
    const u = new URL(canonical);
    const m = u.pathname.match(/^\/c\/([^/?#]+)/);
    return m ? m[1].toLowerCase() : null;
  } catch {
    return null;
  }
}

function historyDir(): string {
  return path.dirname(chatHistoryPath());
}

export function loadChatHistory(): ChatHistoryRecord[] {
  const p = chatHistoryPath();
  try {
    const raw = fs.readFileSync(p, "utf8");
    const parsed = JSON.parse(raw) as Partial<HistoryFileV1>;
    if (
      parsed &&
      parsed.version === 1 &&
      Array.isArray(parsed.conversations)
    ) {
      return parsed.conversations.filter(
        (r): r is ChatHistoryRecord =>
          typeof r === "object" &&
          r !== null &&
          typeof (r as ChatHistoryRecord).conversationId === "string" &&
          typeof (r as ChatHistoryRecord).url === "string" &&
          ("title" in r ? r.title === null || typeof r.title === "string" : true) &&
          typeof (r as ChatHistoryRecord).recordedAt === "string",
      );
    }
  } catch (e) {
    const code = (e as NodeJS.ErrnoException)?.code;
    if (code !== "ENOENT") {
      console.warn("[mira] Could not read chat history file:", (e as Error).message);
    }
  }
  return [];
}

function writeHistoryAtomic(data: HistoryFileV1): void {
  fs.mkdirSync(historyDir(), { recursive: true });
  const p = chatHistoryPath();
  const tmp = `${p}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), "utf8");
  fs.renameSync(tmp, p);
}

export function upsertArchivedConversation(input: {
  url: string;
  title: string | null;
  recordedAt?: Date;
}): void {
  const canonical = parseChatConversationUrl(input.url);
  const convId = canonical ? conversationIdFromChatUrl(canonical) : null;
  if (!canonical || !convId) return;

  const recordedAt = (input.recordedAt ?? new Date()).toISOString();
  const file = emptyFile();
  file.conversations = loadChatHistory();

  const idx = file.conversations.findIndex((r) => r.conversationId === convId);
  const trimmedTitle = input.title?.trim() ?? "";
  const row: ChatHistoryRecord = {
    conversationId: convId,
    url: canonical,
    title: trimmedTitle ? trimmedTitle : idx >= 0 ? file.conversations[idx]!.title : null,
    recordedAt,
  };

  if (idx >= 0) {
    file.conversations[idx] = row;
  } else {
    file.conversations.push(row);
  }

  file.conversations.sort(
    (a, b) => new Date(b.recordedAt).getTime() - new Date(a.recordedAt).getTime(),
  );

  writeHistoryAtomic(file);
}

/** Visible id prefix for tables (Docker-like short hex). */
export function formatShortConversationId(conversationId: string, len = 12): string {
  const flat = conversationId.replace(/-/g, "");
  return flat.slice(0, Math.min(len, flat.length));
}

export type ResolvePrefixResult =
  | { kind: "none" }
  | { kind: "ambiguous"; matches: ChatHistoryRecord[] }
  | { kind: "unique"; record: ChatHistoryRecord };

export function resolveConversationPrefix(rawPrefix: string): ResolvePrefixResult {
  const prefix = rawPrefix.trim().toLowerCase().replace(/-/g, "");
  if (!prefix) return { kind: "none" };

  const all = loadChatHistory();
  const matches = all.filter((r) => {
    const flat = r.conversationId.replace(/-/g, "");
    return flat.startsWith(prefix);
  });

  if (matches.length === 0) return { kind: "none" };
  if (matches.length === 1) return { kind: "unique", record: matches[0]! };
  return { kind: "ambiguous", matches };
}

export function listConversationsSorted(): ChatHistoryRecord[] {
  const xs = loadChatHistory();
  return [...xs].sort(
    (a, b) => new Date(b.recordedAt).getTime() - new Date(a.recordedAt).getTime(),
  );
}
