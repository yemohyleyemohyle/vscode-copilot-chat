# Thinking Tokens Telemetry Investigation

## Overview

"Thinking tokens" (also called reasoning tokens) are intermediate reasoning content produced by models like Claude and o-series. This investigates how they're processed and what reaches MSFT/GH telemetry.

## Data Structures

| Type | Purpose | File |
|------|---------|------|
| `ThinkingDelta` | Normalized streaming delta: `text`, `id`, `metadata` | `src/platform/thinking/common/thinking.ts` |
| `EncryptedThinkingDelta` | Opaque encrypted blob: `id`, `text?`, `encrypted` | `src/platform/thinking/common/thinking.ts` |
| `ThinkingData` | Full round-trip record: `id`, `text`, `metadata`, `tokens`, `encrypted` | `src/platform/thinking/common/thinking.ts` |
| `ThinkingDataInMessage` | Fields on `CAPIChatMessage`: `cot_id`, `cot_summary`, `reasoning_opaque`, `reasoning_text` | `src/platform/networking/common/openai.ts` |
| `ThinkingDataContainer` | TSX component embedding `ThinkingData` as opaque content part in prompt messages | `src/platform/endpoint/common/thinkingDataContainer.tsx` |

Provider-specific field mappings (`thinkingUtils.ts`):
- **Azure OpenAI**: `cot_id` / `cot_summary`
- **Copilot API**: `reasoning_opaque` / `reasoning_text`
- **Anthropic**: `thinking` block / `signature`

## Stream Processing

### Responses API (`responsesApi.ts`)
- `response.output_item.done` with `type: 'reasoning'`: emits `IResponseDelta.thinking` with `{ id, text (summary), encrypted: encrypted_content }`
- `response.reasoning_summary_text.delta`: streams thinking summary as `{ id, text }`
- `response.completed`: maps `output_tokens_details.reasoning_tokens` into `ChatCompletion.usage`

