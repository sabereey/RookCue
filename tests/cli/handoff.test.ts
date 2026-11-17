import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";

it("keeps a three-agent handoff recoverable and shows pending acceptance in status", async () => {
  const root = await mkdtemp(join(tmpdir(), "rookcue-handoff-cli-"));
  try {
    const run = (args: string[], json = true) => {
      const result = spawnSync(process.execPath, ["dist/src/cli.js", ...args, "--project", root, ...(json ? ["--json"] : [])], { encoding: "utf8" });
      expect(result.status, result.stdout + result.stderr).toBe(0);
      if (!json) return result.stdout;
      const envelope = JSON.parse(result.stdout);
      expect(envelope.ok).toBe(true);
      return envelope.data;
    };
    const task = run(["task", "start", "--title", "Brief", "--goal", "Build a brief"]);
    const snapshot = {
      query: "fixed-query", window: "fixed-window", page: { count: 10, nextMaxId: "123" },
      handoff: {
        version: 1, state: "paused", goal: "Build a brief", scope: "Retrieve the first page",
        summary: "First page saved", nextStep: "Screen the saved posts offline",
        artifacts: ["raw-page-1.json"], constraints: ["Do not complete or review"], requiredTools: [],
        completedWork: [{ agent: "grok", summary: "Retrieved page 1", evidence: ["raw-page-1.json"] }],
      },
    };
    run(["task", "checkpoint", "--task", task.id, "--reason", "interrupt", "--snapshot", JSON.stringify(snapshot)]);
    // Every command is a fresh process; each next agent starts with persisted data.
    const codex = run(["context", "show"]).latestCheckpoint.snapshot;
    codex.handoff.scope = "Screen existing posts";
    codex.handoff.summary = "Offline screening saved";
    codex.handoff.nextStep = "Build the brief";
    codex.handoff.artifacts.push("screening.md");
    codex.handoff.completedWork.push({ agent: "codex", summary: "Screened page 1", evidence: ["screening.md"] });
    run(["task", "checkpoint", "--task", task.id, "--reason", "interrupt", "--snapshot", JSON.stringify(codex)]);
    const grok = run(["context", "show"]).latestCheckpoint.snapshot;
    grok.handoff.state = "awaiting-user";
    grok.handoff.scope = "Build the brief";
    grok.handoff.summary = "Brief ready for acceptance";
    grok.handoff.nextStep = "Present brief.html and ask for acceptance or corrections";
    grok.handoff.pendingDecision = "Accept the brief or request changes";
    grok.handoff.artifacts.push("brief.html");
    grok.handoff.completedWork.push({ agent: "grok", summary: "Built the brief", evidence: ["brief.html"] });
    run(["task", "checkpoint", "--task", task.id, "--reason", "interrupt", "--snapshot", JSON.stringify(grok)]);
    const context = run(["context", "show"]);
    expect(context.activeTask).toMatchObject({ id: task.id, status: "active" });
    expect(context.latestCheckpoint.snapshot).toMatchObject({ query: "fixed-query", window: "fixed-window", page: { count: 10, nextMaxId: "123" } });
    expect(context.handoff.artifacts).toEqual(["raw-page-1.json", "screening.md", "brief.html"]);
    expect(context.handoff.completedWork.map((work: { agent: string }) => work.agent)).toEqual(["grok", "codex", "grok"]);
    const statusArgs = ["status", "--personal", join(root, "personal")];
    expect(run(statusArgs)).toMatchObject({ activeTask: { id: task.id, status: "active" }, handoff: { state: "awaiting-user", pendingDecision: "Accept the brief or request changes" } });
    const statusText = run(statusArgs, false);
    expect(statusText).toContain("awaiting-user");
    expect(statusText).toContain("Accept the brief or request changes");
    run(["task", "complete", "--task", task.id, "--summary", "Fixture acceptance received"]);
    expect(run(statusArgs).handoff).toBeNull();
    expect(run(["context", "show"])).not.toHaveProperty("handoff");
  } finally { await rm(root, { recursive: true, force: true }); }
}, 15000);
