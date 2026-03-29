# NanoClaw Platform Vision & Roadmap

A self-hosted, multi-agent automation platform with a web dashboard — built on NanoClaw's container-isolated runtime. Inspired by Lindy.ai, but with full control, data ownership, and extensibility.

---

## Vision

Build a **self-hosted alternative to Lindy.ai** on top of NanoClaw: a web-based platform where users create agent groups, connect integrations (Gmail, GitHub, Slack, etc.), and orchestrate multi-agent workflows — all with container-level isolation, centralized credential management, and a polished dashboard UX.

### Core Principles

- **Self-hosted & data-sovereign** — all data, credentials, and agent state stay on your infrastructure.
- **Container-isolated agents** — every group runs in its own sandboxed environment with scoped mounts and permissions.
- **Connector-first integrations** — connect once at the app level, every agent can use it; no scattered credential files.
- **UI as a layer, not the core** — the dashboard sits on top of a stable control API; the runtime works independently.
- **App-wide connectors + group toggles** — connections live at app scope and can be enabled/disabled per group.

---

## Current State (What NanoClaw Already Provides)

### Strengths to build on

| Capability | Status | Location |
|---|---|---|
| Container-isolated agent execution | Done | `src/container-runner.ts` |
| Group model with per-group memory/files | Done | `src/index.ts`, `groups/*/CLAUDE.md` |
| Main group with elevated admin privileges | Done | `src/ipc.ts` (isMain checks) |
| Per-group IPC with authorization | Done | `src/ipc.ts` |
| Task scheduler (cron/interval/once) | Done | `src/task-scheduler.ts` |
| Per-group queue with concurrency control | Done | `src/group-queue.ts` |
| SQLite state persistence | Done | `src/db.ts` |
| Channel abstraction (WhatsApp/Telegram/Slack/etc.) | Done | `src/channels/registry.ts` |
| Credential injection via OneCLI gateway | Done | `src/container-runner.ts` |
| Per-group OneCLI agent identities | Done | `src/index.ts` |
| Mount security with external allowlist | Done | `src/mount-security.ts` |
| MCP tool interface inside containers | Done | `container/agent-runner/src/ipc-mcp-stdio.ts` |

### Gaps to close

| Gap | Impact |
|---|---|
| No HTTP API for external control (UI, CLI, webhooks) | Blocks dashboard |
| No real-time event stream (SSE/WebSocket) | Blocks live UI updates |
| No connector gateway with OAuth lifecycle | Blocks "connect in chat" UX |
| No connector state machine in DB | Blocks connection status UI |
| No dashboard auth/user model | Blocks multi-user access |
| Integrations use ad-hoc credential files (e.g. Gmail mounts `~/.gmail-mcp`) | Inconsistent security model |
| No formal operation contracts for idempotent UI calls | Blocks reliable dashboard interactions |

---

## Target State

### User Experience (Lindy-like)

1. **Dashboard** — web UI to create groups, manage agents, view tasks, monitor runs.
2. **In-chat connection flow** — agent detects missing integration, guides user through OAuth, retries original request.
3. **Connector catalog** — browse available integrations, connect with one click.
4. **Multi-agent workflows** — visual or chat-based orchestration of agent teams.
5. **Per-group control panel** — view connected integrations, active tasks, memory, mounted directories.
6. **Real-time status** — live agent run status, task progress, connection health.

---

## Architecture

### Layer Diagram

```
┌─────────────────────────────────────────────────────────┐
│                    WEB DASHBOARD (UI)                     │
│   Groups · Connectors · Tasks · Agent Runs · Settings     │
└────────────────────────┬────────────────────────────────┘
                         │ REST + SSE/WebSocket
┌────────────────────────▼────────────────────────────────┐
│                  CONTROL PLANE API                        │
│   /groups · /tasks · /connectors · /runs · /events        │
│   Auth middleware · RBAC · Idempotency                     │
└────────────┬───────────────────────┬────────────────────┘
             │                       │
┌────────────▼────────────┐ ┌───────▼──────────────────────┐
│   NANOCLAW RUNTIME      │ │   CONNECTOR GATEWAY           │
│   (existing core)       │ │                                │
│   • Group orchestrator  │ │   • OAuth lifecycle mgmt       │
│   • Container runner    │ │   • Token refresh/rotation     │
│   • Task scheduler      │ │   • App-wide connectors         │
│   • IPC watcher         │ │   • Per-group access toggles    │
│   • Channel adapters    │ │   • Credential injection       │
│                         │ │   • Connection state machine   │
│                         │ │   • Multi-account resolution   │
└────────────┬────────────┘ └───────┬──────────────────────┘
             │                       │
┌────────────▼───────────────────────▼────────────────────┐
│                    CREDENTIAL LAYER                       │
│  OneCLI Vault: provider client creds + model API keys    │
│  OneCLI Vault: user OAuth token bundles                  │
└─────────────────────────────────────────────────────────┘
```

