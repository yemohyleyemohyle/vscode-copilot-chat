/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { CancellationToken } from '../../../util/vs/base/common/cancellation';
import { LanguageModelTextPart, LanguageModelToolResult, MarkdownString } from '../../../vscodeTypes';
import { ToolName } from '../common/toolNames';
import { ICopilotTool, ToolRegistry } from '../common/toolsRegistry';

interface IStartImplementationParams {
	summary?: string;
}

/**
 * Tool that programmatically transitions from Plan mode to Agent mode.
 * The Plan agent calls this after saving its plan to `/memories/session/plan.md`,
 * triggering agent mode to begin implementation without user interaction.
 *
 * Designed for unattended/container environments where nobody clicks handoff buttons.
 */
export class StartImplementationTool implements ICopilotTool<IStartImplementationParams> {
	public static readonly toolName = ToolName.StartImplementation;

	async invoke(options: vscode.LanguageModelToolInvocationOptions<IStartImplementationParams>, _token: CancellationToken): Promise<vscode.LanguageModelToolResult> {
		// Switch to agent mode and send the implementation prompt.
		// The plan is already persisted in /memories/session/plan.md,
		// so agent mode will pick it up via MemoryContextPrompt.
		await vscode.commands.executeCommand('workbench.action.chat.open', {
			mode: 'agent',
			query: 'Start implementation',
		});

		return new LanguageModelToolResult([
			new LanguageModelTextPart('Switched to Agent mode and sent "Start implementation" prompt. The plan from /memories/session/plan.md will be loaded automatically. Handing off to the implementation agent now.')
		]);
	}

	prepareInvocation(_options: vscode.LanguageModelToolInvocationPrepareOptions<IStartImplementationParams>, _token: vscode.CancellationToken): vscode.ProviderResult<vscode.PreparedToolInvocation> {
		return {
			invocationMessage: new MarkdownString(vscode.l10n.t('Starting implementation...')),
			pastTenseMessage: new MarkdownString(vscode.l10n.t('Started implementation')),
		};
	}
}

ToolRegistry.registerTool(StartImplementationTool);
