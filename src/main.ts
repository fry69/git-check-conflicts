#!/usr/bin/env -S deno run --allow-run --allow-read --allow-write --allow-env
/**
 * @module
 *
 * Git conflict detection CLI tool.
 *
 * This module provides a command-line interface for detecting merge conflicts
 * between Git branches without performing an actual merge. It uses Git's
 * read-tree and merge-tree commands to simulate merges and identify conflicts.
 *
 * @example
 * ```bash
 * # Check for conflicts with default branch
 * deno run -P main.ts
 *
 * # Check against specific branch with diffs
 * deno run -P main.ts --diff develop
 *
 * # Output JSON for CI/CD
 * deno run -P main.ts --json develop
 * ```
 */

import { parseArgs } from "@std/cli/parse-args";
import {
  checkConflictsWithMergeTree,
  checkConflictsWithReadTree,
  type ConflictCheckResult,
  detectDefaultBranch,
  fetchAll,
  getConflictingFilesFromMergeTree,
  getCurrentRef,
  getEmptyTreeHash,
  getFileConflictDetail,
  GitError,
  isGitRepository,
  resolveCommit,
  revToTree,
  runCmd,
  TempIndex,
} from "./lib.ts";

const VERSION = "0.0.1";
const SCRIPT_NAME = "git-check-conflicts";

/**
 * Displays usage information for the CLI tool.
 *
 * @param prog - Program name to display in usage message
 */
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

/**
 * Main entry point for the conflict detection CLI.
 *
 * This function orchestrates the entire conflict detection workflow:
 * 1. Validates Git repository
 * 2. Optionally fetches remote updates
 * 3. Detects or uses provided branch to compare against
 * 4. Resolves commits and finds merge base
 * 5. Checks for conflicts using read-tree (primary) or merge-tree (fallback)
 * 6. Outputs results in human-readable or JSON format
 *
 * @returns Promise resolving to exit code: 0 (no conflicts), 1 (conflicts), 2 (error)
 *
 * @example
 * ```ts
 * // Programmatic usage (if not using import.meta.main)
 * const exitCode = await main();
 * Deno.exit(exitCode);
 * ```
 */
