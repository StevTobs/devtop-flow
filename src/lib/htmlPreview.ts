import { parentDir, readAnyFileAsDataUrl, readFile } from "./fileSystem";

// Builds the "🖥 Preview" iframe's document for an open .html file.
//
// A real browser tab opened on a file:// URL can freely fetch sibling
// resources (style.css, script.js, images) via plain relative paths. This
// preview instead renders through an iframe's `srcDoc` (so it reflects the
// editor's live, possibly-unsaved buffer rather than only what's last saved
// to disk) — but a srcDoc document has no file:// origin of its own, and the
// packaged app's webview refuses to fetch local file:// sub-resources from
// it regardless of a <base href> pointing at the right folder. The old
// preview only injected that <base> tag, so any linked .css/.js/image
// silently failed to load.
//
// The fix: resolve every local <link rel="stylesheet">, <script src>, and
// <img src> reference against the file's own directory ourselves, read it
// off disk, and inline it directly (stylesheets as <style>, scripts as
// inline <script>, images as data: URLs) — CSS url(...) references inside an
// inlined stylesheet are resolved the same way, one level deep. External
// (http/https) references are left untouched; the browser fetches those over
// the network same as it always did. The <base> tag stays as a fallback for
// anything not rewritten (anchors, favicons, absolute paths, CDN links).

function isLocalRef(ref: string | undefined): ref is string {
  if (!ref) return false;
  return !/^([a-z][a-z0-9+.-]*:)?\/\//i.test(ref) && !/^(data|mailto|javascript|file):/i.test(ref);
}

/** Joins a directory and a (possibly `../`-laden) relative reference, Windows-drive-letter aware. Query/hash suffixes are stripped since we're resolving a file on disk, not a URL. */
function joinPath(dir: string, ref: string): string {
  const cleanDir = dir.replace(/\\/g, "/").replace(/\/+$/, "");
  const cleanRef = ref.replace(/\\/g, "/").split(/[?#]/)[0];
  const driveMatch = cleanDir.match(/^([a-zA-Z]:)\/?(.*)$/);
  const drive = driveMatch?.[1] ?? "";
  const dirRest = driveMatch ? driveMatch[2] : cleanDir.replace(/^\/+/, "");
  const combinedRest = cleanRef.startsWith("/") ? cleanRef.replace(/^\/+/, "") : `${dirRest}/${cleanRef}`;

  const resolved: string[] = [];
  for (const part of combinedRest.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") resolved.pop();
    else resolved.push(part);
  }
  const joined = resolved.join("/");
  return drive ? `${drive}/${joined}` : `/${joined}`;
}

/** `src="x.js" type="module"` → { src: "x.js", type: "module" }. Supports both quote styles since real-world HTML mixes them. */
function parseTagAttrs(tag: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  for (const m of tag.matchAll(/([a-zA-Z][\w-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
    attrs[m[1].toLowerCase()] = m[2] ?? m[3] ?? "";
  }
  return attrs;
}

/** Rewrites local `url(...)` references inside CSS text (background images, @font-face, …) to data: URLs, resolved relative to the stylesheet's own directory. */
async function inlineCssUrls(css: string, cssDir: string): Promise<string> {
  let out = css;
  for (const m of css.matchAll(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g)) {
    const ref = m[2];
    if (!isLocalRef(ref)) continue;
    try {
      const dataUrl = await readAnyFileAsDataUrl(joinPath(cssDir, ref));
      out = out.replace(m[0], `url("${dataUrl}")`);
    } catch {
      // Leave the original reference in place — better a broken background
      // image than a preview that silently refuses to render at all.
    }
  }
  return out;
}

export async function buildHtmlPreviewDoc(html: string, filePath: string): Promise<string> {
  const dir = parentDir(filePath);
  let out = html;

  for (const m of [...out.matchAll(/<link\b[^>]*>/gi)]) {
    const tag = m[0];
    const attrs = parseTagAttrs(tag);
    if (attrs.rel?.toLowerCase() !== "stylesheet" || !isLocalRef(attrs.href)) continue;
    try {
      const cssPath = joinPath(dir, attrs.href);
      const cssText = await inlineCssUrls(await readFile(cssPath), parentDir(cssPath));
      out = out.replace(tag, `<style data-devtopflow-src="${attrs.href}">\n${cssText}\n</style>`);
    } catch {
      // Leave the <link> in place — the <base> fallback below may still resolve it.
    }
  }

  for (const m of [...out.matchAll(/<script\b[^>]*>[\s\S]*?<\/script>/gi)]) {
    const tag = m[0];
    const openTag = /^<script\b[^>]*>/i.exec(tag)?.[0] ?? "";
    const attrs = parseTagAttrs(openTag);
    if (!isLocalRef(attrs.src)) continue;
    try {
      const jsText = await readFile(joinPath(dir, attrs.src));
      const typeAttr = attrs.type ? ` type="${attrs.type}"` : "";
      out = out.replace(tag, `<script${typeAttr} data-devtopflow-src="${attrs.src}">\n${jsText}\n</script>`);
    } catch {
      // Leave the <script src> in place.
    }
  }

  for (const m of [...out.matchAll(/<img\b[^>]*>/gi)]) {
    const tag = m[0];
    const attrs = parseTagAttrs(tag);
    if (!isLocalRef(attrs.src)) continue;
    try {
      const dataUrl = await readAnyFileAsDataUrl(joinPath(dir, attrs.src));
      out = out.replace(tag, tag.replace(/\ssrc\s*=\s*(?:"[^"]*"|'[^']*')/i, ` src="${dataUrl}"`));
    } catch {
      // Leave the <img src> in place.
    }
  }

  // <base> fallback for anything not rewritten above (external links, in-page
  // anchors, favicons, absolute paths).
  const dirSlashes = dir.replace(/\\/g, "/");
  const fileUrl = /^[a-zA-Z]:\//.test(dirSlashes) ? `file:///${dirSlashes}` : `file://${dirSlashes}`;
  const baseTag = `<base href="${encodeURI(fileUrl)}/">`;
  out = /<head[^>]*>/i.test(out) ? out.replace(/<head[^>]*>/i, (m) => `${m}\n${baseTag}`) : `${baseTag}\n${out}`;

  return out;
}
