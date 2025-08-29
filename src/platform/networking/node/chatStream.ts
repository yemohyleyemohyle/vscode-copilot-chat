/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Raw } from '@vscode/prompt-tsx';
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

	const telemetryDataWithPrompt = telemetryData.extendedBy({
		messagesJson: JSON.stringify(messagesWithLength),
		message_direction: messageType,
		modelCallId: modelCallId, // Include at telemetry event level too
	});

	telemetryService.sendEnhancedGHTelemetryEvent('engine.messages.length', multiplexProperties(telemetryDataWithPrompt.properties), telemetryDataWithPrompt.measurements);
	telemetryService.sendInternalMSFTTelemetryEvent('engine.messages.length', multiplexProperties(telemetryDataWithPrompt.properties), telemetryDataWithPrompt.measurements);
}

export function sendEngineMessagesTelemetry(telemetryService: ITelemetryService, messages: CAPIChatMessage[], telemetryData: TelemetryData, isOutput: boolean, logService?: ILogService) {
	const telemetryDataWithPrompt = telemetryData.extendedBy({
		messagesJson: JSON.stringify(messages),
	});
	telemetryService.sendEnhancedGHTelemetryEvent('engine.messages', multiplexProperties(telemetryDataWithPrompt.properties), telemetryDataWithPrompt.measurements);
	telemetryService.sendInternalMSFTTelemetryEvent('engine.messages', multiplexProperties(telemetryDataWithPrompt.properties), telemetryDataWithPrompt.measurements);

	// Skip input message telemetry for retry requests to avoid duplicates
	// Retry requests are identified by the presence of retryAfterFilterCategory property
	const isRetryRequest = telemetryData.properties.retryAfterFilterCategory !== undefined;
	if (!isOutput && isRetryRequest) {
		logService?.debug('[TELEMETRY] Skipping input message telemetry for retry request to avoid duplicates');
		return;
	}

	// Send individual message telemetry for deduplication tracking and collect UUIDs with their headerRequestIds
	const messageData = sendIndividualMessagesTelemetry(telemetryService, messages, telemetryData, isOutput ? 'output' : 'input', logService);

	// Send model call telemetry grouped by headerRequestId (separate events for different headerRequestIds)
	if (messageData.length > 0) {
		sendEngineModelCallTelemetry(telemetryService, messageData, telemetryData, isOutput ? 'output' : 'input', logService);
	}

	// Also send length-only telemetry
	sendEngineMessagesLengthTelemetry(telemetryService, messages, telemetryData, isOutput, logService);
}

// Track messages that have already been logged to avoid duplicates
const loggedMessages = new Set<string>();

// Map from message hash to UUID to ensure same content gets same UUID
const messageHashToUuid = new Map<string, string>();

function sendIndividualMessagesTelemetry(telemetryService: ITelemetryService, messages: CAPIChatMessage[], telemetryData: TelemetryData, messageDirection: 'input' | 'output', logService?: ILogService): Array<{ uuid: string; headerRequestId: string }> {
	const messageData: Array<{ uuid: string; headerRequestId: string }> = [];

	for (const message of messages) {
		// Create a hash of the message content to detect duplicates
		const messageHash = JSON.stringify({
			role: message.role,
			content: message.content,
			...(('tool_calls' in message && message.tool_calls) && { tool_calls: message.tool_calls }),
			...(('tool_call_id' in message && message.tool_call_id) && { tool_call_id: message.tool_call_id })
		});

		// Get existing UUID for this message content, or generate a new one
		let messageUuid = messageHashToUuid.get(messageHash);
		if (!messageUuid) {
			messageUuid = generateUuid();
			messageHashToUuid.set(messageHash, messageUuid);
		}

		// Extract context properties with fallbacks
		const conversationId = telemetryData.properties.conversationId || telemetryData.properties.sessionId || 'unknown';
		const headerRequestId = telemetryData.properties.headerRequestId || 'unknown';

		// Always collect UUIDs and headerRequestIds for model call tracking
		messageData.push({ uuid: messageUuid, headerRequestId });

		// Skip sending engine.message.added if this exact message has already been logged
		if (loggedMessages.has(messageHash)) {
			logService?.debug(`[engine.message.added] Reusing existing UUID ${messageUuid} for duplicate message content: ${message.role}`);
			continue;
		}

		// Mark this message as logged for engine.message.added deduplication
		loggedMessages.add(messageHash);

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

			telemetryService.sendInternalMSFTTelemetryEvent('engine.message.added', messageData.properties, messageData.measurements);

			// Log entire messageData as JSON (both properties and measurements)
			logService?.info(`[engine.message.added] chunk ${chunkIndex + 1}/${chunks.length} properties: ${JSON.stringify(messageData.properties)}, measurements: ${JSON.stringify(messageData.measurements)}`);
		}
	}

	return messageData; // Return collected message data with UUIDs and headerRequestIds
}

function sendEngineModelCallTelemetry(telemetryService: ITelemetryService, messageData: Array<{ uuid: string; headerRequestId: string }>, telemetryData: TelemetryData, messageDirection: 'input' | 'output', logService?: ILogService) {
	// Get the unique model call ID
	const modelCallId = telemetryData.properties.modelCallId as string;
	if (!modelCallId) {
		logService?.warn('[TELEMETRY] modelCallId not found in telemetryData, cannot send engine.modelCall event');
		return;
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
		const eventName = messageDirection === 'input' ? 'engine.modelCall.input' : 'engine.modelCall.output';

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
			}, telemetryData.measurements); // Include measurements from original telemetryData

			telemetryService.sendInternalMSFTTelemetryEvent(eventName, modelCallData.properties, modelCallData.measurements);

			// Log model call telemetry
			logService?.info(`[${eventName}] chunk ${chunkIndex + 1}/${chunks.length} modelCallId: ${modelCallId}, ${messageDirection}: ${messageUuids.length} messages, headerRequestId: ${headerRequestId}, properties: ${JSON.stringify(modelCallData.properties)}, measurements: ${JSON.stringify(modelCallData.measurements)}`);
		}
	}
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
