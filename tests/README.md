# Test Suite for git-check-conflicts

This directory contains comprehensive tests for the `git-check-conflicts` tool.

## Test Structure

### 1. Unit Tests (`main_lib_test.ts`)

Tests individual functions in isolation.

**Coverage:**

- Command execution (`runCmd`)
- Git operations (getCurrentRef, resolveCommit, etc.)
- Error handling (GitError class)
- Parsing functions (parseUnmergedFiles)
- TempIndex lifecycle management
- Tree and commit resolution

**Run unit tests:**

```bash
deno task test:unit
```

### 2. Integration Tests (`integration_test.ts`)

Tests with real Git repositories created on-the-fly.

**Test Scenarios:**

- ✅ Repository with no conflicts
- ✅ Repository with conflicts
- ✅ Multiple conflicting files
- ✅ Binary files
- ✅ Remote tracking branches
- ✅ Orphan branches (no common ancestor)
- ✅ File diff generation
- ✅ Empty repositories
- ✅ TempIndex with read-tree conflict detection

**Run integration tests:**

```bash
deno task test:integration
```

### 3. CLI Tests (`cli_test.ts`)

End-to-end tests of the command-line interface.

**Test Scenarios:**

- ✅ Help flag (`--help`)
- ✅ No conflicts scenario
- ✅ Conflicts detected
- ✅ JSON output (`--json`)
- ✅ JSON output with conflicts
- ✅ Diff output (`--diff`, `-d`)
- ✅ Auto-detect default branch
- ✅ Error on same branch
- ✅ Invalid branch error
- ✅ Not a git repository error
- ✅ Combined flags
- ✅ Short aliases

**Run CLI tests:**

```bash
deno task test:cli
```

## Running All Tests

```bash
# Run all tests
deno task test

# Run with coverage
deno test --allow-run --allow-read --allow-write --allow-env --coverage=coverage

# Generate coverage report
deno coverage coverage --lcov > coverage.lcov
```

## Test Conventions

### Test Naming

- `Deno.test("category - description", ...)`
- Categories: `unit`, `integration`, `CLI`
- Descriptions: clear, concise action or scenario

### Assertions

Using `@std/expect` for readable assertions:

```typescript
expect(result).toBe(expected);
expect(array).toContain(item);
expect(fn).toThrow(ErrorClass);
expect(value).toHaveProperty("key");
```

### Test Isolation

- Each test creates its own temporary Git repository
- Cleanup happens in `finally` blocks
- Tests can run in parallel
- No shared state between tests

### Test Structure

```typescript
Deno.test("test name", async () => {
  // Arrange
  const repo = await createTestRepo("name");

  try {
    // Act
    const result = await functionUnderTest();

    // Assert
    expect(result).toBe(expected);
  } finally {
    // Cleanup
    await repo.cleanup();
  }
});
```

## Debugging Tests

### Run a single test

```bash
deno test --allow-all tests/main_lib_test.ts --filter "runCmd - successful"
```

### Run with debugging output

```bash
deno test --allow-all --log-level=debug
```

### Keep temporary directories

Modify cleanup to preserve test repos:

```typescript
const cleanup = async () => {
  console.log("Test repo at:", tempDir);
  // Comment out removal for debugging
  // await Deno.remove(tempDir, { recursive: true });
};
```

## Adding New Tests

### For new library functions

Add to `main_lib_test.ts`:

```typescript
Deno.test("functionName - scenario", async () => {
  const result = await functionName(input);
  expect(result).toBe(expected);
});
```

### For new CLI features

Add to `cli_test.ts`:

```typescript
Deno.test("CLI - new feature", async () => {
  const repo = await createTestRepo("feature");
  try {
    await setupRepo(repo.dir);
    // ... setup scenario

    const result = await runScript(repo.dir, ["--new-flag"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("expected output");
  } finally {
    await repo.cleanup();
  }
});
```

## Test Performance

Current test suite metrics:

- **Total tests**: 50+
- **Typical runtime**: ~5-10 seconds (depending on system)
- **Git repos created**: 1 per test (automatically cleaned up)

### Optimizations

- Tests run in parallel by default
- Minimal commits in test repos (use `--allow-empty` where possible)
- Temp directories auto-cleaned
- No network operations (all local)

## Coverage Goals

Target coverage:

- ✅ Functions: >90%
- ✅ Lines: >85%
- ✅ Branches: >80%
- ✅ Error paths: All major error conditions

## Continuous Integration

Add to CI pipeline:

```yaml
- name: Run tests
  run: deno task test

- name: Check coverage
  run: |
    deno test --allow-all --coverage=coverage
    deno coverage coverage --lcov > coverage.lcov
```

## Known Limitations

1. **Platform-specific**: Tests assume Unix-like environment (bash, git)
2. **Git requirement**: Requires Git 2.x or higher
3. **Temp directory**: Requires write access to system temp directory
4. **Parallel execution**: Some tests may be flaky if system is under heavy load

## Troubleshooting

### Test failures

**"Cannot find git"**

- Ensure Git is installed and in PATH

**"Permission denied"**

- Check file permissions on test directory
- Verify `--allow-read`, `--allow-write`, `--allow-run`, `--allow-env` flags

**"Temp directory not cleaned"**

- Check available disk space
- Verify write permissions to temp directory
- Tests should auto-cleanup even on failure

**"Git command timeout"**

- Large repositories or slow disk may cause issues
- Check system load
- Increase test timeout if needed

### Adding debug output

```typescript
Deno.test("debug test", async () => {
  const result = await runCmd(["git", "status"]);
  console.log("Git status:", result.stdout);
  console.log("Git stderr:", result.stderr);
  console.log("Exit code:", result.code);
});
```

## Resources

- [Deno Testing](https://docs.deno.com/runtime/manual/basics/testing/)
- [@std/expect Documentation](https://jsr.io/@std/expect)
- [Git Documentation](https://git-scm.com/docs)
