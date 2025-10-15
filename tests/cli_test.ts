/**
 * End-to-end CLI tests for the main script
 * Tests the actual command-line interface
 */

import { expect } from "@std/expect";

interface TestRepo {
  dir: string;
  cleanup: () => Promise<void>;
}

async function createTestRepo(name: string): Promise<TestRepo> {
  const tempDir = await Deno.makeTempDir({ prefix: `git_cli_test_${name}_` });

  const cleanup = async () => {
    try {
      await Deno.remove(tempDir, { recursive: true });
    } catch {
      // ignore
    }
  };

  return { dir: tempDir, cleanup };
}

async function runGit(dir: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const command = new Deno.Command("git", {
    args,
    cwd: dir,
    stdout: "piped",
    stderr: "piped",
  });
  const { code, stdout, stderr } = await command.output();
  return {
    code,
    stdout: new TextDecoder().decode(stdout).trim(),
    stderr: new TextDecoder().decode(stderr).trim(),
  };
}

async function runScript(
  dir: string,
  args: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  const scriptPath = new URL("../src/main.ts", import.meta.url).pathname;
  const command = new Deno.Command("deno", {
    args: ["run", "--allow-run", "--allow-read", "--allow-write", "--allow-env", scriptPath, ...args],
    cwd: dir,
    stdout: "piped",
    stderr: "piped",
  });
  const { code, stdout, stderr } = await command.output();
  return {
    code,
    stdout: new TextDecoder().decode(stdout).trim(),
    stderr: new TextDecoder().decode(stderr).trim(),
  };
}

async function setupRepo(dir: string): Promise<void> {
  await runGit(dir, ["init"]);
  await runGit(dir, ["config", "user.email", "test@test.com"]);
  await runGit(dir, ["config", "user.name", "Test User"]);
  await runGit(dir, ["commit", "--allow-empty", "-m", "initial"]);
}

async function writeFile(dir: string, filename: string, content: string): Promise<void> {
  await Deno.writeTextFile(`${dir}/${filename}`, content);
}

