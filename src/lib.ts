/**
 * Core library for detecting Git merge conflicts.
 *
 * This module provides functions to check for merge conflicts between Git branches
 * using two strategies: `read-tree` (fast, reliable) and `merge-tree` (fallback for
 * complex scenarios). It can detect content conflicts, rename/modify conflicts,
 * and delete/modify conflicts.
 *
 * @example
 * ```ts
 * import { isGitRepository, getCurrentRef, resolveCommit, checkConflictsWithReadTree } from "./lib.ts";
 *
 * if (await isGitRepository()) {
 *   const current = await getCurrentRef();
 *   const target = await resolveCommit("main");
 *   // ... check for conflicts
 * }
 * ```
 *
 * @module
 */

/** Maximum number of lines to search ahead for file metadata in merge-tree output */
const MERGE_TREE_METADATA_SEARCH_WINDOW = 4;

/** Maximum number of lines to search ahead for conflict markers in merge-tree output */
const MERGE_TREE_CONFLICT_MARKER_SEARCH_WINDOW = 20;

/**
 * Result of executing a shell command.
 */
export type CmdResult = {
  /** Exit code (0 = success) */
  code: number;
  /** Standard output (trimmed) */
  stdout: string;
  /** Standard error (trimmed) */
  stderr: string;
};

/**
 * Executes a shell command and returns the result.
 *
 * @param cmd - Array where first element is the program and rest are arguments
 * @param env - Optional environment variables to merge with current environment
 * @returns Promise resolving to command result with exit code and output
 *
 * @example
 * ```ts
 * const result = await runCmd(["git", "status"]);
 * if (result.code === 0) {
 *   console.log(result.stdout);
 * }
 * ```
 */
export async function runCmd(
  cmd: string[],
  env?: Record<string, string>,
): Promise<CmdResult> {
  const [program, ...args] = cmd;
  const command = new Deno.Command(program, {
    args,
    env: env ? { ...Deno.env.toObject(), ...env } : undefined,
    stdout: "piped",
    stderr: "piped",
  });
  const { code, stdout, stderr } = await command.output();
  const out = new TextDecoder().decode(stdout).trim();
  const err = new TextDecoder().decode(stderr).trim();
  return { code, stdout: out, stderr: err };
}

/**
 * Custom error class for Git-related errors.
 *
 * @example
 * ```ts
 * throw new GitError("Branch not found", 1);
 * ```
 */
export class GitError extends Error {
  /**
   * Creates a new GitError.
   *
   * @param message - Human-readable error message
   * @param code - Exit code to return (default: 2)
   */
  constructor(message: string, public code: number = 2) {
    super(message);
    this.name = "GitError";
  }
}

/**
 * Gets the current Git ref (branch name or short commit SHA).
 *
 * Attempts to get the symbolic ref (branch name) first, falls back to
 * short commit SHA if HEAD is detached.
 *
 * @returns Promise resolving to current ref name or short SHA
 * @throws {GitError} If unable to determine current ref
 *
 * @example
 * ```ts
 * const ref = await getCurrentRef();
 * console.log(`Currently on: ${ref}`); // "main" or "abc1234"
 * ```
 */
export async function getCurrentRef(): Promise<string> {
  let result = await runCmd([
    "git",
    "symbolic-ref",
    "--quiet",
    "--short",
    "HEAD",
  ]);
  if (result.code === 0 && result.stdout) return result.stdout;

  result = await runCmd(["git", "rev-parse", "--short", "HEAD"]);
  if (result.code === 0 && result.stdout) return result.stdout;

  throw new GitError("Couldn't determine current branch/HEAD.", 2);
}

/**
 * Detects the default branch for comparison.
 *
 * Tries multiple strategies in order:
 * 1. Remote HEAD (e.g., origin/HEAD → origin/main)
 * 2. Local 'main' branch
 * 3. Local 'master' branch
 * 4. Most recent local branch (excluding current)
 *
 * @param currentRef - The current ref to exclude from search
 * @returns Promise resolving to the detected default branch name
 * @throws {GitError} If no suitable branch is found
 *
 * @example
 * ```ts
 * const defaultBranch = await detectDefaultBranch("feature-branch");
 * // Returns "main", "master", or "origin/main"
 * ```
 */
