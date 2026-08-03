# HAFBOT Adaptive Multi-Agent Routing Design

**Status:** Implemented in the local Sandcastle and HAFBOT workspaces; rollout pending
**Date:** 2026-08-03
**Target workflow:** `rogersau/hafbot` ready-for-agent issue processing
**Target runtime:** `hp-hafbot` self-hosted runner → Azure Container Instances

## Executive recommendation

Implement the first version as a **bridge-level router built on the existing public `createSandbox()` API**.

For each issue:

1. Read and normalise trusted GitHub metadata on the runner.
2. Apply a small deterministic routing policy.
3. Create one explicit-branch ACI-backed Sandcastle sandbox.
4. For uncertain issues, run a single read-only Luna preflight in that same ACI.
5. Map the validated classification to a hard-coded route:
   - **Small:** Luna, high reasoning, up to 3 implementation iterations.
   - **Medium or uncertain:** Luna, max reasoning, up to 3 implementation iterations.
   - **Complex:** Sol, high reasoning, one read-only planning pass; then Luna, max reasoning, up to 4 implementation iterations.
6. Optionally run a read-only Sol review for complex work and give Luna one repair iteration when the remaining workflow budget permits it.
7. Close the sandbox in `finally`, aggregate usage and elapsed-time metrics, and return structured outputs to the workflow.

This is the simplest design because Sandcastle already supports:

- one long-lived sandbox through `createSandbox()`;
- repeated `sandbox.run()` calls against one branch;
- multiple iterations within each `sandbox.run()` call;
- ACI reuse through the existing isolated sandbox handle;
- explicit-branch worktree ownership;
- per-iteration token usage from Codex stream events;
- cancellation through `AbortSignal`;
- sync-out after successful iterations.

It does **not** currently provide a first-class adaptive multi-agent router. The bridge must own route selection and phase sequencing.

Two small Sandcastle additions are recommended before calling the planner genuinely read-only:

1. A documented Codex execution policy that supports `read-only` instead of always using `--dangerously-bypass-approvals-and-sandbox`.
2. Structured output support on `Sandbox.run()`, or a reusable exported structured-output parser, so the bridge does not duplicate extraction and validation.

The first rollout can avoid the second addition by validating planner JSON in the bridge. It should not pretend the planner is securely read-only until the first addition exists.

---

## Inspected current state

### HAFBOT workflow

The current `.github/workflows/ready-for-agent.yml`:

- triggers from `ready-for-agent` or manual dispatch;
- runs on `[self-hosted, hafbot, hp-hafbot]`;
- has a 90-minute job timeout;
- validates the issue and deployment variables;
- checks out `master` with full history;
- installs Sandcastle `0.12.0` and the temporary ACI bridge into `RUNNER_TEMP`;
- runs `.github/codex/aci-issue.mjs`;
- rejects changes to trusted automation and repository-instruction paths;
- rejects more than 100 changed files or 10,000 changed lines;
- creates a draft PR when commits exist;
- removes `ready-for-agent` on success or no-change;
- leaves the label in place on failure.

### HAFBOT ACI bridge

The current `.github/codex/aci-issue.mjs`:

- embeds an ACI isolated sandbox provider;
- creates one `gpt-5.6-luna` Codex agent with `effort: "max"`;
- disables session capture;
- calls top-level `run()` once with `maxIterations: 1`;
- uses an explicit issue branch based on issue number and workflow run ID;
- copies the Codex auth file into the ACI;
- uses a 30-minute idle timeout and 60-second completion timeout;
- explicitly deletes the ACI after errors;
- emits branch, commit count, and base SHA through `GITHUB_OUTPUT`.

### Relevant Sandcastle capabilities

The current Sandcastle fork provides:

- `createSandbox({ branch, baseBranch, sandbox, cwd, ... })` for one reusable sandbox and one explicit branch;
- repeated `Sandbox.run()` calls on that sandbox;
- `Sandbox.run({ agent, prompt, maxIterations, signal, ... })`;
- `Sandbox.exec()` for deterministic commands inside the existing sandbox;
- `Sandbox.close()` for ACI and worktree cleanup;
- `IterationResult.usage` for input, cached input, and output tokens;
- isolated-provider sync based on `git format-patch`, `git am`, uncommitted diffs, untracked files, and a sandbox-owned `refs/sandcastle/sync-base` ref;
- ACI WebSocket keepalives and bounded streamed output;
- an ACI maximum lifetime safety limit;
- structured output for top-level `run()` when `maxIterations === 1`.

Important limitations:

1. Top-level `run({ maxIterations: N })` invokes the sandbox factory inside the iteration loop. For an isolated provider, that can create and tear down a separate ACI per iteration. It is therefore the wrong API for the proposed workflow.
2. `Sandbox.run()` reuses one ACI, but it does not accept `output: Output.object(...)`.
3. Structured output is intentionally restricted to one iteration.
4. The Codex provider currently defaults to unrestricted execution inside Sandcastle’s sandbox and has no explicit read-only execution mode.
5. Agent session capture and resume are wired through bind-mount handles. The ACI isolated provider does not currently expose resumable Codex sessions through `SandboxRunResult.resume()`.
6. There is no public `sandbox.sync()` or `sandbox.flush()` operation for salvaging partial isolated-sandbox work after an aborted or failed agent invocation.
7. Sandcastle records token usage but does not expose an exact Codex subscription-credit charge.

These limitations shape the design below.

---

# 1. Recommended architecture and execution sequence

## 1.1 Components

### Workflow controller

`ready-for-agent.yml` remains the outer controller. It owns:

- trusted GitHub event validation;
- checkout and Azure authentication;
- the absolute workflow deadline;
- bridge installation;
- final branch safety checks;
- draft PR publication and issue status updates.

### Adaptive route controller

`aci-issue.mjs` becomes the route controller. It owns:

- input normalisation;
- deterministic classification;
- optional model preflight;
- route mapping;
- ACI creation and reuse;
- planner, implementor, reviewer, and repair sequencing;
- structured handoff validation;
- phase budgets and cancellation;
- usage aggregation;
- structured logs and GitHub outputs;
- best-effort cleanup.

### Sandcastle

Sandcastle continues to own:

- worktree creation;
- branch setup;
- sandbox provider lifecycle;
- agent command construction and parsing;
- iteration loops;
- isolated sync-out;
- commit collection;
- ACI deletion through provider close.

It should not own HAFBOT-specific complexity rules.

## 1.2 Route policy

Recommended initial route table:

