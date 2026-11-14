import { spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "rookcue agents "));
  roots.push(root);
  const user = join(root, "user");
  const runtime = join(root, "runtime");
  const source = join(root, "source skill");
  await mkdir(user);
  await cp(join(process.cwd(), "plugins/growth-memory/skills/growth-memory"), source, { recursive: true });
  const env = { ...process.env, HOME: user, CODEX_HOME: join(user, ".codex"), ROOKCUE_RUNTIME_HOME: runtime, PATH: "/usr/bin:/bin" };
  const run = (...args: string[]) => {
    const result = spawnSync(process.execPath, [join(source, "scripts/runtime.mjs"), ...args], { env, encoding: "utf8" });
    return { ...result, json: JSON.parse(result.stdout) };
  };
  return { user, runtime, source, env, run };
}

describe("shared agent installation", () => {
  it("discovers installed hosts without writing directories", async () => {
    const f = await fixture();
    await mkdir(join(f.user, ".grok"));
    const result = f.run("agents");
    expect(result.json.ok).toBe(true);
    expect(result.json.data.agents.find((agent: { id: string }) => agent.id === "grok").detected).toBe(true);
    expect(await readdir(f.user)).toEqual([".grok"]);
    await expect(readdir(f.runtime)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("connects detected hosts to one self-contained skill and supports repeat runs", async () => {
    const f = await fixture();
    await mkdir(join(f.user, ".grok"));
    await mkdir(join(f.user, ".claude"));
    const result = f.run("connect");
    expect(result.json.ok).toBe(true);
    expect(result.json.data.agents.map((agent: { id: string }) => agent.id)).toEqual(["grok", "claude"]);
    const grok = join(f.user, ".grok/skills/growth-memory");
    const claude = join(f.user, ".claude/skills/growth-memory");
    expect(await realpath(grok)).toBe(await realpath(claude));
    expect(f.run("connect").json.data.agents.every((agent: { status: string }) => agent.status === "connected")).toBe(true);
    await rm(f.source, { recursive: true });
    expect(await readFile(join(grok, "SKILL.md"), "utf8")).toContain("# RookCue");
    const check = spawnSync(process.execPath, [join(grok, "scripts/runtime.mjs"), "check"], { env: f.env, encoding: "utf8" });
    expect(JSON.parse(check.stdout).ok).toBe(true);
    await expect(readdir(join(f.user, ".codex"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readdir(join(f.user, ".growth-memory"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("publishes updates to all connected agents and attaches a newly selected host", async () => {
    const f = await fixture();
    expect(f.run("connect", "--agents", "grok,claude").json.ok).toBe(true);
    await writeFile(join(f.source, "references/new.md"), "new release");
    expect(f.run("connect", "--agents", "codex").json.ok).toBe(true);
    for (const directory of [".grok", ".claude", ".agents"]) {
      expect(await readFile(join(f.user, directory, "skills/growth-memory/references/new.md"), "utf8")).toBe("new release");
    }
  });

  it("reports user-owned conflicts while connecting other hosts, then repairs on retry", async () => {
    const f = await fixture();
    const target = join(f.user, ".grok/skills/growth-memory");
    await mkdir(target, { recursive: true });
    await writeFile(join(target, "SKILL.md"), "custom skill");
    const result = f.run("connect", "--agents", "grok,claude");
    expect(result.status).not.toBe(0);
    expect(result.json.data.status).toBe("needs-attention");
    expect(result.json.data.agents.find((agent: { id: string }) => agent.id === "grok").status).toBe("conflict");
    expect(await readFile(join(target, "SKILL.md"), "utf8")).toBe("custom skill");
    expect(await realpath(join(f.user, ".claude/skills/growth-memory"))).toContain(f.runtime);
    await rm(target, { recursive: true });
    expect(f.run("connect", "--agents", "grok,claude").json.ok).toBe(true);
  });

  it("recognizes enabled Codex plugins without installing a duplicate global skill", async () => {
    const f = await fixture();
    await mkdir(join(f.user, ".codex"));
    await writeFile(join(f.user, ".codex/config.toml"), '[plugins."growth-memory@growth-memory-local"]\nenabled = true\n');
    const result = f.run("connect", "--agents", "codex,grok");
    expect(result.json.data.agents.find((agent: { id: string }) => agent.id === "codex").status).toBe("plugin-managed");
    await expect(realpath(join(f.user, ".agents/skills/growth-memory"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("preserves foreign broken links and refuses concurrent publication", async () => {
    const f = await fixture();
    await mkdir(join(f.user, ".grok/skills"), { recursive: true });
    await symlink(join(f.user, "missing"), join(f.user, ".grok/skills/growth-memory"));
    expect(f.run("connect", "--agents", "grok").json.data.agents[0].status).toBe("conflict");
    await mkdir(join(f.runtime, "agents.lock"));
    expect(f.run("connect", "--agents", "claude").json.error.code).toBe("INSTALL_BUSY");
  });

  it("rejects unknown agents before modifying the user environment", async () => {
    const f = await fixture();
    expect(f.run("connect", "--agents", "unknown").json.error.code).toBe("INVALID_ARGUMENT");
    expect(await readdir(f.user)).toEqual([]);
  });

  it("reports and repairs a managed link whose shared publication was lost", async () => {
    const f = await fixture();
    expect(f.run("connect", "--agents", "grok").json.ok).toBe(true);
    await rm(join(f.runtime, "skills/current"));
    expect(f.run("agents").json.data.agents.find((agent: { id: string }) => agent.id === "grok").status).toBe("needs-repair");
    expect(f.run("connect", "--agents", "grok").json.data.agents[0].status).toBe("connected");
    expect(await readFile(join(f.user, ".grok/skills/growth-memory/SKILL.md"), "utf8")).toContain("# RookCue");
  });

  it("preserves a damaged shared revision and reports a failed update", async () => {
    const f = await fixture();
    expect(f.run("connect", "--agents", "grok").json.ok).toBe(true);
    await writeFile(join(f.user, ".grok/skills/growth-memory/SKILL.md"), "local edit");
    expect(f.run("connect", "--agents", "grok").json.error.code).toBe("INSTALL_DAMAGED");
    expect(await readFile(join(f.user, ".grok/skills/growth-memory/SKILL.md"), "utf8")).toBe("local edit");
  });

  it("isolates an invalid host directory from other selected and unselected hosts", async () => {
    const f = await fixture();
    await mkdir(join(f.user, ".grok"));
    await writeFile(join(f.user, ".grok/skills"), "user file");
    expect(f.run("connect", "--agents", "claude").json.ok).toBe(true);
    const result = f.run("connect", "--agents", "grok,claude");
    expect(result.json.data.agents[0].status).toBe("conflict");
    expect(result.json.data.agents[1].status).toBe("connected");
    expect(await readFile(join(f.user, ".grok/skills"), "utf8")).toBe("user file");
  });

  it("installs through the shell entry point once and reuses the runtime from another agent", async () => {
    const f = await fixture();
    const bin = join(f.user, "bin");
    await mkdir(bin);
    await symlink(process.execPath, join(bin, "node"));
    await symlink(join(process.cwd(), "dist/src/cli.js"), join(bin, "rookcue"));
    const env = { ...f.env, PATH: `${bin}:/usr/bin:/bin` };
    const result = spawnSync("/bin/bash", [join(f.source, "scripts/rookcue.sh"), "install", "--approve-install", "--agents", "codex,grok,claude"], { env, encoding: "utf8" });
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(JSON.parse(result.stdout).data.agents).toHaveLength(3);
    const automatic = spawnSync("/bin/bash", [join(f.source, "scripts/rookcue.sh"), "install", "--approve-install"], { env, encoding: "utf8" });
    expect(automatic.status, automatic.stdout + automatic.stderr).toBe(0);
    expect(JSON.parse(automatic.stdout).data.agents).toHaveLength(3);
    const unapproved = spawnSync("/bin/bash", [join(f.source, "scripts/rookcue.sh"), "install"], { env, encoding: "utf8" });
    expect(JSON.parse(unapproved.stdout).error.code).toBe("INSTALL_APPROVAL_REQUIRED");
    const installed = join(f.user, ".grok/skills/growth-memory/scripts/rookcue.sh");
    const version = spawnSync("/bin/bash", [installed, "run", "--", "--version"], { env, encoding: "utf8" });
    expect(version.stdout.trim()).toBe("0.1.0-beta.8");
    const inspected = spawnSync("/bin/bash", [installed, "agents"], { env: { ...env, ROOKCUE_RUNTIME_HOME: "" }, encoding: "utf8" });
    expect(JSON.parse(inspected.stdout).data.current).toBe(join(f.runtime, "skills/current"));
    const invalid = spawnSync("/bin/bash", [installed, "install", "--approve-install", "--agents", "grok,unknown"], { env, encoding: "utf8" });
    expect(JSON.parse(invalid.stdout).error.code).toBe("INVALID_ARGUMENT");
  });
});
