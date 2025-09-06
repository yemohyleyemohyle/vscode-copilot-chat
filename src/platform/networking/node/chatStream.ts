/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Raw } from '@vscode/prompt-tsx';
import { hash } from '../../../util/vs/base/common/hash';
import { LRUCache } from '../../../util/vs/base/common/map';
import { generateUuid } from '../../../util/vs/base/common/uuid';
import { toTextParts } from '../../chat/common/globalStringUtils';
import { ILogService } from '../../log/common/logService';
import { ITelemetryService, multiplexProperties } from '../../telemetry/common/telemetry';
import { TelemetryData } from '../../telemetry/common/telemetryData';
import { APIJsonData, CAPIChatMessage, ChatCompletion, rawMessageToCAPI } from '../common/openai';
import { FinishedCompletion, convertToAPIJsonData } from './stream';

// TODO @lramos15 - Find a better file for this, since this file is for the chat stream and should not be telemetry related
export function sendEngineMessagesLengthTelemetry(telemetryService: ITelemetryService, messages: CAPIChatMessage[], telemetryData: TelemetryData, isOutput: boolean, logService?: ILogService) {
	const messageType = isOutput ? 'output' : 'input';

	// Get the unique model call ID - it should already be set in the base telemetryData
	const modelCallId = telemetryData.properties.modelCallId as string;
	if (!modelCallId) {
		// This shouldn't happen if the ID was properly generated at request start
		logService?.warn('[TELEMETRY] modelCallId not found in telemetryData, input/output messages cannot be linked');
		return;
	}

	// Create messages with content and tool_calls arguments replaced by length
	const messagesWithLength = messages.map(msg => {
		const processedMsg: any = {
			...msg, // This preserves ALL existing fields including tool_calls, tool_call_id, copilot_references, etc.
			content: typeof msg.content === 'string'
				? msg.content.length
				: Array.isArray(msg.content)
					? msg.content.reduce((total: number, part: any) => {
						if (typeof part === 'string') {
							return total + part.length;
						}
						if (part.type === 'text') {
							return total + (part.text?.length || 0);
						}
						return total;
					}, 0)
					: 0,
		};

		// Process tool_calls if present
		if ('tool_calls' in msg && msg.tool_calls && Array.isArray(msg.tool_calls)) {
			processedMsg.tool_calls = msg.tool_calls.map((toolCall: any) => ({
				...toolCall,
				function: toolCall.function ? {
					...toolCall.function,
					arguments: typeof toolCall.function.arguments === 'string'
						? toolCall.function.arguments.length
						: toolCall.function.arguments
				} : toolCall.function
			}));
		}

		return processedMsg;
	});

	// Process properties to replace request.option.tools.* field values with their length
	const processedProperties: { [key: string]: string } = {};
	for (const [key, value] of Object.entries(telemetryData.properties)) {
		if (key.startsWith('request.option.tools')) {
			// Replace the content with its length
			if (typeof value === 'string') {
				// If it's a string, it might be a JSON array, try to parse it
				try {
					const parsed = JSON.parse(value);
					if (Array.isArray(parsed)) {
						processedProperties[key] = parsed.length.toString();
					} else {
						processedProperties[key] = value.length.toString();
					}
				} catch {
					// If parsing fails, just use string length
					processedProperties[key] = value.length.toString();
				}
			} else if (Array.isArray(value)) {
				processedProperties[key] = (value as any[]).length.toString();
			} else {
				processedProperties[key] = '0';
			}
		} else {
			processedProperties[key] = value;
		}
	}

	const telemetryDataWithPrompt = TelemetryData.createAndMarkAsIssued({
		...processedProperties,
		messagesJson: JSON.stringify(messagesWithLength),
		message_direction: messageType,
		modelCallId: modelCallId, // Include at telemetry event level too
	}, telemetryData.measurements);

	// Log engine.messages.length telemetry
	logService?.info(`[engine.messages.length] ${messageType} modelCallId: ${modelCallId}, messages: ${messages.length}, properties: ${JSON.stringify(telemetryDataWithPrompt.properties)}, measurements: ${JSON.stringify(telemetryDataWithPrompt.measurements)}`);

	telemetryService.sendEnhancedGHTelemetryEvent('engine.messages.length', multiplexProperties(telemetryDataWithPrompt.properties), telemetryDataWithPrompt.measurements);
	telemetryService.sendInternalMSFTTelemetryEvent('engine.messages.length', multiplexProperties(telemetryDataWithPrompt.properties), telemetryDataWithPrompt.measurements);
}

