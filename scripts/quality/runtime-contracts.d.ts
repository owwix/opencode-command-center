/** Host-side execution contracts. Credentials never form part of a run record. */
export interface RunIdentity {
  id: string;
  revision: number;
  workspace: string;
  state: string;
  headSha?: string;
}
export interface RunStore<T extends RunIdentity> {
  loadRun(id: string): T;
  saveRun(run: T): T;
  refreshRun(run: T): T;
}
export interface ExecutionResult {
  passed: boolean;
  exitStatus: number | null;
  output: string;
  protocolError?: string | null;
  structured?: unknown;
  durationMs?: number;
}
export interface Runner<T extends RunIdentity> {
  runOpenCode(
    run: T,
    options?: { reviewer?: boolean; model?: string; reviewIndex?: number }
  ): Promise<ExecutionResult>;
}
export interface VerificationResult {
  passed: boolean;
  sha?: string;
  evidenceDigest?: string;
}
export interface Verifier<T extends RunIdentity> {
  runDagger(run: T, commands: string[]): Promise<VerificationResult>;
}
export interface PublisherRequest {
  workspace: string;
  title: string;
  body: string;
  base: string;
  expectedBranch: string;
  expectedHeadSha: string;
}
export interface PublisherReceipt {
  url: string;
  headSha: string;
  created: boolean;
  reused?: boolean;
}
export interface CapabilityScope {
  workspaceHash: string;
  projectId: string;
  sessionId: string;
  runId: string;
  routes: string[];
  actions: string[];
}
