# pi-discuss

Tiny `pi` extension for discussing the last assistant response by opening it in your external editor and sending only the resulting diff back to the model.

## What it does

- finds the last completed assistant answer on the current branch
- opens that answer directly in your external editor (`$VISUAL` / `$EDITOR`).
- edits a tracked file inside a temporary git repo, so editor git integrations can highlight your changes while you write
- computes a compact unified diff with small context hunks
- sends only that diff back as the next user message

The model sees only the touched parts plus a bit of surrounding context.

## Usage

Run:

```text
/discuss
```

Flow:

The last answer of the model will be opened in the editor of your choice,
where you can give direct feedback to specific parts of the answer.
You do not need a special annotation syntax. Just edit naturally.

Example:

```diff
 This approach uses a cache in memory.
+Why not persist this to disk as well?
```

```diff
-The API should retry forever.
+Retrying forever seems risky. Cap it and explain the failure mode.
```

## Requirements

- Tested on `pi` 0.69.x (nice), but probably works on way older versions.
- `git` in `PATH`
- `$VISUAL` or `$EDITOR` set to an editor command that waits for the file to close

## Install

Use it as a local extension, global extension, or install it from a git repo. See `pi install --help`.

## Limitations

- it only targets the last completed assistant answer
- it only uses text parts from that answer
- it assumes the diff is enough context for the follow-up
- it relies on `git` and an external editor configured via `$VISUAL` or `$EDITOR`

That is deliberate. This extension is supposed to stay small.
