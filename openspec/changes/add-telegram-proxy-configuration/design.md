## Context

Telegram support lives in the Electron main process. The renderer saves a Telegram platform credential through the existing settings contract, preload exposes a narrow token-verification IPC method, and `TelegramRuntime` owns verification, long polling, text/file delivery, and photo downloads. Today those calls use `electron.net.fetch`, so only Electron/system proxy behavior is available.

The repository already depends on `proxy-agent` and has a main-process `fetchWithOptionalProxy` helper for explicit HTTP and SOCKS proxy routing. Telegram file upload uses `FormData`, which the helper does not currently serialize, so consistent Telegram routing also requires completing that existing helper's body handling.

## Goals / Non-Goals

**Goals:**

- Let each Telegram credential opt into an explicit proxy independently of model-provider networking.
- Apply one proxy choice consistently to verification, polling, messages, uploads, metadata calls, and downloads.
- Support authenticated or unauthenticated HTTP, HTTPS, SOCKS, SOCKS4, and SOCKS5 URLs with actionable validation errors.
- Preserve existing settings and direct/system-network behavior when the proxy is absent or disabled.
- Reconcile a running Telegram channel when its proxy changes without restarting unrelated IM channels.

**Non-Goals:**

- Changing the global/model-provider proxy or inheriting it implicitly for Telegram.
- Adding a separate Telegram service, runtime, dependency, proxy server, or system-wide proxy manager.
- Supporting Telegram group chats, webhooks, MTProto client accounts, or proxy protocols other than those supported by `proxy-agent`.
- Performing a live proxy health check without a bot token; token verification remains the end-to-end connectivity check.

## Decisions

### Store an optional channel credential proxy object

`ClawImTelegramPlatformCredentialV1` will gain an optional `proxy` value shaped as `{ enabled: boolean; url: string }`. New connections save the value explicitly, while normalization accepts old credentials with no field and treats them as disabled. The settings patch schema will bound the URL length and preserve strict object validation.

This is preferred over reusing the provider-global proxy because Telegram availability and model routing have different trust and failure domains. It is preferred over a single optional URL because an explicit toggle lets users retain a URL while temporarily returning to system routing.

### Validate at the shared boundary and again before network use

A shared normalizer/validator will trim the URL, require an absolute URL, and allow only `http:`, `https:`, `socks:`, `socks4:`, and `socks5:`. The renderer performs immediate required-field feedback, the token-verification request returns a typed `invalid_proxy` failure, the IPC schema bounds input size, and settings normalization disables malformed persisted values. Runtime code resolves only a valid enabled URL.

Layered validation keeps renderer behavior friendly while ensuring persisted or hand-crafted settings cannot select an unsupported transport.

### Select the request transport per Telegram channel

Telegram requests will use a small fetch selector:

- proxy disabled/absent: keep `electron.net.fetch` with the existing global-fetch fallback used by tests;
- valid explicit proxy: call the existing `fetchWithOptionalProxy` helper with that URL.

`TelegramChannel` receives the resolved proxy URL, and every request method uses the same selector. `verifyTelegramBotToken` accepts the same proxy value through the preload/main IPC contract, so a connection is tested over the route that will later run it.

The channel reconciliation key includes the resolved proxy URL. Saving a changed toggle or URL therefore stops and recreates only that Telegram channel; unchanged channels remain running.

### Complete multipart proxy support in the existing fetch helper

The explicit proxy helper will normalize request bodies into bytes plus any generated headers. Existing string, URL-encoded, ArrayBuffer, and typed-array behavior remains. `Blob` and `FormData` bodies will be materialized through the platform `Response` encoder so multipart boundaries and content type stay standards-compliant before the Node HTTP request is sent through `ProxyAgent`.

This is preferred over a Telegram-only multipart implementation because the limitation belongs to the shared explicit-proxy transport and duplicating multipart encoding would be error-prone.

### Keep secrets out of diagnostics and UI copy

The proxy URL remains inside local settings alongside the bot token. Runtime keys may contain it in memory but are never logged. User-facing and logged transport errors are sanitized so bot-token URL segments and proxy URL user information are not exposed. UI copy notes local persistence and recommends the supported URL schemes without echoing credentials.

## Risks / Trade-offs

- [A malformed persisted proxy could prevent the channel from starting] → Normalize unsupported URLs to a disabled proxy and validate again when resolving the runtime route.
- [Proxy authentication in a URL is sensitive] → Keep the field local, render it as a password-style input, never log the URL, and sanitize transport errors.
- [Buffering multipart uploads increases memory use] → Telegram already reads the whole outbound file before upload; this change does not increase its existing memory complexity and remains bounded by the attachment workflow.
- [Changing proxy settings interrupts an in-flight long poll] → Reuse the existing per-channel abort/stop reconciliation so shutdown is prompt and unrelated channels are unaffected.
- [Different proxy protocols have environment-specific behavior] → Reuse the project's installed `proxy-agent`, cover transport selection and body encoding with focused tests, and retain the system-network fallback when disabled.

## Migration Plan

1. Ship additive optional settings and IPC fields; old settings normalize as proxy disabled.
2. New and edited Telegram connections save the proxy object.
3. On settings sync, a proxy change updates the channel reconciliation key and recreates that channel automatically.
4. Rollback is data-compatible: older builds ignore the extra optional credential field during normalization, while disabling the toggle restores the prior request path.

## Open Questions

None. The supported schemes, per-channel ownership, fallback behavior, and request coverage are fixed by this change.
