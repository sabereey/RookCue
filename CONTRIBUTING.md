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
