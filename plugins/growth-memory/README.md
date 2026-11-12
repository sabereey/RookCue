# RookCue Codex Plugin

This plugin teaches Codex to use the local `growth-memory` CLI as a background protocol for non-trivial coding work.

It does not replace the CLI. The local machine still needs `growth-memory` or `gmem` on `PATH`.

## What It Does

- Starts and completes growth-memory tasks in the background.
- Records important events and checkpoints.
- Recommends `skip`, `quick`, or `deep` review after useful work.
- Keeps ordinary review prompts lightweight.
- Promotes personal knowledge only after explicit human approval.
- Shows the payoff after promotion so review feels like asset accumulation.

## Local Testing

From the repository root:

```bash
npm test -- tests/plugin/growth-memory-plugin.test.ts
```

To install from the repo-local marketplace after implementation:

```bash
codex plugin marketplace add "$PWD"
codex plugin add growth-memory@growth-memory-local
```

Use the repository root as the marketplace source. Codex discovers
`.agents/plugins/marketplace.json` from that root, and the marketplace entry resolves
`./plugins/growth-memory` relative to the same root.

Start a new Codex thread after reinstalling so the updated skill is loaded.

## License

The integration's current source is GPL-3.0-only under the repository-root
LICENSE.

### Phase 2 source guidance

The source skill includes capture after actual task closure and human review,
read-only quality/due/history/recommend/report, and voluntary explicit human
feedback. Beta7 runtime/plugin report `0.1.0-beta.7`. It retains the
`gmem growth --help` check because historical `0.1.0` builds do not identify
Phase 2 support. All capability v2 writers need the new runtime.
Install the matching plugin and start a new Codex session after upgrading. Due dates suggest practice.
