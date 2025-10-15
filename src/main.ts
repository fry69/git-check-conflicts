#!/usr/bin/env -S deno run --allow-run --allow-read --allow-write --allow-env
/**
 * git-check-conflicts.ts
 *
 * Deno 2.x version:
 * - uses Deno.Command instead of Deno.run
 * - uses @std/cli parseArgs for argument parsing
 * - creates a temporary index via Deno.makeTempFile()
 * - supports --fetch, --diff/-d, --json
 *
 * See: migration notes on Deno.run -> Deno.Command and @std/cli docs.
 */

import { parseArgs } from "@std/cli/parse-args";

type CmdResult = { code: number; stdout: string; stderr: string };

async function runCmd(
  cmd: string[],
  env?: Record<string, string>,
): Promise<CmdResult> {
  const [program, ...args] = cmd;
  const command = new Deno.Command(program, {
    args,
    env,
    stdout: "piped",
    stderr: "piped",
  });
  const { code, stdout, stderr } = await command.output();
  const out = new TextDecoder().decode(stdout).trim();
  const err = new TextDecoder().decode(stderr).trim();
  return { code, stdout: out, stderr: err };
}

function fatal(msg: string, code = 2): never {
  console.error(msg);
  Deno.exit(code);
}

function info(...parts: Array<string>) {
  console.log(parts.join(""));
}

function usage(prog = "git-check-conflicts.ts") {
  console.log(
    `Usage: deno run --allow-run --allow-read --allow-write --allow-env ${prog} [--fetch] [--diff|-d] [--json] [other-branch-or-ref]

If other-branch-or-ref is omitted, the script will try to detect the repository's default branch:
  1) remote HEAD (e.g. origin/HEAD -> origin/main)
  2) local 'main'
  3) local 'master'
  4) most-recent local branch (excluding current)

Options:
  --fetch      run 'git fetch --all' before checking
  --diff, -d   print unified diffs (ours -> theirs) for conflicting files
  --json       print machine-readable JSON output (for CI)
  -h, --help   show this help

Exit codes:
  0 -> no conflicts expected
  1 -> conflicts expected
  2 -> error
`,
  );
}

// parse args
const parsed = parseArgs(Deno.args, {
  boolean: ["fetch", "diff", "json", "help"],
  alias: { d: "diff" },
  stopEarly: true,
});
if (parsed.help) {
  usage();
  Deno.exit(0);
}
const doFetch = Boolean(parsed.fetch);
const printDiffs = Boolean(parsed.diff);
const asJSON = Boolean(parsed.json);
const otherArg = parsed._[0] as string | undefined;

// ensure in git repo
{
  const r = await runCmd(["git", "rev-parse", "--git-dir"]);
  if (r.code !== 0) fatal("Not a git repository (or git not available).", 2);
}

// optionally fetch
if (doFetch) {
  info("Fetching remotes...");
  const r = await runCmd(["git", "fetch", "--all"]);
  if (r.code !== 0) {
    console.warn("git fetch --all failed:", r.stderr || r.stdout);
    // continue — user explicitly asked fetch, but failure may be tolerable
  } else {
    info("Fetch complete.");
  }
}

// current ref (branch or short commit)
async function getCurrentRef(): Promise<string> {
  let r = await runCmd(["git", "symbolic-ref", "--quiet", "--short", "HEAD"]);
  if (r.code === 0 && r.stdout) return r.stdout;
  r = await runCmd(["git", "rev-parse", "--short", "HEAD"]);
  if (r.code === 0 && r.stdout) return r.stdout;
  fatal("Couldn't determine current branch/HEAD.", 2);
}
const currentRef = await getCurrentRef();

