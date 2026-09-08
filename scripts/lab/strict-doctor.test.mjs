import assert from "node:assert/strict";
import test from "node:test";
import { formatStrictDoctor, strictDoctor } from "./strict-doctor.mjs";

function runner(responses) {
  return (command, args) => {
    const key = `${command} ${args.join(" ")}`;
    const response = responses[key];
    return response ?? { status: 1, stdout: "", stderr: `unexpected: ${key}` };
  };
}

test("strict doctor accepts a compatible Apple-silicon Docker Sandbox host", () => {
  const result = strictDoctor({
    platform: "darwin",
    arch: "arm64",
    execute: runner({
      "sw_vers -productVersion": { status: 0, stdout: "15.6\n", stderr: "" },
      "docker info --format {{json .}}": {
        status: 0,
        stdout: JSON.stringify({
          OperatingSystem: "Docker Desktop",
          Name: "docker-desktop",
          ServerVersion: "28.3.2"
        }),
        stderr: ""
      },
      "which sbx": { status: 0, stdout: "/opt/homebrew/bin/sbx\n", stderr: "" },
      "sbx version": {
        status: 0,
        stdout: "sbx version: v0.39.0\n",
        stderr: ""
      }
    })
  });
  assert.equal(result.ready, true);
  assert.match(formatStrictDoctor(result), /Strict mode is ready/u);
});

test("strict doctor fails closed without every required backend property", () => {
  const result = strictDoctor({
    platform: "darwin",
    arch: "x64",
    execute: runner({
      "sw_vers -productVersion": { status: 0, stdout: "13.6\n", stderr: "" },
      "docker info --format {{json .}}": {
        status: 1,
        stdout: "",
        stderr: "daemon unavailable"
      },
      "which sbx": { status: 1, stdout: "", stderr: "" }
    })
  });
  assert.equal(result.ready, false);
  assert.equal(result.checks.filter(({ passed }) => !passed).length, 4);
});
