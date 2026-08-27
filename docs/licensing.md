# Licensing

The deployment contains an isolated Go process linked against the pinned `mautrix/gmessages/pkg/libgm` source. The upstream repository is licensed AGPL-3.0. Its `LICENSE.exceptions` grants narrow named exceptions to Beeper and Element; those exceptions do not apply to this project.

The complete pinned upstream source is included as the `gmessages/` submodule, including its `LICENSE` and `LICENSE.exceptions`. The custom adapter under `adapter/` and any modifications to it must remain available under AGPL-3.0-or-later, with prominent attribution and modification notices. AGPL section 13's network-interaction source-offer requirement must be addressed for a deployed service. Process separation over localhost is an architectural isolation and operational boundary, not an assumption that licensing obligations disappear. Obtain legal review before production deployment.

Upstream: `https://github.com/mautrix/gmessages`, package `go.mau.fi/mautrix-gmessages/pkg/libgm`, pinned to tag `v0.2608.0`, commit `9743919f4884327db998fe0f227c073f3f3aceb3`, reviewed on 2026-08-27. The current adapter imports this pinned source and does not expose raw protobuf or authentication data over IPC.

The production source-offer procedure is to publish the exact deployed adapter source and corresponding pinned upstream source at a stable public URL, include the offer URL in service documentation and deployment metadata, and retain matching source for every deployed revision. Legal must approve the final notice and hosting arrangement before enabling public real-mode service.
