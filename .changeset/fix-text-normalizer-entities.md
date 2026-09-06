---
"@shrinivas-sn/adapter-ingestion": patch
---

Fix the `text` normalizer deleting numeric HTML character references
(`&#8211;`, `&#038;`, `&#x...;`) instead of decoding them -- found
integrating a real WordPress source, where every title containing an en
dash or an ampersand was silently mangled.