export async function detectDefaultBranch(currentRef: string): Promise<string> {
  // Try to find remote HEAD
  const remotesRes = await runCmd(["git", "remote"]);
  if (remotesRes.code === 0 && remotesRes.stdout) {
    const remotes = remotesRes.stdout.split(/\r?\n/).filter(Boolean);
    for (const remote of remotes) {
      const symbolicRef = await runCmd([
        "git",
        "symbolic-ref",
        "--quiet",
        `refs/remotes/${remote}/HEAD`,
      ]);
      if (symbolicRef.code === 0 && symbolicRef.stdout) {
        const localBranch = symbolicRef.stdout.replace(
          `refs/remotes/${remote}/`,
          "",
        );
        const localExists = await runCmd([
          "git",
          "show-ref",
          "--verify",
          `refs/heads/${localBranch}`,
        ]);
        if (localExists.code === 0) return localBranch;
        return `${remote}/${localBranch}`; // remote-tracking ref
      }
    }
  }

  // Fallback to local main/master
  if (
    (await runCmd(["git", "show-ref", "--verify", "refs/heads/main"])).code ===
      0
  ) {
    return "main";
  }
  if (
    (await runCmd(["git", "show-ref", "--verify", "refs/heads/master"]))
      .code === 0
  ) {
    return "master";
  }
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
  throw new GitError("Could not detect default branch");
}

/**
 * Resolves a reference to a commit SHA and the actual reference used.
 *
 * This function attempts to resolve a Git reference (branch, tag, SHA) to a
 * commit SHA. If the reference cannot be resolved directly, it tries to
 * resolve it as a remote branch by prefixing each configured remote name.
 *
 * @param ref - The Git reference to resolve (e.g., "main", "v1.0", "abc123")
 * @returns Promise resolving to an object with the commit SHA and resolved reference
 * @throws {GitError} When the reference cannot be resolved to a commit
 *
 * @example
 * ```ts
 * // Resolve a local branch
 * const { commit, resolvedRef } = await resolveCommit("main");
 * // commit: "a1b2c3d...", resolvedRef: "main"
 *
 * // Resolve a remote branch that doesn't exist locally
 * const result = await resolveCommit("develop");
 * // commit: "e4f5g6h...", resolvedRef: "origin/develop"
 * ```
 */
export async function resolveCommit(
  ref: string,
): Promise<{ commit: string; resolvedRef: string }> {
  const result = await runCmd([
    "git",
    "rev-parse",
    "--verify",
    `${ref}^{commit}`,
  ]);
  if (result.code === 0 && result.stdout) {
    return { commit: result.stdout, resolvedRef: ref };
  }

  // try remotes as candidate/ref
  const remotes = (await runCmd(["git", "remote"])).stdout.split(/\r?\n/)
    .filter(Boolean);
  for (const remote of remotes) {
    const candidate = `${remote}/${ref}`;
    const candidateResult = await runCmd([
      "git",
      "rev-parse",
      "--verify",
      `${candidate}^{commit}`,
    ]);
    if (candidateResult.code === 0 && candidateResult.stdout) {
      return { commit: candidateResult.stdout, resolvedRef: candidate };
    }
  }
  throw new GitError(`Couldn't resolve '${ref}' to a commit`);
}

/**
 * Converts a revision (commit, branch, tag) to its tree SHA.
 *
 * This function resolves a Git revision to its corresponding tree object SHA.
 * If the revision is empty or cannot be resolved, it returns the empty tree SHA.
 *
 * @param rev - The Git revision to convert (commit SHA, branch, tag)
 * @param emptyTree - The SHA of the empty tree to return as fallback
 * @returns Promise resolving to the tree SHA
 *
 * @example
 * ```ts
 * const emptyTree = await runCmd(["git", "hash-object", "-t", "tree", "/dev/null"]);
 * const tree = await revToTree("main", emptyTree.stdout);
 * console.log(tree); // "4b825dc642cb6eb9a060e54bf8d69288fbee4904..."
 * ```
 */
export async function revToTree(
  rev: string,
  emptyTree: string,
): Promise<string> {
  if (!rev) return emptyTree;
  const result = await runCmd(["git", "rev-parse", `${rev}^{tree}`]);
  if (result.code === 0 && result.stdout) return result.stdout;
  return emptyTree;
}

