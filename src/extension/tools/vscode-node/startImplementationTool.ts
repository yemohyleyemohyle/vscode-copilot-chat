/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { ILogService } from '../../../platform/log/common/logService';
import { CancellationToken } from '../../../util/vs/base/common/cancellation';
import { LanguageModelTextPart, LanguageModelToolResult, MarkdownString } from '../../../vscodeTypes';
import { ToolName } from '../common/toolNames';
import { ICopilotTool, ToolRegistry } from '../common/toolsRegistry';

interface IStartImplementationParams {
	summary?: string;
}

/**
 * Tool that signals the transition from Plan mode to Agent mode.
 *
 * The Plan agent calls this after saving its plan to `/memories/session/plan.md`.
 * The tool itself is a **signal** — it does not directly trigger implementation.
 * The actual handoff is handled by {@link ToolCallingLoop} which detects the
 * `startImplementation` tool call in its tool-call rounds and injects a follow-up
 * "Start implementation" query with the implementation model endpoint override.
 *
 * See `ToolCallingLoop._runLoop()` at ~line 935 of `toolCallingLoop.ts` for the
 * follow-up injection logic.
 */
export class StartImplementationTool implements ICopilotTool<IStartImplementationParams> {
	public static readonly toolName = ToolName.StartImplementation;

	constructor(
		@ILogService private readonly logService: ILogService,
	) {
		this.logService.info('[StartImplementationTool] constructor: tool instance created and registered with VS Code');
	}

	async invoke(_options: vscode.LanguageModelToolInvocationOptions<IStartImplementationParams>, _token: CancellationToken): Promise<vscode.LanguageModelToolResult> {
		this.logService.info('[StartImplementationTool] invoke: entry');

		// The tool is a signal — ToolCallingLoop detects the startImplementation
		// tool call in its tool-call rounds and injects a follow-up query with
		// the implementation model endpoint override. No action needed here.
		this.logService.info('[StartImplementationTool] invoke: returning tool result (ToolCallingLoop handles follow-up)');
		return new LanguageModelToolResult([
			new LanguageModelTextPart(
				'Implementation handoff acknowledged. ' +
				'Summarize the plan briefly and conclude this planning response. ' +
				'The system will automatically begin implementation.'
			)
		]);
	}

	prepareInvocation(_options: vscode.LanguageModelToolInvocationPrepareOptions<IStartImplementationParams>, _token: vscode.CancellationToken): vscode.ProviderResult<vscode.PreparedToolInvocation> {
		this.logService.info('[StartImplementationTool] prepareInvocation: VS Code core is about to invoke the tool (model requested it)');
		return {
			invocationMessage: new MarkdownString(vscode.l10n.t('Starting implementation...')),
			pastTenseMessage: new MarkdownString(vscode.l10n.t('Started implementation')),
		};
	}
}

ToolRegistry.registerTool(StartImplementationTool);
