# Compliance Checkpoint

Real production integration is blocked until a dated review is recorded for:

- Google Terms of Service
- Google Messages service-specific terms
- RCS Chats Terms of Service
- applicable carrier RCS terms
- Google Messages for Web documentation
- Cloudflare Self-Serve Subscription Agreement
- Cloudflare Developer Platform and Zero Trust terms
- `mautrix/gmessages` AGPL-3.0 license and exceptions

The review must cite each source, date, relevant clause, applicability, risk, and mitigation. Google Messages itself is an official product; this service's linked-device client is an unofficial third-party implementation and must not be described as Google-supported.

## Release Gate

Legal review remains pending. Real mode is not production-ready until the terms review, integration review, exact source offer, and operational controls are complete. The source revisions covered by this release metadata are:

- Adapter: https://github.com/mynameistito/gmessages-cf/commit/93c9ea8e92959d48c3d94daf0130d7c3777ef5f5
- Upstream: https://github.com/mautrix/gmessages/commit/9743919f4884327db998fe0f227c073f3f3aceb3

These are immutable public commit URLs, not a claim that the legal review is complete.
