# JSON Output Format

## Overview

The `--json` flag outputs structured conflict information in a machine-readable
JSON format, ideal for CI/CD pipelines, automation tools, and programmatic
analysis.

## Structure

```json
{
  "current_ref": "string",           // Current branch/ref name
  "other_ref": "string",             // Target branch/ref being compared
  "ours_commit": "string",           // Full commit SHA of current branch
  "theirs_commit": "string",         // Full commit SHA of target branch
  "merge_base": "string | null",     // Common ancestor commit SHA
  "conflicts": boolean,              // True if conflicts detected
  "conflicted_files": ["string"],    // Array of conflicting file paths
  "files": {                         // Detailed conflict information per file
    "filename": {
      "conflict_type": "string",     // Type of conflict (see below)
      "message": "string",           // Human-readable conflict description
      "rename": {                    // Present only if file was renamed
        "old_path": "string",        // Original file path
        "new_path": "string",        // New file path after rename
        "side": "ours | theirs"      // Which branch performed the rename
      },
      "diff": "string"               // Unified diff output (with --diff flag)
    }
  }
}
```

## Conflict Types

The `conflict_type` field indicates the nature of the conflict:

- **`content`** - Both branches modified the same file's content
- **`rename_modify`** - Your branch renamed the file, their branch modified it
- **`modify_rename`** - Your branch modified the file, their branch renamed it
- **`delete_modify`** - File deleted on one branch, modified on the other
- **`modify_delete`** - File modified on one branch, deleted on the other

## Example Output

### Simple Content Conflict

```json
{
  "current_ref": "feature",
  "other_ref": "main",
  "ours_commit": "abc123...",
  "theirs_commit": "def456...",
  "merge_base": "789abc...",
  "conflicts": true,
  "conflicted_files": ["config.json"],
  "files": {
    "config.json": {
      "conflict_type": "content",
      "diff": "diff --git config.json config.json\n..."
    }
  }
}
```

### Rename/Modify Conflict

```json
{
  "current_ref": "refactor-monorepo",
  "other_ref": "main",
  "ours_commit": "570fb40...",
  "theirs_commit": "2cf680...",
  "merge_base": "8c5c8f7...",
  "conflicts": true,
  "conflicted_files": ["CHANGELOG.md"],
  "files": {
    "CHANGELOG.md": {
      "conflict_type": "rename_modify",
      "message": "Your branch: renamed CHANGELOG.md → packages/aqfile/CHANGELOG.md\nTheir branch: modified CHANGELOG.md",
      "rename": {
        "old_path": "CHANGELOG.md",
        "new_path": "packages/aqfile/CHANGELOG.md",
        "side": "ours"
      },
      "diff": "diff --git packages/aqfile/CHANGELOG.md CHANGELOG.md\n..."
    }
  }
}
```

### No Conflicts

```json
{
  "current_ref": "feature",
  "other_ref": "main",
  "ours_commit": "abc123...",
  "theirs_commit": "def456...",
  "merge_base": "789abc...",
  "conflicts": false,
  "conflicted_files": [],
  "files": {}
}
```

## Usage in CI/CD

### Quick Conflict Check

```bash
# Exit code 0 = no conflicts, 1 = conflicts
git-check-conflicts --json main > /dev/null
```

### Parse Conflict Count

```bash
conflicts=$(git-check-conflicts --json main | jq '.conflicted_files | length')
echo "Found $conflicts conflicting files"
```

### Filter by Conflict Type

```bash
# Find all rename conflicts
git-check-conflicts --json --diff main | jq '
  .files | to_entries |
  map(select(.value.conflict_type | contains("rename"))) |
  map(.key)
'
```

### Generate Conflict Report

```bash
git-check-conflicts --json --diff main | jq -r '
  .files | to_entries | map(
    "File: \(.key)\nType: \(.value.conflict_type)\nMessage: \(.value.message // "N/A")\n"
  ) | join("\n")
'
```

## GitHub Actions Example

```yaml
- name: Check for merge conflicts
  run: |
    if ! git-check-conflicts --json main > conflicts.json; then
      echo "::error::Merge conflicts detected"
      jq -r '.files | keys | .[]' conflicts.json | while read file; do
        echo "::error file=$file::Conflict detected"
      done
      exit 1
    fi
```

## GitLab CI Example

```yaml
check-conflicts:
  script:
    - git-check-conflicts --json main > conflicts.json || true
    - |
        if jq -e '.conflicts == true' conflicts.json > /dev/null; then
          echo "Merge conflicts found:"
          jq -r '.conflicted_files[]' conflicts.json
          exit 1
        fi
```

## Integration Tips

1. **Always check exit code first** - Exit code indicates conflict status
2. **Use `--diff` flag judiciously** - Adds significant data, only use when
   needed
3. **Parse conflict_type** - Filter/handle different conflict types
   appropriately
4. **Check rename field existence** - Only present for rename-related conflicts
5. **Validate JSON** - Use `jq` or similar to validate structure before parsing

## Migration from Previous Format

**Breaking Change**: Version 1.x used `diffs` object with raw strings. Version
2.0+ uses `files` object with structured `FileConflictDetail` objects.

### Old Format (v1.x)

```json
{
  "diffs": {
    "file.txt": "⚠️ RENAME/MODIFY CONFLICT:\n..."
  }
}
```

### New Format (v2.0+)

```json
{
  "files": {
    "file.txt": {
      "conflict_type": "rename_modify",
      "message": "Your branch: renamed...",
      "rename": {...},
      "diff": "diff --git..."
    }
  }
}
```

Update your parsing code to use `.files` instead of `.diffs` and access the
structured fields.
