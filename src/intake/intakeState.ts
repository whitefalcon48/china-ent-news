import fs from "node:fs/promises";
import path from "node:path";

export type ManualIntakeStatus = "received" | "fetching" | "researching" | "generating" | "review_ready" | "published" | "failed";

export type ManualIntakeState = {
  version: 1;
  comment_id: string;
  source_url: string;
  note: string;
  status: ManualIntakeStatus;
  created_at: string;
  updated_at: string;
  error?: string;
  review_issue_number?: number;
  published_date?: string;
  published_url?: string;
};

export function getManualIntakeDirectory(commentId: string, dataRoot = "data") {
  if (!/^\d+$/u.test(commentId)) throw new Error("manual intake comment id must be numeric");
  return path.resolve(dataRoot, "manual-intake", commentId);
}

export function getManualIntakeStatePath(commentId: string, dataRoot = "data") {
  return path.join(getManualIntakeDirectory(commentId, dataRoot), "intake-state.json");
}

export async function readManualIntakeState(commentId: string, dataRoot = "data"): Promise<ManualIntakeState | undefined> {
  try {
    return JSON.parse(await fs.readFile(getManualIntakeStatePath(commentId, dataRoot), "utf8")) as ManualIntakeState;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export async function writeManualIntakeState(state: ManualIntakeState, dataRoot = "data") {
  const destination = getManualIntakeStatePath(state.comment_id, dataRoot);
  await writeJsonAtomically(destination, state);
  return destination;
}

export async function updateManualIntakeState(
  state: ManualIntakeState,
  patch: Pick<ManualIntakeState, "status"> & Partial<Pick<ManualIntakeState, "error" | "review_issue_number" | "published_date" | "published_url">>,
  dataRoot = "data"
) {
  const next: ManualIntakeState = { ...state, ...patch, updated_at: new Date().toISOString() };
  if (patch.error === "") delete next.error;
  await writeManualIntakeState(next, dataRoot);
  return next;
}

export async function writeManualIntakeArtifact(commentId: string, name: string, value: unknown, dataRoot = "data") {
  if (!/^[a-z0-9][a-z0-9._-]*\.json$/u.test(name)) throw new Error("invalid manual intake artifact name");
  const destination = path.join(getManualIntakeDirectory(commentId, dataRoot), name);
  await writeJsonAtomically(destination, value);
  return destination;
}

export async function writeManualIntakeTextArtifact(commentId: string, name: string, text: string, dataRoot = "data") {
  if (!/^[a-z0-9][a-z0-9._-]*\.md$/u.test(name)) throw new Error("invalid manual intake text artifact name");
  const destination = path.join(getManualIntakeDirectory(commentId, dataRoot), name);
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.writeFile(destination, text, "utf8");
  return destination;
}

async function writeJsonAtomically(destination: string, value: unknown) {
  await fs.mkdir(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await fs.rename(temporary, destination);
}