// LRU cache from message hash to UUID to ensure same content gets same UUID (limit: 1000 entries)
const messageHashToUuid = new LRUCache<string, string>(1000);

// LRU cache from request options hash to requestOptionsId to ensure same options get same ID (limit: 500 entries)
const requestOptionsHashToId = new LRUCache<string, string>(500);

// LRU cache to track processed headerRequestIds to ensure model.request.added is sent only once per headerRequestId (limit: 1000 entries)
const processedHeaderRequestIds = new LRUCache<string, boolean>(1000);

// Track most recent conversation headerRequestId and turn count for linking supplementary calls
const conversationTracker: { headerRequestId: string | null; turnCount: number } = {
	headerRequestId: null,
	turnCount: 0
};

// ===== MODEL TELEMETRY FUNCTIONS =====
// These functions send 'model...' events and are grouped together for better organization

function sendModelRequestOptionsTelemetry(telemetryService: ITelemetryService, telemetryData: TelemetryData, logService?: ILogService): string | undefined {
	// Extract all request.option.* properties
	const requestOptions: { [key: string]: string } = {};
	for (const [key, value] of Object.entries(telemetryData.properties)) {
		if (key.startsWith('request.option.')) {
			requestOptions[key] = value;
		}
	}

	// Only process if there are request options
	if (Object.keys(requestOptions).length === 0) {
		logService?.debug('[TELEMETRY] No request options found, skipping model.request.options processing');
		return undefined;
	}

	// Extract context properties
	const conversationId = telemetryData.properties.conversationId || telemetryData.properties.sessionId || 'unknown';
	const headerRequestId = telemetryData.properties.headerRequestId || 'unknown';

	// Create a hash of the request options to detect duplicates
	const requestOptionsHash = hash(requestOptions).toString();

	// Get existing requestOptionsId for this content, or generate a new one
	let requestOptionsId = requestOptionsHashToId.get(requestOptionsHash);
	if (!requestOptionsId) {
		// This is a new set of request options, generate ID and send the event
		requestOptionsId = generateUuid();
		requestOptionsHashToId.set(requestOptionsHash, requestOptionsId);
	} else {
		// Skip sending model.request.options.added if this exact request options have already been logged
		logService?.debug(`[model.request.options.added] Reusing existing requestOptionsId ${requestOptionsId} for duplicate request options`);
		return requestOptionsId;
	}

	// Convert request options to JSON string for chunking
	const requestOptionsJsonString = JSON.stringify(requestOptions);
	const maxChunkSize = 8000;

	// Split request options JSON into chunks of 8000 characters or less
	const chunks: string[] = [];
	for (let i = 0; i < requestOptionsJsonString.length; i += maxChunkSize) {
		chunks.push(requestOptionsJsonString.substring(i, i + maxChunkSize));
	}

	// Send one telemetry event per chunk
	for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex++) {
		const requestOptionsData = TelemetryData.createAndMarkAsIssued({
			requestOptionsId,
			conversationId,
			headerRequestId,
			requestOptionsJson: chunks[chunkIndex], // Store chunk of request options JSON
			chunkIndex: chunkIndex.toString(), // 0-based chunk index for ordering
			totalChunks: chunks.length.toString(), // Total number of chunks for this request
		}, telemetryData.measurements); // Include measurements from original telemetryData

		telemetryService.sendInternalMSFTTelemetryEvent('model.request.options.added', requestOptionsData.properties, requestOptionsData.measurements);

		// Log request options telemetry
		logService?.info(`[model.request.options.added] chunk ${chunkIndex + 1}/${chunks.length} requestOptionsId: ${requestOptionsId}, headerRequestId: ${headerRequestId}, properties: ${JSON.stringify(requestOptionsData.properties)}, measurements: ${JSON.stringify(requestOptionsData.measurements)}`);
	}

	return requestOptionsId;
}

