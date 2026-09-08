---
description: Confirm a workspace image path and Command Center gallery URL the user can open.
---

$ARGUMENTS

You help the user locate an image already in the mounted workspace and give a
Mac-openable gallery URL when it lives under `artifacts/marketing/`.

## Parse arguments

Extract from `$ARGUMENTS`:

- `--file` (required): path relative to `/workspace` of an image file.

If `$ARGUMENTS` is empty or `--file` is missing, show usage:

```text
Usage: /view --file <relative-image-path>
```

## Safety checks

1. Reject credential-class paths: anything containing `.env`, `.dev.vars`, `.pem`, `.key`, `.p12`, `.pfx`, `.crt`, `.der`, `.npmrc`, `.netrc`, `credentials.json`, or `secrets.json`.
2. Reject absolute paths and paths that resolve outside `/workspace`.
3. Reject files whose extension is not a known image format: `.jpg`, `.jpeg`, `.png`, `.gif`, `.webp`, `.svg`, `.avif`, `.bmp`, `.ico`.
4. Verify the file exists and is a regular file under `/workspace`.

## Report

If safe, report:

```text
File: <relative-path>
```

If the file is under `artifacts/marketing/`, also report:

```text
Gallery: http://127.0.0.1:3110/file/<path-under-marketing>
```

Otherwise tell the user to open the file from the project folder on the Mac
(Finder / Preview). Never invent ports other than `3110`.
