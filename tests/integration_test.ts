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

async function gitInRepo(
  dir: string,
  args: string[],
): Promise<{ code: number; stdout: string }> {
  const originalDir = Deno.cwd();
  try {
    Deno.chdir(dir);
    return await runCmd(["git", ...args]);
  } finally {
    Deno.chdir(originalDir);
  }
}

async function setupBasicRepo(dir: string): Promise<void> {
  await gitInRepo(dir, ["init", "-b", "main"]);
  await gitInRepo(dir, ["config", "user.email", "test@test.com"]);
  await gitInRepo(dir, ["config", "user.name", "Test User"]);
  await gitInRepo(dir, ["commit", "--allow-empty", "-m", "initial commit"]);
}

async function writeFile(
  dir: string,
  filename: string,
  content: string,
): Promise<void> {
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
    const mergeBase = await gitInRepo(repo.dir, [
      "merge-base",
      "feature",
      "main",
    ]);
    expect(mergeBase.code).toBe(0);

    // These branches should merge cleanly (different files)
    const mergeCheck = await gitInRepo(repo.dir, [
      "merge-tree",
      mergeBase.stdout,
      "feature",
      "main",
    ]);
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
    await writeFile(
      repo.dir,
      "conflict.txt",
      "line1\nmodified in branch1\nline3\n",
    );
    await gitInRepo(repo.dir, ["add", "conflict.txt"]);
    await gitInRepo(repo.dir, ["commit", "-m", "modify in branch1"]);

    // Go back to main and modify same line differently
    await gitInRepo(repo.dir, ["checkout", "-"]);
    await writeFile(
      repo.dir,
      "conflict.txt",
      "line1\nmodified in main\nline3\n",
    );
    await gitInRepo(repo.dir, ["add", "conflict.txt"]);
    await gitInRepo(repo.dir, ["commit", "-m", "modify in main"]);

    // Check for conflicts
    const mainCommit = await gitInRepo(repo.dir, ["rev-parse", "HEAD"]);
    const branch1Commit = await gitInRepo(repo.dir, ["rev-parse", "branch1"]);
    const mergeBase = await gitInRepo(repo.dir, [
      "merge-base",
      "HEAD",
      "branch1",
    ]);

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
    const mergeBase = await gitInRepo(repo.dir, [
      "merge-base",
      "HEAD",
      "branch1",
    ]);

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
    const binaryData = new Uint8Array([
      0x89,
      0x50,
      0x4E,
      0x47,
      0x0D,
      0x0A,
      0x1A,
      0x0A,
    ]);
    await Deno.writeFile(`${repo.dir}/image.bin`, binaryData);
    await gitInRepo(repo.dir, ["add", "image.bin"]);
    await gitInRepo(repo.dir, ["commit", "-m", "add binary"]);

    // Git should recognize it as binary
    const result = await gitInRepo(repo.dir, [
      "diff",
      "--stat",
      "HEAD^",
      "HEAD",
    ]);
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
    const mergeBase = await gitInRepo(repo.dir, [
      "merge-base",
      orphanCommit.stdout,
      firstCommit.stdout,
    ]);
    // In git, branches with no common ancestor will fail merge-base (exit code 1)
    // or in some versions might return empty/error
    expect(mergeBase.code === 1 || mergeBase.stdout === "").toBe(true);
  } finally {
    await repo.cleanup();
  }
});

Deno.test("integration - delete/modify conflict", async () => {
  const repo = await createTestRepo("delete_modify_conflict");
  try {
    await setupBasicRepo(repo.dir);

    // Create initial file
    await writeFile(repo.dir, "file.txt", "original content\n");
    await gitInRepo(repo.dir, ["add", "file.txt"]);
    await gitInRepo(repo.dir, ["commit", "-m", "add file"]);
    const base = await gitInRepo(repo.dir, ["rev-parse", "HEAD"]);

    // Branch 1: delete the file
    await gitInRepo(repo.dir, ["checkout", "-b", "delete-branch"]);
    await gitInRepo(repo.dir, ["rm", "file.txt"]);
    await gitInRepo(repo.dir, ["commit", "-m", "delete file"]);
    const deleteCommit = await gitInRepo(repo.dir, ["rev-parse", "HEAD"]);

    // Branch 2: modify the file
    await gitInRepo(repo.dir, ["checkout", base.stdout]);
    await gitInRepo(repo.dir, ["checkout", "-b", "modify-branch"]);
    await writeFile(repo.dir, "file.txt", "modified content\n");
    await gitInRepo(repo.dir, ["add", "file.txt"]);
    await gitInRepo(repo.dir, ["commit", "-m", "modify file"]);
    const modifyCommit = await gitInRepo(repo.dir, ["rev-parse", "HEAD"]);

    // Check for conflicts using merge-tree
    const mergeBase = await gitInRepo(repo.dir, [
      "merge-base",
      deleteCommit.stdout,
      modifyCommit.stdout,
    ]);
    expect(mergeBase.code).toBe(0);

    const mergeTreeResult = await gitInRepo(repo.dir, [
      "merge-tree",
      mergeBase.stdout,
      deleteCommit.stdout,
      modifyCommit.stdout,
    ]);

    // Should detect delete/modify conflict
    expect(mergeTreeResult.stdout).toMatch(/removed in (local|remote)/);
  } finally {
    await repo.cleanup();
  }
});