/**
 * Parses Git unmerged files output into a list of file paths.
 *
 * This function extracts file paths from `git ls-files --unmerged` output,
 * removing duplicates (since unmerged files appear multiple times with different
 * stage numbers).
 *
 * @param lsOutput - Output from `git ls-files --unmerged` command
 * @returns Array of unique file paths that have merge conflicts
 *
 * @example
 * ```ts
 * const output = "100644 abc123 1\tsrc/file.ts\n100644 def456 2\tsrc/file.ts";
 * const files = parseUnmergedFiles(output);
 * console.log(files); // ["src/file.ts"]
 * ```
 */
export function parseUnmergedFiles(lsOutput: string): string[] {
  if (!lsOutput) return [];
  return Array.from(
    new Set(
      lsOutput.split(/\r?\n/).filter(Boolean).map((line) => {
        const parts = line.split(/\s+/);
        return parts.slice(-1)[0];
      }),
    ),
  );
}

/**
 * Generates a unified diff for a conflicting file between two commits.
 *
 * This function creates a Git diff showing the differences between the same file
 * in two commits. It detects rename/modify conflicts by checking if the file was
 * renamed on one branch while being modified on the other, and generates appropriate
 * diffs comparing the renamed and original versions.
 *
 * @param file - Path to the conflicting file
 * @param oursCommit - Commit SHA for "our" side (current branch)
 * @param theirsCommit - Commit SHA for "their" side (merging branch)
 * @param mergeBase - Optional merge-base commit SHA for rename detection
 * @returns Promise resolving to the diff string with optional rename info, or null if no diff
 *
 * @example
 * ```ts
 * const diff = await fileDiffFor(
 *   "src/lib.ts",
 *   "abc123",
 *   "def456",
 *   "ghi789"
 * );
 * console.log(diff); // Unified diff output or rename conflict message
 * ```
 */
export async function fileDiffFor(
  file: string,
  oursCommit: string,
  theirsCommit: string,
  mergeBase?: string,
): Promise<string | null> {
  let renameInfo = "";

  // If we have a merge-base, check for renames on each side
  if (mergeBase) {
    // Check our side for renames - don't filter by file since it may have been renamed
    const ourRenames = await runCmd([
      "git",
      "diff",
      "-M",
      "--name-status",
      "--diff-filter=R",
      mergeBase,
      oursCommit,
    ]);

    // Check their side for renames
    const theirRenames = await runCmd([
      "git",
      "diff",
      "-M",
      "--name-status",
      "--diff-filter=R",
      mergeBase,
      theirsCommit,
    ]);

    // Look for our file in the rename list (checking if it's the OLD name that was renamed)
    const ourRenameMatch = ourRenames.stdout?.split("\n")
      .map((line) => line.match(/^R\d+\s+(\S+)\s+(\S+)$/))
      .find((match) => match && match[1] === file);

    const theirRenameMatch = theirRenames.stdout?.split("\n")
      .map((line) => line.match(/^R\d+\s+(\S+)\s+(\S+)$/))
      .find((match) => match && match[1] === file);

    if (ourRenameMatch) {
      const [, oldName, newName] = ourRenameMatch;
      renameInfo =
        `⚠️  RENAME/MODIFY CONFLICT:\n   Your branch: renamed ${oldName} → ${newName}\n   Their branch: modified ${oldName}\n\n`;

      // Compare the renamed file on our side with the original file on their side
      const renameContentDiff = await runCmd([
        "git",
        "diff",
        "-U3",
        "--no-prefix",
        `${oursCommit}:${newName}`,
        `${theirsCommit}:${oldName}`,
      ]);

      const renameDiffOutput = renameContentDiff.stdout?.trim() ||
        renameContentDiff.stderr?.trim() || "";
      return renameInfo +
        (renameDiffOutput || "(Files are identical after rename)");
    } else if (theirRenameMatch) {
      const [, oldName, newName] = theirRenameMatch;
      renameInfo =
        `⚠️  MODIFY/RENAME CONFLICT:\n   Your branch: modified ${oldName}\n   Their branch: renamed ${oldName} → ${newName}\n\n`;

      // Compare the original file on our side with the renamed file on their side
      const renameContentDiff = await runCmd([
        "git",
        "diff",
        "-U3",
        "--no-prefix",
        `${oursCommit}:${oldName}`,
        `${theirsCommit}:${newName}`,
      ]);

      const renameDiffOutput = renameContentDiff.stdout?.trim() ||
        renameContentDiff.stderr?.trim() || "";
      return renameInfo +
        (renameDiffOutput || "(Files are identical after rename)");
    }
  }

  const d = await runCmd([
    "git",
    "diff",
    "-U3",
    "--no-prefix",
    "-M",
    oursCommit,
    theirsCommit,
    "--",
    file,
  ]);

  const diffOutput = d.stdout?.trim() || d.stderr?.trim() || "";

  return diffOutput || null;
}

