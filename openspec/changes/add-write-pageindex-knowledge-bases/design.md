## Context

Write stores configured workspace roots in application settings and already performs short-lived BM25 retrieval in the Electron main process for inline completion and Write assistant prompts. Code threads are owned by Kun and support a primary workspace plus `additionalWorkspaces`, but additional workspaces participate in the normal filesystem sandbox and can therefore become writable. Kun has no first-class knowledge-base mount or vectorless document-tree tool.

The change crosses renderer, runtime contracts, thread persistence, tool registration, local indexing, and migration. Knowledge-base content must stay local, be auditable through source locations, and never expand normal Code filesystem authority.

## Goals / Non-Goals

**Goals:**

- Mount up to eight Write workspace directories on an individual Code thread as durable read-only knowledge sources.
- Build and persist a local hierarchy of directories, documents, Markdown sections, text ranges, and PDF pages without embeddings.
- Let Kun discover, navigate, and read bounded source evidence through stable read-only tools.
- Surface mount/index state in Code and open cited sources in Write.
- Incrementally refresh changed sources and safely rebuild after import or corruption.

**Non-Goals:**

- Vector embeddings, a vector database, entity extraction, semantic clustering, or a general graph database.
- Cloud PageIndex APIs, Python packaging, remote uploads, or additional credentials.
- Replacing Write inline-completion BM25 retrieval.
- Allowing generic Code filesystem or shell tools to access knowledge-base roots.

## Decisions

### Persist mounts as a dedicated thread contract

`Thread.knowledgeBases` stores `{ id, root, name, source: 'write-workspace', access: 'read-only' }`. Create/update schemas cap mounts at eight, normalize duplicates, reject the primary workspace and overlapping roots, and forks copy the list. The renderer maps the field and patches it through the existing thread endpoint.

This is separate from `additionalWorkspaces`; reusing that field would let `write`, `edit`, and approved shell commands mutate a knowledge directory in `workspace-write` mode.

### Keep index authority inside Kun

A `KnowledgeBaseService` owns mount validation, index lifecycle, and reads. It stores cache files beneath `<dataDir>/knowledge-index/`, keyed by a hash of the canonical root, using atomic JSON documents. Each persisted index includes schema version, source fingerprint, document metadata, nodes, and reference edges. Index files are derived cache: thread records are authoritative and caches may be deleted or rebuilt.

The indexer scans only `.md`, `.markdown`, `.mdx`, `.txt`, and `.pdf`, skips known generated/hidden directories, caps files/bytes/nodes, rejects external symlink targets, and checks abort signals. Markdown uses heading levels for natural hierarchy and relative Markdown/Wiki links for `reference` edges. Text uses paragraph groups. PDFs use `pdfjs-dist` text extraction and page nodes; image-only pages are reported as unavailable instead of invoking OCR.

### Use PageIndex-style agent navigation

Three read-only tools are registered:

- `knowledge_catalog`: mount status and root nodes.
- `knowledge_browse`: a bounded page of child nodes and reference edges for one mount/node.
- `knowledge_read`: bounded source text for selected node IDs with path plus line/page citations.

Tools receive only mount/node IDs. They load mounts from the active thread context and resolve source paths internally, preventing arbitrary path injection. Results explicitly mark source content as untrusted data. A dynamic context block lists mounted knowledge bases and directs the model to catalog, browse, and read; no source text enters the immutable system prefix.

### Build lazily and refresh by fingerprints

Mounting schedules a background build and returns immediately. Catalog/browse/read ensure an index exists; concurrent callers share one in-flight build. A cheap tree fingerprint over relative path, size, and `mtimeMs` detects staleness. The service rebuilds changed indexes as a whole in v1 while reusing unchanged per-document nodes during the build, which keeps correctness simple and avoids watcher lifetime complexity. Explicit reindex deletes derived cache then rebuilds.

### Place the picker in the Code composer

The Code composer adds a compact knowledge button near workspace/model controls. It lists Write settings roots first, supports selecting another directory, mounts/unmounts on the active idle thread, and polls status while indexing. Adding a new directory also appends it to `settings.write.workspaces`. If no Code thread exists, the action creates one in the selected Code workspace before mounting.

Citation results reuse tool timeline output initially; source locations are actionable through an `openKnowledgeSource` renderer action that switches to Write and opens the file/page. The mount picker is the required v1 UI; bespoke answer footnote parsing is not required.

## Risks / Trade-offs

- [LLM tree traversal costs more than a vector lookup] → Keep structural responses compact, page every tool, and avoid automatic retrieval on unrelated turns.
- [Large or poorly structured folders produce weak trees] → Enforce budgets, expose status/counts, preserve directory/file names, and allow rebuild.
- [Filesystem changes race with reads] → Fingerprint before index use, validate canonical paths again before source reads, and return stale/unavailable status instead of unverified text.
- [PDF extraction increases Kun packaging size] → Reuse the repository's existing `pdfjs-dist`; support text-layer PDFs only and load the module lazily.
- [Thread cache is portable but absolute roots are not] → Reuse typed workspace-root migration rewriting for mounts and always rebuild indexes after import.

## Migration Plan

- Add optional fields so existing thread/session JSON remains valid and normalizes to no mounts.
- Add migration path metadata for `knowledgeBases[*].root`; do not export derived index files.
- Rollback is safe: older binaries ignore the optional field, and deleting `<dataDir>/knowledge-index` removes only rebuildable cache.

## Open Questions

None for v1.