Deno.test("integration - rename/modify conflict with diff", async () => {
  const repo = await createTestRepo("rename_modify");
  try {
    await setupBasicRepo(repo.dir);

    // Create a file on main branch
    await writeFile(repo.dir, "original.txt", "line 1\nline 2\nline 3\n");
    await gitInRepo(repo.dir, ["add", "original.txt"]);
    await gitInRepo(repo.dir, ["commit", "-m", "add original.txt"]);

    // Create feature branch that renames the file
    await gitInRepo(repo.dir, ["checkout", "-b", "feature"]);
    await gitInRepo(repo.dir, ["mv", "original.txt", "renamed.txt"]);
    await writeFile(
      repo.dir,
      "renamed.txt",
      "line 1\nline 2\nline 3\nline 4\n",
    );
    await gitInRepo(repo.dir, ["add", "renamed.txt"]);
    await gitInRepo(repo.dir, ["commit", "-m", "rename and add line 4"]);

    // Go back to main and modify the original file
    await gitInRepo(repo.dir, ["checkout", "main"]);
    await writeFile(
      repo.dir,
      "original.txt",
      "line 1\nline 2 modified\nline 3\n",
    );
    await gitInRepo(repo.dir, ["add", "original.txt"]);
    await gitInRepo(repo.dir, ["commit", "-m", "modify line 2"]);

    // Switch back to feature branch to test from that perspective
    await gitInRepo(repo.dir, ["checkout", "feature"]);

    // Import and run the check
    const originalDir = Deno.cwd();
    try {
      Deno.chdir(repo.dir);
      const {
        checkConflictsWithMergeTree,
        getConflictingFilesFromMergeTree,
        fileDiffFor,
        resolveCommit,
        getEmptyTreeHash,
        runCmd,
      } = await import("../src/lib.ts");

      const oursResult = await resolveCommit("HEAD");
      const theirsResult = await resolveCommit("main");
      const oursCommit = oursResult.commit;
      const theirsCommit = theirsResult.commit;
      const mbRes = await runCmd([
        "git",
        "merge-base",
        oursCommit,
        theirsCommit,
      ]);
      const mergeBase = mbRes.code === 0 && mbRes.stdout ? mbRes.stdout : "";
      const emptyTree = await getEmptyTreeHash();

      // Should detect conflict
      const hasConflict = await checkConflictsWithMergeTree(
        mergeBase || emptyTree,
        oursCommit,
        theirsCommit,
        emptyTree,
      );
      expect(hasConflict).toBe(true);

      // Get conflicting files
      const conflictingFiles = await getConflictingFilesFromMergeTree(
        mergeBase || emptyTree,
        oursCommit,
        theirsCommit,
        emptyTree,
      );
      expect(conflictingFiles.length).toBe(1);
      expect(conflictingFiles[0]).toBe("original.txt");

      // Get diff - should show rename and content differences
      const diff = await fileDiffFor(
        "original.txt",
        oursCommit,
        theirsCommit,
        mergeBase || undefined,
      );
      expect(diff).toContain("RENAME/MODIFY CONFLICT");
      expect(diff).toContain("renamed original.txt → renamed.txt");
      expect(diff).toContain("modified original.txt");
      // Should show actual content differences, not entire file
      expect(diff).toContain("line 2");
      expect(diff).toContain("line 4");
    } finally {
      Deno.chdir(originalDir);
    }
  } finally {
    await repo.cleanup();
  }
});