/**
 * Gets detailed conflict information for a file with structured metadata.
 *
 * This function analyzes a conflicting file and returns structured information
 * including conflict type (content, rename/modify, delete/modify), human-readable
 * message, rename details if applicable, and the unified diff. This provides
 * machine-readable conflict data suitable for CI/CD tools and automated processing.
 *
 * @param file - Path to the conflicting file
 * @param oursCommit - Commit SHA for "our" side (current branch)
 * @param theirsCommit - Commit SHA for "their" side (merging branch)
 * @param mergeBase - Optional merge-base commit SHA for rename detection
 * @returns Promise resolving to {@link FileConflictDetail} with conflict metadata
 *
 * @example
 * ```ts
 * const detail = await getFileConflictDetail("src/lib.ts", "abc123", "def456", "ghi789");
 * console.log(detail.conflict_type); // "rename_modify"
 * console.log(detail.message); // "Your branch: renamed old.ts → new.ts..."
 * console.log(detail.rename); // { old_path: "old.ts", new_path: "new.ts", side: "ours" }
 * console.log(detail.diff); // Unified diff output
 * ```
 */
export async function getFileConflictDetail(
  file: string,
  oursCommit: string,
  theirsCommit: string,
  mergeBase?: string,
): Promise<FileConflictDetail> {
  let conflictType: FileConflictDetail["conflict_type"] = "content";
  let message: string | undefined;
  let renameInfo: RenameInfo | undefined;
  let diff: string | undefined;

  // If we have a merge-base, check for renames on each side
  if (mergeBase) {
    // Check our side for renames
    const ourRenames = await runCmd([
      "git",
      "diff",
      "-M",
      "--name-status",
      "--diff-filter=R",
      mergeBase,
      oursCommit,
    ]);

    // Check their side for renames
    const theirRenames = await runCmd([
      "git",
      "diff",
      "-M",
      "--name-status",
      "--diff-filter=R",
      mergeBase,
      theirsCommit,
    ]);

    // Look for our file in the rename list (checking if it's the OLD name that was renamed)
    const ourRenameMatch = ourRenames.stdout?.split("\n")
      .map((line) => line.match(/^R\d+\s+(\S+)\s+(\S+)$/))
      .find((match) => match && match[1] === file);

    const theirRenameMatch = theirRenames.stdout?.split("\n")
      .map((line) => line.match(/^R\d+\s+(\S+)\s+(\S+)$/))
      .find((match) => match && match[1] === file);

    if (ourRenameMatch) {
      const [, oldName, newName] = ourRenameMatch;
      conflictType = "rename_modify";
      message =
        `Your branch: renamed ${oldName} → ${newName}\nTheir branch: modified ${oldName}`;
      renameInfo = {
        old_path: oldName,
        new_path: newName,
        side: "ours",
      };

      // Compare the renamed file on our side with the original file on their side
      const renameContentDiff = await runCmd([
        "git",
        "diff",
        "-U3",
        "--no-prefix",
        `${oursCommit}:${newName}`,
        `${theirsCommit}:${oldName}`,
      ]);

      diff = renameContentDiff.stdout?.trim() ||
        renameContentDiff.stderr?.trim() || undefined;
    } else if (theirRenameMatch) {
      const [, oldName, newName] = theirRenameMatch;
      conflictType = "modify_rename";
      message =
        `Your branch: modified ${oldName}\nTheir branch: renamed ${oldName} → ${newName}`;
      renameInfo = {
        old_path: oldName,
        new_path: newName,
        side: "theirs",
      };

      // Compare the original file on our side with the renamed file on their side
      const renameContentDiff = await runCmd([
        "git",
        "diff",
        "-U3",
        "--no-prefix",
        `${oursCommit}:${oldName}`,
        `${theirsCommit}:${newName}`,
      ]);

      diff = renameContentDiff.stdout?.trim() ||
        renameContentDiff.stderr?.trim() || undefined;
    }
  }

  // If no rename was detected, get regular diff
  if (!renameInfo) {
    const d = await runCmd([
      "git",
      "diff",
      "-U3",
      "--no-prefix",
      "-M",
      oursCommit,
      theirsCommit,
      "--",
      file,
    ]);

    diff = d.stdout?.trim() || d.stderr?.trim() || undefined;

    // Check if it's a delete/modify conflict
    if (
      diff &&
      (diff.includes("deleted file mode") || diff.includes("new file mode"))
    ) {
      if (diff.includes("deleted file mode")) {
        conflictType = "delete_modify";
        message = "File deleted on one branch, modified on the other";
      } else {
        conflictType = "modify_delete";
        message = "File modified on one branch, deleted on the other";
      }
    }
  }

  return {
    conflict_type: conflictType,
    message,
    rename: renameInfo,
    diff,
  };
}