// detect default branch if none provided
async function detectDefaultBranch(): Promise<string> {
  const remotesRes = await runCmd(["git", "remote"]);
  if (remotesRes.code === 0 && remotesRes.stdout) {
    const remotes = remotesRes.stdout.split(/\r?\n/).filter(Boolean);
    for (const r of remotes) {
      const sym = await runCmd([
        "git",
        "symbolic-ref",
        "--quiet",
        `refs/remotes/${r}/HEAD`,
      ]);
      if (sym.code === 0 && sym.stdout) {
        const localBranch = sym.stdout.replace(`refs/remotes/${r}/`, "");
        const localExists = await runCmd([
          "git",
          "show-ref",
          "--verify",
          `refs/heads/${localBranch}`,
        ]);
        if (localExists.code === 0) return localBranch;
        return `${r}/${localBranch}`; // remote-tracking ref
      }
    }
  }
  // fallback to local main/master
  if (
    (await runCmd(["git", "show-ref", "--verify", "refs/heads/main"])).code ===
      0
  ) return "main";
  if (
    (await runCmd(["git", "show-ref", "--verify", "refs/heads/master"]))
      .code === 0
  ) return "master";
  // most recent local branch excluding current
  const recent = await runCmd([
    "git",
    "for-each-ref",
    "--sort=-committerdate",
    "--format=%(refname:short)",
    "refs/heads",
  ]);
  if (recent.code === 0 && recent.stdout) {
    const candidates = recent.stdout.split(/\r?\n/).filter(Boolean).filter(
      (n) => n !== currentRef,
    );
    if (candidates.length > 0) return candidates[0];
  }
  throw new Error("Could not detect default branch");
}

let otherRef = otherArg;
if (!otherRef) {
  try {
    otherRef = await detectDefaultBranch();
    info(`Detected other branch/ref: ${otherRef}`);
  } catch (_e) {
    fatal(
      "Could not detect a default branch to compare against. Provide one manually as an argument.",
      2,
    );
  }
}
if (otherRef === currentRef) {
  fatal(
    `Other branch ('${otherRef}') is the same as current ('${currentRef}'). Nothing to do.`,
    2,
  );
}

// resolve commits
async function resolveCommit(ref: string): Promise<string> {
  const r = await runCmd(["git", "rev-parse", "--verify", `${ref}^{commit}`]);
  if (r.code === 0 && r.stdout) return r.stdout;
  // try remotes as candidate/ref
  const remotes = (await runCmd(["git", "remote"])).stdout.split(/\r?\n/)
    .filter(Boolean);
  for (const remote of remotes) {
    const cand = `${remote}/${ref}`;
    const s = await runCmd([
      "git",
      "rev-parse",
      "--verify",
      `${cand}^{commit}`,
    ]);
    if (s.code === 0 && s.stdout) {
      otherRef = cand; // update visible name
      return s.stdout;
    }
  }
  throw new Error(`Couldn't resolve '${ref}' to a commit`);
}

let oursCommit: string;
{
  const r = await runCmd(["git", "rev-parse", "--verify", "HEAD^{commit}"]);
  if (r.code !== 0 || !r.stdout) fatal("Can't resolve current HEAD commit.", 2);
  oursCommit = r.stdout;
}

let theirsCommit: string;
try {
  theirsCommit = await resolveCommit(otherRef!);
} catch (_e) {
  fatal(
    `Couldn't resolve other branch/ref '${otherRef}' to a commit. Ensure it exists locally or as a remote-tracking ref.`,
    2,
  );
}

// compute merge-base
const mbRes = await runCmd(["git", "merge-base", oursCommit, theirsCommit]);
const mergeBase = mbRes.code === 0 && mbRes.stdout ? mbRes.stdout : "";
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

// resolve trees
async function revToTree(rev: string | ""): Promise<string> {
  if (!rev) return EMPTY_TREE;
  const r = await runCmd(["git", "rev-parse", `${rev}^{tree}`]);
  if (r.code === 0 && r.stdout) return r.stdout;
  return EMPTY_TREE;
}
const baseTree = mergeBase ? await revToTree(mergeBase) : EMPTY_TREE;
const oursTree = await revToTree(oursCommit);
const theirsTree = await revToTree(theirsCommit);

// create temporary index file (atomic unique name)
let tmpIndex = "";
try {
  tmpIndex = await Deno.makeTempFile();
} catch (e) {
  fatal(`Failed to create temporary index file: ${e}`, 2);
}

// helper to run git with GIT_INDEX_FILE set to tmpIndex
async function gitWithIndex(args: string[]): Promise<CmdResult> {
  const baseEnv = Deno.env.toObject();
  const env = Object.fromEntries(
    Object.entries({ ...baseEnv, GIT_INDEX_FILE: tmpIndex })
      .filter(([_, v]) => v !== undefined),
  ) as Record<string, string>;
  return await runCmd(["git", ...args], env);
}

const _readTreeResult = await gitWithIndex([
  "read-tree",
  "-m",
  "--",
  baseTree,
  oursTree,
  theirsTree,
]).catch(() => ({ code: 1, stdout: "", stderr: "" }));
// collect unmerged entries
const lsRes = await gitWithIndex(["ls-files", "-u", "--stage"]);
const unmergedFiles: string[] = lsRes.stdout
  ? Array.from(
    new Set(
      lsRes.stdout.split(/\r?\n/).filter(Boolean).map((line) => {
        const parts = line.split(/\s+/);
        return parts.slice(-1)[0];
      }),
    ),
  )
  : [];