Deno.test("integration - file moved to subdirectory with modification", async () => {
  const repo = await createTestRepo("move_to_subdir");
  try {
    await setupBasicRepo(repo.dir);

    // Create a file on main branch
    await writeFile(
      repo.dir,
      "config.json",
      '{"version": "1.0", "name": "app"}\n',
    );
    await gitInRepo(repo.dir, ["add", "config.json"]);
    await gitInRepo(repo.dir, ["commit", "-m", "add config"]);

    // Create feature branch that moves file to subdirectory
    await gitInRepo(repo.dir, ["checkout", "-b", "feature"]);
    await Deno.mkdir(`${repo.dir}/conf`, { recursive: true });
    await gitInRepo(repo.dir, ["mv", "config.json", "conf/config.json"]);
    await writeFile(
      repo.dir,
      "conf/config.json",
      '{"version": "2.0", "name": "app"}\n',
    );
    await gitInRepo(repo.dir, ["add", "conf/config.json"]);
    await gitInRepo(repo.dir, [
      "commit",
      "-m",
      "move to conf/ and update version",
    ]);

    // Go back to main and modify the file
    await gitInRepo(repo.dir, ["checkout", "main"]);
    await writeFile(
      repo.dir,
      "config.json",
      '{"version": "1.0", "name": "myapp"}\n',
    );
    await gitInRepo(repo.dir, ["add", "config.json"]);
    await gitInRepo(repo.dir, ["commit", "-m", "change app name"]);

    // Switch back to feature branch
    await gitInRepo(repo.dir, ["checkout", "feature"]);

    const originalDir = Deno.cwd();
    try {
      Deno.chdir(repo.dir);
      const {
        checkConflictsWithMergeTree,
        getConflictingFilesFromMergeTree,
        fileDiffFor,
        resolveCommit,
        getEmptyTreeHash,
        runCmd,
      } = await import("../src/lib.ts");

      const oursResult = await resolveCommit("HEAD");
      const theirsResult = await resolveCommit("main");
      const oursCommit = oursResult.commit;
      const theirsCommit = theirsResult.commit;
      const mbRes = await runCmd([
        "git",
        "merge-base",
        oursCommit,
        theirsCommit,
      ]);
      const mergeBase = mbRes.code === 0 && mbRes.stdout ? mbRes.stdout : "";
      const emptyTree = await getEmptyTreeHash();

      const hasConflict = await checkConflictsWithMergeTree(
        mergeBase || emptyTree,
        oursCommit,
        theirsCommit,
        emptyTree,
      );
      expect(hasConflict).toBe(true);

      const conflictingFiles = await getConflictingFilesFromMergeTree(
        mergeBase || emptyTree,
        oursCommit,
        theirsCommit,
        emptyTree,
      );
      expect(conflictingFiles.length).toBe(1);
      expect(conflictingFiles[0]).toBe("config.json");

      const diff = await fileDiffFor(
        "config.json",
        oursCommit,
        theirsCommit,
        mergeBase || undefined,
      );
      // The diff should either show rename conflict detection OR show the delete/modify conflict
      // Git's behavior may vary, so we check for either case
      if (diff && diff.includes("RENAME/MODIFY CONFLICT")) {
        expect(diff).toContain("config.json → conf/config.json");
      } else {
        // It's detected as a delete/modify conflict instead
        expect(diff).toBeTruthy();
      }
    } finally {
      Deno.chdir(originalDir);
    }
  } finally {
    await repo.cleanup();
  }
});