| Route                 | Classification                    | Planner                        | Implementor          | Iteration cap | Review                 |
| --------------------- | --------------------------------- | ------------------------------ | -------------------- | ------------: | ---------------------- |
| `small-luna-high-v1`  | small                             | none                           | `gpt-5.6-luna`, high |             3 | none                   |
| `medium-luna-max-v1`  | medium                            | optional Luna preflight output | `gpt-5.6-luna`, max  |             3 | none initially         |
| `complex-sol-luna-v1` | complex                           | `gpt-5.6-sol`, high, one pass  | `gpt-5.6-luna`, max  |             4 | conditional Sol review |
| `fallback-medium-v1`  | unknown or invalid classification | none                           | `gpt-5.6-luna`, max  |             3 | none                   |

`maxIterations` is a ceiling, not a target. Every implementation prompt must tell the agent to emit `<promise>COMPLETE</promise>` as soon as the issue is complete.

Do not start with very high iteration caps. Each Codex iteration is a fresh invocation and can reload most of the repository context. A cap of 3–4 provides recovery opportunities without turning one issue into an unbounded loop.

## 1.3 End-to-end sequence

### Step 0 — Establish the absolute deadline

At the start of the workflow, record a deadline approximately 80 minutes after the job starts. This leaves about 10 minutes before GitHub’s 90-minute hard timeout for:

- ACI close;
- host sync completion;
- branch validation;
- `git push`;
- draft PR creation;
- issue comment and label updates.

Pass the deadline to the bridge as an epoch value. Do not calculate all timeouts independently from the moment each phase begins.

### Step 1 — Load trusted issue context

Fetch the issue through GitHub’s API and construct a normalised object containing only required fields:

- issue number;
- title;
- body;
- state;
- labels;
- author association;
- triggering actor;
- repository;
- base branch and base SHA;
- workflow run ID.

The title and body remain explicitly untrusted data.

### Step 2 — Deterministic pre-classification on the runner

Before creating the ACI, apply the trusted policy described in section 2.

Possible results:

- `small` with high deterministic confidence;
- `medium` with high deterministic confidence;
- `complex` due to a trusted high-risk label or override;
- `unknown`, requiring model preflight.

This avoids paying for classification on obvious issues.

### Step 3 — Create one explicit-branch sandbox

Use:

```ts
const sandbox = await createSandbox({
  cwd: process.cwd(),
  branch,
  baseBranch: baseSha,
  sandbox: azureContainer(...),
  hooks: ...,
});
```

The ACI, sandbox repository, host worktree, and explicit issue branch stay alive through all phases.

Always close it in `finally`.

### Step 4 — Optional Luna preflight classification

For `unknown` issues, run one read-only `gpt-5.6-luna`/high pass in the same ACI.

The preflight may inspect the repository and issue but must return only a constrained classification payload:

- complexity enum;
- confidence;
- fixed reason codes;
- fixed risk flags;
- estimated affected file count band;
- estimated subsystem count band.

It must not select a model, reasoning effort, iteration count, timeout, reviewer, branch, or workflow action.

The bridge validates the payload. The route controller, not the model, maps it to a route.

If output is missing, malformed, or low confidence:

- high-risk flags → complex;
- otherwise → `fallback-medium-v1`.

### Step 5 — Complex planning

For a complex route, invoke Sol once with high reasoning in read-only mode.

Sol receives:

- the trusted wrapper prompt;
- the issue title and body as untrusted data;
- repository rules;
- the current base SHA;
- the requested structured handoff schema.

Sol returns a plan only. It cannot select automation settings.

Validate the plan before implementation. Reject it if it:

- references protected automation paths;
- contains invalid or parent-traversing paths;
- exceeds size limits;
- includes model names, credentials, workflow instructions, branch names, or arbitrary executable commands;
- does not bind to the current issue number and base SHA;
- omits acceptance criteria or validation intent.

### Step 6 — Implementation

Run the selected implementor in the same sandbox.

The implementation prompt contains:

1. trusted repository and automation constraints;
2. the selected route ID and fixed iteration cap for logging only;
3. the issue as untrusted task data;
4. the validated planner handoff, if present;
5. instructions to inspect the existing branch state at the start of every iteration;
6. instructions to commit coherent changes;
7. instructions to stop as soon as acceptance criteria are satisfied.

For multiple iterations, the prompt must make continuation semantics explicit because each iteration starts a new agent invocation:

> Inspect the current branch and existing commits before changing anything. Continue incomplete work instead of restarting it. Do not repeat completed steps. Emit the completion signal as soon as the issue and validation are complete.

Successful iterations sync to the host worktree through the existing isolated sync protocol.

### Step 7 — Deterministic post-implementation checks

Before optional model review, use `sandbox.exec()` for cheap deterministic checks:

- `git status --porcelain`;
- current sandbox `HEAD`;
- changed-file count;
- protected-path check;
- diff-size check;
- presence of at least one commit when implementation claims completion.

The workflow must retain its existing host-side protected-path and size checks. The bridge-side checks provide earlier failure and clearer routing logs; they do not replace the workflow’s trust boundary.

### Step 8 — Optional Sol review

Run Sol review only when all are true:

- route is complex, or a high-risk flag is present;
- implementation produced commits;
- sufficient deadline budget remains;
- review is enabled for the current rollout cohort.

The reviewer receives the issue, validated plan, and diff summary. It returns a constrained review payload:

- `approved`, `repairable`, or `blocked`;
- severity-coded findings;
- affected paths;
- acceptance criteria not met;
- validation gaps.

The reviewer cannot execute workflow actions or alter route settings.

### Step 9 — One Luna repair iteration

If Sol returns `repairable` and the remaining budget permits it, invoke Luna once with the review findings.

After repair:

- rerun deterministic checks;
- do not run a second Sol review in the initial implementation;
- mark the run `completed_after_repair` if checks pass;
- otherwise mark it `needs_human_review`.

One repair pass prevents an open-ended reviewer–implementor loop.

### Step 10 — Close, aggregate, and report

In `finally`:

- close the Sandcastle sandbox;
- if close fails, run the existing explicit ACI deletion fallback;
- aggregate all phase and iteration metrics;
- write GitHub outputs;
- write a concise GitHub step summary;
- preserve the current workflow’s final branch validation and PR publication steps.

---

# 2. Classification alternatives

## 2.1 Deterministic classification

### Approach

Use trusted metadata and small fixed rules:

- explicit trusted size labels;
- trusted domain labels;
- issue type labels;
- whether migrations, security, billing, deployment, or cross-cutting architecture are involved;
- optionally a bounded static scan for referenced paths or subsystem names.