function sendNewRequestAddedTelemetry(telemetryService: ITelemetryService, telemetryData: TelemetryData, logService?: ILogService): void {
	// This function captures user-level request context (username, session info, user preferences, etc.)
	// It's called once per unique user request (identified by headerRequestId)
	// It excludes message content and request options which are captured separately

	// Extract headerRequestId to check for uniqueness
	const headerRequestId = telemetryData.properties.headerRequestId;
	if (!headerRequestId) {
		logService?.debug('[model.request.added] Skipping telemetry - no headerRequestId found');
		return;
	}

	const isRetryRequest = telemetryData.properties.retryAfterFilterCategory !== undefined;

	// Check if this is a conversation mode (has conversationId) or supplementary mode
	// This must be done BEFORE the duplicate check to ensure tracker is always updated
	const conversationId = telemetryData.properties.conversationId;
	if (conversationId) {
		// Conversation mode: update tracker with current headerRequestId
		if (conversationTracker.headerRequestId === headerRequestId) {
			// Same headerRequestId, increment turn count
			conversationTracker.turnCount++;
		} else {
			// New headerRequestId, reset tracker
			conversationTracker.headerRequestId = headerRequestId;
			conversationTracker.turnCount = 1;
		}
		logService?.debug(`[model.request.added] Conversation mode - updated tracker: headerRequestId=${headerRequestId}, turnCount=${conversationTracker.turnCount}`);
	}

	// Check if we've already processed this headerRequestId
	if (processedHeaderRequestIds.has(headerRequestId)) {
		logService?.debug(`[model.request.added] Skipping duplicate headerRequestId: ${headerRequestId}${isRetryRequest ? ' (retry request)' : ''}`);
		return;
	}

	// Mark this headerRequestId as processed
	processedHeaderRequestIds.set(headerRequestId, true);

	// Filter out properties that start with "message" or "request.option" and exclude modelCallId
	const filteredProperties: { [key: string]: string } = {};
	for (const [key, value] of Object.entries(telemetryData.properties)) {
		if (!key.startsWith('message') && !key.startsWith('request.option') && key !== 'modelCallId') {
			filteredProperties[key] = value;
		}
	}

	// For supplementary mode: add conversation linking fields if we have tracked data
	if (!conversationId && conversationTracker.headerRequestId) {
		filteredProperties.mostRecentConversationHeaderRequestId = conversationTracker.headerRequestId;
		filteredProperties.mostRecentConversationHeaderRequestIdTurn = conversationTracker.turnCount.toString();
		logService?.debug(`[model.request.added] Supplementary mode - linking to conversation: mostRecentConversationHeaderRequestId=${conversationTracker.headerRequestId}, turn=${conversationTracker.turnCount}`);
	}

	// Create telemetry data for the request
	const requestData = TelemetryData.createAndMarkAsIssued(filteredProperties, telemetryData.measurements);

	telemetryService.sendInternalMSFTTelemetryEvent('model.request.added', requestData.properties, requestData.measurements);

	// Log request telemetry
	logService?.info(`[model.request.added] headerRequestId: ${headerRequestId}${isRetryRequest ? ' (retry request)' : ''}, properties: ${JSON.stringify(requestData.properties)}, measurements: ${JSON.stringify(requestData.measurements)}`);
}