/**
 * Information about a file rename in a conflict.
 */
export interface RenameInfo {
  /** Original file path before rename */
  old_path: string;
  /** New file path after rename */
  new_path: string;
  /** Which side performed the rename: "ours" (current branch) or "theirs" (merging branch) */
  side: "ours" | "theirs";
}

/**
 * Detailed information about a file conflict.
 *
 * This structure provides machine-readable conflict metadata suitable for
 * CI/CD automation and programmatic conflict analysis.
 */
export interface FileConflictDetail {
  /** Type of conflict detected */
  conflict_type:
    | "content"
    | "rename_modify"
    | "modify_rename"
    | "delete_modify"
    | "modify_delete";
  /** Human-readable description of the conflict */
  message?: string;
  /** Rename details if this is a rename-related conflict */
  rename?: RenameInfo;
  /** Unified diff showing the conflicting changes */
  diff?: string;
}

/**
 * Complete result of a conflict check operation.
 *
 * Contains all information about detected conflicts including branch references,
 * commit SHAs, merge base, and detailed per-file conflict information.
 */
export interface ConflictCheckResult {
  /** Current branch reference name */
  current_ref: string;
  /** Other branch reference being merged */
  other_ref: string;
  /** Commit SHA of current branch */
  ours_commit: string;
  /** Commit SHA of other branch */
  theirs_commit: string;
  /** Merge base commit SHA, or null if branches have no common ancestor */
  merge_base: string | null;
  /** Whether any conflicts were detected */
  conflicts: boolean;
  /** Array of file paths with conflicts */
  conflicted_files: string[];
  /** Detailed conflict information keyed by file path */
  files: Record<string, FileConflictDetail>;
}

/**
 * Manages a temporary Git index file for conflict detection.
 *
 * This class creates and manages a temporary Git index file used for
 * three-way merge simulation without modifying the working directory.
 * It ensures proper cleanup of temporary resources.
 */
export class TempIndex {
  private path: string | null = null;

  /**
   * Creates a new temporary index file.
   *
   * @returns Promise resolving to the path of the temporary index file
   */
  async create(): Promise<string> {
    this.path = await Deno.makeTempFile();
    return this.path;
  }

  /**
   * Gets the path to the temporary index file.
   *
   * @returns The index file path, or null if not yet created
   */
  getPath(): string | null {
    return this.path;
  }

  /**
   * Cleans up the temporary index file.
   *
   * Removes the temporary file from disk. Cleanup errors are silently ignored.
   */
  async cleanup(): Promise<void> {
    if (this.path) {
      try {
        await Deno.remove(this.path);
        this.path = null;
      } catch {
        // ignore cleanup errors
      }
    }
  }

  /**
   * Runs a Git command with this temporary index.
   *
   * @param args - Git command arguments (without the "git" prefix)
   * @returns Promise resolving to the command result
   * @throws {Error} If the temporary index has not been created
   */
  async runGitWithIndex(args: string[]): Promise<CmdResult> {
    if (!this.path) {
      throw new Error("Temporary index not created");
    }
    return await runCmd(["git", ...args], { GIT_INDEX_FILE: this.path });
  }
}

/**
 * Gets the hash of Git's empty tree object.
 *
 * This function returns the SHA-1 hash of an empty Git tree, which is useful
 * as a base tree when comparing branches with no common ancestor or when a
 * branch doesn't exist yet.
 *
 * @returns Promise resolving to the empty tree hash
 *
 * @example
 * ```ts
 * const emptyTree = await getEmptyTreeHash();
 * console.log(emptyTree); // "4b825dc642cb6eb9a060e54bf8d69288fbee4904"
 * ```
 */
