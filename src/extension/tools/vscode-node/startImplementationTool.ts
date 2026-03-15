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

	constructor(
		@ILogService private readonly logService: ILogService,
	) { }

	/**
	 * If the `implementAgent.model` setting is configured, resolve the corresponding
	 * chat model so it can be applied during the mode transition.
	 *
	 * @returns The resolved model info, or `undefined` if no override is configured
	 *          or the model could not be found.
	 */
	async resolveImplementModel(): Promise<{ vendor: string; id: string; family: string } | undefined> {
		const cfg = vscode.workspace.getConfiguration();
		const modelId: string | undefined = cfg.get(IMPLEMENT_AGENT_MODEL_SETTING);
		this.logService.info(`[StartImplementationTool] resolveImplementModel: setting '${IMPLEMENT_AGENT_MODEL_SETTING}' = '${modelId ?? '(not set)'}' `);

		if (!modelId) {
			this.logService.info('[StartImplementationTool] resolveImplementModel: no model configured, returning undefined');
			return undefined;
		}

		// Try to resolve the model by id first, then fall back to family
		let models = await vscode.lm.selectChatModels({ id: modelId, vendor: 'copilot' });
		this.logService.info(`[StartImplementationTool] resolveImplementModel: selectChatModels({id: '${modelId}'}) returned ${models.length} model(s)`);

		if (models.length === 0) {
			models = await vscode.lm.selectChatModels({ family: modelId, vendor: 'copilot' });
			this.logService.info(`[StartImplementationTool] resolveImplementModel: selectChatModels({family: '${modelId}'}) returned ${models.length} model(s)`);
		}

		if (models.length > 0) {
			const model = models[0];
			const resolved = { vendor: model.vendor, id: model.id, family: model.family };
			this.logService.info(`[StartImplementationTool] resolveImplementModel: resolved model = ${JSON.stringify(resolved)}`);
			return resolved;
		}

		// Log all available models to help diagnose mismatches
		const allModels = await vscode.lm.selectChatModels({ vendor: 'copilot' });
		this.logService.warn(
			`[StartImplementationTool] resolveImplementModel: could not resolve '${modelId}'. ` +
			`Available copilot models: ${allModels.map(m => `${m.id} (family=${m.family})`).join(', ') || '(none)'}`,
		);
		return undefined;
	}

	async invoke(options: vscode.LanguageModelToolInvocationOptions<IStartImplementationParams>, _token: CancellationToken): Promise<vscode.LanguageModelToolResult> {
		this.logService.info('[StartImplementationTool] invoke: entry');

		// Resolve the implement agent model before switching modes
		const resolvedModel = await this.resolveImplementModel();
		this.logService.info(`[StartImplementationTool] invoke: resolvedModel = ${resolvedModel ? JSON.stringify(resolvedModel) : 'undefined'}`);

		// Switch to agent mode within the current session and submit the
		// implementation prompt atomically via `prompt` + `send`.
		//
		// This replicates the interactive handoff button behavior:
		// the handoff in agent.md defines { agent, prompt, send, model } and
		// VS Code core handles the mode switch, model change, input population,
		// and request submission as a single operation — with proper timing and
		// focus management.
		//
		// Previously, a deferred resubmission used `type` + `submit` commands
		// which was fragile: the `type` command depends on keyboard focus being
		// on the chat input widget, but during an active request focus may be
		// on the response area. This caused either no submission (trajectories
		// ending at the tool call) or re-triggering the original plan request
		// with the new model (wrong request text, no memory).
		const toggleArgs = {
			modeId: 'agent',
			sessionResource: options.chatSessionResource,
			prompt: 'Start implementation',
			send: true,
			...(resolvedModel ? { model: resolvedModel } : {}),
		};
		this.logService.info(`[StartImplementationTool] invoke: calling toggleAgentMode with args = ${JSON.stringify(toggleArgs)}`);
		await vscode.commands.executeCommand('workbench.action.chat.toggleAgentMode', toggleArgs);
		this.logService.info('[StartImplementationTool] invoke: toggleAgentMode completed');

		// Explicitly switch the model AFTER the mode transition as a belt-and-suspenders
		// fallback. The model is already passed in toggleArgs, but changeModel ensures
		// the model picker UI also reflects the selection for any subsequent requests.
		if (resolvedModel) {
			this.logService.info(`[StartImplementationTool] invoke: calling changeModel with ${JSON.stringify(resolvedModel)}`);
			await vscode.commands.executeCommand('workbench.action.chat.changeModel', resolvedModel);
			this.logService.info('[StartImplementationTool] invoke: changeModel completed');
		} else {
			this.logService.info('[StartImplementationTool] invoke: no model override, skipping changeModel');
		}

		// Tell the LLM to STOP — do not continue in the current request.
		// The toggleAgentMode with send: true will submit a new request
		// in agent mode with the correct model.
		return new LanguageModelToolResult([
			new LanguageModelTextPart(
				'Handoff to Agent mode initiated. The planning session is now complete. ' +
				'Do NOT call any more tools or take any further action. ' +
				'A new request will be submitted automatically in Agent mode to begin implementation.'
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
