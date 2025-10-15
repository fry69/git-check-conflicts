# Integration Guide: Using the Refactored Library

This guide shows how to integrate the refactored `main_lib.ts` into your existing `main.ts` script.

## Option 1: Full Integration (Recommended)

Replace the current `main.ts` with a version that uses the library functions:

```typescript
#!/usr/bin/env -S deno run --allow-run --allow-read --allow-write --allow-env
/**
 * git-check-conflicts.ts - CLI entry point
 *
 * Main executable that uses the library functions from main_lib.ts
 */

import { parseArgs } from "@std/cli/parse-args";
import {
  checkConflictsWithMergeTree,
  checkConflictsWithReadTree,
  detectDefaultBranch,
  fetchAll,
  fileDiffFor,
  getChangedFilesBetween,
  getCurrentRef,
  getEmptyTreeHash,
  GitError,
  isGitRepository,
  resolveCommit,
  revToTree,
  TempIndex,
  type ConflictCheckResult,
} from "./main_lib.ts";

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

async function main(): Promise<number> {
  // Parse arguments
  const parsed = parseArgs(Deno.args, {
    boolean: ["fetch", "diff", "json", "help"],
    alias: { d: "diff", h: "help" },
    stopEarly: true,
  });

  if (parsed.help) {
    usage();
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
    } catch (e) {
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

  const theirsResult = await resolveCommit(otherRef).catch(() => {
    throw new GitError(
      `Couldn't resolve other branch/ref '${otherRef}' to a commit. Ensure it exists locally or as a remote-tracking ref.`,
      2,
    );
  });
  const theirsCommit = theirsResult.commit;
  otherRef = theirsResult.resolvedRef; // Use resolved name

  // Compute merge-base
  const emptyTree = await getEmptyTreeHash();
  const mergeBaseResult = await resolveCommit(`${oursCommit}...${theirsCommit}`).catch(() => ({
    commit: "",
    resolvedRef: "",
  }));
  const mergeBase = mergeBaseResult.commit;

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
    diffs: {},
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
          result.diffs[f] = await fileDiffFor(f, oursCommit, theirsCommit);
        }
      }

      if (asJSON) {
        console.log(JSON.stringify(result, null, 2));
        return 1;
      }

      console.log("CONFLICTS EXPECTED when merging (detected via read-tree):");
      for (const f of unmergedFiles) console.log(f);

      if (printDiffs) {
        console.log("\nUnified diffs (ours -> theirs) for each conflicting file:");
        for (const f of unmergedFiles) {
          console.log("\n--- " + f + " ---");
          const diff = result.diffs[f];
          if (diff) console.log(diff);
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
    const changedFiles = await getChangedFilesBetween(oursCommit, theirsCommit);
    result.conflicts = true;
    result.conflicted_files = changedFiles;

    if (printDiffs) {
      for (const f of changedFiles) {
        result.diffs[f] = await fileDiffFor(f, oursCommit, theirsCommit);
      }
    }

    if (asJSON) {
      console.log(JSON.stringify(result, null, 2));
      return 1;
    }

    console.log("CONFLICTS EXPECTED (detected via merge-tree).");
    if (changedFiles.length > 0) {
      for (const f of changedFiles) console.log(f);
      if (printDiffs) {
        console.log("\nUnified diffs (ours -> theirs) for files that differ:");
        for (const f of changedFiles) {
          console.log("\n--- " + f + " ---");
          const diff = result.diffs[f];
          if (diff) console.log(diff);
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

// Run main and handle errors
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
```

### Benefits of This Approach

1. **Testable**: Main logic is now in `main()` function that can be tested
2. **Clean separation**: CLI concerns vs business logic
3. **Reusable**: Library functions can be used by other tools
4. **Better error handling**: Consistent GitError usage
5. **Resource management**: TempIndex cleanup guaranteed

## Option 2: Gradual Migration

Keep the current `main.ts` but gradually replace functions:

```typescript
// Start by importing and using specific functions
import { runCmd, TempIndex, GitError } from "./main_lib.ts";

// Replace inline implementations one at a time
// Example: Replace the runCmd function with the library version
const result = await runCmd(["git", "status"]);
```

## Option 3: Keep Both

Keep both versions and use them for different purposes:

- `main.ts` - Original monolithic script (for quick edits)
- `main_lib.ts` + new entry point - Tested, maintainable version (for production)

## Testing the Integration

After integrating, run all tests:

```bash
# Test the library
deno task test:unit

# Test integration
deno task test:integration

# Test CLI
deno task test:cli

# Test everything
deno task test
```

## Migration Checklist

- [ ] Review `main_lib.ts` functions
- [ ] Decide on integration approach (Full/Gradual/Both)
- [ ] If full: Replace `main.ts` with new version
- [ ] Run all tests to verify functionality
- [ ] Update documentation/README
- [ ] Add JSDoc comments to public API
- [ ] Set up code coverage reporting
- [ ] Update CI/CD if applicable

## Rollback Plan

If issues arise, you can easily rollback:

```bash
# The original main.ts is unchanged
git checkout main.ts  # If you replaced it

# Or just don't import from main_lib.ts
# The original script is self-contained
```

## Questions?

Refer to:
- `CODE_REVIEW.md` - Detailed code analysis
- `tests/README.md` - How to run and write tests
- `TEST_RESULTS.md` - Current test status
- `SUMMARY.md` - Executive overview