### Connector Access Model

Connections live at **app scope** with **per-group access policies**:

```
┌─────────────────────────────────────────────────────┐
│  APP-WIDE CONNECTIONS  (scope: "app")               │
│                                                     │
│  Gmail (work@gmail.com)   ← all agents can use      │
│  Gmail (personal@gmail.com) ← all agents can use    │
│  GitHub (myorg)            ← all agents can use      │
├─────────────────────────────────────────────────────┤
│  GROUP ACCESS TOGGLES                                │
│                                                     │
│  [email-assistant]  Gmail(work)=ON, Gmail(personal)=ON │
│  [dev-agent]        Gmail(work)=OFF, GitHub(myorg)=ON  │
└─────────────────────────────────────────────────────┘
```

**App-wide connections** are created by main/admin context (dashboard settings or main agent). They can then be enabled for one or more groups.

**Group-requested connections** are still created at app scope, but default to `enabled_for=[requesting_group]` so they are initially available only to the requesting group. Admins can later toggle them on for more groups.

**Resolution order** when an agent calls an integration tool:
1. Load app-wide connections for that integration
2. Filter by group access toggle (`enabled_for` contains current group)
3. If one account remains → use it; if multiple remain → choose by context or ask user
4. If none remain → return `INTEGRATION_NOT_CONNECTED` error

### Key Design Decisions

- **Control API is separate from runtime** — NanoClaw core continues to work standalone (chat-only mode). The API wraps existing IPC/DB operations.
- **Connector Gateway is separate from NanoClaw** — can be developed/deployed independently. NanoClaw calls it via MCP tools or HTTP.
- **App-wide connector registry** — every connection is app-scoped and governed by per-group access toggles.
- **Group-requested defaults** — when a group adds a connector, it becomes app-wide but initially enabled only for that group.
- **Multi-account support** — multiple accounts per integration are first-class. Agents resolve which to use by context or by asking.
- **OneCLI is the sole credential backend** — provider OAuth client secrets (client_id/client_secret) are loaded exclusively from the OneCLI Agent Vault at startup using canonical keys like `connector/client/gmail`. No connector credentials appear in `.env`.
- **OneCLI-managed user token vault** — user OAuth token bundles are stored/read/deleted via OneCLI secret APIs only (`connector/token/{connectionId}`).
- **DB stores metadata only** — the `oauth_token_refs` table stores only `vault_ref` and timing metadata; raw access/refresh tokens are never written to SQLite.
- **Strict cutover policy** — on startup, any connections with legacy plain-text tokens (written by a pre-cutover install) are automatically expired. Users reconnect each integration once; no silent migration or fallback.
- **SQLite stays for MVP** — migrate to Postgres only when multi-instance or dashboard performance demands it.

---

## Requirements

### R1: Control Plane API

| Requirement | Priority |
|---|---|
| REST API for group CRUD (create, list, update, delete) | P0 |
| REST API for task CRUD (create, list, pause, resume, cancel) | P0 |
| REST API for connector operations (begin auth, check status, disconnect) | P0 |
| REST API for agent run status (active, history, logs) | P1 |
| SSE or WebSocket endpoint for real-time events | P1 |
| API authentication (token-based or session-based) | P0 |
| Idempotent operation contracts (safe retries from UI) | P1 |

### R2: Connector Gateway

| Requirement | Priority |
|---|---|
| OAuth2 flow management (authorize, callback, refresh, revoke) | P0 |
| Connection state machine (pending → connected → expired → failed) | P0 |
| App-wide connector registry (all connections stored once at app scope) | P0 |
| Per-group connector access toggles (`enabled_for_groups`) | P0 |
| Group-requested connector default (`enabled_for` starts with requesting group only) | P0 |
| Multi-account support per integration (e.g. two Gmail accounts) | P0 |
| Agent-side account resolution (pick by context or ask user) | P0 |
| Provider client credentials in OneCLI vault (no .env fallback) | P0 |
| User OAuth tokens stored in OneCLI (`connector/token/{connectionId}`) | P0 |
| Strict cutover: legacy plain-text token records expired at startup | P0 |
| MCP tool facade for container agents (`connector_begin_auth`, `connector_check_status`, `connector_list`) | P0 |
| Webhook receiver for provider callbacks | P1 |
| Connection health monitoring and auto-refresh | P1 |
| Connector registry/catalog (available integrations + setup metadata) | P2 |

