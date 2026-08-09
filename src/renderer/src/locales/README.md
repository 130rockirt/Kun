# Application locales

Kun registers `en`, `zh`, `ru`, `hi`, `th`, `ja`, and `ko` as selectable
application locales. English remains the fallback language.

Every active locale mirrors the complete English `common` and `settings` key
trees. Tests reject missing or extra keys and interpolation-token drift before
a resource can ship. The previously reviewed Russian entries are preserved;
automated translations in the newly activated resources should continue to be
refined by native speakers without changing keys or placeholders.

Each namespace has a small TypeScript entry (`common.ts` or `settings.ts`)
that merges the ordered JSON fragments in the matching directory. Keep keys in
their existing fragment and preserve the import order: it is the namespace's
stable resource order and keeps every authored resource below 700 lines.