export async function getEmptyTreeHash(): Promise<string> {
  // Get the empty tree hash from git itself
  const result = await runCmd([
    "git",
    "hash-object",
    "-t",
    "tree",
    "/dev/null",
  ]);
  if (result.code === 0 && result.stdout) {
    return result.stdout;
  }
  // Fallback to well-known hash
  return "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
}

/**
 * Checks for merge conflicts using Git's read-tree command.
 *
 * This function performs a three-way merge simulation using `git read-tree -m`
 * to detect conflicts between two branches. This is the primary conflict
 * detection method as it's fast and accurate for most cases.
 *
 * @param baseTree - Tree SHA of the merge base (common ancestor)
 * @param oursTree - Tree SHA of the current branch
 * @param theirsTree - Tree SHA of the branch being merged
 * @param tempIndex - Temporary index for the merge operation
 * @returns Promise resolving to array of conflicting file paths
 *
 * @example
 * ```ts
 * const tempIndex = new TempIndex();
 * await tempIndex.create();
 * const conflicts = await checkConflictsWithReadTree(
 *   "base123",
 *   "ours456",
 *   "theirs789",
 *   tempIndex
 * );
 * console.log(conflicts); // ["src/file1.ts", "src/file2.ts"]
 * await tempIndex.cleanup();
 * ```
 */
export async function checkConflictsWithReadTree(
  baseTree: string,
  oursTree: string,
  theirsTree: string,
  tempIndex: TempIndex,
): Promise<string[]> {
  // Try to read the tree
  await tempIndex.runGitWithIndex([
    "read-tree",
    "-m",
    "--",
    baseTree,
    oursTree,
    theirsTree,
  ]).catch(() => ({ code: 1, stdout: "", stderr: "" }));

  // Check for unmerged entries
  const lsRes = await tempIndex.runGitWithIndex(["ls-files", "-u", "--stage"]);
  return parseUnmergedFiles(lsRes.stdout);
}

/**
 * Checks if a merge would result in conflicts using Git's merge-tree command.
 *
 * This is a fallback conflict detection method that uses `git merge-tree` to
 * perform a tree-based merge and analyze the output for conflict markers and
 * structural conflicts. This is used when read-tree doesn't detect conflicts.
 *
 * @param mergeBase - Merge base commit SHA (common ancestor)
 * @param oursCommit - Commit SHA of the current branch
 * @param theirsCommit - Commit SHA of the branch being merged
 * @param emptyTree - Empty tree SHA to use if merge base is not available
 * @returns Promise resolving to true if conflicts exist, false otherwise
 *
 * @example
 * ```ts
 * const hasConflicts = await checkConflictsWithMergeTree(
 *   "base123",
 *   "ours456",
 *   "theirs789",
 *   emptyTreeHash
 * );
 * console.log(hasConflicts); // true or false
 * ```
 */
export async function checkConflictsWithMergeTree(
  mergeBase: string,
  oursCommit: string,
  theirsCommit: string,
  emptyTree: string,
): Promise<boolean> {
  const mergeTreeRes = await runCmd([
    "git",
    "merge-tree",
    mergeBase || emptyTree,
    oursCommit,
    theirsCommit,
  ]);

  // Check for content conflicts (markers)
  if (/<<<<<<< /m.test(mergeTreeRes.stdout)) {
    return true;
  }

  // Check for delete/modify and other structural conflicts
  // These appear at the start of lines in merge-tree output
  if (
    /^(removed in (local|remote)|added in (local|remote)|changed in both)/m
      .test(mergeTreeRes.stdout)
  ) {
    return true;
  }

  return false;
}

/**
 * Extracts the list of conflicting files from merge-tree output.
 *
 * This function parses the output of `git merge-tree` to identify files with
 * actual conflicts. It looks for both structural conflicts (removed/added/changed)
 * and content conflicts (merge markers) in the merge-tree output.
 *
 * @param mergeBase - Merge base commit SHA (common ancestor)
 * @param oursCommit - Commit SHA of the current branch
 * @param theirsCommit - Commit SHA of the branch being merged
 * @param emptyTree - Empty tree SHA to use if merge base is not available
 * @returns Promise resolving to array of file paths with actual conflicts
 *
 * @example
 * ```ts
 * const files = await getConflictingFilesFromMergeTree(
 *   "base123",
 *   "ours456",
 *   "theirs789",
 *   emptyTreeHash
 * );
 * console.log(files); // ["src/lib.ts", "README.md"]
 * ```
 */
