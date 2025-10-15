# git-check-conflicts

Pre-merge conflict detection tool for Git repositories. Checks if merging a
branch would result in conflicts without modifying the working tree.

## Usage

```bash
deno run -P src/main.ts [options] [branch]
```

The tool uses named permissions defined in `deno.json`. Use `-P` to apply the
default permission set, or use `--allow-all` for full permissions.

### Basic Examples

```bash
# Check current branch against auto-detected default branch
deno run -P src/main.ts

# Check against specific branch
deno run -P src/main.ts main

# Fetch remotes first
deno run -P src/main.ts --fetch origin/main

# Show diffs for conflicting files
deno run -P src/main.ts --diff feature-branch

# JSON output for CI/CD
deno run -P src/main.ts --json main
```

## Options

```
--fetch      Fetch all remotes before checking
--diff, -d   Print unified diffs for conflicting files
--json       Output results as JSON
--help, -h   Show usage information
```

## Exit Codes

- `0` - No conflicts expected
- `1` - Conflicts expected
- `2` - Error (not a git repo, invalid ref, etc.)

## Detection Methods

The tool uses two strategies:

1. **read-tree**: Primary method using Git's three-way merge index
2. **merge-tree**: Fallback method checking for conflict markers

Default branch detection tries in order:

1. Remote HEAD (e.g., `origin/HEAD`)
2. Local `main` branch
3. Local `master` branch
4. Most recent local branch (excluding current)

## JSON Output

With `--json`, outputs structured data:

```json
{
  "current_ref": "feature",
  "other_ref": "main",
  "ours_commit": "abc123...",
  "theirs_commit": "def456...",
  "merge_base": "789abc...",
  "conflicts": true,
  "conflicted_files": ["file1.txt", "file2.js"],
  "diffs": {
    "file1.txt": "diff --git...",
    "file2.js": "diff --git..."
  }
}
```

The `diffs` object is populated only when `--diff` is also specified.

## Installation

### Compile to Binary

Compile to a standalone executable for distribution:

```bash
deno task compile
```

This creates a `git-check-conflicts` binary in the current directory that can be
used without Deno installed:

```bash
./git-check-conflicts --help
./git-check-conflicts main
```

### Cross-compilation

Compile for different platforms:

```bash
# Linux x86_64
deno compile --target x86_64-unknown-linux-gnu -P --output git-check-conflicts-linux src/main.ts

# macOS ARM64
deno compile --target aarch64-apple-darwin -P --output git-check-conflicts-macos-arm src/main.ts

# Windows
deno compile --target x86_64-pc-windows-msvc -P --output git-check-conflicts.exe src/main.ts
```

## Requirements

- Deno 2.x (for development and running from source)
- Git (always required)

## Development

```bash
# Run tests
deno task test

# Run specific test suite
deno task test:unit
deno task test:integration
deno task test:cli

# Compile binary
deno task compile

# Lint and format
deno fmt
deno lint
```

## Implementation

- `src/main.ts` - CLI entry point
- `src/lib.ts` - Core library functions
- `tests/` - Test suites (49 tests, 100% passing)

See `docs/` for detailed implementation notes and test results.

## License

Copyright © 2025
