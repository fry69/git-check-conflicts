# Documentation Guide

## Overview

This document describes the documentation standards used in the
git-check-conflicts project, following JSR (JavaScript Registry) guidelines for
Deno packages.

## JSDoc Standards

All exported functions, classes, interfaces, and types are documented using
JSDoc comments following these conventions:

### Module Documentation

Each module starts with a `@module` tag and description:

````typescript
/**
 * @module
 *
 * Core library for detecting Git merge conflicts.
 *
 * This module provides functions to check for merge conflicts...
 *
 * @example
 * ```ts
 * import { isGitRepository } from "./lib.ts";
 * if (await isGitRepository()) {
 *   // ...
 * }
 * ```
 */
````

### Function Documentation

Functions include:

- Description (brief + detailed)
- `@param` for each parameter
- `@returns` for return values
- `@throws` for exceptions
- `@example` with working code samples

````typescript
/**
 * Brief description.
 *
 * Detailed explanation of what the function does and when to use it.
 *
 * @param name - Description of parameter
 * @returns Promise resolving to description
 * @throws {ErrorType} When condition occurs
 *
 * @example
 * ```ts
 * const result = await functionName(args);
 * console.log(result); // Expected output
 * ```
 */
export async function functionName(name: string): Promise<string> {
  // ...
}
````

### Interface Documentation

Interfaces document each property:

```typescript
/**
 * Description of interface purpose.
 */
export interface MyInterface {
  /** Description of property */
  propertyName: string;
  /** Another property description */
  anotherProperty: number;
}
```

### Class Documentation

Classes document the class itself and all methods:

```typescript
/**
 * Description of class purpose and behavior.
 *
 * Additional context about usage patterns.
 */
export class MyClass {
  /**
   * Creates an instance.
   *
   * @param param - Parameter description
   */
  constructor(param: string) {
    // ...
  }

  /**
   * Method description.
   *
   * @returns Description of return value
   */
  method(): string {
    // ...
  }
}
```

## Documentation Coverage

### src/lib.ts

**Functions (15):**

- ✅ `runCmd` - Execute shell commands with environment variables
- ✅ `getCurrentRef` - Get current Git branch or commit
- ✅ `detectDefaultBranch` - Auto-detect default branch
- ✅ `resolveCommit` - Resolve reference to commit SHA
- ✅ `revToTree` - Convert revision to tree SHA
- ✅ `parseUnmergedFiles` - Parse Git unmerged output
- ✅ `fileDiffFor` - Generate unified diff for file
- ✅ `getFileConflictDetail` - Get structured conflict info
- ✅ `getEmptyTreeHash` - Get empty tree hash
- ✅ `checkConflictsWithReadTree` - Primary conflict detection
- ✅ `checkConflictsWithMergeTree` - Fallback conflict detection
- ✅ `getConflictingFilesFromMergeTree` - Extract conflicts from merge-tree
- ✅ `getChangedFilesBetween` - Get changed files between commits
- ✅ `isGitRepository` - Check if in Git repository
- ✅ `fetchAll` - Fetch all remotes

**Classes (2):**

- ✅ `GitError` - Custom error class
- ✅ `TempIndex` - Temporary index management

**Interfaces (4):**

- ✅ `CmdResult` - Command execution result
- ✅ `RenameInfo` - File rename information
- ✅ `FileConflictDetail` - Detailed conflict metadata
- ✅ `ConflictCheckResult` - Complete conflict check result

### src/main.ts

**Functions (2):**

- ✅ `usage` - Display CLI help
- ✅ `main` - Main entry point

**Module:**

- ✅ Module-level documentation with CLI examples

## Code Examples

All documentation includes practical, working examples that:

1. **Show real usage patterns**
   ```typescript
   const ref = await getCurrentRef();
   console.log(ref); // "main" or "abc123..."
   ```

2. **Demonstrate error handling**
   ```typescript
   try {
     const result = await resolveCommit("develop");
   } catch (error) {
     if (error instanceof GitError) {
       console.error(error.message);
     }
   }
   ```

3. **Include expected outputs**
   ```typescript
   const files = await getChangedFilesBetween("abc123", "def456");
   console.log(files); // ["src/lib.ts", "README.md"]
   ```

## Best Practices

1. **Be Specific**: Use concrete examples with realistic data
2. **Show Context**: Include surrounding code that makes sense
3. **Document Errors**: Always document what exceptions can be thrown
4. **Cross-Reference**: Use `{@link}` to reference related functions/types
5. **Keep Updated**: Update docs when changing function behavior

## VSCode Integration

The JSDoc comments provide:

- IntelliSense autocomplete
- Hover tooltips with formatted documentation
- Parameter hints
- Jump to definition
- Symbol search

## JSR Publishing

When publishing to JSR (jsr.io), this documentation will:

- Generate package documentation automatically
- Provide browsable API reference
- Show code examples in the web interface
- Enable better discoverability

## References

- [JSR Documentation Guide](https://jsr.io/docs/writing-docs)
- [TypeScript JSDoc Reference](https://www.typescriptlang.org/docs/handbook/jsdoc-supported-types.html)
- [Deno Style Guide](https://deno.land/manual/references/contributing/style_guide)