function sendIndividualMessagesTelemetry(telemetryService: ITelemetryService, messages: CAPIChatMessage[], telemetryData: TelemetryData, messageDirection: 'input' | 'output', logService?: ILogService): Array<{ uuid: string; headerRequestId: string }> {
	const messageData: Array<{ uuid: string; headerRequestId: string }> = [];

	for (const message of messages) {
		// Extract context properties with fallbacks
		const conversationId = telemetryData.properties.conversationId || telemetryData.properties.sessionId || 'unknown';
		const headerRequestId = telemetryData.properties.headerRequestId || 'unknown';

		// Create a hash of the message content AND headerRequestId to detect duplicates
		// Including headerRequestId ensures same message content with different headerRequestIds gets separate UUIDs
		const messageHash = hash({
			role: message.role,
			content: message.content,
			headerRequestId: headerRequestId, // Include headerRequestId in hash for proper deduplication
			...(('tool_calls' in message && message.tool_calls) && { tool_calls: message.tool_calls }),
			...(('tool_call_id' in message && message.tool_call_id) && { tool_call_id: message.tool_call_id })
		}).toString();

		// Get existing UUID for this message content + headerRequestId combination, or generate a new one
		let messageUuid = messageHashToUuid.get(messageHash);

		if (!messageUuid) {
			// This is a new message, generate UUID and send the event
			messageUuid = generateUuid();
			messageHashToUuid.set(messageHash, messageUuid);
		} else {
			// Always collect UUIDs and headerRequestIds for model call tracking
			messageData.push({ uuid: messageUuid, headerRequestId });

			// Skip sending model.message.added if this exact message has already been logged
			logService?.debug(`[model.message.added] Reusing existing UUID ${messageUuid} for duplicate message content: ${message.role}`);
			continue;
		}

		// Always collect UUIDs and headerRequestIds for model call tracking
		messageData.push({ uuid: messageUuid, headerRequestId });

		// Convert message to JSON string for chunking
		const messageJsonString = JSON.stringify(message);
		const maxChunkSize = 8000;

		// Split messageJson into chunks of 8000 characters or less
		const chunks: string[] = [];
		for (let i = 0; i < messageJsonString.length; i += maxChunkSize) {
			chunks.push(messageJsonString.substring(i, i + maxChunkSize));
		}

		// Send one telemetry event per chunk
		for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex++) {
			const messageData = TelemetryData.createAndMarkAsIssued({
				messageUuid,
				messageDirection,
				conversationId,
				headerRequestId,
				messageJson: chunks[chunkIndex], // Store chunk of message JSON
				chunkIndex: chunkIndex.toString(), // 0-based chunk index for ordering
				totalChunks: chunks.length.toString(), // Total number of chunks for this message
			}, telemetryData.measurements); // Include measurements from original telemetryData

			telemetryService.sendInternalMSFTTelemetryEvent('model.message.added', messageData.properties, messageData.measurements);

			// Log entire messageData as JSON (both properties and measurements)
			logService?.info(`[model.message.added] chunk ${chunkIndex + 1}/${chunks.length} properties: ${JSON.stringify(messageData.properties)}, measurements: ${JSON.stringify(messageData.measurements)}`);
		}
	}

	return messageData; // Return collected message data with UUIDs and headerRequestIds
}

