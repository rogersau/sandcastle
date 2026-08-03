# Codex execution policy is explicit provider configuration

Codex normally runs under Sandcastle with its unrestricted bypass flag. This
preserves the historical provider behavior: Sandcastle owns the outer sandbox
boundary and the agent can write freely inside it.

Planning and review agents need a different contract. Telling an agent not to
write through its prompt is advisory only; it does not prevent filesystem
changes. The Codex provider therefore accepts explicit `sandboxMode` and
`approvalPolicy` options.

```ts
codex("gpt-5.6-sol", {
  effort: "high",
  sandboxMode: "read-only",
  approvalPolicy: "never",
});
```

## Rules

- When neither option is set, the provider keeps the existing unrestricted
  command line for backward compatibility.
- Setting `sandboxMode` switches to Codex's explicit sandbox and approval flags.
- The default approval policy for an explicit sandbox mode is `never`, so an
  unattended run fails rather than waiting for a human approval.
- Setting only `approvalPolicy` uses `danger-full-access`, matching the
  provider's historical filesystem behavior while making approvals explicit.
- An explicit sandbox or approval policy takes precedence over
  `approvalsReviewer`. This lets a caller enforce `read-only` even if shared
  provider defaults enable auto-review.
- Sandcastle remains the outer isolation boundary. Codex read-only mode is an
  additional inner boundary for agents whose role is inspection, planning, or
  review.

## Consequences

- Consumers can create a non-writing Codex planner instead of relying only on
  prompt instructions.
- Existing consumers receive the same command line unless they opt in.
- Multi-agent workflows can use different execution policies per agent while
  sharing one Sandcastle sandbox and branch.
