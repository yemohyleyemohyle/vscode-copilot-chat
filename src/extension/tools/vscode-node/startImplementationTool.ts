/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { CancellationToken } from '../../../util/vs/base/common/cancellation';
import { LanguageModelTextPart, LanguageModelToolResult, MarkdownString } from '../../../vscodeTypes';
import { ToolName } from '../common/toolNames';
import { ICopilotTool, ToolRegistry } from '../common/toolsRegistry';

const IMPLEMENT_AGENT_MODEL_SETTING = 'github.copilot.chat.implementAgent.model';

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

	/**
	 * If the `implementAgent.model` setting is configured, switch the chat model
	 * before opening agent mode so the implementation agent uses the right model.
	 */
	private async switchModel(): Promise<void> {
		const cfg = vscode.workspace.getConfiguration();
		const modelId: string | undefined = cfg.get(IMPLEMENT_AGENT_MODEL_SETTING);
		if (!modelId) {
			return;
		}

		// Try to resolve the model by id first, then fall back to family
		let models = await vscode.lm.selectChatModels({ id: modelId, vendor: 'copilot' });
		if (models.length === 0) {
			models = await vscode.lm.selectChatModels({ family: modelId, vendor: 'copilot' });
		}

		if (models.length > 0) {
			const model = models[0];
			await vscode.commands.executeCommand('workbench.action.chat.changeModel', {
				vendor: model.vendor,
				id: model.id,
				family: model.family,
			});
		}
	}

	async invoke(options: vscode.LanguageModelToolInvocationOptions<IStartImplementationParams>, _token: CancellationToken): Promise<vscode.LanguageModelToolResult> {
		// Switch model if implementAgent.model is configured
		await this.switchModel();

		// Switch to agent mode within the current session (like SwitchAgentTool does).
		// Using toggleAgentMode instead of chat.open because chat.open tries to open
		// a new session, which gets dropped when called mid-request.
		await vscode.commands.executeCommand('workbench.action.chat.toggleAgentMode', {
			modeId: 'agent',
			sessionResource: options.chatSessionResource,
		});

		return new LanguageModelToolResult([
			new LanguageModelTextPart(
				'Switched to Agent mode. You are now the implementation agent. ' +
				'Read the plan from /memories/session/plan.md and start implementing it immediately. ' +
				'Use all available tools to make the code changes described in the plan. ' +
				'This tool may no longer be available in the new agent.'
			)
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
