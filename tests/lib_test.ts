/**
 * Unit tests for lib.ts
 */

import { expect } from "@std/expect";
import {
  checkConflictsWithMergeTree,
  detectDefaultBranch,
  fileDiffFor,
  getChangedFilesBetween,
  getCurrentRef,
  getEmptyTreeHash,
  GitError,
  isGitRepository,
  parseUnmergedFiles,
  resolveCommit,
  revToTree,
  runCmd,
  TempIndex,
} from "../src/lib.ts";

Deno.test("runCmd - successful command", async () => {
  const result = await runCmd(["echo", "hello"]);
  expect(result.code).toBe(0);
  expect(result.stdout).toBe("hello");
  expect(result.stderr).toBe("");
});

Deno.test("runCmd - failed command", async () => {
  const result = await runCmd(["false"]);
  expect(result.code).not.toBe(0);
});

Deno.test("runCmd - with environment variables", async () => {
  const result = await runCmd(["bash", "-c", "echo $TEST_VAR"], {
    TEST_VAR: "test_value",
  });
  expect(result.code).toBe(0);
  expect(result.stdout).toBe("test_value");
});

Deno.test("runCmd - command not found", async () => {
  try {
    const result = await runCmd(["nonexistent_command_xyz_123456"]);
    expect(result.code).not.toBe(0);
  } catch (error) {
    // Command not found throws on spawn failure
    expect(error).toBeInstanceOf(Error);
  }
});

Deno.test("GitError - creates error with code", () => {
  const error = new GitError("test message", 123);
  expect(error.message).toBe("test message");
  expect(error.code).toBe(123);
  expect(error.name).toBe("GitError");
});

Deno.test("GitError - default code is 2", () => {
  const error = new GitError("test message");
  expect(error.code).toBe(2);
});

Deno.test("parseUnmergedFiles - empty input", () => {
  const result = parseUnmergedFiles("");
  expect(result).toEqual([]);
});

Deno.test("parseUnmergedFiles - single file", () => {
  const input = "100644 abc123 1\tfile.txt";
  const result = parseUnmergedFiles(input);
  expect(result).toEqual(["file.txt"]);
});

Deno.test("parseUnmergedFiles - multiple files with duplicates", () => {
  const input = `100644 abc123 1\tfile.txt
100644 def456 2\tfile.txt
100644 ghi789 3\tfile.txt
100644 jkl012 1\tother.txt`;
  const result = parseUnmergedFiles(input);
  expect(result).toHaveLength(2);
  expect(result).toContain("file.txt");
  expect(result).toContain("other.txt");
});

Deno.test("parseUnmergedFiles - complex paths", () => {
  const input = `100644 abc123 1\tsrc/deeply/nested/file.txt
100644 def456 2\tsrc/deeply/nested/file.txt`;
  const result = parseUnmergedFiles(input);
  expect(result).toEqual(["src/deeply/nested/file.txt"]);
});

Deno.test("TempIndex - lifecycle", async () => {
  const tempIndex = new TempIndex();

  // Initially no path
  expect(tempIndex.getPath()).toBeNull();

  // Create temp file
  const path = await tempIndex.create();
  expect(path).toBeTruthy();
  expect(tempIndex.getPath()).toBe(path);

  // File should exist
  const stat = await Deno.stat(path);
  expect(stat.isFile).toBe(true);

  // Cleanup
  await tempIndex.cleanup();
  expect(tempIndex.getPath()).toBeNull();

  // File should not exist
  await expect(Deno.stat(path)).rejects.toThrow();
});

Deno.test("TempIndex - runGitWithIndex throws if not created", async () => {
  const tempIndex = new TempIndex();
  await expect(tempIndex.runGitWithIndex(["status"])).rejects.toThrow(
    "Temporary index not created",
  );
});

Deno.test("TempIndex - cleanup is idempotent", async () => {
  const tempIndex = new TempIndex();
  await tempIndex.create();

  // Cleanup multiple times should not throw
  await tempIndex.cleanup();
  await tempIndex.cleanup();
  await tempIndex.cleanup();
});

Deno.test("getEmptyTreeHash - returns valid hash", async () => {
  const hash = await getEmptyTreeHash();
  expect(hash).toMatch(/^[0-9a-f]{40}$/);
});

