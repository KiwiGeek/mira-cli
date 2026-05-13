/**
 * ChatGPT cycles through short inline status strings while image-gen replaces skeleton canvas/UI.
 */

const PLACEHOLDER_HEAD_REGEX_SOURCES = [
  "^creating\\s+image\\b",
  "^generating\\b",
  "^sketching(\\s+it\\s+out)?\\b",
  "^drafting\\b",
  "^painting\\b",
  "^drawing\\b",
  "^working\\s+on\\s+it\\b",
  "^almost\\s+there\\b",
  "^hang\\s+tight\\b",
  "^one\\s+moment\\b",
  "^just\\s+a\\s+(moment|second)\\b",
  "^crafting\\b",
  "^composing\\b",
  "^imagining\\b",
  "^visualizing\\b",
  "^bringing\\s+it\\s+to\\s+life\\b",
  "^getting\\s+this\\s+ready\\b",
  "^almost\\s+done\\b",
  "^setting\\s+the\\s+scene\\b",
  "^adding\\s+final\\s+touches\\b",
  "^polishing\\s+details\\b",
  "^finishing\\s+up\\b",
] as const;

const PLACEHOLDER_BODY_REGEX_SOURCES = [
  "\\bcreating\\s+image\\b",
  "\\bsketching\\s+it\\s+out\\b",
  "\\bgenerating\\s+your\\s+image\\b",
  "\\bdrafting\\s+your\\s+image\\b",
  "\\bpainting\\s+your\\s+image\\b",
  "\\bsetting\\s+the\\s+scene\\b",
  "\\badding\\s+final\\s+touches\\b",
  "\\bpolishing\\s+details\\b",
  "\\bfinishing\\s+up\\b",
] as const;

const PLACEHOLDER_BODY_MAX_LEN = 280;

/** Image-edit tool sometimes flashes a lone “Edit” / “Editing…” line before the bitmap+caption land. */
function editPhaseBubble(raw: string): boolean {
  const t = raw.trim();
  if (!t) return false;

  const firstLine = t.split(/\n/)[0]?.trim() ?? "";
  const nl = t.indexOf("\n");
  const tail = nl === -1 ? "" : t.slice(nl + 1).trim();

  const chip =
    /^edit\s*$/i.test(firstLine) ||
    /^editing\b/i.test(firstLine) ||
    /^edit\s+image\b/i.test(firstLine) ||
    /^applying\s+edits?\b/i.test(firstLine);

  if (!chip) return false;

  /* Caption arrived below the chip — don’t stall the reply on persistent chrome text. */
  return tail.length < 48;
}

function matchesPlaceholderHead(firstLine: string): boolean {
  for (const src of PLACEHOLDER_HEAD_REGEX_SOURCES) {
    if (new RegExp(src, "i").test(firstLine)) return true;
  }
  return false;
}

function matchesPlaceholderBody(raw: string): boolean {
  if (raw.length > PLACEHOLDER_BODY_MAX_LEN) return false;
  for (const src of PLACEHOLDER_BODY_REGEX_SOURCES) {
    if (new RegExp(src, "i").test(raw)) return true;
  }
  return false;
}

/** Node-side gate for reply stability / finalize / capture teaser checks. */
export function assistantBubbleShowsImagePlaceholder(text: string): boolean {
  const raw = text.trim();
  if (!raw) return false;

  if (editPhaseBubble(raw)) return true;

  const firstLine = raw.split(/\n/)[0]?.trim() ?? "";
  if (matchesPlaceholderHead(firstLine)) return true;

  if (matchesPlaceholderBody(raw)) return true;

  return false;
}
