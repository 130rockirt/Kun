## Why

The repository has accumulated hundreds of human-maintained source, test, style, script, data, and documentation files above 700 physical lines. These files mix unrelated responsibilities, make review and ownership difficult, and leave no automated protection against further growth.

## What Changes

- Establish a repository-wide maximum of 700 physical lines for every human-maintained, line-oriented text file.
- Split every existing oversized file along functional boundaries while preserving public APIs, runtime behavior, packaging inputs, and test coverage.
- Keep compatibility entry points where callers rely on an existing module path, with implementation moved into focused sibling modules.
- Add a deterministic repository check that fails when an applicable tracked file exceeds 700 lines and reports every violation.
- Exclude only opaque binary/media artifacts and package-manager lockfiles, whose physical line layout is not an authored module boundary.
- Document the limit and wire the check into the normal validation workflow so future changes cannot silently reintroduce oversized files.

## Capabilities

### New Capabilities

- `source-file-size-governance`: Defines the repository-wide 700-line contract, applicable-file classification, violation reporting, and validation expectations.

### Modified Capabilities

None.

## Impact

This is a broad internal refactor across the renderer, Electron main process, shared contracts, Kun runtime and TUI, extension examples and packages, scripts, styles, tests, localization resources, and long-form documentation. Public behavior and serialized/runtime contracts remain unchanged; import paths may gain compatibility barrels while implementations move to focused modules. Package lockfiles and binary/media assets remain machine-managed and are not evaluated as authored line-oriented files.
