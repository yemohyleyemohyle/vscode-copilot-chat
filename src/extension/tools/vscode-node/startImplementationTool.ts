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
 *
 * **Architecture note**: Plan mode uses `target: 'vscode'`, meaning VS Code core
 * owns the tool calling loop. The extension's {@link ToolCallingLoop._runLoop}
 * never executes for Plan mode, so the in-loop follow-up injection
 * (`_followUpQuery` at ~line 930 of toolCallingLoop.ts) is dead code for this flow.
 *
 * To work around this, after toggling the mode and model, this tool schedules a
 * **deferred `chat.open` command** via `setTimeout` that submits the implementation
 * prompt to Agent mode after the Plan response completes.
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

		// Switch to agent mode within the current session.
		// NOTE: toggleAgentMode only supports { modeId, sessionResource, model }.
		const toggleArgs = {
			modeId: 'agent',
			sessionResource: options.chatSessionResource,
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

		// Schedule a deferred chat.open to submit the implementation prompt.
		//
		// Plan mode uses `target: 'vscode'`, so VS Code core owns the tool calling loop.
		// The extension's ToolCallingLoop._runLoop() never executes for Plan mode, making
		// the in-loop follow-up injection (~line 930 of toolCallingLoop.ts) dead code.
		// We schedule a deferred chat.open command that fires after the Plan response
		// completes, submitting the implementation prompt to Agent mode in the same session.
		this.scheduleDeferredHandoff(resolvedModel);

		// Return a result that concludes the planning turn.
		this.logService.info('[StartImplementationTool] invoke: returning tool result (deferred handoff scheduled)');
		return new LanguageModelToolResult([
			new LanguageModelTextPart(
				'Planning phase completed successfully. The session mode has been switched to Agent for implementation. ' +
				'Summarize the plan briefly and conclude this planning response. ' +
				'The system will automatically submit a follow-up implementation request.'
			)
		]);
	}

	prepareInvocation(_options: vscode.LanguageModelToolInvocationPrepareOptions<IStartImplementationParams>, _token: vscode.CancellationToken): vscode.ProviderResult<vscode.PreparedToolInvocation> {
		return {
			invocationMessage: new MarkdownString(vscode.l10n.t('Starting implementation...')),
			pastTenseMessage: new MarkdownString(vscode.l10n.t('Started implementation')),
		};
	}

	/**
	 * The delay (in ms) before submitting the deferred implementation request.
	 * After this tool returns, VS Code core sends the result to the model, the model
	 * produces a brief summary, and the Plan response completes. This delay must be
	 * long enough for that sequence to finish.
	 */
	static readonly HANDOFF_DELAY_MS = 5000;

	/**
	 * Schedule a deferred `workbench.action.chat.open` command to submit the
	 * implementation prompt after the Plan response completes.
	 *
	 * Plan mode uses `target: 'vscode'`, so VS Code core owns the tool calling loop.
	 * After this tool returns, core sends the result to the model, the model produces
	 * a brief summary, and the response completes. We use a delay to ensure the
	 * response has finished before submitting the follow-up.
	 */
	scheduleDeferredHandoff(resolvedModel?: { vendor: string; id: string; family: string }): void {
		this.logService.info(`[StartImplementationTool] Scheduling deferred handoff in ${StartImplementationTool.HANDOFF_DELAY_MS}ms`);

		setTimeout(async () => {
			try {
				this.logService.info('[StartImplementationTool] Submitting deferred implementation request via chat.open');
				const chatOpenArgs: Record<string, unknown> = {
					query: 'Start implementation. Read the plan from /memories/session/plan.md and execute it.',
					mode: 'agent',
				};
				if (resolvedModel) {
					chatOpenArgs.modelSelector = { id: resolvedModel.id, vendor: resolvedModel.vendor };
				}
				await vscode.commands.executeCommand('workbench.action.chat.open', chatOpenArgs);
				this.logService.info('[StartImplementationTool] Deferred implementation request submitted successfully');
			} catch (e) {
				this.logService.error(`[StartImplementationTool] Failed to submit deferred implementation request: ${e}`);
			}
		}, StartImplementationTool.HANDOFF_DELAY_MS);
	}
}

ToolRegistry.registerTool(StartImplementationTool);
