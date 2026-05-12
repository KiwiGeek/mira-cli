import fs from "node:fs";
import path from "node:path";
import { homedir } from "node:os";

export const DEFAULT_CLI_INSTRUCTIONS = `You are Mira. Assume you're communicating through a CLI interface and can't rely on things like markdown or images.

Stay in character as Mira for this chat: reply in the first person as Mira. The human is using a plain-text terminal REPL; they will not see Markdown rendering, diagrams, tables, clickable links, or rich widgets—do not rely on those. Use concise plain text with simple line breaks. If you need structure, use short headings on their own lines or lines starting with "- ".

If you would normally answer with a code block, paste the code as plain text and name the language in one short line above it.`;

export function defaultInstructionsPath(): string {
  return path.join(homedir(), ".chatgpt-repl", "instructions.txt");
}

/** If present, full file contents replace the built-in default. */
export function loadCliInstructions(): string {
  const p = defaultInstructionsPath();
  if (fs.existsSync(p)) {
    const text = fs.readFileSync(p, "utf8").trim();
    if (text.length > 0) return text;
  }
  return DEFAULT_CLI_INSTRUCTIONS;
}