### Advantages

- near-zero model cost;
- deterministic and easy to audit;
- no prompt-injection route control;
- predictable latency;
- easy to replay against historical issues.

### Weaknesses

- labels can be absent or stale;
- repository complexity is not always visible from metadata;
- title/body keyword rules are easy to game and should not directly select expensive routes;
- a small-looking bug can require deep cross-cutting work.

### Recommended use

Use deterministic rules to classify only high-confidence cases and to enforce minimum complexity for high-risk domains.

Do not attempt to classify every issue deterministically.

## 2.2 Issue-label routing

### Suggested labels

- `agent-size:small`
- `agent-size:medium`
- `agent-size:complex`

Optional risk labels already used by the repository can map to minimum routes, for example:

- security;
- architecture;
- migration;
- billing or commerce;
- infrastructure;
- cross-cutting.

### Trust requirements

A size label may be treated as a hard override only when:

- the trigger actor has repository triage/write permission; or
- the workflow was manually dispatched by an authorised actor.

The bridge should not trust arbitrary issue text such as “use Sol” or a similarly named user-created label outside the allowlist.

### Advantages

- simplest and most predictable route;
- gives maintainers control over expensive work;
- avoids preflight cost;
- useful for emergency overrides and rollback.

### Weaknesses

- requires maintainers to classify issues;
- may become stale when an issue expands;
- can overuse expensive models if labels are applied casually;
- does not adapt automatically.

### Recommended use

Use labels as trusted overrides, not as the only classifier.

## 2.3 Model-based preflight planning

### Approach

Run a low-cost read-only agent that inspects the issue and repository before implementation.

### Advantages

- understands actual repository shape;
- can detect hidden cross-cutting effects;
- can estimate affected subsystems and validation needs;
- produces useful context for the implementor.

### Weaknesses

- adds latency and cost to every issue if used universally;
- consumes untrusted issue content;
- can produce invalid structured output;
- can still under- or over-classify;
- requires a real read-only execution policy to be a strong safety boundary.

### Recommended use

Use model preflight only for deterministic `unknown` cases.

## 2.4 Recommended hybrid policy

Order of precedence:

1. **Trusted manual size label**.
2. **Trusted minimum-complexity risk rule**.
3. **High-confidence deterministic rule**.
4. **Read-only Luna preflight**.
5. **Conservative fallback**.

Recommended fallback:

- general uncertainty → medium Luna/max;
- uncertainty plus security, migration, billing, infrastructure, or broad architectural risk → complex Sol-plan route.

This fallback avoids using Sol for every ambiguous issue while reducing the chance that a risky issue is under-routed.

## 2.5 Model classification must not directly select models

The classifier may emit:

```json
{
  "complexity": "medium",
  "confidence": 0.82,
  "reasonCodes": ["MULTIPLE_SUBSYSTEMS"],
  "riskFlags": [],
  "estimatedFileBand": "FOUR_TO_TEN"
}
```

It must not emit:

```json
{
  "model": "gpt-5.6-sol",
  "effort": "max",
  "iterations": 20,
  "timeoutMinutes": 90
}
```

The route mapping is trusted application code with fixed constants.

---

# 3. Integration with the current Sandcastle API and ACI bridge

## 3.1 Use `createSandbox()`, not repeated top-level `run()`

The existing bridge uses top-level `run()` because it performs one implementation invocation.

The adaptive design should change to `createSandbox()` because it provides the long-lived object needed for multi-phase orchestration:

```ts
const sandbox = await createSandbox(...);
try {
  await sandbox.run({ name: "preflight", ... });
  await sandbox.run({ name: "planner", ... });
  await sandbox.run({ name: "implementor", maxIterations: 4, ... });
  await sandbox.run({ name: "reviewer", ... });
  await sandbox.run({ name: "repair", maxIterations: 1, ... });
} finally {
  await sandbox.close();
}
```

This is a supported composition pattern. Existing Sandcastle templates already sequence implementers and reviewers through one `createSandbox()` handle.

## 3.2 ACI reuse

The embedded bridge’s `azureContainer()` returns one isolated sandbox handle containing:

- `worktreePath`;
- `exec`;
- `copyIn`;
- `copyFileOut`;
- `close`.

`createSandbox()` starts this handle once. Each `sandbox.run()` reuses its `SandboxService` rather than calling the provider’s `create()` again.

This avoids:

- repeated ACI provisioning;
- repeated repository sync-in;
- repeated auth setup;
- repeated dependency setup hooks;
- repeated Azure control-plane latency.

The ACI safety lifetime should remain greater than the workflow timeout. The existing two-hour lifetime is adequate for a 90-minute workflow, while `restartPolicy: Never` limits orphan billing.

## 3.3 Worktree and commit synchronisation

Use one explicit branch:

```text
agent/issue-<number>-<run-id>
```

The host worktree remains the authoritative branch published by the workflow.

For each successful implementation or repair iteration:

1. Sandcastle records the host worktree base SHA.
2. The agent works in the ACI repository.
3. The agent commits changes.
4. `syncOut()` creates patches from the sandbox’s current sync-base ref.
5. The host applies them with `git am --3way`.
6. Sandcastle advances the sandbox-owned sync-base ref.
7. Commit collection returns host-side SHAs.

The sandbox and host commit SHAs can differ because `git am` recreates commits. The route controller must treat the host worktree and returned commit list as authoritative for PR publication.

Aggregate commits across phases. Do not assume the last `SandboxRunResult.commits` contains earlier implementation commits.

## 3.4 Structured output integration

There are two viable approaches.

### Initial bridge implementation

For preflight, planning, and review:

- run exactly one `sandbox.run()` iteration;
- require a named XML tag;
- extract the last matching tag from `stdout`;
- parse JSON;
- validate with Zod or another Standard Schema library in the bridge;
- permit one fresh retry for malformed output;
- reject or fall back after the retry.

This requires no new Sandcastle API.

### Preferred Sandcastle API parity

Add `output?: OutputDefinition` to `SandboxRunOptions` and overload `Sandbox.run()` similarly to top-level `run()`.

Constraints should remain:

- `maxIterations === 1` when output is set;
- prompt must contain the opening tag;
- validation occurs after the run;
- retry through session resume is unavailable for isolated ACI until isolated session capture exists.

This avoids bridge-specific extraction code and keeps validation behaviour consistent.

## 3.5 Read-only planner integration

The current Codex provider always uses unrestricted execution unless `approvalsReviewer: "auto_review"` changes approval behaviour. Prompting a planner not to write is not an enforceable read-only boundary.

