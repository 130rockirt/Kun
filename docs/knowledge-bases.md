# Write workspace knowledge bases

Kun can mount a Write workspace on an individual Code thread as a read-only
knowledge base. The feature uses a PageIndex-inspired structural index rather
than embeddings or a vector database. Indexes are derived local data and can be
rebuilt at any time.

## Product model

- Write workspaces remain the source of truth. Mounting does not copy or move
  their documents.
- Mounts belong to a thread and are copied when that thread is forked.
- A mount stores a stable id, absolute root, display name,
  `source: write-workspace`, and `access: read-only`.
- A Code thread can mount at most eight non-overlapping roots. Its primary
  working directory cannot also be mounted as a knowledge base.
- Mount mutation and manual rebuild are rejected while the thread is running.

`additionalWorkspaces` and `knowledgeBases` are intentionally different:
additional workspaces extend normal filesystem/sandbox authority, while a
knowledge-base root never does. Knowledge-base content is available only
through the three read-only tools below.

## Vectorless index

The indexer scans supported sources with fixed file, byte, page, entry, and
node limits. It ignores symlinks, hidden directories, VCS metadata, dependency
trees, generated output, unreadable files, and sources whose canonical path
escapes the mount root.

Supported sources:

- Markdown: `.md`, `.markdown`, `.mdx`
- Plain text: `.txt`
- PDF: `.pdf` (text layer only; no OCR in the Kun indexer)

The generated graph contains:

- root and directory nodes;
- document nodes;
- Markdown heading nodes with exact line ranges;
- plain-text paragraph nodes with exact line ranges;
- PDF page nodes with exact page numbers;
- Markdown and Wiki-link reference edges between indexed documents.

Node ids are deterministic hashes of structural source locations. A source
fingerprint is calculated from the bounded scan metadata. The index is stored
under Kun's data directory in `knowledge-indexes/`, never in the Write
workspace. Status is one of `pending`, `indexing`, `ready`, `stale`,
`unavailable`, or `error`. Concurrent requests for the same root share one
in-flight build.

## Retrieval flow

```text
User mounts Write workspace on Code thread
  -> bounded canonical-path scan
  -> directory/document/section/page graph
  -> knowledge_catalog(query?)
  -> knowledge_browse(mount_id, node_id?)
  -> knowledge_read(mount_id, node_ids)
  -> bounded evidence with relative path + line/page citation
```

`knowledge_catalog` lists authorized mount ids and root node ids. An optional
query performs lightweight deterministic term ranking over node titles,
relative paths, and summaries; it does not create embeddings.

`knowledge_browse` returns a bounded page of child summaries and related graph
edges. The model chooses where to navigate next, which provides the
PageIndex-style reasoning loop.

`knowledge_read` accepts at most six authorized node ids and returns bounded
source evidence with a structural breadcrumb and exact line/page location.
Absolute roots are not returned to the model. Every result marks source text as
untrusted evidence, not executable instructions.

## Runtime and GUI boundaries

Kun owns contracts, persistence, indexing, authorization, tools, and HTTP
routes. The renderer only maps thread state and presents the picker/status UI.
The dynamic per-turn context includes mount names and ids after the immutable
system prefix, so changing mounts does not destabilize the shared cache prefix.

Renderer routes:

- `GET /v1/threads/{id}/knowledge-bases`
- `POST /v1/threads/{id}/knowledge-bases/{knowledgeBaseId}/reindex`
- `PATCH /v1/threads/{id}` with `knowledgeBases`

The Code composer picker is sourced from Write workspaces. It can add a new
directory to Write and mount it in one operation, shows index freshness, and
can switch to the matching Write workspace for source inspection.

## Security invariants

1. Tool arguments contain mount/node ids, never arbitrary filesystem paths.
2. Every tool call reloads the owning thread and authorizes the mount id.
3. Source reads resolve both the mount and file through canonical paths and
   reject root escape, including symlink replacement after indexing.
4. Knowledge tools are `read-only`, automatic, local-only, and are advertised
   only when the active thread has mounts.
5. Knowledge roots are never added to the workspace sandbox or ordinary file
   tools.
6. Missing, stale, unreadable, oversized, or malformed sources degrade to
   status/diagnostics without granting broader access.
