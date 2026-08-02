---
"@ai-hero/sandcastle": minor
---

Add an optional Azure Container Instances isolated sandbox provider at `sandboxes/azure-container`.

The provider configures interactive ACI exec sessions for reliable large-input
streaming and reports premature WebSocket termination instead of treating it as
success.

The Codex provider explicitly selects stdin for fresh `codex exec` prompts.