### Anthropic Messages API (`messagesApi.ts`)
- `content_block_start` with `type: 'thinking'`: initializes accumulator
- `content_block_start` with `type: 'redacted_thinking'`: emits encrypted delta immediately
- `content_block_delta` with `type: 'thinking_delta'`: accumulates and streams `{ id, text }`
- `content_block_stop`: emits final `{ id, encrypted: signature }`
- `message_stop`: sets `reasoning_tokens: 0` (Anthropic doesn't provide breakdown)

### `chatMLFetcher.ts` (lines 397–413)
After response completes, extracts thinking text from `FetchStreamRecorder.deltas`:
- Filters out encrypted thinking deltas
- Joins plaintext thinking summaries
- Sets OTel span attribute `copilot_chat.reasoning_content` (truncated, encrypted → `[encrypted]`)

**Key**: Encrypted thinking is explicitly excluded from the OTel attribute — only plaintext summaries appear.

## What Reaches Telemetry

### Summary Table

| Data | GH Telemetry | MSFT Telemetry | OTel (local debug) |
|------|-------------|----------------|---------------------|
| **Reasoning token count** | ✅ `response.success` measurement (`reasoningTokens`) | ✅ same | ✅ `gen_ai.usage.reasoning_tokens` span attr |
| **Thinking text (output summary)** | ❌ | ❌ | ✅ `copilot_chat.reasoning_content` (local only) |
| **Thinking in input messages (multi-turn)** | ✅ `engine.messages` `messagesJson` | ✅ `model.message.added` `messageJson` | ❌ |
| **Reasoning config (effort/budget)** | ✅ `request.option.reasoning` / `request.option.thinking` | ✅ `model.request.options.added` | ✅ span attrs |
| **Encrypted blobs in input messages** | ✅ serialized in `messagesJson` (opaque, not readable) | ✅ same | ❌ |
| **Full thinking text (not summary)** | ❌ never | ❌ never | ❌ never |

### Detailed Breakdown

#### 1. Reasoning Token Count — ✅ GH + MSFT + OTel

`response.success` event (`chatMLFetcherTelemetry.ts`):
- `reasoningTokens` measurement from `chatCompletion.usage.completion_tokens_details.reasoning_tokens`
- `reasoningEffort` and `reasoningSummary` from request body

OTel span: `gen_ai.usage.reasoning_tokens` attribute (`chatMLFetcher.ts:381`).

#### 2. Thinking Text from Output — ❌ GH/MSFT, ✅ OTel only

The actual thinking/reasoning summary text only goes to the local OTel span attribute `copilot_chat.reasoning_content`. It is consumed by `chatDebugFileLoggerService.ts` for the debug panel log files. It does **not** reach any GH or MSFT telemetry event.

The output `CAPIChatMessage` (built in `prepareChatCompletionForReturn` in `chatStream.ts`) only contains `role: assistant` + `content: textParts` — no thinking fields. So `engine.messages` output direction has no thinking.

#### 3. Thinking in Multi-Turn Input Messages — ✅ GH + MSFT

When a conversation includes thinking from a previous turn, `ThinkingDataContainer` embeds thinking data into assistant messages. During serialization to `CAPIChatMessage`:
- **Copilot API**: sets `reasoning_opaque` (opaque ID) and `reasoning_text` (summary text) on the message
- **BYOK**: sets `cot_id` and `cot_summary`

These fields are on the `CAPIChatMessage` object (which extends `ThinkingDataInMessage`). When `sendEngineMessagesTelemetry` serializes the input messages array into `messagesJson`, these fields **are included**.

Affected events:
- `engine.messages` (GH enhanced) — full `messagesJson` with `reasoning_text`/`cot_summary`
- `model.message.added` (MSFT internal) — per-message `messageJson` with same fields
- `engine.messages.length` (GH + MSFT) — content is length-replaced, but `reasoning_text`/`cot_summary` are **top-level message fields** (not inside `content`), so they appear as **raw text** in the length-replaced JSON

**Note**: `reasoning_opaque` / encrypted blobs also appear in serialized form — opaque strings, not human-readable.

#### 4. Request Config Parameters — ✅ GH + MSFT

`chatMLFetcher.ts` iterates all request body keys (except `messages`/`input`) as `request.option.*`:

| Request Field | Telemetry Property | Events |
|---|---|---|
| `reasoning` (Responses API) | `request.option.reasoning` | `request.sent`, `request.response` (GH); `model.request.options.added` (MSFT) |
| `thinking` (Anthropic) | `request.option.thinking` | same |
| `include` (Responses API) | `request.option.include` | same — contains `["reasoning.encrypted_content"]` |

Plus explicit fields on `response.success`/`response.error`: `reasoningEffort`, `reasoningSummary`.

## Key Findings

1. **Token counts**: Reasoning token counts reliably reach GH+MSFT telemetry via `response.success`. Exception: Anthropic hardcodes `reasoning_tokens: 0` because the API doesn't break down token usage.

2. **Output thinking text**: Never reaches GH/MSFT telemetry. Only goes to local OTel debug spans as `copilot_chat.reasoning_content`.

3. **Input thinking (multi-turn)**: The `reasoning_text`/`cot_summary` plaintext summary from prior turns DOES appear in `engine.messages` and `model.message.added` telemetry because the full `CAPIChatMessage` is serialized. This is the main vector where thinking content reaches production telemetry.

4. **`engine.messages.length` leak**: This event replaces `content` with character counts but `reasoning_text`/`cot_summary` are top-level message fields, not inside `content`. So the actual summary text may appear un-redacted in `engine.messages.length`.

5. **Encrypted content**: Opaque encrypted blobs (`reasoning_opaque`, `encrypted_content`) are serialized into telemetry events when present in input messages, but they're not human-readable.

## Gap: Responses API Thinking Lost in Telemetry (Fixed)

### Problem

For Responses API models (GPT-5.4, o-series, GPT-4.1), thinking/reasoning content was **not** reaching `model.message.added` telemetry. The telemetry logging path in `chatMLFetcher.ts` falls back to:

1. `responseApiInputToRawMessagesForLogging()` — converts Responses API `input` back to Raw messages
2. `rawMessageToCAPI()` — converts Raw messages to CAPI format for telemetry serialization

Two issues in this pipeline:

- **`responseApiInputToRawMessagesForLogging`** converted `reasoning` items to plain text `"Reasoning summary: <text>"`, discarding the structured thinking data (id, encrypted blob)
- **`rawMessageToCAPI`** only preserved thinking data when a `callback` was provided — the telemetry path never provides one

### Per-API-Path Behavior (Before Fix)

| API Path | Models | Thinking in `model.message.added`? |
|---|---|---|
| CAPI | GPT-4o (non-thinking) | Had callback, but these models don't produce thinking |
| Responses API | GPT-5.4, o-series, GPT-4.1 | **Missing** — flattened to plain text, then dropped |
| Anthropic Messages | Claude 3.5/4 | Present as Anthropic `thinking`/`redacted_thinking` blocks (different format) |

### Changes Made

#### 1. `responsesApi.ts` — Preserve thinking summary in `extractThinkingData`

`extractThinkingData()` was setting `summary: []` when converting `ThinkingData` to Responses API `ResponseReasoningItem` for the request body. The thinking text from `thinkingData.text` was discarded. Changed to populate `summary` with `{ type: 'summary_text', text }` entries from the thinking data, matching the `ResponseReasoningItem` schema. This fixes both the actual request (summary is now round-tripped) and the telemetry path (summary is available for logging).

#### 2. `responsesApi.ts` — Preserve thinking as Opaque parts in telemetry logging

Changed `responseApiInputToRawMessagesForLogging` to emit `reasoning` items as `Raw.ChatCompletionContentPartKind.Opaque` with `CustomDataPartMimeTypes.ThinkingData` instead of plain text `"Reasoning summary: <text>"`. This preserves `id`, `text` (summary), and `encrypted` (encrypted_content) in the Raw message format so they survive CAPI conversion.

#### 3. `openai.ts` — Default thinking preservation in `rawMessageToCAPI`

Changed `rawMessageToCAPI` to set `reasoning_opaque` and `reasoning_text` on the CAPI message even without a callback. Previously, thinking data from Opaque parts was only extracted when a callback was passed. The no-callback path is exclusively used by telemetry logging — actual model request bodies always use a callback (CAPI) or a different serializer (Responses/Anthropic).

### Note on Message Splitting

The Responses API format decomposes a single Raw assistant message (containing [stateful_marker, thinking, phase_data, text, tool_calls]) into separate `input` items: `reasoning`, `message`, `function_call`. This means `model.message.added` telemetry produces separate events for the thinking and text content. This is inherent to the Responses API format and cannot be avoided without a fundamentally different approach.

### Result

After these changes, `model.message.added` events for Responses API models include `reasoning_opaque` and `reasoning_text` fields on assistant messages, making thinking content available in MSFT telemetry.

### About "encrypted" Fields

The `encrypted`/`reasoning_opaque` fields are **not** an encryption of the thinking text. They serve different purposes per provider:

- **Anthropic (`signature`)**: Cryptographic proof that thinking came from Claude. Used for verification when replaying thinking blocks in subsequent turns. `redacted_thinking` blocks contain only this field (text withheld).
- **Copilot API (`reasoning_opaque`)**: An opaque token for server-side verification/replay of reasoning. Also used as the thinking block identifier.
- **`stateful_marker`**: Encrypted model state marker for context management — unrelated to thinking.

---

## Additional Changes: `[REQUEST_TO_MODEL]` Logging & Telemetry Fixes

### `[REQUEST_TO_MODEL]` — Raw Payload Logging at the Network Send Point

Added `[REQUEST_TO_MODEL]` info logs at the **actual network send points** — right before bytes go on the wire — in both transport paths. These log the raw `request.input` (Responses API) or `request.messages` (CAPI) exactly as the model will see them, with no transformations.

#### HTTP Path — `networking.ts` (`networkRequest`)

Right before `fetcher.fetch()` / `capiClientService.makeRequest()`:
```
[REQUEST_TO_MODEL] requestId=<id> transport=http totalItems=<n> tailCount=<n>
[REQUEST_TO_MODEL] requestId=<id> item: <JSON substring 0..2000>
```
Logs the last 3 non-system/non-user items from `body.input ?? body.messages`. For Responses API, these are raw `ResponseInputItem` objects (reasoning, message, function_call, function_call_output). For CAPI, these are `CAPIChatMessage` objects.

#### WebSocket Path — `chatWebSocketManager.ts` (`sendRequest`)

Right before `this._ws.send(serializedMessage)`:
```
[REQUEST_TO_MODEL] requestId=<id> transport=websocket totalItems=<n> tailCount=<n>
[REQUEST_TO_MODEL] requestId=<id> item: <JSON substring 0..2000>
```
Same format. Logs from `body.input ?? body.messages` before the body is wrapped in a `response.create` envelope and serialized.

#### Key Design Decisions

- **Location**: At the actual send point (`fetcher.fetch` / `ws.send`), not in the telemetry pipeline or `chatMLFetcher.ts`. This ensures the log shows exactly what the model receives.
- **No transformation**: The raw `input`/`messages` items are logged as-is. No CAPI conversion, no merging, no `responseApiInputToRawMessagesForLogging` — these are the actual API objects.
- **Tail-only**: Only last 3 non-system/non-user items to keep logs manageable. System prompts and user messages are excluded since they're not what we need to debug (tool results and assistant turns are the interesting part).
- **Truncation**: Each item JSON is truncated to 2000 chars to prevent log explosion from large tool outputs.

### `sendEngineMessagesTelemetry` — Kept in `finally` Blocks

The `sendEngineMessagesTelemetry` calls remain in the `finally` blocks of both `_doFetchViaWebSocket` and `_fetchWithInstrumentation` (HTTP). These convert Responses API input to CAPI format via `responseApiInputToRawMessagesForLogging` + `rawMessageToCAPI` for the telemetry events (`engine.messages`, `model.message.added`, `model.modelCall.input`). The `[REQUEST_TO_MODEL]` debug logs were removed from these `finally` blocks — they now only live at the network send points.

### `headerRequestId=unknown` Fix

#### Problem
`model.modelCall.input` and `model.modelCall.output` telemetry events showed `headerRequestId=unknown`.

#### Root Cause — Input Events
In the HTTP path, `_fetchWithInstrumentation`'s `.then()` handler calls `telemetryData.extendWithRequestId(modelRequestId)`, which overwrites `headerRequestId` with `response.headers.get('x-request-id')`. If the header is missing, this becomes an empty string, and `'' || 'unknown'` in the telemetry log produces `unknown`.

**Fix**: After `extendWithRequestId`, restore with `telemetryData.properties['headerRequestId'] = modelRequestId.headerRequestId || ourRequestId`.

#### Root Cause — Output Events
`extendedBaseTelemetryData` (used for output events) was created from `baseTelemetryData.extendedBy({ modelCallId })` without including `headerRequestId`.

**Fix**: Include `headerRequestId: ourRequestId` in both WS and HTTP paths:
```typescript
const extendedBaseTelemetryData = baseTelemetryData.extendedBy({ modelCallId, headerRequestId: ourRequestId });
```

### `ourRequestId` Empty String Fix

Changed `??` to `||` at the `ourRequestId` derivation:
```typescript
const ourRequestId = telemetryProperties.requestId || telemetryProperties.messageId || generateUuid();
```
`??` only guards against `null`/`undefined`, but `telemetryProperties.requestId` can be an empty string `''`. Using `||` falls through to `messageId` or UUID generation when requestId is empty.