Deno.test("CLI - help flag", async () => {
  const repo = await createTestRepo("help");
  try {
    await setupRepo(repo.dir);

    const result = await runScript(repo.dir, ["--help"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Usage:");
    expect(result.stdout).toContain("--fetch");
    expect(result.stdout).toContain("--diff");
    expect(result.stdout).toContain("--json");
  } finally {
    await repo.cleanup();
  }
});

Deno.test("CLI - no conflicts scenario", async () => {
  const repo = await createTestRepo("no_conflicts_cli");
  try {
    await setupRepo(repo.dir);

    // Create main branch
    await writeFile(repo.dir, "file1.txt", "content\n");
    await runGit(repo.dir, ["add", "file1.txt"]);
    await runGit(repo.dir, ["commit", "-m", "add file1"]);
    await runGit(repo.dir, ["branch", "main"]);

    // Create feature branch with different file
    await runGit(repo.dir, ["checkout", "-b", "feature"]);
    await writeFile(repo.dir, "file2.txt", "other content\n");
    await runGit(repo.dir, ["add", "file2.txt"]);
    await runGit(repo.dir, ["commit", "-m", "add file2"]);

    // Run script to check feature vs main
    const result = await runScript(repo.dir, ["main"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("No conflicts expected");
  } finally {
    await repo.cleanup();
  }
});

Deno.test("CLI - conflicts detected", async () => {
  const repo = await createTestRepo("conflicts_cli");
  try {
    await setupRepo(repo.dir);

    // Create initial file
    await writeFile(repo.dir, "conflict.txt", "line1\nline2\nline3\n");
    await runGit(repo.dir, ["add", "conflict.txt"]);
    await runGit(repo.dir, ["commit", "-m", "initial file"]);
    const baseCommit = (await runGit(repo.dir, ["rev-parse", "HEAD"])).stdout;

    // Branch 1
    await runGit(repo.dir, ["checkout", "-b", "branch1"]);
    await writeFile(repo.dir, "conflict.txt", "line1\nmodified in branch1\nline3\n");
    await runGit(repo.dir, ["add", "conflict.txt"]);
    await runGit(repo.dir, ["commit", "-m", "modify in branch1"]);

    // Main branch - reset to base and modify
    await runGit(repo.dir, ["checkout", "main"]);
    await runGit(repo.dir, ["reset", "--hard", baseCommit]);
    await writeFile(repo.dir, "conflict.txt", "line1\nmodified in main\nline3\n");
    await runGit(repo.dir, ["add", "conflict.txt"]);
    await runGit(repo.dir, ["commit", "-m", "modify in main"]);

    // Check branch1 from main
    const result = await runScript(repo.dir, ["branch1"]);
    expect(result.code).toBe(1); // Conflicts expected
    expect(result.stdout).toContain("CONFLICTS EXPECTED");
    expect(result.stdout).toContain("conflict.txt");
  } finally {
    await repo.cleanup();
  }
});

Deno.test("CLI - json output", async () => {
  const repo = await createTestRepo("json_cli");
  try {
    await setupRepo(repo.dir);

    await writeFile(repo.dir, "file.txt", "content\n");
    await runGit(repo.dir, ["add", "file.txt"]);
    await runGit(repo.dir, ["commit", "-m", "add file"]);
    await runGit(repo.dir, ["branch", "main"]);

    await runGit(repo.dir, ["checkout", "-b", "feature"]);
    await writeFile(repo.dir, "other.txt", "other\n");
    await runGit(repo.dir, ["add", "other.txt"]);
    await runGit(repo.dir, ["commit", "-m", "add other"]);

    const result = await runScript(repo.dir, ["--json", "main"]);
    expect(result.code).toBe(0);

    // Parse JSON output
    const json = JSON.parse(result.stdout);
    expect(json).toHaveProperty("current_ref");
    expect(json).toHaveProperty("other_ref");
    expect(json).toHaveProperty("ours_commit");
    expect(json).toHaveProperty("theirs_commit");
    expect(json).toHaveProperty("merge_base");
    expect(json).toHaveProperty("conflicts");
    expect(json).toHaveProperty("conflicted_files");
    expect(json).toHaveProperty("diffs");
    expect(json.conflicts).toBe(false);
    expect(json.other_ref).toBe("main");
  } finally {
    await repo.cleanup();
  }
});

Deno.test("CLI - json output with conflicts", async () => {
  const repo = await createTestRepo("json_conflicts_cli");
  try {
    await setupRepo(repo.dir);

    // Setup conflict scenario
    await writeFile(repo.dir, "conflict.txt", "original\n");
    await runGit(repo.dir, ["add", "conflict.txt"]);
    await runGit(repo.dir, ["commit", "-m", "original"]);
    const base = (await runGit(repo.dir, ["rev-parse", "HEAD"])).stdout;

    await runGit(repo.dir, ["checkout", "-b", "branch1"]);
    await writeFile(repo.dir, "conflict.txt", "branch1\n");
    await runGit(repo.dir, ["add", "conflict.txt"]);
    await runGit(repo.dir, ["commit", "-m", "branch1"]);

    await runGit(repo.dir, ["checkout", "main"]);
    await runGit(repo.dir, ["reset", "--hard", base]);
    await writeFile(repo.dir, "conflict.txt", "main\n");
    await runGit(repo.dir, ["add", "conflict.txt"]);
    await runGit(repo.dir, ["commit", "-m", "main"]);

    const result = await runScript(repo.dir, ["--json", "branch1"]);
    expect(result.code).toBe(1);

    const json = JSON.parse(result.stdout);
    expect(json.conflicts).toBe(true);
    expect(json.conflicted_files).toContain("conflict.txt");
  } finally {
    await repo.cleanup();
  }
});

Deno.test("CLI - diff output", async () => {
  const repo = await createTestRepo("diff_cli");
  try {
    await setupRepo(repo.dir);

    await writeFile(repo.dir, "file.txt", "line1\nline2\nline3\n");
    await runGit(repo.dir, ["add", "file.txt"]);
    await runGit(repo.dir, ["commit", "-m", "initial"]);
    const base = (await runGit(repo.dir, ["rev-parse", "HEAD"])).stdout;

    await runGit(repo.dir, ["checkout", "-b", "branch1"]);
    await writeFile(repo.dir, "file.txt", "line1\nbranch1\nline3\n");
    await runGit(repo.dir, ["add", "file.txt"]);
    await runGit(repo.dir, ["commit", "-m", "branch1"]);

    await runGit(repo.dir, ["checkout", "main"]);
    await runGit(repo.dir, ["reset", "--hard", base]);
    await writeFile(repo.dir, "file.txt", "line1\nmain\nline3\n");
    await runGit(repo.dir, ["add", "file.txt"]);
    await runGit(repo.dir, ["commit", "-m", "main"]);

    const result = await runScript(repo.dir, ["--diff", "branch1"]);
    expect(result.code).toBe(1);
    expect(result.stdout).toContain("Unified diffs");
    expect(result.stdout).toContain("file.txt");
    expect(result.stdout).toContain("-");
    expect(result.stdout).toContain("+");
  } finally {
    await repo.cleanup();
  }
});

Deno.test("CLI - auto-detect default branch", async () => {
  const repo = await createTestRepo("autodetect_cli");
  try {
    await setupRepo(repo.dir);

    // Create main branch
    await writeFile(repo.dir, "file.txt", "content\n");
    await runGit(repo.dir, ["add", "file.txt"]);
    await runGit(repo.dir, ["commit", "-m", "add file"]);
    await runGit(repo.dir, ["branch", "main"]);

    // Create and checkout feature branch
    await runGit(repo.dir, ["checkout", "-b", "feature"]);

    // Run without specifying branch - should detect main
    const result = await runScript(repo.dir, []);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Detected other branch/ref");
    expect(result.stdout).toContain("main");
  } finally {
    await repo.cleanup();
  }
});

Deno.test("CLI - error on same branch", async () => {
  const repo = await createTestRepo("same_branch_cli");
  try {
    await setupRepo(repo.dir);

    await writeFile(repo.dir, "file.txt", "content\n");
    await runGit(repo.dir, ["add", "file.txt"]);
    await runGit(repo.dir, ["commit", "-m", "add file"]);
    await runGit(repo.dir, ["branch", "main"]);
    await runGit(repo.dir, ["checkout", "main"]);

    // Try to compare main with itself
    const result = await runScript(repo.dir, ["main"]);
    expect(result.code).toBe(2); // Error
    expect(result.stderr).toContain("same as current");
  } finally {
    await repo.cleanup();
  }
});

Deno.test("CLI - invalid branch", async () => {
  const repo = await createTestRepo("invalid_branch_cli");
  try {
    await setupRepo(repo.dir);

    await writeFile(repo.dir, "file.txt", "content\n");
    await runGit(repo.dir, ["add", "file.txt"]);
    await runGit(repo.dir, ["commit", "-m", "add file"]);

    // Try to compare with non-existent branch
    const result = await runScript(repo.dir, ["nonexistent"]);
    expect(result.code).toBe(2); // Error
    expect(result.stderr).toContain("Couldn't resolve");
  } finally {
    await repo.cleanup();
  }
});

Deno.test("CLI - not a git repository", async () => {
  const repo = await createTestRepo("not_git_cli");
  try {
    // Don't initialize git
    const result = await runScript(repo.dir, []);
    expect(result.code).toBe(2); // Error
    expect(result.stderr).toContain("Not a git repository");
  } finally {
    await repo.cleanup();
  }
});

Deno.test("CLI - combined flags", async () => {
  const repo = await createTestRepo("combined_flags_cli");
  try {
    await setupRepo(repo.dir);

    await writeFile(repo.dir, "file.txt", "original\n");
    await runGit(repo.dir, ["add", "file.txt"]);
    await runGit(repo.dir, ["commit", "-m", "original"]);
    const base = (await runGit(repo.dir, ["rev-parse", "HEAD"])).stdout;

    await runGit(repo.dir, ["checkout", "-b", "branch1"]);
    await writeFile(repo.dir, "file.txt", "branch1\n");
    await runGit(repo.dir, ["add", "file.txt"]);
    await runGit(repo.dir, ["commit", "-m", "branch1"]);

    await runGit(repo.dir, ["checkout", "main"]);
    await runGit(repo.dir, ["reset", "--hard", base]);
    await writeFile(repo.dir, "file.txt", "main\n");
    await runGit(repo.dir, ["add", "file.txt"]);
    await runGit(repo.dir, ["commit", "-m", "main"]);

    // Use both --json and --diff
    const result = await runScript(repo.dir, ["--json", "--diff", "branch1"]);
    expect(result.code).toBe(1);

    const json = JSON.parse(result.stdout);
    expect(json.conflicts).toBe(true);
    expect(json.diffs["file.txt"]).toBeTruthy();
  } finally {
    await repo.cleanup();
  }
});

Deno.test("CLI - short alias for diff", async () => {
  const repo = await createTestRepo("diff_alias_cli");
  try {
    await setupRepo(repo.dir);

    await writeFile(repo.dir, "file.txt", "original\n");
    await runGit(repo.dir, ["add", "file.txt"]);
    await runGit(repo.dir, ["commit", "-m", "original"]);
    const base = (await runGit(repo.dir, ["rev-parse", "HEAD"])).stdout;

    await runGit(repo.dir, ["checkout", "-b", "branch1"]);
    await writeFile(repo.dir, "file.txt", "branch1\n");
    await runGit(repo.dir, ["add", "file.txt"]);
    await runGit(repo.dir, ["commit", "-m", "branch1"]);

    await runGit(repo.dir, ["checkout", "main"]);
    await runGit(repo.dir, ["reset", "--hard", base]);
    await writeFile(repo.dir, "file.txt", "main\n");
    await runGit(repo.dir, ["add", "file.txt"]);
    await runGit(repo.dir, ["commit", "-m", "main"]);

    // Use -d instead of --diff
    const result = await runScript(repo.dir, ["-d", "branch1"]);
    expect(result.code).toBe(1);
    expect(result.stdout).toContain("Unified diffs");
  } finally {
    await repo.cleanup();
  }
});
