# Building a native executable

Supported native targets are `darwin-arm64` and `linux-x64`. Build on the matching
OS/architecture with **Node 24.12.0** and npm. The full upstream Node LICENSE is
vendored at `third_party/node/v24.12.0/LICENSE`; its URL and SHA-256 are recorded
beside it. A different runtime or modified license is rejected.

From the clean release commit:

```sh
npm ci
npm run typecheck
npm test -- --maxWorkers=2 --testTimeout=30000
npm run build:binary -- --target darwin-arm64
npm run verify:binary -- --target darwin-arm64
version=$(node -p "require('./package.json').version")
GROWTH_TEST_BINARY="$PWD/release/$version/darwin-arm64/gmem-darwin-arm64" npx vitest run tests/cli/growth-workflow.test.ts --maxWorkers=2 --testTimeout=30000
npm run package:binary -- --target darwin-arm64
```

For Linux, replace every `darwin-arm64` with `linux-x64`. Source development can
use the package's documented Node range; native distribution is pinned exactly.
macOS requires Xcode command-line tools (`lipo`, `codesign`); Linux requires
the system C runtime supported by the official Node binary. Git and tar are
needed for corresponding-source assembly. npm restores build tools and application
dependencies from `package-lock.json`. The application uses esbuild and Node SEA,
then postject; macOS signatures are ad-hoc, without Developer ID notarization.

Build and packaging reject dirty tracked/untracked source and inconsistent
package/lock/plugin versions. Ignored build outputs, dependencies and private
memory never enter the source archive. If using an extracted `source.tar.gz`,
initialize a Git repository, add the extracted source and make a local commit
before building. This rebuild identifies that local commit; the original
distribution's `provenance.json` retains the original release source SHA.

The builder records the actual Node version, source commit, version, target,
binary digest and exact Node license digest at build time. The packager checks
them against the clean current commit and actual executable version, and fails
on mismatch. It never attributes an existing binary to a newly selected commit.

The final package is `release/<version>/packages/gmem-<version>-<target>.tar.gz`.
It contains exactly the executable, `SHA256SUMS`, `LICENSE`, `NOTICE`,
`THIRD_PARTY_NOTICES.md`, `NODE-LICENSE.txt`, `provenance.json`, `SOURCE.md`,
`INSTALL.md`, and `source.tar.gz`, under a matching named root directory.
`SHA256SUMS` covers the other nine delivered files. The command prints the
outer archive's separately calculated SHA-256, byte size and source SHA.

`source.tar.gz` is built from immutable Git objects for the built commit. It
includes source, tests, release scripts, lockfile/configuration, plugin materials,
licenses and required build/upgrade documentation. Git metadata, private memory,
dependencies, generated output and internal historical/coordinator documents are
excluded; the actual archive listing is checked. Rebuilding from these materials
is supported; byte-identical native executables are not promised, including
because native signatures can vary.

Test the native executable and verify the resulting hashes for the exact source revision before distributing a package.