async function main(): Promise<number> {
  // Parse arguments
  const parsed = parseArgs(Deno.args, {
    boolean: ["fetch", "diff", "json", "help", "version"],
    alias: { d: "diff", h: "help", v: "version" },
    stopEarly: true,
  });

  if (parsed.help) {
    usage();
    return 0;
  }

  if (parsed.version) {
    console.log(`${SCRIPT_NAME} version ${VERSION}`);
    return 0;
  }

  const doFetch = Boolean(parsed.fetch);
  const printDiffs = Boolean(parsed.diff);
  const asJSON = Boolean(parsed.json);
  const otherArg = parsed._[0] as string | undefined;

  // Ensure in git repo
  if (!(await isGitRepository())) {
    throw new GitError("Not a git repository (or git not available).", 2);
  }

  // Optional fetch
  if (doFetch) {
    console.log("Fetching remotes...");
    const fetchResult = await fetchAll();
    if (!fetchResult.success) {
      console.warn("git fetch --all failed:", fetchResult.error);
    } else {
      console.log("Fetch complete.");
    }
  }

  // Get current ref
  const currentRef = await getCurrentRef();

  // Detect or use provided other branch
  let otherRef = otherArg;
  if (!otherRef) {
    try {
      otherRef = await detectDefaultBranch(currentRef);
      console.log(`Detected other branch/ref: ${otherRef}`);
    } catch (_e) {
      throw new GitError(
        "Could not detect a default branch to compare against. Provide one manually as an argument.",
        2,
      );
    }
  }

  if (otherRef === currentRef) {
    throw new GitError(
      `Other branch ('${otherRef}') is the same as current ('${currentRef}'). Nothing to do.`,
      2,
    );
  }

  // Resolve commits
  const oursResult = await resolveCommit("HEAD");
  const oursCommit = oursResult.commit;

  let theirsResult;
  try {
    theirsResult = await resolveCommit(otherRef);
  } catch (_e) {
    throw new GitError(
      `Couldn't resolve other branch/ref '${otherRef}' to a commit. Ensure it exists locally or as a remote-tracking ref.`,
      2,
    );
  }
  const theirsCommit = theirsResult.commit;
  otherRef = theirsResult.resolvedRef; // Use resolved name

  // Compute merge-base
  const emptyTree = getEmptyTreeHash();
  const mbRes = await runCmd(["git", "merge-base", oursCommit, theirsCommit]);
  const mergeBase = mbRes.code === 0 && mbRes.stdout ? mbRes.stdout : "";

  // Resolve trees
  const baseTree = await revToTree(mergeBase, emptyTree);
  const oursTree = await revToTree(oursCommit, emptyTree);
  const theirsTree = await revToTree(theirsCommit, emptyTree);

  // Prepare result object
  const result: ConflictCheckResult = {
    current_ref: currentRef,
    other_ref: otherRef,
    ours_commit: oursCommit,
    theirs_commit: theirsCommit,
    merge_base: mergeBase || null,
    conflicts: false,
    conflicted_files: [],
    files: {},
  };

  // Check for conflicts using read-tree
  const tempIndex = new TempIndex();
  try {
    await tempIndex.create();
    const unmergedFiles = await checkConflictsWithReadTree(
      baseTree,
      oursTree,
      theirsTree,
      tempIndex,
    );

    if (unmergedFiles.length > 0) {
      result.conflicts = true;
      result.conflicted_files = unmergedFiles;

      if (printDiffs) {
        for (const f of unmergedFiles) {
          result.files[f] = await getFileConflictDetail(
            f,
            oursCommit,
            theirsCommit,
            mergeBase || undefined,
          );
        }
      }

      if (asJSON) {
        console.log(JSON.stringify(result, null, 2));
        return 1;
      }

      console.log("CONFLICTS EXPECTED when merging (detected via read-tree):");
      for (const f of unmergedFiles) console.log(f);

      if (printDiffs) {
        console.log(
          "\nUnified diffs (ours -> theirs) for each conflicting file:",
        );
        for (const f of unmergedFiles) {
          console.log("\n--- " + f + " ---");
          const fileDetail = result.files[f];
          if (fileDetail?.message) {
            console.log(
              `⚠️  ${
                fileDetail.conflict_type.toUpperCase().replace(/_/g, "/")
              } CONFLICT:`,
            );
            console.log(
              fileDetail.message.split("\n").map((line) => `   ${line}`).join(
                "\n",
              ),
            );
            console.log();
          }
          if (fileDetail?.diff) console.log(fileDetail.diff);
          else console.log("(no textual diff available or file is binary)");
        }
      }

      return 1;
    }
  } finally {
    await tempIndex.cleanup();
  }

  // Fallback: use merge-tree
  const hasConflicts = await checkConflictsWithMergeTree(
    mergeBase || emptyTree,
    oursCommit,
    theirsCommit,
    emptyTree,
  );

  if (hasConflicts) {
    const conflictingFiles = await getConflictingFilesFromMergeTree(
      mergeBase || emptyTree,
      oursCommit,
      theirsCommit,
      emptyTree,
    );
    result.conflicts = true;
    result.conflicted_files = conflictingFiles;

    if (printDiffs) {
      for (const f of conflictingFiles) {
        result.files[f] = await getFileConflictDetail(
          f,
          oursCommit,
          theirsCommit,
          mergeBase || undefined,
        );
      }
    }

    if (asJSON) {
      console.log(JSON.stringify(result, null, 2));
      return 1;
    }

    console.log("CONFLICTS EXPECTED (detected via merge-tree).");
    if (conflictingFiles.length > 0) {
      for (const f of conflictingFiles) console.log(f);
      if (printDiffs) {
        console.log("\nUnified diffs (ours -> theirs) for files that differ:");
        for (const f of conflictingFiles) {
          console.log("\n--- " + f + " ---");
          const fileDetail = result.files[f];
          if (fileDetail?.message) {
            console.log(
              `⚠️  ${
                fileDetail.conflict_type.toUpperCase().replace(/_/g, "/")
              } CONFLICT:`,
            );
            console.log(
              fileDetail.message.split("\n").map((line) => `   ${line}`).join(
                "\n",
              ),
            );
            console.log();
          }
          if (fileDetail?.diff) console.log(fileDetail.diff);
          else console.log("(no textual diff available or file is binary)");
        }
      }
    }

    return 1;
  }

  // Success: no conflicts
  if (asJSON) {
    console.log(JSON.stringify(result, null, 2));
    return 0;
  }

  console.log("No conflicts expected.");
  console.log(`  current branch: ${currentRef} (${oursCommit})`);
  console.log(`  other branch  : ${otherRef} (${theirsCommit})`);
  if (mergeBase) console.log(`  merge-base     : ${mergeBase}`);
  else console.log("  merge-base     : (no common ancestor)");

  return 0;
}

// Entry point
if (import.meta.main) {
  try {
    const exitCode = await main();
    Deno.exit(exitCode);
  } catch (error) {
    if (error instanceof GitError) {
      console.error(error.message);
      Deno.exit(error.code);
    }
    console.error("Unexpected error:", error);
    Deno.exit(2);
  }
}
