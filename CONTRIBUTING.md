# Contributing

Project code and documentation are GPL-3.0-only unless separately marked.
Submit only material you have the right to contribute under that license;
retain existing third-party copyrights and notices. No separate CLA or
proprietary-relicensing grant is established by this document.

Use Node.js >=22.12.0 for source development and Node.js >=24 for native SEA
builds. Install locked dependencies with `npm ci`, then run:

```sh
npm run typecheck
npm test
```

HTTP S3 integration fixtures bind to localhost and require loopback listening.
Use disposable roots for task/review/personal-memory testing. Do not commit
real knowledge, credentials, exports, `.env` files, build artifacts, or logs.
Keep human approval and evidence gates intact. Formatting and license-only
changes need metadata/documentation verification; runtime changes need tests.

RookCue is the product name. Preserve compatibility with existing CLI, data
directory and marketplace identifiers.

## Documentation languages

Maintain the English and Simplified Chinese versions of the README, quickstart,
and installation guide together. English uses the base filename; Chinese uses
the `_CN.md` suffix. Update both versions in the same change when installation
commands, supported platforms or feature status change. Keep command examples
identical and link to the matching language when a translation exists.
Agent instructions have one maintained version with multilingual usage examples.
Check relative links and language switches before submitting documentation changes.
