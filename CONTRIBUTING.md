# Contributing

## Development

Use Bun for JavaScript and TypeScript work. Initialize the pinned upstream submodule before building or testing the adapter:

```powershell
git submodule update --init --recursive
bun install
```

The supported test path is fake mode and requires no Google account, cookies, access token, session key, or other credentials. Do not add secrets or real personal message data to the repository, tests, fixtures, logs, or pull requests.

Run the relevant checks before submitting a change:

```powershell
bun test
bunx tsc --noEmit
bunx ultracite check
bunx oxfmt --check .
go test ./cmd/server
go vet ./cmd/server
```

Run the Go commands from `adapter/`. Keep changes to the `gmessages/` submodule deliberate and preserve its pinned revision unless the change explicitly updates that pin.

## Pull Requests

Describe behavior changes, security implications, and test results. Do not claim legal approval or Google support. Real-mode work remains gated by legal, integration, source-offer, and operational review.
