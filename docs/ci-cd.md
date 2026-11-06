# CI, automatic delivery and signed commits

The workflows deliver the **existing web application and infrastructure-agent image**. They do not implement or deploy the proposed Robinhood arena, initialize or upgrade contracts, run the agent with user funds, or select DAO rules. Both blockchain configuration and the hosting project are dedicated to testnet/demo use.

## CI on every branch and pull request

[CI workflow](../.github/workflows/ci.yml) runs on branch pushes, pull requests and manual workflow dispatch. On main, in-progress runs are not canceled. Other runs cancel older work for the same event/ref.

| Job | Required checks |
| --- | --- |
| docs | Tracked Markdown file links; OpenSpec 1.2.0 strict validation |
| contracts | Rust formatting, Clippy and contract unit tests |
| sandbox | Contract integration tests |
| node | Frozen pnpm install, typecheck, agent/web tests and build |
| docker | Build agent image and offline health smoke test with a throwaway key |

The file-link checker skips fenced code, remote URLs and section anchors. It does not claim to validate network availability or every Markdown construct. OpenSpec completion means specification validity, not feature implementation.

CI has read-only repository permissions by default. Pull-request jobs do not receive Vercel deployment credentials or package-publishing permissions. The deploy call is permitted only for main outside pull-request events and needs every listed CI job to succeed. Protect main with required CI checks if repository settings do not already enforce them; workflow files alone do not configure branch protection.

## Automatic delivery after main passes CI

[CD testnet workflow](../.github/workflows/cd.yml) is reusable and called by CI. It does not deploy branch/PR builds or expose a direct dispatch bypass. Once merged, each successful main CI run automatically:

1. Builds and publishes the agent image to `ghcr.io/<owner>/<repo>-agent:sha-<full-commit>`. The summary records its registry digest. GHCR authentication uses the workflow's `GITHUB_TOKEN` with package-write permission; no registry password is committed.
2. Pulls the configured Vercel project, validates testnet network/mock funding, builds with pinned Vercel CLI 52.0.0, and deploys the prebuilt web output. The job records the deployment URL in the testnet environment and summary.

CD runs are serialized. Image delivery and web hosting are separate jobs: an image may publish even if Vercel configuration fails. A missing hosting value fails the web job explicitly; it is not reported as a successful deployment.

A registry push distributes an image; it does **not** launch or update a running agent. The agent's eventual host, runtime gas key, NEAR AI API configuration and state-volume lifecycle are separate from this image-delivery workflow. No automatic chain transactions are added.

## One-time Vercel testnet setup

Use an existing or newly provisioned dedicated testnet Vercel project; the workflow does not create accounts, projects or paid plans. Configure the project for this pnpm monorepo with **Root Directory `web`**, Next.js framework detection and access to workspace files outside that directory. Run the CLI from repository root so its linked project settings select the correct application. Use Node 22 and the pinned package manager.

Configure these GitHub values, preferably scoped to the **testnet** environment:

| Type | Name | Purpose |
| --- | --- | --- |
| Secret | `VERCEL_TOKEN` | Deployment token authorized for the chosen project/team |
| Variable | `VERCEL_ORG_ID` | Selected Vercel organization/team ID |
| Variable | `VERCEL_PROJECT_ID` | Selected Vercel web project ID |

The CI caller uses inherited secrets. IDs are read from GitHub variables; setting them only as secrets will not satisfy this workflow. Never send tokens in issues, comments or tracked files. `.vercel/` and downloaded environment files are ignored.

In that project's **Production** environment set:

- `NEXT_PUBLIC_NEAR_NETWORK=testnet`
- `NEXT_PUBLIC_FUNDING_ROUTER=mock`
- Optionally, the existing testnet RPC and arena account values from [deployment](deployment.md). An empty arena ID retains the existing deterministic demo mode.

Vercel's Production label controls its stable hosting alias; it does not mean NEAR mainnet. This project is reserved for testnet. The workflow also supplies testnet/mock defaults and rejects contradictory pulled project values before building. Runtime credentials such as `NEAR_AI_API_KEY` belong in the Vercel project's server environment, not browser-visible variables.

Disable independent Vercel Git auto-deployments for this project so Actions owns the CI gate. Keep deployment protection configured as needed. Record any environment approval rules; these may intentionally pause the otherwise automatic delivery job.

Until the hosting values are configured, the workflow is ready but a live deployment is not established. The target arena remains planned even if this legacy UI is deployed successfully.

## Verification and rollback

After delivery, inspect CI/CD logs, exact commit, Vercel deployment URL and GHCR digest. Verify the deployed web's network and data mode, wallet connection and existing terminal routes; a hosting success is not proof that target Robinhood integrations exist.

For web rollback, use the dedicated Vercel project's previous known-good deployment. For an agent host, retain and deploy the previous image digest with its compatible runtime configuration and persistent state. Neither procedure migrates contract state. Re-running main CI retries delivery after all checks pass; immutable SHA tags and recorded digests identify the delivered source.

References: [Vercel Actions guide](https://vercel.com/kb/guide/how-can-i-use-github-actions-with-vercel), [GitHub image publishing](https://docs.github.com/en/actions/tutorials/publish-packages/publish-docker-images).

## Commit signatures and GitHub Verified

Repository-local Git configuration uses the owner's existing SSH signing key. The documentation commits were reconstructed with their original trees, authors, messages and timestamps, then signed. The unsigned history is retained locally at `backup/near-hackathon-arena-spec-unsigned`. Publishing the signed history requires an explicit force-with-lease against the previously published head; it must refuse if another contributor advanced the branch.

Local `git log --format='%h %G? %s'` reports `G` when the signature verifies with the local allowed-signers file. GitHub's **Verified** badge additionally requires the corresponding public key to be registered with the account as an **SSH signing key**. An authentication key is not automatically a registered signing key. Only the public key may be uploaded; never upload the private key. See [GitHub commit verification](https://docs.github.com/en/authentication/managing-commit-signature-verification/about-commit-signature-verification).

Local signature verification and GitHub verification are distinct results; report the remote badge only after checking GitHub. Signing does not grant deployment rights or prove CI passed.
