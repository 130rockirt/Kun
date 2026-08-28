# ADR: WPS WebOffice migration boundary

- Status: accepted for foundation; production cutover blocked
- Date: 2026-08-28
- Owners: Kun runtime and desktop workbench

## Decision

Kun will integrate WPS WebOffice through a trusted HTTPS gateway. The desktop
application and Kun runtime never receive a WPS `appSecret`, signing key, or
long-lived management token. The gateway contract is frozen in
`docs/contracts/wps-office-gateway.openapi.yaml`.

The local workspace file remains the source of truth. Remote saves are complete
only after Kun downloads the expected remote version, validates the Office
container and size, verifies that the local source SHA-256 did not change, and
atomically replaces the local file.

The model-facing names `office_inspect`, `office_preview`, and `office_edit` are
preserved when the WPS provider is enabled. GUI and headless clients must use
the same runtime service; a WebOffice iframe is never a tool backend.

## Capability gate

| Capability | Status | Required evidence before cutover |
| --- | --- | --- |
| DOC/DOCX, XLS/XLSX, PPT/PPTX upload | gateway-required | Test-tenant compatibility matrix and documented size limits |
| Short-lived read/edit session | gateway-required | Official SDK package/version, token refresh and expiry semantics |
| Save-complete notification | gateway-required | Signed callback format, replay protection and version semantics |
| Download an exact saved version | gateway-required | Immutable version or ETag contract |
| Word selection and page location | unsupported-until-verified | Official JS API and event documentation |
| Sheet range, formulas and sheet location | unsupported-until-verified | Official JS API and event documentation |
| Slide selection and current slide | unsupported-until-verified | Official JS API and event documentation |
| Headless inspect/query/validate | unsupported-until-verified | Official server API or approved automation service |
| Headless structured edit | unsupported-until-verified | Official server API or approved automation service |
| Page/sheet/slide render | unsupported-until-verified | Official server API or approved automation service |
| Cloud delete and retention | gateway-required | Deletion SLA, audit and data-residency terms |

## Go / no-go rule

Production GUI cutover is **no-go** until all `unsupported-until-verified` rows
needed by the selected release scope have official evidence and integration
tests against a WPS test tenant. OfficeCLI, LibreOffice and browser renderers
must not be removed before that gate passes. There is no silent local fallback
after a workspace explicitly selects WPS mode.

## Security invariants

- Gateway URLs are credential-free HTTPS. Loopback HTTP is allowed only in tests
  and local development.
- Session tokens are memory-only and excluded from settings, logs, events and
  model-visible tool results.
- Upload consent is scoped to a workspace and tenant. Inspecting a document is
  an external data transfer, not a purely local read.
- Remote mutation requests use an idempotency key and expected remote version.
- Local writes retain SHA-256 optimistic locking and per-path serialization.
- Renderer framing and navigation use an exact WPS origin allowlist; arbitrary
  `https:` is not an acceptable CSP policy.

## Rollout

The temporary modes are `local`, `wps-canary`, and `wps`. Canary selects one
provider per document and does not shadow-upload production documents. Removal
of the local implementation happens only after a stable release window and the
acceptance matrix in the migration plan passes.
