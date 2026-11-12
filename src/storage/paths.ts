import { homedir } from "node:os";
import { realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { DomainError } from "../domain/errors.js";

export interface AssetPaths {
  project: {
    base: string;
    current: string;
    working: string;
    state: string;
    events: string;
    tasks: string;
    checkpoints: string;
    evolution: string;
    reviews: string;
  };
  personal: {
    base: string;
    index: string;
    concepts: string;
    reviews: string;
    capabilities: string;
    practice: string;
  };
}

export function resolvePaths(
  projectRoot: string,
  personalRoot?: string,
): AssetPaths {
  const projectBase = join(resolve(projectRoot), ".growth-memory");
  const personalBase = resolve(
    personalRoot ?? process.env.GROWTH_MEMORY_HOME ?? join(homedir(), ".growth-memory"),
  );

  return {
    project: {
      base: projectBase,
      current: join(projectBase, "current.md"),
      working: join(projectBase, "working.md"),
      state: join(projectBase, "state.json"),
      events: join(projectBase, "events", "events.jsonl"),
      tasks: join(projectBase, "tasks"),
      checkpoints: join(projectBase, "checkpoints"),
      evolution: join(projectBase, "evolution"),
      reviews: join(projectBase, "reviews"),
    },
    personal: {
      base: personalBase,
      index: join(personalBase, "index.md"),
      concepts: join(personalBase, "concepts"),
      reviews: join(personalBase, "reviews"),
      capabilities: join(personalBase, "capabilities.json"),
      practice: join(personalBase, "practice"),
    },
  };
}

export function safeChildPath(root: string, child: string): string {
  const resolvedRoot = resolve(root);
  const resolvedChild = resolve(resolvedRoot, child);
  const childRelative = relative(resolvedRoot, resolvedChild);

  if (
    child.length === 0 ||
    childRelative.length === 0 ||
    childRelative === ".." ||
    childRelative.startsWith(`..${sep}`) ||
    isAbsolute(childRelative)
  ) {
    throw new DomainError("UNSAFE_PATH", "Resolved child path escapes its owning root", {
      root: resolvedRoot,
      child,
    });
  }

  return resolvedChild;
}

/** Check ownership at project/mixed operations, not during personal-only setup. */
export async function assertSeparateStorageRoots(paths: Pick<AssetPaths, "project" | "personal">): Promise<void> {
  const [project, personal] = await Promise.all([
    physicalPath(paths.project.base), physicalPath(paths.personal.base),
  ]);
  if (project === personal) {
    throw new DomainError(
      "STORAGE_ROOT_CONFLICT",
      "Project and personal storage resolve to the same directory; select a separate --personal root or project before retrying. Existing files were retained; no relocation or repair was performed.",
      { projectRoot: paths.project.base, personalRoot: paths.personal.base },
    );
  }
}

/** Resolve existing ancestors too: a missing base can still share physical ownership. */
async function physicalPath(path: string): Promise<string> {
  const absolute = resolve(path);
  try {
    return await realpath(absolute);
  } catch (error) {
    if (!(typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT")) throw error;
    const parent = dirname(absolute);
    if (parent === absolute) throw error;
    return join(await physicalPath(parent), basename(absolute));
  }
}

export function toLogicalPath(path: string): string {
  return path.replaceAll("\\", "/");
}
