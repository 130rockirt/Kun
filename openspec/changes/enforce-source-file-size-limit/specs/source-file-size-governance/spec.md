## ADDED Requirements

### Requirement: Applicable repository text files have a hard line limit
The repository SHALL limit every Git-tracked, line-oriented, human-maintained text file to no more than 700 physical lines. Blank lines and comment lines SHALL count, and a final unterminated line SHALL count as a physical line.

#### Scenario: File is exactly at the limit
- **WHEN** an applicable tracked text file contains exactly 700 physical lines
- **THEN** the file-size validation passes for that file

#### Scenario: File exceeds the limit
- **WHEN** an applicable tracked text file contains 701 or more physical lines
- **THEN** the file-size validation fails for that file

#### Scenario: File has no trailing newline
- **WHEN** an applicable tracked text file ends with content after its last newline delimiter
- **THEN** the final content is counted as one physical line

### Requirement: Non-authored opaque artifacts are classified consistently
The validation SHALL exclude opaque binary or media artifacts and recognized package-manager lockfiles from the physical-line modularity rule. It SHALL NOT exclude other tracked text merely because its extension is unknown or uncommon.

#### Scenario: Binary asset contains newline bytes
- **WHEN** a tracked binary or media artifact contains byte values that resemble newline delimiters
- **THEN** the artifact is excluded instead of being reported as an oversized source file

#### Scenario: Package-manager lockfile is generated
- **WHEN** a recognized tracked package-manager lockfile exceeds 700 physical lines
- **THEN** the lockfile is excluded from the authored-file validation

#### Scenario: Text file has an uncommon extension
- **WHEN** a tracked non-binary text file with an uncommon extension exceeds 700 physical lines
- **THEN** the file is reported unless it is a recognized package-manager lockfile

### Requirement: Violations are completely and deterministically reported
The validation command MUST inspect all applicable tracked files, print every violation with its physical line count and repository-relative path in stable order, and exit with a non-zero status when at least one violation exists.

#### Scenario: Multiple files violate the limit
- **WHEN** multiple applicable tracked files exceed 700 physical lines
- **THEN** one validation run reports every violation in deterministic path order and exits non-zero

#### Scenario: Repository has no violations
- **WHEN** every applicable tracked file contains no more than 700 physical lines
- **THEN** the command exits successfully and reports that the repository satisfies the limit

### Requirement: Functional behavior remains compatible after extraction
Refactoring performed to satisfy the limit MUST preserve existing runtime behavior, public module contracts, serialized formats, packaging inputs, test scenarios, and architectural layer boundaries.

#### Scenario: Existing callers use a moved implementation
- **WHEN** implementation is extracted from an existing public module path
- **THEN** callers continue to receive the same contract through updated imports or a compatibility facade

#### Scenario: Tests are divided into focused files
- **WHEN** an oversized test file is split by behavior or scenario group
- **THEN** all prior scenarios remain discoverable and retain equivalent setup and assertions

#### Scenario: Styles or data are divided
- **WHEN** oversized styles, localization data, manifests, or documentation are split
- **THEN** ordering, key precedence, packaging resolution, and stable navigation remain equivalent as applicable

### Requirement: The line limit is part of normal repository validation
The repository MUST expose a dedicated line-limit command and invoke it from the normal lint or validation workflow after the existing baseline reaches zero.

#### Scenario: A future change adds an oversized file
- **WHEN** normal repository validation runs after a change introduces an applicable file above 700 lines
- **THEN** validation fails and identifies the offending file
