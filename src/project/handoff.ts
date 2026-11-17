import { handoffSchema, type Checkpoint, type Handoff } from "../domain/schema.js";

export function readCheckpointHandoff(checkpoint?: Checkpoint): Handoff | undefined {
  const parsed = handoffSchema.safeParse(checkpoint?.snapshot.handoff);
  return parsed.success ? parsed.data : undefined;
}