// prepare a JSON-friendly result object (for --json)
const result: Record<string, unknown> = {
  current_ref: currentRef,
  other_ref: otherRef,
  ours_commit: oursCommit,
  theirs_commit: theirsCommit,
  merge_base: mergeBase || null,
  conflicts: false,
  conflicted_files: [] as string[],
  diffs: {} as Record<string, string | null>,
};

// utility to produce unified diff for a file (ours -> theirs)
async function fileDiffFor(f: string): Promise<string | null> {
  // prefer git diff OURS THEIRS -- file
  const d = await runCmd([
    "git",
    "diff",
    "-U3",
    "--no-prefix",
    oursCommit,
    theirsCommit,
    "--",
    f,
  ]);
  if (d.stdout && d.stdout.trim()) return d.stdout;
  if (d.stderr && d.stderr.trim()) return d.stderr;
  return null;
}

// if read-tree found unmerged entries -> conflicts
if (unmergedFiles.length > 0) {
  result.conflicts = true;
  (result.conflicted_files as string[]) = unmergedFiles;
  if (printDiffs) {
    for (const f of unmergedFiles) {
      (result.diffs as Record<string, string | null>)[f] = await fileDiffFor(f);
    }
  }
  // cleanup
  try {
    await Deno.remove(tmpIndex);
  } catch { /* ignored */ }
  if (asJSON) {
    console.log(JSON.stringify(result, null, 2));
    Deno.exit(1);
  }
  console.log("CONFLICTS EXPECTED when merging (detected via read-tree):");
  for (const f of unmergedFiles) console.log(f);
  if (printDiffs) {
    console.log("\nUnified diffs (ours -> theirs) for each conflicting file:");
    for (const f of unmergedFiles) {
      console.log("\n--- " + f + " ---");
      const diff = (result.diffs as Record<string, string | null>)[f];
      if (diff) console.log(diff);
      else console.log("(no textual diff available or file is binary)");
    }
  }
  Deno.exit(1);
}

// fallback: use git merge-tree and search markers
const mergeTreeRes = await runCmd([
  "git",
  "merge-tree",
  mergeBase || EMPTY_TREE,
  oursCommit,
  theirsCommit,
]);
if (/^<<<<<<< /m.test(mergeTreeRes.stdout)) {
  // approximate list of changed files between ours and theirs
  const changedRes = await runCmd([
    "git",
    "diff",
    "--name-only",
    oursCommit,
    theirsCommit,
  ]);
  const changedFiles = changedRes.code === 0 && changedRes.stdout
    ? changedRes.stdout.split(/\r?\n/).filter(Boolean)
    : [];
  result.conflicts = true;
  (result.conflicted_files as string[]) = changedFiles;
  if (printDiffs) {
    for (const f of changedFiles) {
      (result.diffs as Record<string, string | null>)[f] = await fileDiffFor(f);
    }
  }
  try {
    await Deno.remove(tmpIndex);
  } catch { /* ignored */ }
  if (asJSON) {
    console.log(JSON.stringify(result, null, 2));
    Deno.exit(1);
  }
  console.log("CONFLICTS EXPECTED (detected via merge-tree).");
  if (changedFiles.length > 0) {
    for (const f of changedFiles) console.log(f);
    if (printDiffs) {
      console.log("\nUnified diffs (ours -> theirs) for files that differ:");
      for (const f of changedFiles) {
        console.log("\n--- " + f + " ---");
        const diff = (result.diffs as Record<string, string | null>)[f];
        if (diff) console.log(diff);
        else console.log("(no textual diff available or file is binary)");
      }
    }
  } else {
    console.log(mergeTreeRes.stdout);
  }
  Deno.exit(1);
}

// success: no conflicts
result.conflicts = false;
try {
  await Deno.remove(tmpIndex);
} catch { /* ignored */ }
if (asJSON) {
  console.log(JSON.stringify(result, null, 2));
  Deno.exit(0);
}
console.log("No conflicts expected.");
console.log(`  current branch: ${currentRef} (${oursCommit})`);
console.log(`  other branch  : ${otherRef} (${theirsCommit})`);
if (mergeBase) console.log(`  merge-base     : ${mergeBase}`);
else console.log("  merge-base     : (no common ancestor)");
Deno.exit(0);
