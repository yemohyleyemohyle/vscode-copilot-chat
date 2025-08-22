/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createServiceIdentifier } from '../../../util/common/services';
import { ILogService } from '../../log/common/logService';
import { ITelemetryService, multiplexProperties } from './telemetry';

export const IConversationTelemetryService = createServiceIdentifier<IConversationTelemetryService>('IConversationTelemetryService');

export interface IConversationTelemetryService {
	readonly _serviceBrand: undefined;

	// Conversation-level events
	sendConversationStarted(conversationId: string, headerRequestId: string, sessionType: string, userInitiated: boolean): void;

	// Query-level events
	sendQueryStarted(conversationId: string, headerRequestId: string, queryIndex: number, inputType?: string, participantId?: string, slashCommand?: string): void;
	sendQueryCompleted(conversationId: string, headerRequestId: string, completionType: string, userAction?: string, editApplied?: boolean, totalDuration?: number, messageCount?: number): void;

	// Message-level events
	sendMessageAdded(conversationId: string, headerRequestId: string, messageUuid: string, role: string, contentType: string, contentLength: number, messageIndex: number): void;

	// Tool-level events
	sendToolsUsed(conversationId: string, headerRequestId: string, toolsOffered: any[], toolsUsed: any[]): void;

	// API-level events
	sendApiRequest(conversationId: string, headerRequestId: string, modelCallId: string, model: string, messageCount: number, totalTokensEstimate?: number, temperature?: number, maxTokens?: number): void;
	sendApiResponse(conversationId: string, headerRequestId: string, modelCallId: string, promptTokens: number, completionTokens: number, totalTokens: number, finishReason: string, responseTime: number): void;
}

export class ConversationTelemetryService implements IConversationTelemetryService {
	declare readonly _serviceBrand: undefined;

	constructor(
		private readonly telemetryService: ITelemetryService,
		private readonly logService: ILogService
	) { }

	sendConversationStarted(conversationId: string, headerRequestId: string, sessionType: string, userInitiated: boolean): void {
		const properties = {
			conversationId,
			headerRequestId,
			sessionType,
			userInitiated: userInitiated.toString(),
			timestamp: Date.now().toString()
		};

		this.logService.debug(`[NEW TELEMETRY] conversation.started: ${JSON.stringify(properties)}`);

		// Send only to Microsoft internal telemetry
		this.telemetryService.sendInternalMSFTTelemetryEvent('conversation.started', multiplexProperties(properties));
	}

	sendQueryStarted(conversationId: string, headerRequestId: string, queryIndex: number, inputType?: string, participantId?: string, slashCommand?: string): void {
		const properties = {
			conversationId,
			headerRequestId,
			queryIndex: queryIndex.toString(),
			timestamp: Date.now().toString(),
			...(inputType && { inputType }),
			...(participantId && { participantId }),
			...(slashCommand && { slashCommand })
		};

		this.logService.debug(`[NEW TELEMETRY] query.started: ${JSON.stringify(properties)}`);

		// Send only to Microsoft internal telemetry
		this.telemetryService.sendInternalMSFTTelemetryEvent('query.started', multiplexProperties(properties));
	}

	sendQueryCompleted(conversationId: string, headerRequestId: string, completionType: string, userAction?: string, editApplied?: boolean, totalDuration?: number, messageCount?: number): void {
		const properties = {
			conversationId,
			headerRequestId,
			completionType,
			timestamp: Date.now().toString(),
			...(userAction && { userAction }),
			...(editApplied !== undefined && { editApplied: editApplied.toString() }),
			...(messageCount !== undefined && { messageCount: messageCount.toString() })
		};

		const measurements = {
			...(totalDuration !== undefined && { totalDuration })
		};

		this.logService.debug(`[NEW TELEMETRY] query.completed: ${JSON.stringify({ properties, measurements })}`);

		// Send only to Microsoft internal telemetry
		this.telemetryService.sendInternalMSFTTelemetryEvent('query.completed', multiplexProperties(properties), measurements);
	}

	sendMessageAdded(conversationId: string, headerRequestId: string, messageUuid: string, role: string, contentType: string, contentLength: number, messageIndex: number): void {
		const properties = {
			conversationId,
			headerRequestId,
			messageUuid,
			role,
			contentType,
			messageIndex: messageIndex.toString(),
			timestamp: Date.now().toString()
		};

		const measurements = {
			contentLength
		};

		this.logService.debug(`[NEW TELEMETRY] query.message.added: ${JSON.stringify({ properties, measurements })}`);

		// Send only to Microsoft internal telemetry
		this.telemetryService.sendInternalMSFTTelemetryEvent('query.message.added', multiplexProperties(properties), measurements);
	}

	sendToolsUsed(conversationId: string, headerRequestId: string, toolsOffered: any[], toolsUsed: any[]): void {
		const properties = {
			conversationId,
			headerRequestId,
			toolsOfferedJson: JSON.stringify(toolsOffered.map(tool => ({
				name: tool.name,
				parametersSchema: tool.parametersSchema || tool.parameters
			}))),
			toolsUsedJson: JSON.stringify(toolsUsed.map(tool => ({
				name: tool.name,
				parametersLength: typeof tool.parameters === 'string' ? tool.parameters.length : JSON.stringify(tool.parameters || {}).length,
				resultLength: typeof tool.result === 'string' ? tool.result.length : JSON.stringify(tool.result || {}).length
			}))),
			timestamp: Date.now().toString()
		};

		this.logService.debug(`[NEW TELEMETRY] query.api.tools: ${JSON.stringify(properties)}`);

		// Send only to Microsoft internal telemetry
		this.telemetryService.sendInternalMSFTTelemetryEvent('query.api.tools', multiplexProperties(properties));
	}

	sendApiRequest(conversationId: string, headerRequestId: string, modelCallId: string, model: string, messageCount: number, totalTokensEstimate?: number, temperature?: number, maxTokens?: number): void {
		const properties = {
			conversationId,
			headerRequestId,
			modelCallId,
			model,
			messageCount: messageCount.toString(),
			requestStartTime: Date.now().toString(),
			...(temperature !== undefined && { temperature: temperature.toString() }),
			...(maxTokens !== undefined && { maxTokens: maxTokens.toString() })
		};

		const measurements = {
			...(totalTokensEstimate !== undefined && { totalTokensEstimate })
		};

		this.logService.debug(`[NEW TELEMETRY] query.api.request: ${JSON.stringify({ properties, measurements })}`);

		// Send only to Microsoft internal telemetry
		this.telemetryService.sendInternalMSFTTelemetryEvent('query.api.request', multiplexProperties(properties), measurements);
	}

	sendApiResponse(conversationId: string, headerRequestId: string, modelCallId: string, promptTokens: number, completionTokens: number, totalTokens: number, finishReason: string, responseTime: number): void {
		const properties = {
			conversationId,
			headerRequestId,
			modelCallId,
			finishReason,
			timestamp: Date.now().toString()
		};

		const measurements = {
			promptTokens,
			completionTokens,
			totalTokens,
			responseTime
		};

		this.logService.debug(`[NEW TELEMETRY] query.api.response: ${JSON.stringify({ properties, measurements })}`);

		// Send only to Microsoft internal telemetry
		this.telemetryService.sendInternalMSFTTelemetryEvent('query.api.response', multiplexProperties(properties), measurements);
	}
}