/**
 * Library functions for git-check-conflicts
 * Separated from main.ts for testability
 */

export type CmdResult = { code: number; stdout: string; stderr: string };

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

export class GitError extends Error {
  constructor(message: string, public code: number = 2) {
    super(message);
    this.name = "GitError";
  }
}

export async function getCurrentRef(): Promise<string> {
  let r = await runCmd(["git", "symbolic-ref", "--quiet", "--short", "HEAD"]);
  if (r.code === 0 && r.stdout) return r.stdout;
  r = await runCmd(["git", "rev-parse", "--short", "HEAD"]);
  if (r.code === 0 && r.stdout) return r.stdout;
  throw new GitError("Couldn't determine current branch/HEAD.", 2);
}

export async function detectDefaultBranch(currentRef: string): Promise<string> {
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
  throw new GitError("Could not detect default branch");
}

export async function resolveCommit(ref: string): Promise<{ commit: string; resolvedRef: string }> {
  const r = await runCmd(["git", "rev-parse", "--verify", `${ref}^{commit}`]);
  if (r.code === 0 && r.stdout) return { commit: r.stdout, resolvedRef: ref };

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
      return { commit: s.stdout, resolvedRef: cand };
    }
  }
  throw new GitError(`Couldn't resolve '${ref}' to a commit`);
}

export async function revToTree(rev: string, emptyTree: string): Promise<string> {
  if (!rev) return emptyTree;
  const r = await runCmd(["git", "rev-parse", `${rev}^{tree}`]);
  if (r.code === 0 && r.stdout) return r.stdout;
  return emptyTree;
}

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

export async function fileDiffFor(
  file: string,
  oursCommit: string,
  theirsCommit: string,
): Promise<string | null> {
  const d = await runCmd([
    "git",
    "diff",
    "-U3",
    "--no-prefix",
    oursCommit,
    theirsCommit,
    "--",
    file,
  ]);
  if (d.stdout && d.stdout.trim()) return d.stdout;
  if (d.stderr && d.stderr.trim()) return d.stderr;
  return null;
}

export interface ConflictCheckResult {
  current_ref: string;
  other_ref: string;
  ours_commit: string;
  theirs_commit: string;
  merge_base: string | null;
  conflicts: boolean;
  conflicted_files: string[];
  diffs: Record<string, string | null>;
}

export class TempIndex {
  private path: string | null = null;

  async create(): Promise<string> {
    this.path = await Deno.makeTempFile();
    return this.path;
  }

  getPath(): string | null {
    return this.path;
  }

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

  async runGitWithIndex(args: string[]): Promise<CmdResult> {
    if (!this.path) {
      throw new Error("Temporary index not created");
    }
    return await runCmd(["git", ...args], { GIT_INDEX_FILE: this.path });
  }
}

export async function getEmptyTreeHash(): Promise<string> {
  // Get the empty tree hash from git itself
  const result = await runCmd(["git", "hash-object", "-t", "tree", "/dev/null"]);
  if (result.code === 0 && result.stdout) {
    return result.stdout;
  }
  // Fallback to well-known hash
  return "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
}

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
  if (/^(removed in (local|remote)|added in (local|remote)|changed in both)/m.test(mergeTreeRes.stdout)) {
    return true;
  }

  return false;
}

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

export async function isGitRepository(): Promise<boolean> {
  const r = await runCmd(["git", "rev-parse", "--git-dir"]);
  return r.code === 0;
}

export async function fetchAll(): Promise<{ success: boolean; error?: string }> {
  const r = await runCmd(["git", "fetch", "--all"]);
  if (r.code !== 0) {
    return { success: false, error: r.stderr || r.stdout };
  }
  return { success: true };
}
