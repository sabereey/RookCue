export type ReleaseTarget = {
  platform: "darwin" | "linux" | "win32";
  arch: "arm64" | "x64";
};

export function parseReleaseTarget(value: string): ReleaseTarget;

export function releaseAssetName(target: ReleaseTarget): string;