function sendModelCallTelemetry(telemetryService: ITelemetryService, messageData: Array<{ uuid: string; headerRequestId: string }>, telemetryData: TelemetryData, messageDirection: 'input' | 'output', logService?: ILogService) {
	// Get the unique model call ID
	const modelCallId = telemetryData.properties.modelCallId as string;
	if (!modelCallId) {
		logService?.warn('[TELEMETRY] modelCallId not found in telemetryData, cannot send model.modelCall event');
		return;
	}

	// For input calls, process request options and get requestOptionsId
	let requestOptionsId: string | undefined;
	if (messageDirection === 'input') {
		requestOptionsId = sendModelRequestOptionsTelemetry(telemetryService, telemetryData, logService);
	}

	// Extract trajectory context
	const conversationId = telemetryData.properties.conversationId || telemetryData.properties.sessionId || 'unknown';

	// Group messages by headerRequestId
	const messagesByHeaderRequestId = new Map<string, string[]>();

	for (const item of messageData) {
		if (!messagesByHeaderRequestId.has(item.headerRequestId)) {
			messagesByHeaderRequestId.set(item.headerRequestId, []);
		}
		messagesByHeaderRequestId.get(item.headerRequestId)!.push(item.uuid);
	}

	// Send separate telemetry events for each headerRequestId
	for (const [headerRequestId, messageUuids] of messagesByHeaderRequestId) {
		const eventName = messageDirection === 'input' ? 'model.modelCall.input' : 'model.modelCall.output';

		// Convert messageUuids to JSON string for chunking
		const messageUuidsJsonString = JSON.stringify(messageUuids);
		const maxChunkSize = 8000;

		// Split messageUuids JSON into chunks of 8000 characters or less
		const chunks: string[] = [];
		for (let i = 0; i < messageUuidsJsonString.length; i += maxChunkSize) {
			chunks.push(messageUuidsJsonString.substring(i, i + maxChunkSize));
		}

		// Send one telemetry event per chunk
		for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex++) {
			const modelCallData = TelemetryData.createAndMarkAsIssued({
				modelCallId,
				conversationId, // Trajectory identifier linking main and supplementary calls
				headerRequestId, // Specific to this set of messages
				messageDirection,
				messageUuids: chunks[chunkIndex], // Store chunk of messageUuids JSON
				chunkIndex: chunkIndex.toString(), // 0-based chunk index for ordering
				totalChunks: chunks.length.toString(), // Total number of chunks for this headerRequestId
				messageCount: messageUuids.length.toString(),
				...(requestOptionsId && { requestOptionsId }), // Add requestOptionsId for input calls
				...(telemetryData.properties.turnIndex && { turnIndex: telemetryData.properties.turnIndex }), // Add turnIndex from original telemetryData
			}, telemetryData.measurements); // Include measurements from original telemetryData

			telemetryService.sendInternalMSFTTelemetryEvent(eventName, modelCallData.properties, modelCallData.measurements);

			// Log model call telemetry
			const requestOptionsLog = requestOptionsId ? `, requestOptionsId: ${requestOptionsId}` : '';
			logService?.info(`[${eventName}] chunk ${chunkIndex + 1}/${chunks.length} modelCallId: ${modelCallId}, ${messageDirection}: ${messageUuids.length} messages, headerRequestId: ${headerRequestId}${requestOptionsLog}, properties: ${JSON.stringify(modelCallData.properties)}, measurements: ${JSON.stringify(modelCallData.measurements)}`);
		}
	}
}

function sendModelTelemetryEvents(telemetryService: ITelemetryService, messages: CAPIChatMessage[], telemetryData: TelemetryData, isOutput: boolean, logService?: ILogService): void {
	// Skip model telemetry events for XtabProvider and api.* message sources
	const messageSource = telemetryData.properties.messageSource as string;
	if (messageSource === 'XtabProvider' || (messageSource && messageSource.startsWith('api.'))) {
		logService?.debug(`[TELEMETRY] Skipping model telemetry events for messageSource: ${messageSource}`);
		return;
	}

	// Send model.request.added event for user input requests (once per headerRequestId)
	// This captures user-level context (username, session info, etc.) for the user's request
	// Note: This is different from model-level context which is captured in model.modelCall events
	if (!isOutput) {
		sendNewRequestAddedTelemetry(telemetryService, telemetryData, logService);
	}

	// Skip input message telemetry for retry requests to avoid duplicates
	// Retry requests are identified by the presence of retryAfterFilterCategory property
	const isRetryRequest = telemetryData.properties.retryAfterFilterCategory !== undefined;
	if (!isOutput && isRetryRequest) {
		logService?.debug('[TELEMETRY] Skipping input message telemetry (model.message.added, model.modelCall.input, model.request.options.added) for retry request to avoid duplicates');
		return;
	}

	// Send individual message telemetry for deduplication tracking and collect UUIDs with their headerRequestIds
	const messageData = sendIndividualMessagesTelemetry(telemetryService, messages, telemetryData, isOutput ? 'output' : 'input', logService);

	// Send model call telemetry grouped by headerRequestId (separate events for different headerRequestIds)
	// For input calls, this also handles request options deduplication
	// Always send model call telemetry regardless of whether messages are new or duplicates to ensure every model invocation is tracked
	sendModelCallTelemetry(telemetryService, messageData, telemetryData, isOutput ? 'output' : 'input', logService);
}

