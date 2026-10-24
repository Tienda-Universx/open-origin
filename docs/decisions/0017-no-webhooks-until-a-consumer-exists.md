# 0017. No webhooks until a consumer exists

- Status: Accepted
- Date: 2026-10-24

## Context

The maintainer asked for webhooks that report every state of the GitHub Actions runs, plus any
others worth having, and delegated the decision (tracker L16). The official documentation, read on
2026-10-24, shows:

- every run and job state needs two events: `workflow_run` (`requested`, `in_progress`,
  `completed`) and `workflow_job` (`queued`, `in_progress`, `waiting`, `completed`);
- a webhook delivers to an HTTPS endpoint that must answer within 10 seconds; GitHub never retries
  a failed delivery, and manual redelivery is possible for 3 days;
- Discord's GitHub-compatible endpoint does not support `workflow_run` or `workflow_job`, and Slack
  incoming webhooks reject GitHub's payload; the maintainer uses neither;
- security alerts (`secret_scanning_alert`, `dependabot_alert`, `code_scanning_alert`) disclose
  unfixed vulnerabilities and must never reach a third party;
- GitHub already notifies by email or on the web when a workflow run the user triggered completes,
  with its status, and can limit this to failed runs.

Open Origin has no deployed service ([0013](0013-defer-hosting-v0-1-runs-locally.md)).

## Decision

We will not create repository or organization webhooks until a consumer exists that acts on the
events, such as an operations dashboard or the server's observability. Until then, run states are
followed in the Actions tab and through GitHub's own notifications.

When a consumer exists, the webhooks will be:

| Webhook | Events | Receiver |
|---|---|---|
| CI status | `workflow_run`, `workflow_job` (all actions) | The consumer's HTTPS endpoint |
| Governance and security | `push`, `pull_request`, `pull_request_review`, `repository_ruleset`, `branch_protection_rule`, `branch_protection_configuration`, `repository`, `security_and_analysis`, `member`, `repository_advisory`, `secret_scanning_alert`, `secret_scanning_alert_location`, `dependabot_alert`, `code_scanning_alert` | A private endpoint we operate, never a third party |

Both use `content_type: json`, SSL verification, and their own random secret stored only on the
receiver. The receiver verifies `X-Hub-Signature-256` in constant time, ignores repeated
`X-GitHub-Delivery` identifiers, and answers within 10 seconds before doing the work. GitHub does not
retry, so an operator or a scheduled job lists the failed deliveries and asks GitHub to redeliver
them within 3 days (REST: list deliveries, then redeliver).

## Consequences

- No endpoint to host, secure, monitor, or pay for, and no event data leaves GitHub.
- No history of events outside GitHub; the Actions tab keeps the run history.
- The design above is ready, so creating the webhooks later is a configuration step, not a new
  decision.

## Alternatives considered

- **Discord or Slack channel.** Rejected: the maintainer uses neither, Discord cannot render run and
  job events, and Slack rejects GitHub's payload.
- **A receiver deployed now (for example a Cloudflare Worker).** Rejected: nothing would consume the
  events, and it adds a public endpoint, a secret, and hosting that [0013](0013-defer-hosting-v0-1-runs-locally.md) defers.
- **smee.io or `gh webhook forward`.** Rejected: GitHub documents them for testing only.
- **A workflow on `workflow_run` that opens an issue when CI fails.** Rejected: it duplicates
  GitHub's failure notifications and adds a workflow with write permission.

## References

- Webhook events and payloads: https://docs.github.com/en/webhooks/webhook-events-and-payloads
- Best practices: https://docs.github.com/en/webhooks/using-webhooks/best-practices-for-using-webhooks
- Validating deliveries: https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries
- Failed deliveries: https://docs.github.com/en/webhooks/using-webhooks/handling-failed-webhook-deliveries
- Notifications for workflow runs: https://docs.github.com/en/actions/concepts/workflows-and-actions/notifications-for-workflow-runs
- Discord webhooks: https://docs.discord.com/developers/resources/webhook
- Tracker `docs/roadmap/v0.1-tracker.md`: L16, L17.
