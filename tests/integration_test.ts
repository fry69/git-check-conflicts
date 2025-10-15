/**
 * Integration tests for git-check-conflicts
 * These tests create actual git repositories and test the full workflow
 */

import { expect } from "@std/expect";
import { runCmd, TempIndex } from "../src/lib.ts";

interface TestRepo {
  dir: string;
  cleanup: () => Promise<void>;
}

async function createTestRepo(name: string): Promise<TestRepo> {
  const tempDir = await Deno.makeTempDir({ prefix: `git_test_${name}_` });

  const cleanup = async () => {
    try {
      await Deno.remove(tempDir, { recursive: true });
    } catch {
      // ignore
    }
  };

  return { dir: tempDir, cleanup };
}

async function gitInRepo(dir: string, args: string[]): Promise<{ code: number; stdout: string }> {
  const originalDir = Deno.cwd();
  try {
    Deno.chdir(dir);
    return await runCmd(["git", ...args]);
  } finally {
    Deno.chdir(originalDir);
  }
}

async function setupBasicRepo(dir: string): Promise<void> {
  await gitInRepo(dir, ["init"]);
  await gitInRepo(dir, ["config", "user.email", "test@test.com"]);
  await gitInRepo(dir, ["config", "user.name", "Test User"]);
  await gitInRepo(dir, ["commit", "--allow-empty", "-m", "initial commit"]);
}

async function writeFile(dir: string, filename: string, content: string): Promise<void> {
  await Deno.writeTextFile(`${dir}/${filename}`, content);
}

Deno.test("integration - repo with no conflicts", async () => {
  const repo = await createTestRepo("no_conflicts");
  try {
    await setupBasicRepo(repo.dir);

    // Create main branch with a file
    await writeFile(repo.dir, "file.txt", "line1\nline2\nline3\n");
    await gitInRepo(repo.dir, ["add", "file.txt"]);
    await gitInRepo(repo.dir, ["commit", "-m", "add file"]);
    await gitInRepo(repo.dir, ["branch", "main"]);

    // Create feature branch and add different file
    await gitInRepo(repo.dir, ["checkout", "-b", "feature"]);
    await writeFile(repo.dir, "other.txt", "other content\n");
    await gitInRepo(repo.dir, ["add", "other.txt"]);
    await gitInRepo(repo.dir, ["commit", "-m", "add other file"]);

    // Check for conflicts between feature and main
    const mergeBase = await gitInRepo(repo.dir, ["merge-base", "feature", "main"]);
    expect(mergeBase.code).toBe(0);

    // These branches should merge cleanly (different files)
    const mergeCheck = await gitInRepo(repo.dir, ["merge-tree", mergeBase.stdout, "feature", "main"]);
    expect(mergeCheck.stdout).not.toContain("<<<<<<<");
  } finally {
    await repo.cleanup();
  }
});

Deno.test("integration - repo with conflicts", async () => {
  const repo = await createTestRepo("with_conflicts");
  try {
    await setupBasicRepo(repo.dir);

    // Create initial file on main
    await writeFile(repo.dir, "conflict.txt", "line1\nline2\nline3\n");
    await gitInRepo(repo.dir, ["add", "conflict.txt"]);
    await gitInRepo(repo.dir, ["commit", "-m", "add conflict.txt"]);

    // Create branch and modify the same line
    await gitInRepo(repo.dir, ["checkout", "-b", "branch1"]);
    await writeFile(repo.dir, "conflict.txt", "line1\nmodified in branch1\nline3\n");
    await gitInRepo(repo.dir, ["add", "conflict.txt"]);
    await gitInRepo(repo.dir, ["commit", "-m", "modify in branch1"]);

    // Go back to main and modify same line differently
    await gitInRepo(repo.dir, ["checkout", "-"]);
    await writeFile(repo.dir, "conflict.txt", "line1\nmodified in main\nline3\n");
    await gitInRepo(repo.dir, ["add", "conflict.txt"]);
    await gitInRepo(repo.dir, ["commit", "-m", "modify in main"]);

    // Check for conflicts
    const mainCommit = await gitInRepo(repo.dir, ["rev-parse", "HEAD"]);
    const branch1Commit = await gitInRepo(repo.dir, ["rev-parse", "branch1"]);
    const mergeBase = await gitInRepo(repo.dir, ["merge-base", "HEAD", "branch1"]);

    expect(mergeBase.code).toBe(0);

    const mergeCheck = await gitInRepo(repo.dir, [
      "merge-tree",
      mergeBase.stdout,
      mainCommit.stdout,
      branch1Commit.stdout,
    ]);

    // Should contain conflict markers
    expect(mergeCheck.stdout).toContain("<<<<<<<");
  } finally {
    await repo.cleanup();
  }
});

