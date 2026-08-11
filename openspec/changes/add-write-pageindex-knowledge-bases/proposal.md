## Why

Write workspaces already contain long-form project knowledge, but Code conversations cannot attach those directories as explicit, read-only knowledge sources. Users must currently paste material into prompts or let the agent traverse arbitrary paths, which loses source traceability and grants broader filesystem authority than retrieval needs.

## What Changes

- Treat configured Write workspaces as reusable knowledge-base sources that can be mounted on an individual Code thread.
- Persist thread-level, read-only knowledge-base mounts independently from writable additional workspaces and inherit them when a thread is forked.
- Build a local vectorless index organized as directory, document, section, and page nodes, with Markdown reference edges.
- Expose catalog, tree-browse, and bounded source-read tools so Kun can reason through the index and return line/page citations.
- Add a Code composer knowledge-base picker with mount state, indexing status, removal, rebuild, and source-opening actions.
- Keep existing Write BM25 retrieval for inline completion; the new index is an on-demand Kun capability and does not inject snippets into every Code prompt.

## Capabilities

### New Capabilities

- `thread-knowledge-base-mounts`: Per-thread discovery, mounting, persistence, status, inheritance, and read-only authorization of Write workspace knowledge bases.
- `vectorless-knowledge-retrieval`: Local PageIndex-style structure indexing and auditable agent tools for catalog, tree navigation, and cited source reads without embeddings.

### Modified Capabilities


## Impact

- Extends shared/Kun thread contracts, HTTP routes, thread persistence, runtime context, data migration path rewriting, and renderer thread mapping.
- Adds a Kun-local knowledge index under the runtime data directory and a read-only tool provider in the capability registry.
- Adds Code composer UI and renderer actions while reusing the existing directory picker and Write workspace settings.
- Introduces no vector database, cloud upload, Python runtime, or new external service dependency.