Recommended Sandcastle addition:

```ts
codex(model, {
  effort: "high",
  executionMode: "read-only",
  approvalPolicy: "never",
});
```

Exact naming can differ, but the provider should have an explicit, typed execution policy. It should generate documented Codex CLI flags rather than requiring the HAFBOT bridge to replace command substrings.

Defence in depth after every read-only phase:

- compare sandbox `HEAD` before and after;
- require `git status --porcelain` to remain empty;
- require no new commits;
- abort the route if the planner changed the repository.

Without the provider change, describe the planner as **non-writing by prompt and verified afterwards**, not securely read-only.

## 3.6 No required generic multi-agent API

The first version does not need a new abstraction such as:

```ts
sandcastle.route(...)
sandcastle.multiAgent(...)
sandcastle.orchestrateAgents(...)
```

Those APIs do not exist and would add unnecessary framework design before the HAFBOT policy is proven.

The bridge can sequence existing primitives directly.

A generic route API should only be considered after at least two workflows need the same policy model.

---

# 4. Structured handoff schema between Sol and the implementor

## 4.1 Separate classification and implementation-plan schemas

Do not combine route selection and implementation planning into one object.

- Classification is consumed by trusted route policy.
- The implementation plan is consumed by the implementor.

This separation prevents planner text from controlling model, effort, iterations, timeouts, or workflow actions.

## 4.2 Classification schema

Suggested schema:

```ts
const Classification = z.object({
  schemaVersion: z.literal("1"),
  issueNumber: z.number().int().positive(),
  baseSha: z.string().regex(/^[0-9a-f]{40}$/),
  complexity: z.enum(["small", "medium", "complex", "unknown"]),
  confidence: z.number().min(0).max(1),
  reasonCodes: z
    .array(
      z.enum([
        "LOCAL_CHANGE",
        "SINGLE_SUBSYSTEM",
        "MULTIPLE_SUBSYSTEMS",
        "CROSS_CUTTING_CONTRACT",
        "DATA_MIGRATION",
        "SECURITY_BOUNDARY",
        "EXTERNAL_INTEGRATION",
        "INFRASTRUCTURE_CHANGE",
        "UNCLEAR_SCOPE",
      ]),
    )
    .max(8),
  riskFlags: z
    .array(
      z.enum([
        "SECURITY",
        "MIGRATION",
        "BILLING",
        "INFRASTRUCTURE",
        "AUTHENTICATION",
        "CROSS_GUILD_DATA",
        "DESTRUCTIVE_CHANGE",
      ]),
    )
    .max(8),
  estimatedFileBand: z.enum([
    "ONE_TO_THREE",
    "FOUR_TO_TEN",
    "MORE_THAN_TEN",
    "UNKNOWN",
  ]),
  estimatedSubsystemBand: z.enum([
    "ONE",
    "TWO_OR_THREE",
    "MORE_THAN_THREE",
    "UNKNOWN",
  ]),
});
```

The route controller verifies `issueNumber` and `baseSha` against trusted values.

## 4.3 Sol implementation-plan schema

Suggested schema:

```ts
const ImplementationPlan = z.object({
  schemaVersion: z.literal("1"),
  issueNumber: z.number().int().positive(),
  baseSha: z.string().regex(/^[0-9a-f]{40}$/),
  objective: z.string().min(1).max(1000),
  assumptions: z.array(z.string().max(500)).max(12),
  affectedAreas: z.array(z.string().min(1).max(240)).min(1).max(30),
  steps: z
    .array(
      z.object({
        id: z.string().regex(/^S[1-9][0-9]?$/),
        description: z.string().min(1).max(1200),
        paths: z.array(z.string().max(240)).max(20),
        dependsOn: z.array(z.string().regex(/^S[1-9][0-9]?$/)).max(10),
        acceptanceCriteria: z.array(z.string().max(500)).min(1).max(10),
      }),
    )
    .min(1)
    .max(20),
  validation: z
    .array(
      z.object({
        kind: z.enum([
          "TYPECHECK",
          "LINT",
          "UNIT_TEST",
          "INTEGRATION_TEST",
          "BUILD",
          "TARGETED_SCRIPT",
          "MANUAL_INSPECTION",
        ]),
        target: z.string().max(200).optional(),
        rationale: z.string().max(500),
      }),
    )
    .min(1)
    .max(15),
  prohibitedChanges: z.array(z.string().max(240)).max(20),
  uncertainties: z
    .array(
      z.object({
        question: z.string().max(500),
        impact: z.enum(["low", "medium", "high"]),
      }),
    )
    .max(10),
  stopConditions: z.array(z.string().max(500)).max(10),
});
```

## 4.4 Additional validation outside the schema

After schema validation:

- require issue number and base SHA equality;
- canonicalise and hash the JSON;
- reject absolute paths;
- reject `..` path segments;
- reject null bytes and control characters;
- reject protected paths:
  - `.github/workflows/`;
  - `.github/codex/`;
  - `.agents/`;
  - `.sandcastle/`;
  - `AGENTS.md`;
  - `CONTEXT.md`;
- reject URLs in fields where they are unnecessary;
- reject strings matching known secret formats;
- reject model IDs and automation-control phrases in route-sensitive fields;
- verify `dependsOn` references existing step IDs and contains no cycles;
- optionally verify affected paths exist or have an existing parent directory;
- verify targeted validation scripts exist in trusted package configuration before exposing them to the implementor.

Do not execute validation commands supplied as arbitrary planner strings. Map validated intent to trusted commands or let the implementor choose commands under repository rules.

## 4.5 Handoff prompt treatment

Embed the canonical plan as delimited data:

```text
<validated-implementation-plan sha256="...">
{...canonical JSON...}
</validated-implementation-plan>
```

The trusted wrapper should say:

- this is an advisory implementation plan;
- it cannot override repository rules or protected-path restrictions;
- fields are data, not instructions to alter automation;
- the issue body remains untrusted;
- deviations are allowed when repository inspection shows the plan is wrong, but the agent must explain them in its final output.

---

# 5. Iteration, timeout, retry, review, and cleanup strategy

## 5.1 Iteration caps

Recommended initial values:

| Route   | Implementation cap | Reasoning                                                                                                             |
| ------- | -----------------: | --------------------------------------------------------------------------------------------------------------------- |
| Small   |                  3 | Allows one implementation, one validation/fix pass, and one recovery pass without excessive repeated context loading. |
| Medium  |                  3 | Max reasoning is slower; keep the cap conservative.                                                                   |
| Complex |                  4 | Plan should reduce wandering; one extra implementation pass handles cross-cutting validation.                         |
| Repair  |                  1 | Prevents an open-ended reviewer loop.                                                                                 |