Deno.test("integration - TempIndex with read-tree workflow", async () => {
  const repo = await createTestRepo("readtree_conflicts");
  try {
    await setupBasicRepo(repo.dir);

    // Create a simple scenario with divergent changes
    await writeFile(repo.dir, "file.txt", "original\n");
    await gitInRepo(repo.dir, ["add", "file.txt"]);
    await gitInRepo(repo.dir, ["commit", "-m", "add file"]);
    const baseCommit = await gitInRepo(repo.dir, ["rev-parse", "HEAD"]);

    // Branch 1: modify file
    await gitInRepo(repo.dir, ["checkout", "-b", "branch1"]);
    await writeFile(repo.dir, "file.txt", "modified in branch1\n");
    await gitInRepo(repo.dir, ["add", "file.txt"]);
    await gitInRepo(repo.dir, ["commit", "-m", "modify in branch1"]);

    // Branch 2: modify same file differently
    await gitInRepo(repo.dir, ["checkout", baseCommit.stdout]);
    await gitInRepo(repo.dir, ["checkout", "-b", "branch2"]);
    await writeFile(repo.dir, "file.txt", "modified in branch2\n");
    await gitInRepo(repo.dir, ["add", "file.txt"]);
    await gitInRepo(repo.dir, ["commit", "-m", "modify in branch2"]);

    // Test TempIndex basic workflow
    const tempIndex = new TempIndex();
    const originalDir = Deno.cwd();
    try {
      const indexPath = await tempIndex.create();
      Deno.chdir(repo.dir);

      // Verify temp index was created
      expect(indexPath).toBeTruthy();
      expect(tempIndex.getPath()).toBe(indexPath);

      // Read HEAD tree into the temp index
      const headTree = await gitInRepo(repo.dir, ["rev-parse", "HEAD^{tree}"]);
      await tempIndex.runGitWithIndex(["read-tree", headTree.stdout]);

      // Verify we can list files from the temp index
      const result = await tempIndex.runGitWithIndex(["ls-files"]);
      expect(result.code).toBe(0);
      expect(result.stdout).toContain("file.txt");
    } finally {
      Deno.chdir(originalDir);
      await tempIndex.cleanup();
    }
  } finally {
    await repo.cleanup();
  }
});

Deno.test("integration - detect default branch strategies", async () => {
  const repo = await createTestRepo("default_branch");
  try {
    await setupBasicRepo(repo.dir);

    // Create main branch
    await gitInRepo(repo.dir, ["branch", "main"]);
    await gitInRepo(repo.dir, ["checkout", "main"]);

    // Create feature branch
    await gitInRepo(repo.dir, ["checkout", "-b", "feature"]);

    // Should be able to detect main as default
    const branches = await gitInRepo(repo.dir, ["branch"]);
    expect(branches.stdout).toContain("main");
    expect(branches.stdout).toContain("feature");
  } finally {
    await repo.cleanup();
  }
});

Deno.test("integration - empty repository handling", async () => {
  const repo = await createTestRepo("empty");
  try {
    await gitInRepo(repo.dir, ["init"]);
    await gitInRepo(repo.dir, ["config", "user.email", "test@test.com"]);
    await gitInRepo(repo.dir, ["config", "user.name", "Test User"]);

    // Should handle empty repo gracefully
    const result = await gitInRepo(repo.dir, ["rev-parse", "HEAD"]);
    expect(result.code).not.toBe(0); // No HEAD yet
  } finally {
    await repo.cleanup();
  }
});

Deno.test("integration - remote tracking branches", async () => {
  const repo = await createTestRepo("remote");
  try {
    await setupBasicRepo(repo.dir);

    // Create a "remote" repo
    const remoteRepo = await createTestRepo("remote_origin");
    try {
      await setupBasicRepo(remoteRepo.dir);
      await writeFile(remoteRepo.dir, "remote.txt", "remote content\n");
      await gitInRepo(remoteRepo.dir, ["add", "remote.txt"]);
      await gitInRepo(remoteRepo.dir, ["commit", "-m", "remote commit"]);

      // Add remote
      await gitInRepo(repo.dir, ["remote", "add", "origin", remoteRepo.dir]);
      await gitInRepo(repo.dir, ["fetch", "origin"]);

      // Check that we can see remote branches
      const branches = await gitInRepo(repo.dir, ["branch", "-r"]);
      expect(branches.stdout).toContain("origin");
    } finally {
      await remoteRepo.cleanup();
    }
  } finally {
    await repo.cleanup();
  }
});

