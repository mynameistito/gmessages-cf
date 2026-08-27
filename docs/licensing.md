# Licensing

The deployment contains an isolated Go process linked against the pinned `mautrix/gmessages/pkg/libgm` source. The upstream repository is licensed AGPL-3.0. Its `LICENSE.exceptions` grants narrow named exceptions to Beeper and Element; those exceptions do not apply to this project.

The complete pinned upstream source is included as the `gmessages/` submodule, including its `LICENSE` and `LICENSE.exceptions`. The custom adapter under `adapter/` and any modifications to it must remain available under AGPL-3.0-or-later, with prominent attribution and modification notices. AGPL section 13's network-interaction source-offer requirement must be addressed for a deployed service. Process separation over localhost is an architectural isolation and operational boundary, not an assumption that licensing obligations disappear. Obtain legal review before production deployment.

Upstream: `https://github.com/mautrix/gmessages`, package `go.mau.fi/mautrix-gmessages/pkg/libgm`, pinned to tag `v0.2608.0`, commit `9743919f4884327db998fe0f227c073f3f3aceb3`, reviewed on 2026-08-27. The current adapter imports this pinned source and does not expose raw protobuf or authentication data over IPC.

## Source Offer

The source offer must identify the exact deployed revisions, not a mutable branch, tag, or placeholder. For the currently reviewed source, the adapter is at repository commit https://github.com/mynameistito/gmessages-cf/commit/93c9ea8e92959d48c3d94daf0130d7c3777ef5f5 and the pinned upstream is at https://github.com/mautrix/gmessages/commit/9743919f4884327db998fe0f227c073f3f3aceb3. The deployed service must retain matching source for every revision and expose these exact URLs through its public source-offer notice.

Legal review of the final notice and hosting arrangement is pending. Real-mode production must not be enabled on the basis of this documentation alone.