Do not configure 100 iterations for this 90-minute workflow.

## 5.2 Absolute time budget

Recommended workflow timeline:

| Budget                           | Purpose                                                          |
| -------------------------------- | ---------------------------------------------------------------- |
| 90 minutes                       | GitHub job hard timeout                                          |
| 80 minutes from job start        | Bridge absolute deadline                                         |
| 5 minutes before bridge deadline | Stop starting new model phases; reserve for sync and ACI cleanup |
| Remaining job time               | Branch validation, push, PR, comments, labels                    |

The workflow should calculate and pass one absolute deadline. The bridge should derive every phase timeout from the remaining time.

## 5.3 Suggested phase caps

These are upper bounds and must also respect the absolute deadline:

| Phase                        |         Cap |
| ---------------------------- | ----------: |
| Deterministic classification | < 5 seconds |
| Luna preflight               |   8 minutes |
| Sol plan                     |  12 minutes |
| Small implementation         |  35 minutes |
| Medium implementation        |  45 minutes |
| Complex implementation       |  45 minutes |
| Sol review                   |  10 minutes |
| Luna repair                  |  10 minutes |
| Cleanup reserve              |   5 minutes |

The complex route cannot always run every optional phase. Review and repair are conditional on remaining budget.

## 5.4 Cancellation

Create an `AbortController` per phase.

Abort when either:

- the phase cap expires; or
- the absolute workflow deadline minus cleanup reserve is reached.

Pass the signal to `sandbox.run()`.

Sandcastle can kill the in-flight agent subprocess and leaves the reusable sandbox handle available after abort. The route controller can inspect state, decide whether a safe retry is possible, and still close the ACI.

## 5.5 Idle and completion timeouts

Keep idle timeout separate from phase wall-clock timeout.

Suggested defaults:

- preflight and planning: 10-minute idle timeout;
- implementation: 20-minute idle timeout;
- review and repair: 10-minute idle timeout;
- completion timeout: 60 seconds.

The ACI WebSocket keepalive prevents transport silence from closing healthy exec sessions. Sandcastle’s idle timeout still protects against a genuinely silent agent.

## 5.6 Structured output retry

For classification, planning, and review:

- first attempt: normal structured prompt;
- if extraction or validation fails: one fresh single-iteration retry containing only the validation error and required tag;
- if the retry fails: use the policy fallback or fail the optional phase.

Because ACI sessions are not currently captured for resume, this is a new Codex invocation, not a resumed conversation.

## 5.7 Agent retry

Retry only clearly transient failures:

- Codex rate limit or temporary service error;
- ACI exec transport failure before repository writes;
- ACI provisioning failure before the first agent starts.

Maximum one retry.

Before retrying an implementation invocation in the same ACI:

- inspect `git status`;
- inspect sandbox `HEAD` against the phase start;
- include current state in the retry prompt;
- do not reset or discard partial work automatically unless policy proves no useful changes exist.

Do not retry deterministic test failures by launching the same unchanged prompt repeatedly. Use another implementation iteration or repair prompt that includes the failure.

## 5.8 Review outcomes

- `approved`: continue to publish.
- `repairable`: run one Luna repair if budget remains.
- `blocked`: publish only as a clearly marked draft requiring human review, or fail the route according to rollout policy.
- invalid review output: log `review_unavailable`; do not discard otherwise valid implementation commits.

Recommended initial behaviour is to create a draft PR for useful commits even when model review is unavailable, because the workflow already creates drafts for human review.

## 5.9 Failure cleanup

Always use nested cleanup:

```ts
let sandbox;
try {
  sandbox = await createSandbox(...);
  // phases
} finally {
  if (sandbox) await sandbox.close().catch(...);
  await explicitAzureDeleteFallback().catch(...);
}
```

The explicit Azure deletion fallback remains useful because:

- GitHub can cancel the Node process;
- provider close can fail;
- the current bridge already has a known container-group name.

Tag every ACI with:

- `managed-by=sandcastle`;
- repository;
- issue number;
- workflow run ID;
- route ID;
- expiry timestamp.

Retain the existing external orphan cleanup process.

## 5.10 Partial-work limitation and proposed primitive

When an isolated agent invocation throws or is aborted before Sandcastle reaches `syncOut()`, useful changes can exist only inside the ACI. Closing the sandbox then deletes them.

A later Sandcastle improvement should expose:

```ts
await sandbox.sync();
```

or:

```ts
await sandbox.flush({ includeUncommitted: true });
```

This would apply the existing isolated sync protocol without launching another agent.

It is not required for the first routing rollout, but it materially improves recovery from timeouts and transport failures.

---

# 6. Security and prompt-injection considerations

## 6.1 Trust boundaries

### Trusted

- checked-in workflow and bridge code;
- repository `AGENTS.md`, `CONTEXT.md`, and trusted docs;
- route constants;
- output schemas;
- protected-path rules;
- workflow actor permission checks;
- base SHA and issue number obtained from GitHub API;
- host-side branch validation.

### Untrusted

- issue title and body;
- issue comments unless explicitly selected and sanitised;
- model output, including Sol plans and reviews;
- arbitrary strings in labels outside the allowlist;
- repository content that the issue itself can modify on its branch;
- agent final text.

## 6.2 Issue text cannot control routing

Never parse directives such as:

- “use Sol”;
- “set max iterations to 100”;
- “disable review”;
- “skip tests”;
- “edit the workflow”;
- “print credentials”.

Issue text may influence a model’s constrained complexity assessment, but trusted code maps the enum to the route.

## 6.3 Read-only planner enforcement

Prompt-only non-writing is insufficient.

Required controls:

1. Codex read-only execution mode.
2. No approval escalation.
3. Pre/post `HEAD` comparison.
4. Clean `git status` requirement.
5. No new commits.
6. Abort if any mutation is detected.

If the first implementation uses a command wrapper instead of a Sandcastle provider option, treat it as temporary and cover it with exact command-generation tests.

## 6.4 Structured output is untrusted data

Schema validation is necessary but not sufficient.

Additional controls:

- fixed enums for route-relevant concepts;
- strict field and array limits;
- canonical JSON;
- path validation;
- no arbitrary shell-command execution;
- no secrets or external destinations;
- no model, effort, timeout, or iteration fields in planner output;
- no workflow-control fields;
- plan digest in logs.