Deno.test("integration - multiple files renamed and modified", async () => {
  const repo = await createTestRepo("multiple_renames");
  try {
    await setupBasicRepo(repo.dir);

    // Create multiple files on main branch
    await writeFile(repo.dir, "file1.txt", "content 1\n");
    await writeFile(repo.dir, "file2.txt", "content 2\n");
    await writeFile(repo.dir, "file3.txt", "content 3\n");
    await gitInRepo(repo.dir, ["add", "."]);
    await gitInRepo(repo.dir, ["commit", "-m", "add files"]);

    // Create feature branch that renames multiple files
    await gitInRepo(repo.dir, ["checkout", "-b", "feature"]);
    await gitInRepo(repo.dir, ["mv", "file1.txt", "renamed1.txt"]);
    await gitInRepo(repo.dir, ["mv", "file2.txt", "renamed2.txt"]);
    await writeFile(repo.dir, "renamed1.txt", "content 1 updated\n");
    await writeFile(repo.dir, "renamed2.txt", "content 2 updated\n");
    await gitInRepo(repo.dir, ["add", "."]);
    await gitInRepo(repo.dir, [
      "commit",
      "-m",
      "rename and update file1 and file2",
    ]);

    // Go back to main and modify the original files
    await gitInRepo(repo.dir, ["checkout", "main"]);
    await writeFile(repo.dir, "file1.txt", "content 1 modified\n");
    await writeFile(repo.dir, "file2.txt", "content 2 modified\n");
    await gitInRepo(repo.dir, ["add", "."]);
    await gitInRepo(repo.dir, ["commit", "-m", "modify file1 and file2"]);

    // Switch back to feature branch
    await gitInRepo(repo.dir, ["checkout", "feature"]);

    const originalDir = Deno.cwd();
    try {
      Deno.chdir(repo.dir);
      const {
        checkConflictsWithMergeTree,
        getConflictingFilesFromMergeTree,
        fileDiffFor,
        resolveCommit,
        getEmptyTreeHash,
        runCmd,
      } = await import("../src/lib.ts");

      const oursResult = await resolveCommit("HEAD");
      const theirsResult = await resolveCommit("main");
      const oursCommit = oursResult.commit;
      const theirsCommit = theirsResult.commit;
      const mbRes = await runCmd([
        "git",
        "merge-base",
        oursCommit,
        theirsCommit,
      ]);
      const mergeBase = mbRes.code === 0 && mbRes.stdout ? mbRes.stdout : "";
      const emptyTree = await getEmptyTreeHash();

      const hasConflict = await checkConflictsWithMergeTree(
        mergeBase || emptyTree,
        oursCommit,
        theirsCommit,
        emptyTree,
      );
      expect(hasConflict).toBe(true);

      const conflictingFiles = await getConflictingFilesFromMergeTree(
        mergeBase || emptyTree,
        oursCommit,
        theirsCommit,
        emptyTree,
      );
      expect(conflictingFiles.length).toBeGreaterThanOrEqual(2);
      expect(conflictingFiles).toContain("file1.txt");
      expect(conflictingFiles).toContain("file2.txt");

      // Check both files have diffs (may or may not be detected as renames depending on Git's rename detection threshold)
      const diff1 = await fileDiffFor(
        "file1.txt",
        oursCommit,
        theirsCommit,
        mergeBase || undefined,
      );
      expect(diff1).toBeTruthy();
      if (diff1 && diff1.includes("RENAME/MODIFY CONFLICT")) {
        expect(diff1).toContain("file1.txt → renamed1.txt");
      }

      const diff2 = await fileDiffFor(
        "file2.txt",
        oursCommit,
        theirsCommit,
        mergeBase || undefined,
      );
      expect(diff2).toBeTruthy();
      if (diff2 && diff2.includes("RENAME/MODIFY CONFLICT")) {
        expect(diff2).toContain("file2.txt → renamed2.txt");
      }
    } finally {
      Deno.chdir(originalDir);
    }
  } finally {
    await repo.cleanup();
  }
});

Deno.test("integration - rename without modification (no conflict)", async () => {
  const repo = await createTestRepo("rename_no_modify");
  try {
    await setupBasicRepo(repo.dir);

    // Create a file on main branch
    await writeFile(repo.dir, "original.txt", "unchanged content\n");
    await gitInRepo(repo.dir, ["add", "original.txt"]);
    await gitInRepo(repo.dir, ["commit", "-m", "add original.txt"]);

    // Create feature branch that only renames the file (no content change)
    await gitInRepo(repo.dir, ["checkout", "-b", "feature"]);
    await gitInRepo(repo.dir, ["mv", "original.txt", "renamed.txt"]);
    await gitInRepo(repo.dir, ["add", "renamed.txt"]);
    await gitInRepo(repo.dir, ["commit", "-m", "just rename"]);

    // Go back to main - no changes
    await gitInRepo(repo.dir, ["checkout", "main"]);

    // Switch back to feature branch
    await gitInRepo(repo.dir, ["checkout", "feature"]);

    const originalDir = Deno.cwd();
    try {
      Deno.chdir(repo.dir);
      const {
        checkConflictsWithMergeTree,
        resolveCommit,
        getEmptyTreeHash,
        runCmd,
      } = await import("../src/lib.ts");

      const oursResult = await resolveCommit("HEAD");
      const theirsResult = await resolveCommit("main");
      const oursCommit = oursResult.commit;
      const theirsCommit = theirsResult.commit;
      const mbRes = await runCmd([
        "git",
        "merge-base",
        oursCommit,
        theirsCommit,
      ]);
      const mergeBase = mbRes.code === 0 && mbRes.stdout ? mbRes.stdout : "";
      const emptyTree = await getEmptyTreeHash();

      // Should NOT detect conflict since content is unchanged
      const hasConflict = await checkConflictsWithMergeTree(
        mergeBase || emptyTree,
        oursCommit,
        theirsCommit,
        emptyTree,
      );
      expect(hasConflict).toBe(false);
    } finally {
      Deno.chdir(originalDir);
    }
  } finally {
    await repo.cleanup();
  }
});

