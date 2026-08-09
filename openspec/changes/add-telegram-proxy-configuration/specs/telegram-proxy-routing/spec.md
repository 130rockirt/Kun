## ADDED Requirements

### Requirement: Per-connection Telegram proxy configuration
The settings UI SHALL let a user enable or disable an explicit proxy and enter a proxy URL for each Telegram Bot connection. The setting SHALL be stored with that Telegram credential and SHALL remain independent from model-provider proxy settings.

#### Scenario: Connect a bot with an explicit proxy
- **WHEN** a user enables the Telegram proxy, enters a supported proxy URL, and connects a valid bot token
- **THEN** the saved Telegram credential contains the enabled proxy configuration used for that connection

#### Scenario: Temporarily disable a saved proxy
- **WHEN** a user disables the Telegram proxy without clearing its saved URL
- **THEN** the URL remains available in settings and Telegram returns to the existing Electron/system network route

#### Scenario: Load an older Telegram credential
- **WHEN** settings contain a Telegram credential created before proxy configuration existed
- **THEN** the application loads it as proxy disabled without requiring a migration or changing its existing connection behavior

### Requirement: Supported proxy validation
The application MUST accept absolute `http`, `https`, `socks`, `socks4`, and `socks5` proxy URLs and MUST reject an enabled empty, malformed, or unsupported URL before saving a new Telegram connection.

#### Scenario: Verify over a supported authenticated proxy
- **WHEN** a user supplies a syntactically valid supported proxy URL containing authentication and requests bot-token verification
- **THEN** the verification request uses that proxy and returns the normal Telegram verification result

#### Scenario: Reject an unsupported proxy
- **WHEN** a user enables the proxy with an empty URL, a relative value, or an unsupported scheme
- **THEN** the application reports an actionable proxy validation error and does not save the Telegram connection

#### Scenario: Normalize an invalid persisted proxy
- **WHEN** an untrusted persisted Telegram credential contains an invalid enabled proxy value
- **THEN** settings normalization disables that proxy before runtime use

### Requirement: Consistent Telegram request routing
An enabled valid Telegram proxy MUST route every request for that connection, including token verification, long polling, Bot API metadata calls, outbound text, outbound file upload, and inbound file download. A disabled or absent proxy SHALL preserve the existing Electron/system network behavior.

#### Scenario: Run a proxied Telegram channel
- **WHEN** a Telegram channel starts with an enabled valid proxy
- **THEN** polling and every subsequent inbound or outbound Telegram HTTP request for that channel use the configured proxy

#### Scenario: Run a channel without an explicit proxy
- **WHEN** a Telegram channel starts with no proxy or a disabled proxy
- **THEN** all Telegram requests continue through Electron's network stack and its system proxy behavior

#### Scenario: Upload a file through a proxy
- **WHEN** a proxied Telegram channel sends a local attachment
- **THEN** the multipart request is encoded with a valid content type and body and is sent through the configured proxy

### Requirement: Proxy change lifecycle
The Telegram runtime SHALL restart only a Telegram channel whose effective proxy route changes and SHALL leave unchanged IM channels running.

#### Scenario: Change an active channel proxy
- **WHEN** settings enable, disable, or change the proxy URL for a running Telegram channel
- **THEN** that channel's active poll is stopped and the channel is recreated with the new route

#### Scenario: Save an equivalent proxy configuration
- **WHEN** settings synchronization does not change a Telegram channel's effective proxy URL
- **THEN** the runtime keeps the existing channel and long poll active

### Requirement: Telegram network credential confidentiality
Telegram transport diagnostics MUST NOT expose a bot token or proxy URL credentials in logs or user-facing error details.

#### Scenario: Authenticated proxy connection fails
- **WHEN** a Telegram request through a proxy URL with user information fails
- **THEN** the reported error identifies a network/proxy failure without containing the proxy username, password, or bot token
