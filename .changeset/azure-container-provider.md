---
"@ai-hero/sandcastle": minor
---

Add an optional Azure Container Instances isolated sandbox provider at `sandboxes/azure-container`.

The provider configures interactive ACI exec sessions for reliable large-input
streaming and reports premature WebSocket termination instead of treating it as
success.

Exec sessions complete as soon as their framed exit marker arrives and release
their client WebSocket, so ACI sessions that never finish a graceful close
cannot block a following sync command.

The Codex provider explicitly selects stdin for fresh `codex exec` prompts.
The bridge waits until the ACI terminal is ready to consume stdin before
streaming those prompts, preventing a startup race that can leave Codex waiting
indefinitely for EOF. Exec transports send periodic WebSocket pings so quiet,
long-running commands do not get dropped by an idle connection timeout.

Files copied out of ACI retain Base64's wrapped whitespace so synced commit
patches are decoded without corrupting their contents.