### R3: Web Dashboard

| Requirement | Priority |
|---|---|
| Group management UI (create, configure, delete groups) | P0 |
| Task management UI (view, create, pause, cancel tasks) | P0 |
| App-wide connector management (Settings → Connections page) | P0 |
| Group-level connector access toggles (Group detail → Connections tab) | P0 |
| Multi-account view per integration (list accounts, add another, remove) | P0 |
| Agent run viewer (live status, history, logs) | P1 |
| Group detail view (memory, files, enabled connectors, tasks) | P1 |
| Real-time updates (agent running indicator, task completion) | P1 |
| Multi-user auth (login, roles) | P2 |
| Workflow builder (visual multi-agent orchestration) | P3 |

### R4: In-Chat Connection Flow

| Requirement | Priority |
|---|---|
| Agent detects `INTEGRATION_NOT_CONNECTED` from tool errors | P0 |
| Agent calls `connector_begin_auth` and presents OAuth link | P0 |
| Agent polls/checks `connector_check_status` after user completes | P0 |
| Agent retries original user intent after successful connection | P0 |
| Prompt policy in group CLAUDE.md for consistent behavior | P0 |
| Timeout handling and clear retry path | P1 |

---

## Roadmap

### Phase 1: Control Plane API (Foundation)

**Goal:** Expose NanoClaw operations via HTTP so a UI (or any client) can control it.

**Tasks:**
- [ ] Add HTTP server to NanoClaw host process (e.g. Fastify or Express, lightweight)
- [ ] Wrap existing IPC operations as REST endpoints:
  - `POST /api/groups` — register group
  - `GET /api/groups` — list groups
  - `DELETE /api/groups/:jid` — remove group
  - `GET /api/tasks` — list tasks (scoped by group or all)
  - `POST /api/tasks` — create task
  - `PATCH /api/tasks/:id` — update/pause/resume
  - `DELETE /api/tasks/:id` — cancel task
  - `GET /api/runs` — active and recent agent runs
- [ ] Add API key or bearer token auth middleware
- [ ] Add SSE endpoint (`GET /api/events`) for real-time updates
- [ ] Emit events from existing subsystems (group-queue, task-scheduler, ipc) to event bus

**Outcome:** Any HTTP client can manage NanoClaw. Dashboard has a stable contract to build against.

---

### Phase 2: Connector Gateway + Auth Lifecycle

**Goal:** Centralized integration auth with OAuth lifecycle, replacing ad-hoc credential file mounts.

**Tasks:**
- [ ] Design connector gateway service (can be same process or separate)
- [ ] Define connection state machine and DB schema:
  - `connections` table: id, scope ("app"), integration, status, provider_account, label, created_at, expires_at
  - `connection_group_access` table: connection_id, group_folder, enabled
  - `oauth_sessions` table: id, connection_id, state, redirect_uri, refresh_at
  - `connector_registry` table: integration name, OAuth config, scopes, icon, supports_multi_account
- [ ] Implement OAuth2 flow endpoints:
  - `POST /api/connectors/auth/begin` → returns auth_url + connection_id (accepts `requested_by_group` for default access toggle)
  - `GET /api/connectors/auth/callback` → handles OAuth redirect
  - `GET /api/connectors/status/:id` → returns connection status
  - `DELETE /api/connectors/:id` → disconnect and revoke
  - `GET /api/connectors` → list all app-wide connections
  - `GET /api/connectors?group=:group_folder` → list app-wide connections enabled for that group
  - `PATCH /api/connectors/:id/access` → enable/disable connector for specific groups
- [x] Store user token bundles in OneCLI (`connector/token/{connectionId}`); DB keeps only vault refs
- [x] Load provider client credentials from OneCLI vault at startup (no .env fallback); strict cutover for legacy tokens
- [ ] Add MCP tools for container agents:
  - `connector_begin_auth(integration)` — always app-wide; default access is requesting group only
  - `connector_check_status(connection_id)`
  - `connector_list(integration?)` — returns app-wide connections enabled for the calling group
  - `connector_use(integration, account?)` — resolve which account to use; if ambiguous, returns list for agent to choose
  - `connector_disconnect(connection_id)`