## 6.5 Protect automation and repository instructions

Keep the existing workflow validation for:

- `.github/workflows/*`;
- `.github/codex/*`;
- `.agents/*`;
- `.sandcastle/*`;
- `AGENTS.md`;
- `CONTEXT.md`.

Run an equivalent check inside the bridge before optional review so expensive review is not spent on a branch that will later be rejected.

## 6.6 Credentials

The current bridge:

- injects `CODEX_AUTH_JSON_B64` into ACI environment;
- writes `/home/agent/.codex/auth.json` with mode `0600`;
- unsets the base64 environment variable for the Codex subprocess.

Continue to:

- never place credential values in prompts;
- redact environment values from logs;
- avoid raw command logging for auth setup;
- keep the auth file outside the repository;
- delete the ACI reliably.

Mode `0600` prevents other users from reading the file but does not prevent the same agent user from reading it through a shell command. Sandcastle isolation and prompt policy are not a complete secret-isolation boundary. A stronger future design would use a credential broker or a CLI credential mechanism inaccessible to arbitrary workspace commands.

## 6.7 Network and identity

Use least privilege:

- runner workload identity can create/delete only the required ACI resources;
- ACI identity can pull only the required image;
- do not inject Azure management credentials into the container;
- do not grant the agent GitHub tokens;
- retain “do not call GitHub APIs or push branches” in the trusted prompt;
- consider outbound network restrictions later if the ACI environment supports them without excessive complexity.

## 6.8 Denial-of-wallet controls

An attacker should not be able to force Sol merely by writing issue text.

Controls:

- only trusted labels can force complex;
- model classification uses constrained output;
- fixed route caps;
- absolute workflow deadline;
- maximum one structured-output retry;
- maximum one repair iteration;
- stable allowlisted model IDs;
- per-route experiment allocation controlled by code, not issue content.

---

# 7. Cost and latency trade-offs

## 7.1 Model positioning

As of 2026-08-03, OpenAI describes:

- **Luna** as the fastest and lowest-cost GPT-5.6 model;
- **Terra** as balancing intelligence and cost;
- **Sol** as the frontier model for complex professional work.

Published API token prices at this date are:

| Model | Input / 1M | Output / 1M | Relative to Luna |
| ----- | ---------: | ----------: | ---------------: |
| Luna  |      $1.00 |       $6.00 |               1× |
| Terra |      $2.50 |      $15.00 |             2.5× |
| Sol   |      $5.00 |      $30.00 |               5× |

These prices are useful for relative design decisions. Exact Codex subscription credit consumption may differ and must not be inferred unless Codex exposes it directly.

References:

- https://developers.openai.com/api/docs/models/gpt-5.6-luna
- https://developers.openai.com/api/docs/models/gpt-5.6-terra
- https://developers.openai.com/api/docs/models/gpt-5.6-sol

## 7.2 Why multiple Luna iterations can help

Benefits:

- a fresh agent can inspect and repair prior work;
- validation failures can be addressed without manual requeue;
- completion signals stop the loop early;
- same ACI and branch preserve repository progress.

Costs:

- every iteration is a fresh context load;
- repeated repository inspection increases input tokens;
- max reasoning can make each iteration slow;
- later agents can undo good prior work if the prompt does not emphasise continuation.

Use 3–4 as a measured cap, not an arbitrary large number.

## 7.3 Sol planning economics

Sol planning adds cost before implementation but can reduce:

- architecture mistakes;
- unnecessary file exploration;
- duplicated implementation attempts;
- failed validation late in the workflow;
- human review burden.

It is economically justified only if it improves the end-to-end success metric for complex issues. Do not use Sol universally.

## 7.4 Terra as complex implementor

### Hypothesis

Terra/high may be a better complex implementor than Luna/max because Terra is positioned between Luna and Sol on capability and price. It may:

- follow a complex plan more reliably;
- require fewer iterations;
- produce fewer repair findings;
- finish faster than repeated Luna/max attempts despite a higher per-token price.

### Why not make Terra the default immediately

There is no HAFBOT-specific evidence yet that Terra/high produces better implementation outcomes per unit cost or within the 90-minute budget.

Luna is already deployed and forms a useful control.

### Recommendation

- Keep Luna/max as the initial complex implementor.
- Run Terra/high as an experiment on historical issues first.
- Then allocate a stable 50% of eligible complex production issues to Terra/high.
- Compare end-to-end success, not only token cost.

Primary comparison:

```text
successful draft PR
+ required CI passes
+ no major human review findings
+ completed within workflow deadline
```

If Terra reduces implementation iterations or repair frequency enough, its 2.5× token price can still produce a lower total cost per successful issue.

## 7.5 ACI reuse economics

One ACI per issue avoids repeated provisioning latency and repository transfer.

Benefits are strongest for complex routes with planner, implementor, reviewer, and repair phases.

The ACI remains billed while models reason, so reuse does not eliminate compute cost. It removes control-plane and setup overhead and lowers failure exposure.

---

# 8. Observability and routing-quality metrics

## 8.1 Structured event log

Emit one JSON object per significant event, prefixed consistently, for example:

```text
SANDCASTLE_ROUTE_EVENT { ... }
```

Common fields:

- schema version;
- timestamp;
- repository;
- issue number;
- workflow run ID;
- branch;
- base SHA;
- ACI group name;
- route-policy version;
- experiment cohort;
- selected route;
- phase;
- model;
- reasoning effort;
- configured iteration cap;
- actual iteration;
- elapsed phase seconds;
- elapsed total seconds;
- remaining budget seconds;
- input tokens;
- cache-creation input tokens;
- cache-read input tokens;
- output tokens;
- credit usage when directly reported, otherwise `null`;
- usage source;
- commit count;
- changed-file count;
- changed-line count;
- outcome;
- error category.

Do not log prompts, issue body, auth paths containing secret values, or raw environment variables in structured metrics.

## 8.2 Classification metrics

Log:

- deterministic result;
- deterministic rule ID;
- model preflight result;
- confidence;
- reason codes;
- risk flags;
- final policy route;
- fallback reason;
- manual label override.

This permits later comparison between classifier prediction and actual implementation scope.

## 8.3 Plan metrics

Log:

- plan schema version;
- plan hash;
- number of steps;
- number of affected areas;
- number of validation intents;
- uncertainty count;
- validation attempt count;
- validation failure category.

Do not log the entire plan into a public issue comment.

## 8.4 Agent usage

Sandcastle already returns per-iteration token usage from Codex `turn.completed` events. Aggregate by:

