## ADDED Requirements

### Requirement: Foreground shell execution has a bounded duration
The Bash tool SHALL default foreground commands to a 15-minute ceiling while retaining a 24-hour ceiling for explicitly backgrounded commands.

#### Scenario: Foreground command exceeds its ceiling
- **WHEN** a foreground command remains active for 15 minutes
- **THEN** Kun terminates its process tree, records a terminal timeout result, and allows the owning turn to settle

#### Scenario: Long command is explicitly backgrounded
- **WHEN** the model invokes Bash with `background: true`
- **THEN** the foreground ceiling does not terminate the background session

### Requirement: Silent foreground work reports liveness
The runtime SHALL emit non-durable liveness updates at least every 30 seconds while a foreground command is alive without output.

#### Scenario: Test command produces no output
- **WHEN** a foreground command has produced no output for 30 seconds
- **THEN** the client can show elapsed duration and last-output age without growing durable message history

### Requirement: Cancellation cleans up the process tree
Timeout, tool cancellation, turn interruption, and runtime shutdown SHALL use a common cleanup path that terminates descendant processes and completes the tool call.

#### Scenario: Child process ignores graceful termination
- **WHEN** cancellation does not stop the process tree within the grace period
- **THEN** Kun force-terminates it and releases the thread lease within five seconds
