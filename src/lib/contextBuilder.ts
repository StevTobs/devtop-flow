import { ChatMessage } from "./modelProvider";

// Context builder (build plan §5.3): decides what to send the model — the
// editor's current selection if there is one, else the whole open file,
// truncated to control token cost.
//
// The attachment is built as a real, visible `user`-role turn (not a hidden
// system message re-injected on every request) — it appears in the chat
// transcript exactly once, right where it was attached, so there's no doubt
// the agent actually received it, and it isn't silently resent forever.

export interface ActiveFileContext {
  relativePath: string;
  languageId: string;
  content: string;
  selection?: string;
}

const MAX_CONTEXT_CHARS = 6000;

/** Prefix used to recognize an attachment turn for styling in the chat transcript. */
export const ATTACHMENT_PREFIX = "📎 Attached";

export function buildFileContextMessage(ctx: ActiveFileContext): ChatMessage {
  const usingSelection = !!ctx.selection?.trim();
  let body = usingSelection ? ctx.selection! : ctx.content;
  let truncated = false;
  if (body.length > MAX_CONTEXT_CHARS) {
    body = body.slice(0, MAX_CONTEXT_CHARS);
    truncated = true;
  }

  const header = `${ATTACHMENT_PREFIX} \`${ctx.relativePath}\`${usingSelection ? " (selection)" : ""}`;
  const content = [header, "```" + ctx.languageId, truncated ? `${body}\n… (truncated)` : body, "```"].join("\n");

  return { role: "user", content };
}

/** The one-line summary to actually show in the chat transcript — the full fenced content still goes to the model, just not onto the screen. */
export function attachmentSummaryLine(content: string): string {
  return content.split("\n")[0];
}

/** Builds a visible, image-carrying attachment turn — e.g. a design mockup the model should actually look at, not just read a filename for. */
export function buildImageAttachmentMessage(relativePath: string, dataUrl: string): ChatMessage {
  const match = /^data:([^;]+);base64,(.*)$/s.exec(dataUrl);
  const mimeType = match?.[1] ?? "image/png";
  const dataBase64 = match?.[2] ?? "";
  return {
    role: "user",
    content: `${ATTACHMENT_PREFIX} image \`${relativePath}\` — follow this design when building the app.`,
    image: { mimeType, dataBase64 },
  };
}

/** Rough token estimate for a cost indicator (build plan §8). ~4 chars/token. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
