# Conversation Trajectory

Kun exposes a conversation-scoped trajectory view for model requests, Session messages, tool calls, timing, usage, retries, and failures. It is a content view of the selected conversation, not a runtime diagnostics or provider-control panel.

## UI

Use the **Trace** button in the conversation title bar to switch the center area between chat and trajectory. The composer and hidden chat timeline stay mounted, so drafts, model/permission choices, and chat scroll state are preserved.

The trajectory contains:

- all/LLM/tool/error filters and bounded metadata/preview search;
- conversation-wide token, cache, timing, speed, and reference-value metrics;
- input/model/tool timing lanes;
- a chronological, virtualized Turn ledger with backward pagination;
- request and tool inspectors for overview, input, output, usage, timing, and normalized JSON;
- live-edge following that pauses while older records are being inspected.

The inspector docks at wide widths, overlays the ledger at medium widths, and becomes a full center view on narrow windows. The old Agent Perspective right-panel contribution is intentionally removed; saved references to that panel normalize to no panel.

## Capture policy

Lifecycle metadata is always recorded. The existing per-thread `modelRequestCaptureEnabled` switch controls only complete prompt detail and bounded in-memory wire diagnostics. It can be changed from the trajectory **More** menu; Settings controls the default for conversations created later.

When complete content capture is off, model/tool status, usage, timings, retries, errors, and canonical Session output remain available. Exact System Prompt, tool schemas, and request options display as not captured.

## Storage

Canonical conversation content remains in the Session store:

- user and assistant messages;
- reasoning items;
- tool arguments/results;
- compaction items;
- attachments and generated media.

Trajectory persistence stores compact lifecycle facts and references. It never durably stores ordinary stream deltas, raw HTTP headers/frames, credentials, attachment bytes, image/Base64 bodies, complete tool outputs, or another copy of assistant output.

Optional prompt detail uses a manifest and immutable content-addressed blobs:

```text
<dataDir>/observability/trajectory/
  records/<base64url-thread-id>.jsonl
  manifests/<base64url-thread-id>/<base64url-request-id>.json
  blobs/<sha256>.br
```

Blobs are sanitized before hashing, compressed with Brotli, deduplicated by SHA-256, and written with private directory/file permissions. Large blobs retain bounded head/tail data with explicit truncation metadata.

Default detail budgets are:

- 512 MiB globally;
- 64 MiB per conversation;
- 16 KiB inline detail preview;
- 2 KiB searchable list preview;
- 8 MiB maximum source blob before bounded head/tail retention.

Budget cleanup evicts old detail only. Lifecycle metadata remains until the conversation is deleted. Conversation deletion removes its manifests and legacy trace file, then mark-and-sweep removes unreferenced blobs.

Legacy schema-v1 model-request JSONL remains readable without an eager destructive migration. New durable records omit raw request and response bodies.

## API

Authenticated routes:

```http
GET /v1/threads/{threadId}/trajectory
GET /v1/threads/{threadId}/trajectory/summary
GET /v1/threads/{threadId}/trajectory/{recordId}/detail?section=overview
```

The page route accepts `limit`, opaque `cursor`, `filter=all|llm|tool|error`, and bounded `q` search. The detail route supports `overview`, `input`, `output`, `usage`, `timing`, `raw`, `arguments`, and `result` as appropriate for the record type.

`GET /v1/threads/{threadId}/model-requests` remains available for compatibility. The thread PATCH field remains the content-capture switch.

## Failure and recovery behavior

- Every concrete Provider attempt has its own request ID and attempt ordinal.
- Attempts from one logical model step share a round ID and Step number.
- First model content records the TTFT boundary; stream deltas are not persisted as trace rows.
- A pending persisted attempt with no matching live request is projected as interrupted after restart.
- Missing or budget-evicted manifests do not hide lifecycle metadata.
- Query and capture failures never retry, rewrite, or block the Provider request.