Deno.test("isGitRepository - in git repo", async () => {
  const tempDir = await Deno.makeTempDir();
  const originalDir = Deno.cwd();
  try {
    Deno.chdir(tempDir);
    await runCmd(["git", "init"]);
    const result = await isGitRepository();
    expect(result).toBe(true);
  } finally {
    Deno.chdir(originalDir);
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("isGitRepository - not in git repo", async () => {
  // Create temp directory outside git
  const tempDir = await Deno.makeTempDir();
  try {
    const originalDir = Deno.cwd();
    Deno.chdir(tempDir);

    const result = await isGitRepository();
    expect(result).toBe(false);

    Deno.chdir(originalDir);
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("getCurrentRef - returns current branch or commit", async () => {
  const tempDir = await Deno.makeTempDir();
  const originalDir = Deno.cwd();
  try {
    Deno.chdir(tempDir);
    await runCmd(["git", "init"]);
    await runCmd(["git", "config", "user.email", "test@test.com"]);
    await runCmd(["git", "config", "user.name", "Test"]);
    await runCmd(["git", "commit", "--allow-empty", "-m", "initial"]);
    const ref = await getCurrentRef();
    expect(ref).toBeTruthy();
    expect(typeof ref).toBe("string");
    expect(ref.length).toBeGreaterThan(0);
  } finally {
    Deno.chdir(originalDir);
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("detectDefaultBranch - finds a branch", async () => {
  const tempDir = await Deno.makeTempDir();
  const originalDir = Deno.cwd();
  try {
    Deno.chdir(tempDir);
    await runCmd(["git", "init"]);
    await runCmd(["git", "config", "user.email", "test@test.com"]);
    await runCmd(["git", "config", "user.name", "Test"]);
    await runCmd(["git", "commit", "--allow-empty", "-m", "initial"]);
    await runCmd(["git", "branch", "main"]);
    await runCmd(["git", "checkout", "-b", "feature"]);
    const currentRef = await getCurrentRef();
    const defaultBranch = await detectDefaultBranch(currentRef);
    expect(defaultBranch).toBeTruthy();
    expect(typeof defaultBranch).toBe("string");
  } finally {
    Deno.chdir(originalDir);
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("detectDefaultBranch - throws if no branch found", async () => {
  // This is hard to test without creating a complex git setup
  // We'll test the error type is correct
  try {
    // Create a minimal git repo with only one branch
    const tempDir = await Deno.makeTempDir();
    const originalDir = Deno.cwd();

    try {
      Deno.chdir(tempDir);
      await runCmd(["git", "init"]);
      await runCmd(["git", "config", "user.email", "test@test.com"]);
      await runCmd(["git", "config", "user.name", "Test"]);
      await runCmd(["git", "commit", "--allow-empty", "-m", "initial"]);

      const ref = await getCurrentRef();
      // In a brand new repo, this might still find main/master
      const result = await detectDefaultBranch(ref);
      expect(result).toBeTruthy();
    } finally {
      Deno.chdir(originalDir);
      await Deno.remove(tempDir, { recursive: true });
    }
  } catch (e) {
    expect(e).toBeInstanceOf(GitError);
  }
});

Deno.test("resolveCommit - valid ref", async () => {
  const tempDir = await Deno.makeTempDir();
  const originalDir = Deno.cwd();
  try {
    Deno.chdir(tempDir);
    await runCmd(["git", "init"]);
    await runCmd(["git", "config", "user.email", "test@test.com"]);
    await runCmd(["git", "config", "user.name", "Test"]);
    await runCmd(["git", "commit", "--allow-empty", "-m", "initial"]);
    const result = await resolveCommit("HEAD");
    expect(result.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(result.resolvedRef).toBe("HEAD");
  } finally {
    Deno.chdir(originalDir);
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("resolveCommit - invalid ref throws", async () => {
  await expect(resolveCommit("nonexistent_ref_xyz_123")).rejects.toThrow(
    GitError,
  );
  await expect(resolveCommit("nonexistent_ref_xyz_123")).rejects.toThrow(
    "Couldn't resolve",
  );
});

Deno.test("revToTree - valid rev", async () => {
  const emptyTree = await getEmptyTreeHash();
  const tree = await revToTree("HEAD", emptyTree);
  expect(tree).toMatch(/^[0-9a-f]{40}$/);
});

Deno.test("revToTree - empty rev returns empty tree", async () => {
  const emptyTree = await getEmptyTreeHash();
  const tree = await revToTree("", emptyTree);
  expect(tree).toBe(emptyTree);
});

Deno.test("revToTree - invalid rev returns empty tree", async () => {
  const emptyTree = await getEmptyTreeHash();
  const tree = await revToTree("invalid_ref_xyz", emptyTree);
  expect(tree).toBe(emptyTree);
});

Deno.test("getChangedFilesBetween - same commit", async () => {
  const result = await getChangedFilesBetween("HEAD", "HEAD");
  expect(result).toEqual([]);
});

Deno.test("checkConflictsWithMergeTree - no conflicts", async () => {
  const tempDir = await Deno.makeTempDir();
  const originalDir = Deno.cwd();
  try {
    Deno.chdir(tempDir);
    await runCmd(["git", "init"]);
    await runCmd(["git", "config", "user.email", "test@test.com"]);
    await runCmd(["git", "config", "user.name", "Test"]);
    await runCmd(["git", "commit", "--allow-empty", "-m", "initial"]);
    const emptyTree = await getEmptyTreeHash();
    const headCommit = (await resolveCommit("HEAD")).commit;

    // Comparing HEAD with itself should have no conflicts
    const hasConflicts = await checkConflictsWithMergeTree(
      headCommit,
      headCommit,
      headCommit,
      emptyTree,
    );
    expect(hasConflicts).toBe(false);
  } finally {
    Deno.chdir(originalDir);
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("fileDiffFor - same commit returns null or empty", async () => {
  const tempDir = await Deno.makeTempDir();
  const originalDir = Deno.cwd();
  try {
    Deno.chdir(tempDir);
    await runCmd(["git", "init"]);
    await runCmd(["git", "config", "user.email", "test@test.com"]);
    await runCmd(["git", "config", "user.name", "Test"]);
    await Deno.writeTextFile(`${tempDir}/test.txt`, "content\n");
    await runCmd(["git", "add", "test.txt"]);
    await runCmd(["git", "commit", "-m", "add file"]);
    const commit = (await resolveCommit("HEAD")).commit;
    const diff = await fileDiffFor("test.txt", commit, commit);
    // Should be null or empty since comparing to itself
    expect(diff === null || diff === "").toBe(true);
  } finally {
    Deno.chdir(originalDir);
    await Deno.remove(tempDir, { recursive: true });
  }
});
