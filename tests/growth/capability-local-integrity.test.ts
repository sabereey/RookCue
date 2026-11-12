import { mkdir, readFile, writeFile } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { capabilityStateSchema, type CapabilityState } from "../../src/domain/schema.js";
import { GrowthRepository } from "../../src/growth/repository.js";
import { GrowthService } from "../../src/growth/service.js";
import { KnowledgeService } from "../../src/personal/knowledge-service.js";
import { portableCapabilities } from "../fixtures/growth-assets.js";
import { cleanupFixtures, fixture } from "./fixtures.js";

afterEach(cleanupFixtures);

function inconsistentRise(): CapabilityState {
  const state = capabilityStateSchema.parse(structuredClone(portableCapabilities));
  if (state.version !== 2) throw new Error("Fixture requires v2");
  state.history[1]!.newLevel = "independent";
  if (state.history[1]!.kind !== "baseline") state.history[1]!.input.level = "independent";
  return state;
}

describe("local capability semantic integrity", () => {
  // Catches typed repository saves bypassing semantic history validation.
  it("rejects a false rise on save without replacing previously valid bytes", async () => {
    const f = await fixture();
    await f.personal.saveCapabilities({ version: 1, records: [] });
    const bytes = await readFile(f.paths.personal.capabilities, "utf8");

    await expect(f.personal.saveCapabilities(inconsistentRise())).rejects.toThrow();

    expect(await readFile(f.paths.personal.capabilities, "utf8")).toBe(bytes);
  });

  // Catches local read/snapshot/report and mutation consumers projecting or extending corrupt state.
  it("rejects inconsistent on-disk history before reads, reports or capability mutation and preserves it", async () => {
    const f = await fixture();
    await mkdir(f.paths.personal.base, { recursive: true });
    const bytes = JSON.stringify(inconsistentRise());
    await writeFile(f.paths.personal.capabilities, bytes);
    const repository = new GrowthRepository(f.project, f.personal, { clock: f.clock, id: f.id });
    const growth = new GrowthService(f.project, f.personal, { clock: f.clock, id: f.id });
    const knowledge = new KnowledgeService(f.personal, f.project, { clock: f.clock, id: f.id });

    await expect(f.personal.readCapabilities()).rejects.toMatchObject({ code: "INVALID_STORED_DATA" });
    await expect(repository.readSnapshot()).rejects.toMatchObject({ code: "INVALID_STORED_DATA" });
    await expect(growth.report()).rejects.toMatchObject({ code: "INVALID_STORED_DATA" });
    await expect(knowledge.updateCapability("c", {
      level: "seen", evidence: [{ kind: "explanation", reviewId: "review", passed: true }], operationId: "new-assessment",
    })).rejects.toMatchObject({ code: "INVALID_STORED_DATA" });

    expect(await readFile(f.paths.personal.capabilities, "utf8")).toBe(bytes);
  });

  // Catches stronger validation accidentally rejecting honest v1, seeded baselines or later noop receipts.
  it("reads legacy baselines and legitimate later noop receipts through local snapshots and reports", async () => {
    const f = await fixture();
    const valid = capabilityStateSchema.parse(structuredClone(portableCapabilities));
    if (valid.version !== 2) throw new Error("Fixture requires v2");
    const transition = valid.history[1]!;
    if (transition.kind === "baseline") throw new Error("Fixture requires transition");
    valid.history.push({ ...structuredClone(transition), kind: "noop", operationId: "later-noop", previousLevel: "understood", at: "2026-10-30T00:00:00.000Z" });
    const growth = new GrowthService(f.project, f.personal, { clock: () => new Date("2026-10-31T00:00:00.000Z"), id: f.id });

    await f.personal.saveCapabilities({ version: 1, records: [valid.history[0]!.returnedRecord] });
    expect(await f.personal.readCapabilities()).toMatchObject({ version: 1, records: [{ level: "seen" }] });
    await expect(growth.report()).resolves.toBeDefined();
    await f.personal.saveCapabilities(valid);

    expect(await f.personal.readCapabilities()).toEqual(valid);
    await expect(growth.report()).resolves.toMatchObject({ counts: { capabilityRises: 1 } });
  });
});
