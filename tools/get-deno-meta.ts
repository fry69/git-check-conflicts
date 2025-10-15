// Reads deno.json and writes tool_name, tool_version and entry to GITHUB_OUTPUT
const outPath = Deno.env.get("GITHUB_OUTPUT");
if (!outPath) {
  console.error("GITHUB_OUTPUT not set");
  Deno.exit(1);
}
const raw = JSON.parse(await Deno.readTextFile("deno.json"));
const rawName = raw.name ?? (raw.publish && raw.publish.name) ?? "tool";
// sanitize name (strip scope @org/name -> name, and disallow strange chars)
const name = String(rawName).replace(/^@.*\//, "").replace(
  /[^a-zA-Z0-9._-]/g,
  "-",
);
const version = raw.version ?? "0.0.0";
// try exports["."] then main, fallback to src/main.ts
let entry = "src/main.ts";
if (raw.exports && raw.exports["."]) {
  const e = raw.exports["."];
  if (typeof e === "string") entry = e;
  else if (e.import) entry = e.import;
  else if (e.require) entry = e.require;
} else if (raw.main) {
  entry = raw.main;
}
// write to GITHUB_OUTPUT for step outputs
await Deno.writeTextFile(
  outPath,
  `tool_name=${name}\ntool_version=${version}\nentry=${entry}\n`,
);