- phase;
- model;
- route;
- issue;
- successful versus failed attempt.

Record exact token counts.

For credits:

- record a direct value only if Codex emits one and the parser captures it;
- otherwise record `credits: null` and optionally a clearly labelled API-price estimate;
- never present an estimate as an actual subscription charge.

## 8.5 Outcome metrics

Primary outcome:

- draft PR produced within deadline;
- branch passes required CI;
- no major human-requested changes;
- PR merged or issue accepted.

Secondary metrics:

- no-change rate;
- timeout rate;
- transport failure rate;
- invalid structured-output rate;
- planner mutation attempts;
- first-pass CI success;
- number of agent iterations used;
- Sol review approval rate;
- repair success rate;
- human review comments by severity;
- time to draft PR;
- time to merge;
- tokens per successful issue;
- estimated cost per successful issue;
- ACI lifetime;
- fallback frequency;
- route distribution.

## 8.6 Routing quality

Detect under-routing:

- small route uses all iterations and still fails;
- small route changes many files or subsystems;
- human review identifies architectural omissions;
- issue is requeued after no useful result.

Detect over-routing:

- complex route changes one or two simple files;
- Sol plan contains one trivial step;
- Luna completes on first iteration with minimal tokens;
- human review finds no complexity and no repair need.

Build a confusion matrix against post-hoc complexity labels.

## 8.7 GitHub outputs and step summary

Extend bridge outputs with:

- `route`;
- `classification`;
- `classification_confidence`;
- `implementor_model`;
- `implementor_effort`;
- `iterations_used`;
- `review_status`;
- `outcome`;
- `elapsed_seconds`;
- `input_tokens`;
- `cached_input_tokens`;
- `output_tokens`;
- `credits` when available;
- `metrics_path` if an artifact is uploaded later.

Write a concise Markdown table to `GITHUB_STEP_SUMMARY`.

---

# 9. Staged rollout and A/B evaluation using historical HAFBOT issues

## Stage 0 — Baseline instrumentation

Keep the current Luna/max, one-iteration behaviour.

Add only:

- route ID `legacy-luna-max-1`;
- elapsed-time logging;
- per-iteration token aggregation;
- commit and diff statistics;
- outcome classification.

Run long enough to establish a baseline.

## Stage 1 — Offline historical classifier evaluation

Build a dataset from closed HAFBOT issues with merged PRs.

For each issue, capture information available before implementation:

- title;
- body;
- labels;
- creation and update metadata;
- base repository state if reconstructable.

Capture outcome proxies:

- changed files;
- changed lines;
- subsystems touched;
- migrations added;
- security-sensitive areas touched;
- CI results;
- review comment severity;
- time to merge;
- whether the PR was substantially rewritten.

Create a provisional post-hoc complexity label:

- **Small:** 1–3 files, limited lines, one subsystem, no high-risk boundary.
- **Medium:** 4–10 files or multiple related components.
- **Complex:** broad cross-cutting work, migrations, security boundaries, architecture changes, or more than 10 files.

This proxy is imperfect. Manually review a representative sample.

Evaluate:

- deterministic rules;
- label overrides;
- Luna preflight classification;
- fallback frequency;
- under-routing and over-routing rates.

Tune thresholds before changing production routes.

## Stage 2 — Shadow routing in production

Run the classifier and log its proposed route, but continue using the existing implementation route.

Compare predicted complexity with actual diff and review outcomes.

Exit criteria:

- invalid classification output below 2%;
- high-risk issues under-routed below an agreed threshold;
- unknown/fallback rate low enough to provide value;
- no planner/preflight repository mutation.

## Stage 3 — Small and medium routes

Enable:

- small → Luna/high, up to 3 iterations;
- medium → Luna/max, up to 3 iterations;
- unknown → fallback medium.

Use a stable experiment assignment such as a hash of:

```text
repository + issue number + experiment version
```

Control:

- current Luna/max, one iteration.

Treatment:

- adaptive small/medium route.

Primary metric:

- successful useful draft PR within deadline and acceptable human review.

Guardrails:

- p95 bridge duration below 70 minutes;
- no significant increase in failed or empty PRs;
- no increase in protected-path violations;
- cost per successful issue does not regress beyond the agreed threshold.

## Stage 4 — Complex Sol planning

Enable complex routing for a limited cohort.

Control:

- Luna/max implementation without Sol planning.

Treatment:

- Sol/high plan → Luna/max implementation.

Initially disable Sol final review to isolate the effect of planning.

Measure:

- implementation iterations;
- first-pass CI success;
- major human findings;
- completion within deadline;
- tokens and elapsed time.

## Stage 5 — Terra versus Luna complex implementor

### Offline replay

Select historical complex issues and recreate the pre-change base revision.

For each issue:

1. Generate one Sol plan.
2. Run Luna/max against one isolated branch.
3. Run Terra/high against another isolated branch.
4. Run the same trusted validations.
5. Compare each result with the merged historical PR.
6. Use blinded human review or a fixed reviewer rubric.

Do not let the two implementors share worktrees or session context.

### Production A/B

After offline evidence, assign eligible complex issues 50/50:

- Sol/high plan → Luna/max implementor;
- Sol/high plan → Terra/high implementor.

Keep plan, budget, prompt, validation, and review policy identical.

Promote Terra only if it improves cost per successful issue, success rate, or latency without worsening review quality.

## Stage 6 — Sol review and Luna repair

Enable review for a small complex cohort.

Compare:

- no model review;
- Sol review only;
- Sol review plus one Luna repair.

Measure whether review catches issues that humans would otherwise catch and whether repair resolves them without introducing regressions.

## Rollback

A single trusted workflow variable should disable adaptive routing and return to:

```text
Luna / max / maxIterations 1
```

Keep policy versions in logs so results can be compared across rollouts.

---

# 10. Exact files and interfaces likely to change

## 10.1 HAFBOT — required for the first implementation

### `.github/codex/aci-issue.mjs`

Replace the single-agent call with the bridge-level route controller.

Likely additions:

- route constants;
- deterministic classifier;
- trusted-label validation;
- deadline manager;
- model factories for Luna, Terra, and Sol;
- `createSandbox()` usage;
- preflight, plan, implementation, review, and repair phase functions;
- structured tag extraction and schema validation;
- plan/path validation;
- phase `AbortController`s;
- usage aggregation;
- structured JSON event logs;
- expanded GitHub outputs;
- cleanup fallback;
- optional experiment assignment.

Retain:

