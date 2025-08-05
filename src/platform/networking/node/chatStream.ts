/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Raw } from '@vscode/prompt-tsx';
import { toTextParts } from '../../chat/common/globalStringUtils';
import { ILogService } from '../../log/common/logService';
import { ITelemetryService, multiplexProperties } from '../../telemetry/common/telemetry';
import { TelemetryData } from '../../telemetry/common/telemetryData';
import { APIJsonData, CAPIChatMessage, ChatCompletion, rawMessageToCAPI } from '../common/openai';
import { FinishedCompletion, convertToAPIJsonData } from './stream';

// TODO @lramos15 - Find a better file for this, since this file is for the chat stream and should not be telemetry related
export function sendEngineMessagesLengthTelemetry(telemetryService: ITelemetryService, messages: CAPIChatMessage[], telemetryData: TelemetryData, logService?: ILogService) {
	// Determine if this is input or output based on message characteristics
	const isOutput = messages.length === 1 && messages[0].role === 'assistant';
	const messageType = isOutput ? 'output' : 'input';

	// Create messages with content and tool_calls arguments replaced by length
	const messagesWithLength = messages.map(msg => {
		const processedMsg: any = {
			...msg, // This preserves ALL existing fields including tool_calls, tool_call_id, copilot_references, etc.
			content: typeof msg.content === 'string'
				? msg.content.length
				: Array.isArray(msg.content)
					? msg.content.reduce((total: number, part: any) => {
						if (typeof part === 'string') return total + part.length;
						if (part.type === 'text') return total + (part.text?.length || 0);
						return total;
					}, 0)
					: 0,
			copilot_message_type: messageType,
		};

		// Add completionId to connect input/output messages
		const modelCallId = telemetryData.properties.completionId;
		if (modelCallId) {
			processedMsg.completionId = modelCallId;
		}

		// Process tool_calls if present
		if (msg.tool_calls && Array.isArray(msg.tool_calls)) {
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

	// Log the messages before sending to telemetry
	logService?.info(`[TELEMETRY] engine.messages.length (${messageType}): ${JSON.stringify(messagesWithLength, null, 2)}`);

	const telemetryDataWithPrompt = telemetryData.extendedBy({
		messagesJson: JSON.stringify(messagesWithLength),
		message_direction: messageType,
	});

	telemetryService.sendEnhancedGHTelemetryEvent('engine.messages.length', multiplexProperties(telemetryDataWithPrompt.properties), telemetryDataWithPrompt.measurements);
	telemetryService.sendInternalMSFTTelemetryEvent('engine.messages.length', multiplexProperties(telemetryDataWithPrompt.properties), telemetryDataWithPrompt.measurements);
}

export function sendEngineMessagesTelemetry(telemetryService: ITelemetryService, messages: CAPIChatMessage[], telemetryData: TelemetryData, logService?: ILogService) {
	const telemetryDataWithPrompt = telemetryData.extendedBy({
		messagesJson: JSON.stringify(messages),
	});
	telemetryService.sendEnhancedGHTelemetryEvent('engine.messages', multiplexProperties(telemetryDataWithPrompt.properties), telemetryDataWithPrompt.measurements);
	telemetryService.sendInternalMSFTTelemetryEvent('engine.messages', multiplexProperties(telemetryDataWithPrompt.properties), telemetryDataWithPrompt.measurements);

	// Also send length-only telemetry
	sendEngineMessagesLengthTelemetry(telemetryService, messages, telemetryData, logService);
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

	// Create enhanced message for telemetry with usage and token information
	const telemetryMessage = rawMessageToCAPI(message);

	// Add usage information if available
	if (c.usage) {
		(telemetryMessage as any).usage = c.usage;
	}

	// Add token information if available
	if (jsonData.tokens) {
		(telemetryMessage as any).tokens = jsonData.tokens;
	}

	sendEngineMessagesTelemetry(telemetryService, [telemetryMessage], telemetryData, logService);
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
		telemetryData: telemetryData,
	};
}