- [ ] Implement connection resolution logic:
  1. Load app-wide connections for integration
  2. Filter by group access toggle (`enabled_for`)
  3. If one account remains, use it; if multiple, return list for agent to choose
  4. None found → `INTEGRATION_NOT_CONNECTED`
- [ ] Implement token refresh background job
- [ ] Migrate Gmail integration from file-mount to gateway model
- [ ] Add GitHub as second integration to validate multi-account generality

**Outcome:** "Connect Gmail" works from chat and from UI. All connectors are app-wide, but access is controlled per group. Multiple accounts per integration supported.

---

### Phase 3: In-Chat Connection UX

**Goal:** Agent guides user through connecting integrations conversationally.

**Tasks:**
- [ ] Define error contract for integration tools (typed `INTEGRATION_NOT_CONNECTED` errors)
- [ ] Add prompt policy to group CLAUDE.md templates:
  - When tool returns not-connected, offer to connect
  - Present auth link, wait for completion, retry original intent
- [ ] Test end-to-end flow: user asks for emails → agent detects no Gmail → guides OAuth → fetches emails
- [ ] Add timeout/retry handling in prompt policy
- [ ] Document the flow for skill authors (so new integrations get this behavior automatically)

**Outcome:** Lindy-like "help me connect" experience works purely in chat.

---

### Phase 4: Web Dashboard (MVP)

**Goal:** Functional web UI for managing groups, tasks, and connectors.

**Tasks:**
- [ ] Choose frontend framework (Nuxt 3 recommended given existing ecosystem)
- [ ] Implement dashboard pages:
  - **Groups** — list, create, configure, delete
  - **Group detail** — connected integrations, active tasks, memory viewer, recent runs
  - **Tasks** — list all, filter by group, create/pause/cancel
  - **Connectors** — connect new integration (OAuth popup), view status, disconnect
  - **Runs** — live agent run status, historical logs
- [ ] Wire to Control Plane API (Phase 1 endpoints)
- [ ] Add real-time updates via SSE connection
- [ ] Implement dashboard auth (simple token or session-based for MVP)
- [ ] Style and UX polish (clean, modern, Lindy-inspired)

**Outcome:** Functional self-hosted dashboard. Users can manage everything from browser.

---

### Phase 5: Multi-Agent Workflow Builder

**Goal:** Visual orchestration of agent teams and workflows.

**Tasks:**
- [ ] Design workflow model (trigger → steps → conditions → actions)
- [ ] Add workflow persistence (DB schema + API)
- [ ] Build visual workflow editor (node-based or step-based UI)
- [ ] Map workflow steps to existing primitives (group agents, tasks, connector tools)
- [ ] Add workflow execution engine (or extend task scheduler)
- [ ] Add workflow templates for common patterns

**Outcome:** Users build multi-agent automations visually, like Lindy's workflow builder.

---

## Tech Stack (Recommended)

| Layer | Technology | Rationale |
|---|---|---|
| Runtime | NanoClaw (Node.js + TypeScript) | Existing, proven |
| Control API | Fastify (or Express) in same process | Lightweight, no new service |
| Real-time | SSE (Server-Sent Events) | Simpler than WebSocket for dashboard |
| Database | SQLite → Postgres migration path | SQLite for MVP simplicity |
| Credential vault | OneCLI | Already integrated |
| Frontend | Nuxt 3 + Nuxt UI | Modern, good DX, SSR support |
| Container runtime | Docker / Apple Container | Already supported |

---

## Risk Register

| Risk | Mitigation |
|---|---|
| OAuth complexity across providers | Start with Gmail + GitHub only; generalize after |
| Token refresh failures silently break integrations | Health monitor + proactive alerts to dashboard |
| UI coupling to runtime internals | Strict API contract; never bypass API from UI |
| SQLite scaling limits with many groups/runs | Design DB layer with migration path to Postgres |
| Scope creep on dashboard features | Ship MVP (groups + tasks + connectors) first |
| Security regression when adding HTTP API | Auth middleware from day one; audit surface area |

---

## Success Criteria

- [ ] User connects Gmail from dashboard Settings → all agents can use it immediately.
- [ ] User connects a second Gmail account → agents see both and choose by context or ask.
- [ ] A group requests a new Outlook connection → it is created app-wide but enabled only for that group by default.
- [ ] User can do the same flows entirely from chat (no dashboard required).
- [ ] Credentials never appear in container environment, files, or logs.
- [ ] Group access toggles are enforced: disabled groups cannot use a connector.
- [ ] Dashboard shows real-time agent run status and task progress.
- [ ] System works fully self-hosted with no external SaaS dependencies.
