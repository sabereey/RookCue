import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = process.cwd();
const pluginRoot = join(repoRoot, "plugins", "growth-memory");

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

describe("growth-memory Codex plugin manifest", () => {
  it("declares a valid local plugin manifest", () => {
    const manifest = readJson<{
      name: string;
      version: string;
      description: string;
      skills: string;
      author: { name: string };
      interface: {
        displayName: string;
        shortDescription: string;
        longDescription: string;
        developerName: string;
        category: string;
        capabilities: string[];
        defaultPrompt: string[];
      };
    }>(join(pluginRoot, ".codex-plugin", "plugin.json"));

    expect(manifest.name).toBe("growth-memory");
    expect(manifest.version).toBe(readJson<{ version: string }>(join(repoRoot, "package.json")).version);
    expect(manifest.description).toContain("local-first");
    expect(manifest.skills).toBe("./skills/");
    expect(manifest.author.name).toBe("Growth Memory");
    expect(manifest.interface.displayName).toBe("RookCue");
    expect(manifest.interface.category).toBe("Productivity");
    expect(manifest.interface.capabilities).toEqual(["Interactive", "Write"]);
    expect(manifest.interface.defaultPrompt).toHaveLength(3);
    for (const prompt of manifest.interface.defaultPrompt) {
      expect(prompt.length).toBeLessThanOrEqual(128);
    }
  });

  it("documents the required agent behavior guardrails", () => {
    const skill = readFileSync(
      join(pluginRoot, "skills", "growth-memory", "SKILL.md"),
      "utf8",
    );

    expect(skill).toContain("Use `--project` as the current repository root");
    expect(skill).toContain("Use `--personal` as `$HOME/.growth-memory`");
    expect(skill).toContain("Do not ask the user to run `growth-memory` commands manually");
    expect(skill).toContain("This task has knowledge worth capturing. I recommend a 2-minute quick review.");
    expect(skill).toContain("If the user does not confirm, do not start a review session.");
    expect(skill).toContain("Recommend `deep` only when there are strong signals");
    expect(skill).toContain("What did I understand?");
    expect(skill).toContain("Where is the AI summary inaccurate?");
    expect(skill).toContain("Which principle is worth preserving?");
    expect(skill).toContain("Never promote personal knowledge without explicit human approval.");
    expect(skill).toContain("Promoted 1 personal knowledge item.");
  });

  it("declares a repo-local marketplace entry for testing", () => {
    const marketplace = readJson<{
      name: string;
      interface: { displayName: string };
      plugins: Array<{
        name: string;
        source: { source: string; path: string };
        policy: { installation: string; authentication: string };
        category: string;
      }>;
    }>(join(repoRoot, ".agents", "plugins", "marketplace.json"));

    expect(marketplace.name).toBe("growth-memory-local");
    expect(marketplace.interface.displayName).toBe("Growth Memory Local");
    expect(marketplace.plugins).toEqual([
      {
        name: "growth-memory",
        source: {
          source: "local",
          path: "./plugins/growth-memory",
        },
        policy: {
          installation: "AVAILABLE",
          authentication: "ON_INSTALL",
        },
        category: "Productivity",
      },
    ]);
  });
});
