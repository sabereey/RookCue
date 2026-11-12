export const NODE_VERSION: string;
export const NODE_LICENSE_SHA256: string;
export function releaseSourceIdentity(repoRoot: string): Promise<{ sourceSHA: string; version: string }>;
export function validateNodeLicense(repoRoot: string, actualNodeVersion: string): Promise<{ license: Buffer; nodeLicenseSHA256: string }>;
