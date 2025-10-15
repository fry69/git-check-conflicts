/**
 * Release script
 *
 * Updates version in src/main.ts and deno.json, then runs tests.
 *
 * Usage:
 *   deno run -A tools/release.ts <version|major|minor|patch>
 *
 * Examples:
 *   deno run -A tools/release.ts 0.3.0
 *   deno run -A tools/release.ts patch
 *   deno run -A tools/release.ts minor
 *
 * @module
 */

import * as semver from "@std/semver";
import { bold, green, red, yellow } from "@std/fmt/colors";
import { join } from "@std/path";

const ROOT_DIR = join(import.meta.dirname!, "..");
const VERSION_FILE = join(ROOT_DIR, "src", "main.ts");
const DENO_JSON = join(ROOT_DIR, "deno.json");

function showHelp() {
  console.log(`
${
    bold("Usage:")
  } deno run -A tools/release.ts [--dry-run] <version|major|minor|patch>

${bold("Options:")}
  --dry-run                               Stop before pushing to GitHub

${bold("Examples:")}
  deno run -A tools/release.ts 0.3.0      # Set specific version
  deno run -A tools/release.ts patch      # Bump patch version (0.2.4 -> 0.2.5)
  deno run -A tools/release.ts minor      # Bump minor version (0.2.4 -> 0.3.0)
  deno run -A tools/release.ts major      # Bump major version (0.2.4 -> 1.0.0)
  deno run -A tools/release.ts --dry-run patch  # Test without pushing
`);
}

function exitError(msg: string): never {
  console.error(red(`Error: ${msg}`));
  showHelp();
  Deno.exit(1);
}

// Parse command line arguments
let dryRun = false;
let versionArg = "";

for (const arg of Deno.args) {
  if (arg === "--dry-run") {
    dryRun = true;
  } else if (!versionArg) {
    versionArg = arg;
  } else {
    exitError("Too many arguments.");
  }
}

if (!versionArg) {
  exitError("Missing version argument.");
}

// Read current version from deno.json
const denoJsonText = await Deno.readTextFile(DENO_JSON);
const denoJson = JSON.parse(denoJsonText);
const currentVersion = denoJson.version;

if (!currentVersion) {
  exitError("No version found in deno.json");
}

const current = semver.parse(currentVersion);
let next: semver.SemVer;

// Determine next version
if (versionArg === "major") {
  next = semver.parse(currentVersion);
  next.major++;
  next.minor = 0;
  next.patch = 0;
  next.prerelease = [];
} else if (versionArg === "minor") {
  next = semver.parse(currentVersion);
  next.minor++;
  next.patch = 0;
  next.prerelease = [];
} else if (versionArg === "patch") {
  next = semver.parse(currentVersion);
  next.patch++;
  next.prerelease = [];
} else {
  // Try to parse as explicit version
  try {
    next = semver.parse(versionArg);
  } catch {
    exitError(`Invalid version: ${versionArg}`);
  }
}

const nextVersion = semver.format(next);

// Show what will be updated
console.log();
console.log(
  `  ${bold("Version bump:")} ${green(semver.format(current))} -> ${
    yellow(nextVersion)
  }`,
);
console.log();

// Prompt for confirmation
const proceed = confirm("Proceed with version update?");
if (!proceed) {
  console.log("Cancelled.");
  Deno.exit(0);
}

console.log();

// Update src/main.ts
console.log(`${bold("Updating")} src/main.ts...`);
const versionFileContent = await Deno.readTextFile(VERSION_FILE);
const updatedVersionFile = versionFileContent.replace(
  /(?:export )?const VERSION = "[^"]+";/,
  (match) => match.replace(/"[^"]+"/, `"${nextVersion}"`),
);

if (versionFileContent === updatedVersionFile) {
  exitError("Failed to update VERSION constant in src/main.ts");
}

await Deno.writeTextFile(VERSION_FILE, updatedVersionFile);
console.log(green("✓") + " Updated src/main.ts");

// Update deno.json
console.log(`${bold("Updating")} deno.json...`);
const updatedDenoJson = denoJsonText.replace(
  /"version":\s*"[^"]+"/,
  `"version": "${nextVersion}"`,
);

