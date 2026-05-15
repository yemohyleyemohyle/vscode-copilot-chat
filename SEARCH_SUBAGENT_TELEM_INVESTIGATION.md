# Subagent Telemetry Investigation & Changes

## Problem

Subagent LLM calls (search, execution) lacked proper telemetry identifiers in MSFT/GH events:
- No **stable grouping ID** across all LLM calls within one subagent invocation (`headerRequestId` changed every iteration)
- No **`parentToolCallId`** linking subagent calls back to the parent agent's tool call
- `model.request.added` events **never fired** for subagents (silent early-return due to missing `headerRequestId`)
- `model.modelCall.input` showed `headerRequestId: "unknown"` instead of a real value

## Root Causes

### 1. Unstable `headerRequestId` in subagents

Main agent uses a stable `messageId` (set once at construction via `ChatTelemetryBuilder`). Subagent loops called `randomUUID()` inline in `fetch()` on every iteration, producing a new `messageId` each time. Since `chatMLFetcher` derives `ourRequestId` from `messageId`, `headerRequestId` changed every call.

### 2. `headerRequestId` overwritten with empty string

`getRequestId(response.headers)` returns `headerRequestId: ''` when the server doesn't echo `x-request-id`. `extendWithRequestId()` then overwrites the previously-set `headerRequestId` with `''`. Downstream code uses `headerRequestId || 'unknown'` → shows `"unknown"`.

### 3. `model.request.added` never fires

`sendNewRequestAddedTelemetry()` has `if (!headerRequestId) return;`. Empty string is falsy → silent early-return.

### 4. No `parentToolCallId` in MSFT/GH telemetry

The LLM-assigned `tool_call_id` (available as `options.chatStreamToolCallId`) was never passed through to subagent `telemetryProperties`.

### 5. `parentToolCallId` missing from `model.modelCall.input/output`

`sendModelCallTelemetry()` creates a fresh `TelemetryData` with hardcoded fields — it didn't include `parentToolCallId` from the original `telemetryData.properties`.

## Changes Made

### Files Modified

| File | Change |
|---|---|
| `src/platform/networking/common/networking.ts` | Added `parentToolCallId?: string` to `IChatRequestTelemetryProperties` |
| `src/extension/prompt/node/searchSubagentToolCallingLoop.ts` | Added `parentToolCallId` to options; set `requestId: this.options.subAgentInvocationId` and `parentToolCallId` in `telemetryProperties` |
| `src/extension/tools/node/searchSubagentTool.ts` | Pass `options.chatStreamToolCallId` as `parentToolCallId` |
| `src/extension/prompt/node/executionSubagentToolCallingLoop.ts` | Same as search: stable `requestId`, `parentToolCallId` in telemetry |
| `src/extension/tools/node/executionSubagentTool.ts` | Pass `options.chatStreamToolCallId` as `parentToolCallId` |
| `src/extension/prompt/node/chatMLFetcher.ts` | (1) Set `headerRequestId: ourRequestId` on `baseTelemetry` at creation; (2) Preserve `ourRequestId` when server doesn't echo `x-request-id` (both HTTP and WebSocket paths) |
| `src/platform/networking/node/chatStream.ts` | Include `parentToolCallId` in `sendModelCallTelemetry()`'s freshly-created `TelemetryData` |

### How the fixes work

**Stable `requestId`**: Subagent loops now pass `requestId: this.options.subAgentInvocationId` in `telemetryProperties`. In `chatMLFetcher`, `ourRequestId = telemetryProperties.requestId ?? ...` picks this up → `headerRequestId` is stable across all iterations and matches `chatSessionId` in OTel.

**`headerRequestId` preservation**: In `chatMLFetcher`, both HTTP and WebSocket paths now do:
```typescript
modelRequestId.headerRequestId = modelRequestId.headerRequestId || ourRequestId;
```
This prevents `extendWithRequestId()` from overwriting with `''` when the server doesn't return `x-request-id`. This fix benefits **all** callers (main agent, subagents, API wrapper).

**`parentToolCallId` flow**: `SearchSubagentTool`/`ExecutionSubagentTool` read `options.chatStreamToolCallId` (the LLM's `tool_call_id`) and pass it as `parentToolCallId` through loop options → `telemetryProperties` → `TelemetryData` → all MSFT/GH events. `sendModelCallTelemetry` also explicitly includes it in its fresh `TelemetryData`.

### Join path for trajectory reconstruction

```
Main agent telemetry:
  model.message.added (assistant message with tool_calls[].id = "call_abc123")
    ↓ matches parentToolCallId
Subagent telemetry:
  model.request.added   (parentToolCallId="call_abc123", headerRequestId=subAgentInvocationId)
  model.modelCall.input  (parentToolCallId="call_abc123", headerRequestId=subAgentInvocationId)
  engine.messages        (parentToolCallId="call_abc123", headerRequestId=subAgentInvocationId)
```

## Scope & Limitations

**Covered**: Search subagent, execution subagent — both get stable `headerRequestId`, `parentToolCallId`, and working `model.request.added` events.

**Not covered**: `runSubagent`-based agents (Explore, etc.) go through `defaultIntentRequestHandler.ts` which doesn't set `requestId` or `parentToolCallId` in `telemetryProperties`. The VS Code `ChatRequest` API doesn't expose the LLM's `tool_call_id`. These agents still benefit from the `chatMLFetcher` `headerRequestId` preservation fix (no more `"unknown"`), but lack `parentToolCallId` and a stable `headerRequestId` across turns.