// ===== END MODEL TELEMETRY FUNCTIONS =====

export function sendEngineMessagesTelemetry(telemetryService: ITelemetryService, messages: CAPIChatMessage[], telemetryData: TelemetryData, isOutput: boolean, logService?: ILogService) {
	const telemetryDataWithPrompt = telemetryData.extendedBy({
		messagesJson: JSON.stringify(messages),
	});
	telemetryService.sendEnhancedGHTelemetryEvent('engine.messages', multiplexProperties(telemetryDataWithPrompt.properties), telemetryDataWithPrompt.measurements);
	telemetryService.sendInternalMSFTTelemetryEvent('engine.messages', multiplexProperties(telemetryDataWithPrompt.properties), telemetryDataWithPrompt.measurements);

	// Send all model telemetry events (model.request.added, model.message.added, model.modelCall.input/output, model.request.options.added)
	// Comment out the line below to disable the new deduplicated model telemetry events
	sendModelTelemetryEvents(telemetryService, messages, telemetryData, isOutput, logService);

	// Also send length-only telemetry
	sendEngineMessagesLengthTelemetry(telemetryService, messages, telemetryData, isOutput, logService);
}

export function prepareChatCompletionForReturn(
	telemetryService: ITelemetryService,
	logService: ILogService,
	c: FinishedCompletion,
	telemetryData: TelemetryData
): ChatCompletion {
	let messageContent = c.solution.text.join('');

	let blockFinished = false;
	if (c.finishOffset !== undefined) {
		// Trim solution to finishOffset returned by finishedCb
		logService.debug(`message ${c.index}: early finish at offset ${c.finishOffset}`);
		messageContent = messageContent.substring(0, c.finishOffset);
		blockFinished = true;
	}

	logService.info(`message ${c.index} returned. finish reason: [${c.reason}]`);
	logService.debug(
		`message ${c.index} details: finishOffset: [${c.finishOffset}] completionId: [{${c.requestId.completionId}}] created: [{${c.requestId.created}}]`
	);
	const jsonData: APIJsonData = convertToAPIJsonData(c.solution);
	const message: Raw.ChatMessage = {
		role: Raw.ChatRole.Assistant,
		content: toTextParts(messageContent),
	};

	// Create enhanced message for telemetry with usage information
	const telemetryMessage = rawMessageToCAPI(message);

	// Add request metadata to telemetry data
	telemetryData.extendWithRequestId(c.requestId);

	// Add usage information to telemetryData if available
	let telemetryDataWithUsage = telemetryData;
	if (c.usage) {
		telemetryDataWithUsage = telemetryData.extendedBy({}, {
			promptTokens: c.usage.prompt_tokens,
			completionTokens: c.usage.completion_tokens,
			totalTokens: c.usage.total_tokens
		});
	}

	sendEngineMessagesTelemetry(telemetryService, [telemetryMessage], telemetryDataWithUsage, true, logService);
	return {
		message: message,
		choiceIndex: c.index,
		requestId: c.requestId,
		blockFinished: blockFinished,
		finishReason: c.reason,
		filterReason: c.filterReason,
		error: c.error,
		tokens: jsonData.tokens,
		usage: c.usage,
		telemetryData: telemetryDataWithUsage,
	};
}