if (denoJsonText === updatedDenoJson) {
  exitError("Failed to update version in deno.json");
}

await Deno.writeTextFile(DENO_JSON, updatedDenoJson);
console.log(green("✓") + " Updated deno.json");

// Run tests
console.log();
console.log(bold("Running tests..."));
console.log();

const testCommand = new Deno.Command("deno", {
  args: ["task", "check"],
  cwd: ROOT_DIR,
  stdout: "inherit",
  stderr: "inherit",
});

const testResult = await testCommand.output();

if (!testResult.success) {
  console.log();
  console.error(
    red("✗") + " Tests failed. Please fix issues before releasing.",
  );
  Deno.exit(1);
}

console.log();
console.log(green("✓") + " All tests passed!");
console.log();
console.log(bold("Creating release..."));
console.log();

// Git commit
console.log(
  `${
    bold("Committing changes...")
  } git commit -am "chore: release v${nextVersion}"`,
);
const commitCommand = new Deno.Command("git", {
  args: ["commit", "-am", `chore: release v${nextVersion}`],
  cwd: ROOT_DIR,
  stdout: "inherit",
  stderr: "inherit",
});

const commitResult = await commitCommand.output();
if (!commitResult.success) {
  console.log();
  console.error(red("✗") + " Git commit failed. Please check git status.");
  Deno.exit(1);
}
console.log(green("✓") + " Changes committed");

// Git tag
console.log();
console.log(
  `${
    bold("Creating tag...")
  } git tag -a v${nextVersion} -m "Release ${nextVersion}"`,
);
const tagCommand = new Deno.Command("git", {
  args: ["tag", "-a", `v${nextVersion}`, "-m", `Release ${nextVersion}`],
  cwd: ROOT_DIR,
  stdout: "inherit",
  stderr: "inherit",
});

const tagResult = await tagCommand.output();
if (!tagResult.success) {
  console.log();
  console.error(red("✗") + " Git tag creation failed.");
  Deno.exit(1);
}
console.log(green("✓") + " Tag created");

// Check if dry-run
if (dryRun) {
  console.log();
  console.log(yellow(bold("🏃 Dry-run mode - stopping before push")));
  console.log();
  console.log(bold("To revert these changes, run:"));
  console.log();
  console.log(yellow(`  git reset --hard HEAD~1`));
  console.log(yellow(`  git tag --delete v${nextVersion}`));
  console.log();
  console.log(bold("To complete the release, run:"));
  console.log();
  console.log(yellow(`  git push && git push --tags`));
  console.log();
  console.log(
    `  View on GitHub: ${
      yellow(`https://github.com/fry69/aqfile/releases/tag/v${nextVersion}`)
    }`,
  );
  console.log(
    `  View on JSR: ${yellow(`https://jsr.io/@fry69/aqfile@${nextVersion}`)}`,
  );
  console.log();
  Deno.exit(0);
}

// Git push
console.log();
console.log(`${bold("Pushing to GitHub...")} git push && git push --tags`);
const pushCommand = new Deno.Command("git", {
  args: ["push"],
  cwd: ROOT_DIR,
  stdout: "inherit",
  stderr: "inherit",
});

const pushResult = await pushCommand.output();
if (!pushResult.success) {
  console.log();
  console.error(red("✗") + " Git push failed.");
  Deno.exit(1);
}

const pushTagsCommand = new Deno.Command("git", {
  args: ["push", "--tags"],
  cwd: ROOT_DIR,
  stdout: "inherit",
  stderr: "inherit",
});

const pushTagsResult = await pushTagsCommand.output();
if (!pushTagsResult.success) {
  console.log();
  console.error(red("✗") + " Git push tags failed.");
  Deno.exit(1);
}

console.log(green("✓") + " Pushed to GitHub");
console.log();
console.log(green(bold("🎉 Release v" + nextVersion + " complete!")));
console.log();
console.log(
  `  View on GitHub: ${
    yellow(`https://github.com/fry69/aqfile/releases/tag/v${nextVersion}`)
  }`,
);
console.log(
  `  View on JSR: ${yellow(`https://jsr.io/@fry69/aqfile@${nextVersion}`)}`,
);
console.log();