Deno.test("integration - JSON output with rename/modify conflict", async () => {
  const repo = await createTestRepo("json_rename");
  try {
    await setupBasicRepo(repo.dir);

    // Create a file
    await writeFile(repo.dir, "data.txt", "original data\n");
    await gitInRepo(repo.dir, ["add", "data.txt"]);
    await gitInRepo(repo.dir, ["commit", "-m", "add data"]);

    // Rename on feature branch
    await gitInRepo(repo.dir, ["checkout", "-b", "feature"]);
    await gitInRepo(repo.dir, ["mv", "data.txt", "info.txt"]);
    await writeFile(repo.dir, "info.txt", "original data\nmore info\n");
    await gitInRepo(repo.dir, ["add", "info.txt"]);
    await gitInRepo(repo.dir, [
      "commit",
      "-m",
      "rename to info.txt and add content",
    ]);

    // Modify on main
    await gitInRepo(repo.dir, ["checkout", "main"]);
    await writeFile(
      repo.dir,
      "data.txt",
      "original data\ndifferent addition\n",
    );
    await gitInRepo(repo.dir, ["add", "data.txt"]);
    await gitInRepo(repo.dir, ["commit", "-m", "add different content"]);

    // Switch back to feature
    await gitInRepo(repo.dir, ["checkout", "feature"]);

    const originalDir = Deno.cwd();
    try {
      Deno.chdir(repo.dir);
      const {
        checkConflictsWithMergeTree,
        getConflictingFilesFromMergeTree,
        getFileConflictDetail,
        resolveCommit,
        getEmptyTreeHash,
        getCurrentRef,
        runCmd,
      } = await import("../src/lib.ts");

      const currentRef = await getCurrentRef();
      const oursResult = await resolveCommit("HEAD");
      const theirsResult = await resolveCommit("main");
      const oursCommit = oursResult.commit;
      const theirsCommit = theirsResult.commit;
      const mbRes = await runCmd([
        "git",
        "merge-base",
        oursCommit,
        theirsCommit,
      ]);
      const mergeBase = mbRes.code === 0 && mbRes.stdout ? mbRes.stdout : "";
      const emptyTree = await getEmptyTreeHash();

      const hasConflict = await checkConflictsWithMergeTree(
        mergeBase || emptyTree,
        oursCommit,
        theirsCommit,
        emptyTree,
      );
      expect(hasConflict).toBe(true);

      const conflictingFiles = await getConflictingFilesFromMergeTree(
        mergeBase || emptyTree,
        oursCommit,
        theirsCommit,
        emptyTree,
      );

      // Build JSON result like main.ts does with new structure
      interface FileDetail {
        conflict_type: string;
        message?: string;
        rename?: {
          old_path: string;
          new_path: string;
          side: string;
        };
        diff?: string;
      }

      const result = {
        current_ref: currentRef,
        other_ref: "main",
        ours_commit: oursCommit,
        theirs_commit: theirsCommit,
        merge_base: mergeBase,
        conflicts: true,
        conflicted_files: conflictingFiles,
        files: {} as Record<string, FileDetail>,
      };

      for (const f of conflictingFiles) {
        result.files[f] = await getFileConflictDetail(
          f,
          oursCommit,
          theirsCommit,
          mergeBase || undefined,
        );
      }

      // Verify JSON structure
      expect(result.conflicts).toBe(true);
      expect(result.conflicted_files).toContain("data.txt");
      expect(result.files["data.txt"]).toBeTruthy();
      expect(result.files["data.txt"].conflict_type).toBe("rename_modify");
      expect(result.files["data.txt"].message).toContain("data.txt → info.txt");
      expect(result.files["data.txt"].rename).toBeTruthy();
      expect(result.files["data.txt"].rename?.old_path).toBe("data.txt");
      expect(result.files["data.txt"].rename?.new_path).toBe("info.txt");

      // Verify it's valid JSON when stringified
      const jsonString = JSON.stringify(result, null, 2);
      expect(jsonString).toContain("rename_modify");

      // Verify it can be parsed back
      const parsed = JSON.parse(jsonString);
      expect(parsed.files["data.txt"].conflict_type).toBe("rename_modify");
    } finally {
      Deno.chdir(originalDir);
    }
  } finally {
    await repo.cleanup();
  }
});
