# Application locales

Kun registers `en`, `zh`, `ru`, `hi`, `th`, `ja`, and `ko` as selectable
application locales. English remains the fallback language.

Every active locale mirrors the complete English `common` and `settings` key
trees. Tests reject missing or extra keys and interpolation-token drift before
a resource can ship. The previously reviewed Russian entries are preserved;
automated translations in the newly activated resources should continue to be
refined by native speakers without changing keys or placeholders.
