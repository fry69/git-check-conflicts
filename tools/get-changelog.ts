// usage: deno run -A tools/get-changelog.ts <version>
// writes to GITHUB_OUTPUT as `changelog<<EOF\n...\nEOF`
const outPath = Deno.env.get("GITHUB_OUTPUT");
if (!outPath) {
  console.error("ERROR: GITHUB_OUTPUT not set");
  Deno.exit(1);
}
const versionArg = Deno.args[0] ?? "";
if (!versionArg) {
  console.error("Usage: deno run -A tools/get-changelog.ts <version>");
  Deno.exit(1);
}
function escapeForRegex(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
const version = versionArg.replace(/^v/, ""); // normalize if user passed v1.2.3
let content: string;
try {
  const md = await Deno.readTextFile("CHANGELOG.md");
  const lines = md.split(/\r?\n/);
  const hdrRx = new RegExp(
    `^#{1,6}\\s*\\[?v?${escapeForRegex(version)}\\]?\\b`,
    "i",
  );
  // also allow headings like "## 1.2.3" or "## v1.2.3"
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (hdrRx.test(lines[i])) {
      start = i;
      break;
    }
  }
  if (start === -1) {
    // Fallback: try finding "## [Unreleased]" or "## Unreleased"
    const unreleasedRx = /^#{1,6}\s*\[?Unreleased\]?/i;
    start = lines.findIndex((l) => unreleasedRx.test(l));
  }
  if (start === -1) {
    content =
      `No changelog entry found for version ${version} and no 'Unreleased' section present.`;
  } else {
    // gather until next same-or-higher-level heading (## or #)
    let end = lines.length;
    for (let i = start + 1; i < lines.length; i++) {
      if (/^#{1,6}\s+\S/.test(lines[i])) {
        end = i;
        break;
      }
    }
    content = lines.slice(start, end).join("\n").trim();
  }
} catch (err) {
  content = `Failed to read CHANGELOG.md: ${
    err instanceof Error ? err.message : String(err)
  }`;
}
// Write multiline output for GITHUB_OUTPUT
// Use the "name<<EOF" format so Actions handles newlines.
await Deno.writeTextFile(outPath, `changelog<<EOF\n${content}\nEOF\n`);
