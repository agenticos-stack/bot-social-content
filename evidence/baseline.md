# Baseline evidence

The extraction source is `origin/staging` at
`d483c211dec643e3fe49d52e5428965c41d9f623`.

| Artifact | Bytes | SHA-256 |
| --- | ---: | --- |
| Standalone `dist/social-content.gadget` | 94860 | `b93c643b1418f2b35af0a21149ffa6376a71a00916a226f85c2c28cb4ab90820` |
| `origin/staging:workers/api/format-blueprints/social-localization.gadget` | 94860 | `b93c643b1418f2b35af0a21149ffa6376a71a00916a226f85c2c28cb4ab90820` |

The bytes compare equal. The shared API checkout's working-tree artifact was
older and had SHA-256 `f8dba947aa9e4874fd346e364e8e6c8e44ce1ce0e57a0df70091af7e5eafdeab`;
it was not used as the extraction source.

Focused verification: `npm ci --ignore-scripts`, `npm test` (6 passing),
`npm run build`, and `npm run validate` all passed. No preview server was left
running.
