import { DomainError } from "../domain/errors.js";

export type S3RemoteConfig = {
  bucket: string;
  prefix: string;
  endpoint: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  forcePathStyle: boolean;
};

export function resolveS3RemoteConfig(input: {
  bucket: string;
  prefix: string;
  env?: NodeJS.ProcessEnv;
}): S3RemoteConfig {
  const env = input.env ?? process.env;
  const endpoint = env.GMEM_S3_ENDPOINT;
  const region = env.GMEM_S3_REGION ?? "auto";
  const accessKeyId = env.GMEM_S3_ACCESS_KEY_ID;
  const secretAccessKey = env.GMEM_S3_SECRET_ACCESS_KEY;
  if (!endpoint || !accessKeyId || !secretAccessKey) {
    throw new DomainError(
      "CLOUD_S3_CONFIG_MISSING",
      "S3 remote requires GMEM_S3_ENDPOINT, GMEM_S3_ACCESS_KEY_ID, and GMEM_S3_SECRET_ACCESS_KEY",
      {
        missing: [
          ...(!endpoint ? ["GMEM_S3_ENDPOINT"] : []),
          ...(!accessKeyId ? ["GMEM_S3_ACCESS_KEY_ID"] : []),
          ...(!secretAccessKey ? ["GMEM_S3_SECRET_ACCESS_KEY"] : []),
        ],
      },
    );
  }
  return {
    bucket: input.bucket,
    prefix: input.prefix,
    endpoint,
    region,
    accessKeyId,
    secretAccessKey,
    forcePathStyle: env.GMEM_S3_FORCE_PATH_STYLE === "true",
  };
}
