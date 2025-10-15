# Test Fixes Summary

## Issue Resolution

All tests now pass: **49/49 (100%)** ✅

## Problems Found and Fixed

### 1. **Incorrect merge-base resolution in `src/main.ts`**

**Problem:** Used `resolveCommit()` with `...` syntax instead of `git merge-base`
```typescript
// BEFORE (incorrect):
const mergeBaseResult = await resolveCommit(`${oursCommit}...${theirsCommit}`);
```

**Fix:** Use `git merge-base` directly
```typescript
// AFTER (correct):
const mbRes = await runCmd(["git", "merge-base", oursCommit, theirsCommit]);
const mergeBase = mbRes.code === 0 && mbRes.stdout ? mbRes.stdout : "";
```

**Impact:** This was causing "no common ancestor" errors even when branches had a merge base.

---

### 2. **Incorrect regex in `checkConflictsWithMergeTree()` in `src/lib.ts`**

**Problem:** Regex `/^<<<<<<< /m` was looking for conflict markers at the start of a line, but `git merge-tree` output shows them preceded by a `+` diff marker.

```typescript
// BEFORE (incorrect):
return /^<<<<<<< /m.test(mergeTreeRes.stdout);
```

**Fix:** Remove the `^` anchor to match anywhere in the line
```typescript
// AFTER (correct):
return /<<<<<<< /m.test(mergeTreeRes.stdout);
```

**Impact:** This was the main reason conflicts weren't being detected. The merge-tree fallback never triggered.

---

### 3. **Test setup bug in `tests/cli_test.ts`**

**Problem:** Tests tried to create a branch called "main" which already existed (modern Git uses "main" as default). The command `git checkout -b main` would fail silently, leaving changes on a detached HEAD instead of the main branch.

```typescript
// BEFORE (incorrect):
await runGit(repo.dir, ["checkout", baseCommit]);
await runGit(repo.dir, ["checkout", "-b", "main"]);  // Fails if main exists!
await writeFile(repo.dir, "conflict.txt", "line1\nmodified in main\nline3\n");
await runGit(repo.dir, ["commit", "-m", "modify in main"]);
```

**Fix:** Check out existing main branch and reset it to the base commit
```typescript
// AFTER (correct):
await runGit(repo.dir, ["checkout", "main"]);
await runGit(repo.dir, ["reset", "--hard", baseCommit]);
await writeFile(repo.dir, "conflict.txt", "line1\nmodified in main\nline3\n");
await runGit(repo.dir, ["commit", "-m", "modify in main"]);
```

**Impact:** Without this fix, the tests weren't creating proper conflict scenarios. Fixed in 5 tests:
- CLI - conflicts detected
- CLI - json output with conflicts
- CLI - diff output
- CLI - combined flags
- CLI - short alias for diff

---

### 4. **Incorrect assertion in `tests/cli_test.ts`**

**Problem:** Used `toHaveProperty("file.txt")` which interprets the dot as a nested path separator, looking for `diffs.file.txt` instead of `diffs["file.txt"]`.

```typescript
// BEFORE (incorrect):
expect(json.diffs).toHaveProperty("file.txt");  // Looks for diffs.file.txt
```

**Fix:** Use bracket notation directly
```typescript
// AFTER (correct):
expect(json.diffs["file.txt"]).toBeTruthy();  // Correctly checks diffs["file.txt"]
```

**Impact:** One test (CLI - combined flags) was failing even after getting the correct output.

---

## Files Modified

### `src/main.ts`
- Added `runCmd` to imports
- Fixed merge-base computation to use `git merge-base` directly

### `src/lib.ts`
- Fixed regex in `checkConflictsWithMergeTree()` to properly detect conflict markers

### `tests/cli_test.ts`
- Fixed test setup in 5 tests to properly create conflicting branches
- Fixed assertion to use bracket notation instead of `toHaveProperty()`

---

## Test Results

### Before Fixes
- **Unit Tests:** 27/27 ✅ (100%)
- **Integration Tests:** 10/10 ✅ (100%)
- **CLI Tests:** 7/12 ⚠️ (58%)
- **Total:** 44/49 (90%)

### After Fixes
- **Unit Tests:** 27/27 ✅ (100%)
- **Integration Tests:** 10/10 ✅ (100%)
- **CLI Tests:** 12/12 ✅ (100%)
- **Total:** 49/49 ✅ (100%)

---

## Root Cause Analysis

The original issue was **not** that the tests were poorly designed or that Git couldn't detect conflicts. The problems were:

1. **Implementation bugs** in the main code (merge-base, regex)
2. **Test setup issues** (branch creation failing silently)
3. **Assertion syntax** (toHaveProperty with dots in property names)

All issues have been resolved and the code is now working correctly.

---

## Verification

Run all tests:
```bash
cd /Users/fry/GitHub/fry69/conflict
deno test --allow-all tests/
```

Expected output:
```
ok | 49 passed | 0 failed (3s)
```

All tests now pass! ✅