Deno.test("integration - file diff generation", async () => {
  const repo = await createTestRepo("diff");
  try {
    await setupBasicRepo(repo.dir);

    // Create file on main
    await writeFile(repo.dir, "diff.txt", "line1\nline2\nline3\n");
    await gitInRepo(repo.dir, ["add", "diff.txt"]);
    await gitInRepo(repo.dir, ["commit", "-m", "initial file"]);
    const commit1 = await gitInRepo(repo.dir, ["rev-parse", "HEAD"]);

    // Modify file
    await writeFile(repo.dir, "diff.txt", "line1\nmodified\nline3\n");
    await gitInRepo(repo.dir, ["add", "diff.txt"]);
    await gitInRepo(repo.dir, ["commit", "-m", "modify file"]);
    const commit2 = await gitInRepo(repo.dir, ["rev-parse", "HEAD"]);

    // Get diff
    const diff = await gitInRepo(repo.dir, [
      "diff",
      "-U3",
      commit1.stdout,
      commit2.stdout,
      "--",
      "diff.txt",
    ]);

    expect(diff.stdout).toContain("-line2");
    expect(diff.stdout).toContain("+modified");
  } finally {
    await repo.cleanup();
  }
});

Deno.test("integration - multiple conflicting files", async () => {
  const repo = await createTestRepo("multi_conflicts");
  try {
    await setupBasicRepo(repo.dir);

    // Create multiple files
    await writeFile(repo.dir, "file1.txt", "content1\n");
    await writeFile(repo.dir, "file2.txt", "content2\n");
    await gitInRepo(repo.dir, ["add", "."]);
    await gitInRepo(repo.dir, ["commit", "-m", "add files"]);

    // Branch 1: modify both
    await gitInRepo(repo.dir, ["checkout", "-b", "branch1"]);
    await writeFile(repo.dir, "file1.txt", "modified1 in branch1\n");
    await writeFile(repo.dir, "file2.txt", "modified2 in branch1\n");
    await gitInRepo(repo.dir, ["add", "."]);
    await gitInRepo(repo.dir, ["commit", "-m", "modify in branch1"]);

    // Branch 2: modify both differently
    await gitInRepo(repo.dir, ["checkout", "-"]);
    await writeFile(repo.dir, "file1.txt", "modified1 in main\n");
    await writeFile(repo.dir, "file2.txt", "modified2 in main\n");
    await gitInRepo(repo.dir, ["add", "."]);
    await gitInRepo(repo.dir, ["commit", "-m", "modify in main"]);

    // Check conflicts
    const mainCommit = await gitInRepo(repo.dir, ["rev-parse", "HEAD"]);
    const branch1Commit = await gitInRepo(repo.dir, ["rev-parse", "branch1"]);
    const mergeBase = await gitInRepo(repo.dir, ["merge-base", "HEAD", "branch1"]);

    const mergeCheck = await gitInRepo(repo.dir, [
      "merge-tree",
      mergeBase.stdout,
      mainCommit.stdout,
      branch1Commit.stdout,
    ]);

    // Should have conflicts in both files
    const conflicts = mergeCheck.stdout.match(/<<<<<<<[^]*?>>>>>>>/g);
    expect(conflicts).toBeTruthy();
    expect(conflicts!.length).toBeGreaterThanOrEqual(2);
  } finally {
    await repo.cleanup();
  }
});

Deno.test("integration - binary files", async () => {
  const repo = await createTestRepo("binary");
  try {
    await setupBasicRepo(repo.dir);

    // Create binary file (simple approach: random bytes)
    const binaryData = new Uint8Array([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
    await Deno.writeFile(`${repo.dir}/image.bin`, binaryData);
    await gitInRepo(repo.dir, ["add", "image.bin"]);
    await gitInRepo(repo.dir, ["commit", "-m", "add binary"]);

    // Git should recognize it as binary
    const result = await gitInRepo(repo.dir, ["diff", "--stat", "HEAD^", "HEAD"]);
    expect(result.code).toBe(0);
  } finally {
    await repo.cleanup();
  }
});

Deno.test("integration - no common ancestor", async () => {
  const repo = await createTestRepo("no_ancestor");
  try {
    await setupBasicRepo(repo.dir);
    const firstCommit = await gitInRepo(repo.dir, ["rev-parse", "HEAD"]);

    // Create orphan branch (no common history)
    await gitInRepo(repo.dir, ["checkout", "--orphan", "orphan"]);
    // Remove all files to truly make it independent
    await gitInRepo(repo.dir, ["rm", "-rf", "."]).catch(() => {});
    await writeFile(repo.dir, "orphan.txt", "orphan content\n");
    await gitInRepo(repo.dir, ["add", "orphan.txt"]);
    await gitInRepo(repo.dir, ["commit", "-m", "orphan commit"]);
    const orphanCommit = await gitInRepo(repo.dir, ["rev-parse", "HEAD"]);

    // Try to find merge base between two unrelated commits
    const mergeBase = await gitInRepo(repo.dir, ["merge-base", orphanCommit.stdout, firstCommit.stdout]);
    // In git, branches with no common ancestor will fail merge-base (exit code 1)
    // or in some versions might return empty/error
    expect(mergeBase.code === 1 || mergeBase.stdout === "").toBe(true);
  } finally {
    await repo.cleanup();
  }
});