- ACI provider until the published Azure provider version used by HAFBOT includes all required fixes;
- current WebSocket keepalive behaviour;
- auth setup;
- explicit branch naming;
- ACI tags;
- explicit error cleanup.

### `.github/workflows/ready-for-agent.yml`

Likely changes:

- record an absolute job deadline early;
- pass routing feature flags and experiment version;
- install `zod` if bridge-local schema validation is used;
- optionally install a Sandcastle version containing read-only Codex policy;
- include route metrics in step summary;
- branch final behaviour on `outcome`, not only `commit_count`;
- optionally upload a metrics JSON artifact;
- keep final protected-path and diff-size validation unchanged.

### `/home/james/hafbot-runner`

No runner change is expected for the basic design if it already provides:

- Node 22;
- Azure CLI/workload identity prerequisites;
- `git`, `jq`, `gh`, `tar`, and required system tools;
- stable runner labels;
- orphan cleanup.

This directory was not available through the current MCP allowlist and must be verified before implementation. Any change should be limited to environment defaults or cleanup scheduling, not routing policy.

## 10.2 HAFBOT — optional split after the design stabilises

To keep the first implementation simple, routing can remain in `aci-issue.mjs`.

If the file becomes difficult to test, split into:

- `.github/codex/routing-policy.mjs`;
- `.github/codex/schemas.mjs`;
- `.github/codex/prompts.mjs`;
- `.github/codex/metrics.mjs`;
- `.github/codex/aci-issue.test.mjs`.

Do not create these files pre-emptively unless the bridge becomes unmanageable.

## 10.3 Sandcastle — recommended required API change

### `src/AgentProvider.ts`

Extend `CodexOptions` with an explicit execution policy, for example:

```ts
readonly executionMode?:
  | "read-only"
  | "workspace-write"
  | "danger-full-access";
readonly approvalPolicy?: "never" | "on-request";
```

Update `codex().buildPrintCommand()` to generate the documented CLI flags.

Default behaviour must remain backward compatible.

### `src/AgentProvider.test.ts`

Add command-generation coverage for:

- default unrestricted mode;
- read-only mode;
- workspace-write mode if supported;
- approval-policy combinations;
- resume/fork combinations;
- shell escaping.

### `src/index.ts`

Export any new public option types if they are not already exported through `CodexOptions`.

### `docs/adr/<new>-codex-execution-policy.md`

Document:

- why planner read-only is a provider execution policy;
- defaults and compatibility;
- relationship to Sandcastle sandbox isolation;
- why prompt-only read-only is insufficient.

### `.changeset/<name>.md`

Add the required minor changeset because this is a new public feature in a pre-1.0 package.

## 10.4 Sandcastle — recommended API parity, not required for v1

### `src/createSandbox.ts`

Add structured output to `SandboxRunOptions` and typed `Sandbox.run()` overloads.

Reuse the top-level `run()` validation rules.

### `src/extractStructuredOutput.ts`

Reuse existing extraction without duplication.

### `src/Output.ts`

No schema redesign is required; only ensure error metadata is appropriate for a long-lived sandbox result.

### `src/createSandbox.test.ts`

Cover:

- output with one iteration;
- rejection with multiple iterations;
- malformed output;
- schema failure;
- repeated output runs in one sandbox;
- no container recreation.

### `docs/adr/0010-structured-output.md`

Amend “run only” to include `Sandbox.run()` and document the same one-iteration constraint.

## 10.5 Sandcastle — later recovery primitive

### `src/createSandbox.ts`

Potentially add:

```ts
Sandbox.sync(): Promise<SyncResult>
```

This should expose the existing isolated `applyToHost` operation safely.

### `src/syncOut.ts`

Reuse current sync-base behaviour; do not implement a second sync algorithm.

### Tests and ADR

Cover:

- committed, uncommitted, and untracked changes;
- repeated sync;
- sync after aborted agent invocation;
- no-op sync;
- failed `git am` recovery artifacts.

This is valuable but can follow the initial routing rollout.

## 10.6 Sandcastle — usage extension, optional

Current `IterationUsage` is sufficient for token reporting.

Only add fields such as:

```ts
readonly credits?: number;
readonly costUsd?: number;
readonly usageSource?: string;
```

if Codex provides authoritative values. Do not add guessed credits to the core interface.

## 10.7 Files that do not need routing changes

No routing-specific changes are expected in:

- `src/sandboxes/azure-container.ts`, beyond any provider fixes already underway;
- `src/Orchestrator.ts`, because `createSandbox()` plus sequential `sandbox.run()` calls already provide the needed execution model;
- `src/SandboxLifecycle.ts`, for successful phase sync;
- `src/syncOut.ts`, until manual flush/sync recovery is added;
- `codex-repo-automation`;
- any Sol escalation thread or external automation.

“Sol” in this design is only the model role.

---

# Proposed first implementation scope

The smallest useful implementation is:

1. Add read-only Codex execution policy to Sandcastle.
2. Update the HAFBOT bridge to use `createSandbox()`.
3. Implement deterministic classification plus Luna preflight fallback.
4. Implement small, medium, and complex route constants.
5. Implement bridge-local validated Sol plan handoff.
6. Run Luna as complex implementor; leave Terra behind an experiment flag.
7. Add absolute deadlines and usage logs.
8. Keep final Sol review disabled by default until baseline data exists.
9. Retain all existing branch validation and cleanup.

This achieves adaptive routing, one-ACI reuse, structured planning, bounded retries, and measurable outcomes without creating a generic multi-agent framework.

---

# Decision summary

- **Architecture:** bridge-level router using one `createSandbox()` per issue.
- **Classifier:** trusted labels + deterministic rules + Luna preflight only for uncertain cases.
- **Fallback:** medium Luna/max unless uncertainty includes a high-risk boundary.
- **Small:** Luna/high, up to 3 iterations.
- **Medium:** Luna/max, up to 3 iterations.
- **Complex:** Sol/high read-only plan, then Luna/max, up to 4 iterations.
- **Terra:** evaluate as an A/B complex implementor; do not assume it is better without HAFBOT evidence.
- **Review:** conditional Sol review with at most one Luna repair pass.
- **ACI:** reuse one instance through `createSandbox()`.
- **Handoff:** strict schema, no automation-control fields, canonical hash.
- **Timeout:** one absolute workflow deadline with cleanup reserve.
- **Security:** issue and model outputs remain untrusted; model output never directly selects route settings.
- **New Sandcastle primitive required for strong read-only:** typed Codex execution policy.
- **Useful later primitives:** structured output on `Sandbox.run()` and manual `Sandbox.sync()`.
