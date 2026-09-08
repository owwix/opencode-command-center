#!/usr/bin/env node

import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { collectProjectPreflight } from "../lab/project-preflight.mjs";
import { loadProjectContract } from "../lab/project-contract.mjs";

export function dogfoodRepositories(
  workspaces,
  { requireManaged = false } = {}
) {
  const canonical = [
    ...new Set(workspaces.map((workspace) => realpathSync(resolve(workspace))))
  ];
  if (canonical.length < 5)
    throw new Error(
      "Beta dogfood requires at least five distinct repositories."
    );
  const reports = canonical.map((workspace) => {
    const loaded = loadProjectContract(workspace);
    const preflight = collectProjectPreflight({
      workspace,
      contract: loaded.contract,
      contractSource: loaded.source,
      applyExcludes: false
    });
    return {
      workspace,
      contractSource: loaded.source,
      healthy: preflight.healthy,
      managedEligible: preflight.managedEligible,
      failures: preflight.checks
        .filter((check) => check.status === "fail")
        .map((check) => check.summary)
    };
  });
  return {
    scope: "preflight-only",
    workflowValidated: false,
    passed: reports.every(
      (report) => report.healthy && (!requireManaged || report.managedEligible)
    ),
    repositories: reports
  };
}

if (process.argv[1]?.endsWith("/dogfood.mjs")) {
  try {
    const requireManaged = process.argv.includes("--require-managed");
    const workspaces = process.argv
      .slice(2)
      .filter((argument) => argument !== "--require-managed");
    const result = dogfoodRepositories(workspaces, { requireManaged });
    console.log(JSON.stringify(result, null, 2));
    if (!result.passed) process.exitCode = 1;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