export async function getConflictingFilesFromMergeTree(
  mergeBase: string,
  oursCommit: string,
  theirsCommit: string,
  emptyTree: string,
): Promise<string[]> {
  const mergeTreeRes = await runCmd([
    "git",
    "merge-tree",
    mergeBase || emptyTree,
    oursCommit,
    theirsCommit,
  ]);

  const conflictingFiles: string[] = [];
  const lines = mergeTreeRes.stdout.split(/\r?\n/);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Check for structural conflicts (removed in local/remote, added in local/remote, changed in both)
    if (
      /^(removed in (local|remote)|added in (local|remote)|changed in both)/
        .test(line)
    ) {
      // The file path appears in the subsequent lines (base, our, their)
      // Look for lines like: "  base   100644 hash filename"
      for (
        let j = i + 1;
        j < Math.min(i + MERGE_TREE_METADATA_SEARCH_WINDOW, lines.length);
        j++
      ) {
        const match = lines[j].match(
          /^\s+(base|our|their)\s+\d+\s+[a-f0-9]+\s+(.+)$/,
        );
        if (match) {
          const filename = match[2];
          if (!conflictingFiles.includes(filename)) {
            conflictingFiles.push(filename);
          }
        }
      }
    }

    // Check for content conflicts by looking for merge result with conflict markers
    // In merge-tree output, the merged content follows "merged" or "result" indicators
    // We need to check if the content has conflict markers
    if (/^merged/.test(line) || /^result/.test(line)) {
      // Look for the file reference in nearby lines
      const match = line.match(/^(merged|result)\s+\d+\s+[a-f0-9]+\s+(.+)$/);
      if (match) {
        const filename = match[2];
        // Check if subsequent content has conflict markers
        let hasMarkers = false;
        for (
          let j = i + 1;
          j <
            Math.min(
              i + MERGE_TREE_CONFLICT_MARKER_SEARCH_WINDOW,
              lines.length,
            );
          j++
        ) {
          if (/^<<<<<<< /.test(lines[j])) {
            hasMarkers = true;
            break;
          }
          // Stop if we hit another file section
          if (
            /^(removed in|added in|changed in|merged|result)/.test(lines[j])
          ) {
            break;
          }
        }
        if (hasMarkers && !conflictingFiles.includes(filename)) {
          conflictingFiles.push(filename);
        }
      }
    }
  }

  return conflictingFiles;
}

/**
 * Gets the list of files that changed between two commits.
 *
 * @param oursCommit - Commit SHA of the first commit
 * @param theirsCommit - Commit SHA of the second commit
 * @returns Promise resolving to array of file paths that differ between commits
 *
 * @example
 * ```ts
 * const files = await getChangedFilesBetween("abc123", "def456");
 * console.log(files); // ["src/lib.ts", "README.md", "tests/test.ts"]
 * ```
 */
export async function getChangedFilesBetween(
  oursCommit: string,
  theirsCommit: string,
): Promise<string[]> {
  const changedRes = await runCmd([
    "git",
    "diff",
    "--name-only",
    oursCommit,
    theirsCommit,
  ]);
  if (changedRes.code === 0 && changedRes.stdout) {
    return changedRes.stdout.split(/\r?\n/).filter(Boolean);
  }
  return [];
}

/**
 * Checks if the current directory is a Git repository.
 *
 * @returns Promise resolving to true if in a Git repository, false otherwise
 *
 * @example
 * ```ts
 * const isRepo = await isGitRepository();
 * if (!isRepo) {
 *   console.error("Not a Git repository");
 * }
 * ```
 */
export async function isGitRepository(): Promise<boolean> {
  const result = await runCmd(["git", "rev-parse", "--git-dir"]);
  return result.code === 0;
}

/**
 * Fetches all remotes in the Git repository.
 *
 * @returns Promise resolving to success status and optional error message
 *
 * @example
 * ```ts
 * const result = await fetchAll();
 * if (!result.success) {
 *   console.error("Fetch failed:", result.error);
 * }
 * ```
 */
export async function fetchAll(): Promise<
  { success: boolean; error?: string }
> {
  const result = await runCmd(["git", "fetch", "--all"]);
  if (result.code !== 0) {
    return { success: false, error: result.stderr || result.stdout };
  }
  return { success: true };
}
