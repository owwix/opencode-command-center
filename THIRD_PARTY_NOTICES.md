# Third-party notices

OpenCode Command Center contains modifications and surviving portions of an internal
harness that was originally distributed under the following MIT notice. The
notice is retained conservatively for every file classified as
`attributed-upstream` in `provenance/files.json`.

## Cloudflare-licensed harness import

MIT License Copyright (c) 2025 Cloudflare Inc.

Permission is hereby granted, free of charge, to any person obtaining a copy of
this software and associated documentation files (the "Software"), to deal in
the Software without restriction, including without limitation the rights to
use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of
the Software, and to permit persons to whom the Software is furnished to do so,
subject to the following conditions:

The above copyright notice and this permission notice (including the next
paragraph) shall be included in all copies or substantial portions of the
Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS
FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR
COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER
IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN
CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

## OpenCode

OpenCode Command Center invokes pinned OpenCode container images but does not redistribute
the OpenCode source tree. OpenCode remains a separate upstream project. See the
image pin in `Dockerfile.opencode` and the upstream project for its current
license and notices.

## Dependency manifests

`package-lock.json`, `quality/inspect/uv.lock`, and the Hound requirements lock
files enumerate independently licensed packages. Those lock files are
classified as `attributed-upstream`; each dependency remains governed by the
license published with that package.

## Contributor Covenant

`CODE_OF_CONDUCT.md` is adapted from Contributor Covenant version 2.1,
available at <https://www.contributor-covenant.org/version/2/1/code_of_conduct/>.
Contributor Covenant is licensed under the Creative Commons Attribution 4.0
International license. OpenCode Command Center modifies the enforcement contact and
project-specific wording.

## Developer Certificate of Origin

`DCO` reproduces Developer Certificate of Origin version 1.1 from
<https://developercertificate.org/>. The upstream page permits verbatim copying
and prohibits modification; OpenCode Command Center retains that text as the contribution
sign-off standard.
