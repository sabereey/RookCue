import { spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";

it("recovers a recorded task, gates review/promotion, and retrieves the approved lesson in another project", async () => {
  // Synthetic human inputs are confined to this disposable fixture, never the user's library.
  const root = await mkdtemp(join(tmpdir(), "rookcue-conversation-fixture-"));
  try {
    const bin = join(root, "bin");
    const skill = join(root, "plugin copy");
    await mkdir(bin);
    await symlink(process.execPath, join(bin, "node"));
    await symlink(join(process.cwd(), "dist/src/cli.js"), join(bin, "rookcue"));
    await cp(join(process.cwd(), "plugins/growth-memory/skills/growth-memory"), skill, { recursive: true });
    const project = join(root, "first project");
    const nextProject = join(root, "next project");
    const personal = join(root, "personal");
    const run = (args: string[], selectedProject = project) => {
      const personalArgs = ["init", "status", "knowledge"].includes(args[0] ?? "") ? ["--personal", personal] : [];
      const result = spawnSync("/bin/bash", [join(skill, "scripts/rookcue.sh"), "run", "--", ...args, "--project", selectedProject, ...personalArgs, "--json"], {
        env: { ...process.env, GROWTH_MEMORY_HOME: personal, PATH: `${bin}:/usr/bin:/bin`, ROOKCUE_RUNTIME_HOME: join(root, "runtime") }, encoding: "utf8",
      });
      const envelope = JSON.parse(result.stdout);
      return { ...result, envelope };
    };
    const ok = (args: string[], selectedProject = project) => {
      const result = run(args, selectedProject);
      expect(result.status, result.stdout + result.stderr).toBe(0);
      expect(result.envelope.ok).toBe(true);
      return result.envelope.data;
    };
    expect(ok(["knowledge", "search", "--query", "checksum"])).toEqual([]);
    expect(await readdir(root)).not.toContain("first project");
    ok(["init"]);
    const task = ok(["task", "start", "--title", "Verify download integrity", "--goal", "Reject mismatched archives before extraction"]);
    const checkpoint = ok(["task", "checkpoint", "--task", task.id, "--reason", "interrupt", "--snapshot", JSON.stringify({ nextStep: "verify checksum rejection" })]);
    const recovered = ok(["context", "show"]);
    expect(recovered.activeTask.id).toBe(task.id);
    expect(recovered.latestCheckpoint.id).toBe(checkpoint.id);
    expect(recovered.latestCheckpoint.snapshot.nextStep).toBe("verify checksum rejection");
    expect(await readdir(join(project, ".growth-memory/tasks"))).toHaveLength(1);
    ok(["task", "event", "--task", task.id, "--type", "test-result", "--summary", "Fixture: bad checksum rejected", "--evidence", `task:${task.id}`]);
    ok(["task", "complete", "--task", task.id, "--summary", "Fixture verified archive validation"]);
    const review = ok(["review", "start", "--task", task.id, "--level", "quick"]);
    expect(run(["review", "advance", "--review", review.id]).envelope.error.code).toBe("REVIEW_LEVEL_DECISION_REQUIRED");
    ok(["review", "respond", "--review", review.id, "--phase", "context", "--text", "Fixture human: I choose quick review."]);
    expect(ok(["review", "advance", "--review", review.id]).phase).toBe("correct");
    expect(run(["review", "advance", "--review", review.id]).envelope.error.code).toBe("QUICK_REVIEW_CONFIRMATION_REQUIRED");
    ok(["review", "respond", "--review", review.id, "--phase", "correct", "--text", "Fixture human: verify checksum before extraction.", "--evidence", `task:${task.id}`]);
    expect(ok(["review", "advance", "--review", review.id]).status).toBe("completed");
    const draft = { principle: "Verify the checksum before extracting downloaded archives.", boundary: "Use for fixed release archives with a trusted expected digest.", evidence: [{ kind: "task", id: task.id }] };
    const [candidate] = ok(["knowledge", "propose", "--review", review.id, "--candidate", JSON.stringify(draft)]);
    expect(run(["knowledge", "promote", "--candidate", candidate.id, "--confidence", "0.8"]).envelope.ok).toBe(false);
    ok(["knowledge", "decide", "--candidate", candidate.id, "--decision", "approve", "--actor", "human", "--source", "Test fixture only: human approves the displayed exact checksum candidate."]);
    const concept = ok(["knowledge", "promote", "--candidate", candidate.id, "--confidence", "0.8"]);
    const results = ok(["knowledge", "search", "--query", "checksum", "--limit", "3"], nextProject);
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe(concept.id);
    const saved = ok(["knowledge", "show", "--concept", concept.id], nextProject);
    expect(saved.principle).toBe(draft.principle);
    expect(saved.boundary).toBe(draft.boundary);
    expect(saved.provenance.taskId).toBe(task.id);
    expect(await readdir(root)).not.toContain("next project");
    const source = await readFile(join(project, ".growth-memory/tasks", `${task.id}.json`), "utf8");
    expect(JSON.parse(source).status).toBe("completed");
  } finally { await rm(root, { recursive: true, force: true }); }
}, 30000);
