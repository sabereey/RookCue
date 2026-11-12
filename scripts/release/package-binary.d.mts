export function sourcePathIncluded(path: string): boolean;
export function releaseSourceIdentity(repoRoot: string): Promise<{ sourceSHA: string; version: string }>;
export function validateNodeLicense(repoRoot: string, actualNodeVersion: string): Promise<{ license: Buffer; nodeLicenseSHA256: string }>;
export function prepareReleasePackage(options: { repoRoot?: string; target: string }): Promise<{ path: string; sha256: string; size: number; sourceSHA: string }>;
