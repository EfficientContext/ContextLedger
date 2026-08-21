import { homedir } from "node:os";
import { extname, relative, resolve, sep } from "node:path";
import { lstat, readFile, readdir } from "node:fs/promises";
import type { IngestInput } from "../../domain/types.js";
import { loadConfig } from "../../infrastructure/config.js";
import { analyzePreparedBundle } from "./session-analyzer.js";
import {
  loadIntentTraceRuntime,
  type DiscoveredSessionCandidate,
  type SessionDiscoveryPart,
  type SessionSource,
} from "./runtime.js";

const MAX_SESSION_BYTES = 64 * 1024 * 1024;

export type SyncSessionsInput = {
  source: SessionSource | "all";
  from: string;
  to: string;
  projectId?: string | undefined;
  projectName?: string | undefined;
  visibility: "private" | "project" | "organization";
  roots?: string[] | undefined;
  maxFiles?: number | undefined;
  dryRun?: boolean | undefined;
  intentTraceRepo?: string | undefined;
};

export type DiscoveredSessionEnvelope = {
  source: SessionSource;
  candidateId: string;
  envelope: IngestInput;
};

export type SessionDiscoveryResult = {
  scannedFiles: number;
  candidates: number;
  failed: Array<{ source: SessionSource; candidateId: string; error: string }>;
  items: DiscoveredSessionEnvelope[];
};

type CandidateWithParts = {
  source: SessionSource;
  candidate: DiscoveredSessionCandidate;
  parts: Map<string, SessionDiscoveryPart>;
  modifiedAt: string;
};

function defaultRoots(source: SessionSource): string[] {
  const home = homedir();
  return source === "codex"
    ? [
        resolve(home, ".codex", "sessions"),
        resolve(home, ".tcodex", "sessions"),
      ]
    : [
        resolve(home, ".claude", "projects"),
        resolve(home, ".tclaude", "projects"),
        resolve(home, ".tclaude", ".claude", "projects"),
      ];
}

function isSessionFile(path: string): boolean {
  return [".jsonl", ".ndjson"].includes(extname(path).toLowerCase());
}

function isGeneratedWriterSession(path: string): boolean {
  return /context-(?:ledger|sync)-report-writer/iu.test(path);
}

async function collectParts(
  root: string,
  fromMs: number,
  toMs: number,
  maxFiles: number,
): Promise<SessionDiscoveryPart[]> {
  const files: Array<{ path: string; modifiedAt: number; size: number }> = [];

  async function walk(directory: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = resolve(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        await walk(path);
        continue;
      }
      if (
        !entry.isFile() ||
        !isSessionFile(path) ||
        isGeneratedWriterSession(path)
      ) {
        continue;
      }
      const info = await lstat(path);
      if (
        info.size <= 0 ||
        info.size > MAX_SESSION_BYTES ||
        info.mtimeMs < fromMs ||
        info.mtimeMs >= toMs
      ) {
        continue;
      }
      files.push({ path, modifiedAt: info.mtimeMs, size: info.size });
    }
  }

  await walk(root);
  const selected = files
    .sort((left, right) => right.modifiedAt - left.modifiedAt)
    .slice(0, maxFiles);
  return Promise.all(
    selected.map(async (file, index) => {
      const relativePath = relative(root, file.path).split(sep).join("/");
      return {
        clientRef: `${index}:${relativePath}`,
        path: relativePath,
        byteLength: file.size,
        modifiedAt: new Date(file.modifiedAt).toISOString(),
        bytes: new Uint8Array(await readFile(file.path)),
        complete: true,
      };
    }),
  );
}

async function discoverCandidates(
  source: SessionSource,
  roots: string[],
  fromMs: number,
  toMs: number,
  maxFiles: number,
  runtime: Awaited<ReturnType<typeof loadIntentTraceRuntime>>,
): Promise<{ scannedFiles: number; candidates: CandidateWithParts[] }> {
  let scannedFiles = 0;
  const candidates: CandidateWithParts[] = [];
  for (const root of roots) {
    const parts = await collectParts(root, fromMs, toMs, maxFiles);
    scannedFiles += parts.length;
    if (parts.length === 0) continue;
    const partMap = new Map(parts.map((part) => [part.clientRef, part]));
    const discovered = await runtime.discoverSessionCandidates(
      source,
      parts,
      50,
    );
    for (const candidate of discovered) {
      const candidateParts = candidate.partRefs
        .map((ref) => partMap.get(ref))
        .filter((part): part is SessionDiscoveryPart => Boolean(part));
      if (candidateParts.length === 0) continue;
      const modifiedAt = candidateParts
        .map((part) => part.modifiedAt)
        .sort()
        .at(-1)!;
      candidates.push({
        source,
        candidate,
        parts: partMap,
        modifiedAt,
      });
    }
  }
  return { scannedFiles, candidates };
}

export async function discoverSessionEnvelopes(
  input: SyncSessionsInput,
): Promise<SessionDiscoveryResult> {
  const config = loadConfig();
  const runtime = await loadIntentTraceRuntime(
    input.intentTraceRepo || config.INTENTTRACE_REPO,
  );
  const sources: SessionSource[] =
    input.source === "all" ? ["codex", "claude"] : [input.source];
  const fromMs = Date.parse(input.from);
  const toMs = Date.parse(input.to);
  const maxFiles = Math.min(Math.max(input.maxFiles ?? 200, 1), 1000);
  const discovered: CandidateWithParts[] = [];
  let scannedFiles = 0;
  for (const source of sources) {
    const roots =
      input.roots && input.roots.length > 0
        ? input.roots
        : defaultRoots(source);
    const result = await discoverCandidates(
      source,
      roots,
      fromMs,
      toMs,
      maxFiles,
      runtime,
    );
    scannedFiles += result.scannedFiles;
    discovered.push(...result.candidates);
  }

  const selected = discovered
    .sort((left, right) => right.modifiedAt.localeCompare(left.modifiedAt))
    .slice(0, 50);
  const output: SessionDiscoveryResult = {
    scannedFiles,
    candidates: selected.length,
    failed: [],
    items: [],
  };

  for (const item of selected) {
    const { source, candidate, parts } = item;
    if (candidate.failureCode) {
      output.failed.push({
        source,
        candidateId: candidate.candidateId,
        error: candidate.failureMessage ?? candidate.failureCode,
      });
      continue;
    }
    try {
      const selectedParts = candidate.partRefs
        .map((ref) => parts.get(ref))
        .filter((part): part is SessionDiscoveryPart => Boolean(part));
      const bundles = await runtime.prepareSessionParts(
        source,
        selectedParts.map((part) => ({ path: part.path, bytes: part.bytes })),
        `context-ledger-${source}-${candidate.candidateId}`,
        {
          id: candidate.candidateId,
          byteLength: selectedParts.reduce(
            (total, part) => total + part.byteLength,
            0,
          ),
          modifiedAt: selectedParts
            .map((part) => part.modifiedAt)
            .sort()
            .at(-1)!,
        },
      );
      for (const bundle of bundles) {
        const envelope = analyzePreparedBundle({
          runtime,
          source,
          bundle,
          ...(input.projectId ? { projectId: input.projectId } : {}),
          ...(input.projectName ? { projectName: input.projectName } : {}),
          visibility: input.visibility,
        });
        output.items.push({
          source,
          candidateId: candidate.candidateId,
          envelope,
        });
      }
    } catch (error) {
      output.failed.push({
        source,
        candidateId: candidate.candidateId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return output;
}
