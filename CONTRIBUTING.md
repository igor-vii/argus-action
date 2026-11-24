# Contributing to Argus Action

Thank you for looking at the internals! Contributions are welcome.

## How to report a problem

- Open a [GitHub Issue](https://github.com/igor-vii/argus-action/issues) and describe what you ran, what you expected, and what happened.
- Include the run id / check-run URL and, if available, the `argus-result.json` from the `argus-evidence` artifact — session evidence makes diagnosis fast.
- Security-sensitive problems (seal verification bypass, evidence tampering, credential handling): **do not open a public issue** — follow [SECURITY.md](SECURITY.md) and file a private vulnerability report.

## How to propose a change

1. Fork the repo and create a feature branch.
2. Make your change; keep the scope of a PR to one concern.
3. Make sure `npm run build` succeeds and `dist/index.js` is rebuilt if you touched the action source.
4. Open a pull request. GitHub issues and pull requests are the contribution process; all discussions happen there.

## Requirements for acceptable contributions

- **CI must be green** — the CI workflow must pass on your PR.
- **Commits must be GPG-signed** — enable `git config --global commit.gpgsign true` and add your key on GitHub.
- Keep TypeScript style consistent with the existing code; no new runtime dependencies without justification.
- If your change affects verdict semantics, evidence paths, or the SUT contract (`argus.sut.v0`), describe the contract change explicitly in the PR description.
- Documentation changes (README, examples) follow the same PR flow.

## Language

English is the working language for issues, PRs and documentation.
