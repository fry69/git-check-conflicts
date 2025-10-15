// Reads deno.json and writes tool_name, tool_version and entry to GITHUB_OUTPUT
// Fails early if required fields are missing
const outPath = Deno.env.get("GITHUB_OUTPUT");
if (!outPath) {
  console.error("ERROR: GITHUB_OUTPUT environment variable not set");
  Deno.exit(1);
}

let raw;
try {
  raw = JSON.parse(await Deno.readTextFile("deno.json"));
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error("ERROR: Failed to read or parse deno.json:", message);
  Deno.exit(1);
}

// Extract and validate name
const rawName = raw.name ?? (raw.publish && raw.publish.name);
if (!rawName) {
  console.error("ERROR: 'name' field is required in deno.json");
  Deno.exit(1);
}
// sanitize name (strip scope @org/name -> name, and disallow strange chars)
const name = String(rawName).replace(/^@.*\//, "").replace(
  /[^a-zA-Z0-9._-]/g,
  "-",
);

// Extract and validate version
if (!raw.version) {
  console.error("ERROR: 'version' field is required in deno.json");
  Deno.exit(1);
}
const version = raw.version;

// Extract and validate entry point from exports
// Deno supports: "exports": "./src/mod.ts" or "exports": { ".": "./src/mod.ts" }
let entry;
if (!raw.exports) {
  console.error("ERROR: 'exports' field is required in deno.json");
  console.error('  Expected: "exports": "./src/main.ts" or "exports": { ".": "./src/main.ts" }');
  Deno.exit(1);
}

if (typeof raw.exports === "string") {
  entry = raw.exports;
} else if (typeof raw.exports === "object" && raw.exports["."] && typeof raw.exports["."] === "string") {
  entry = raw.exports["."];
} else {
  console.error("ERROR: Invalid 'exports' format in deno.json");
  console.error('  Expected: "exports": "./src/main.ts" or "exports": { ".": "./src/main.ts" }');
  Deno.exit(1);
}

// Verify entry point file exists
try {
  await Deno.stat(entry);
} catch {
  console.error(`ERROR: Entry point file '${entry}' does not exist`);
  Deno.exit(1);
}

// write to GITHUB_OUTPUT for step outputs
await Deno.writeTextFile(
  outPath,
  `tool_name=${name}\ntool_version=${version}\nentry=${entry}\n`,
);
