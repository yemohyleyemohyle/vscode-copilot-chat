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

/**
 * How often (ms) to poll for request completion before resubmitting.
 */
const RESUBMIT_POLL_INTERVAL_MS = 2_000;

/**
 * Maximum time (ms) to wait for the current request to finish before giving up.
 */
const RESUBMIT_TIMEOUT_MS = 30_000;

/**
 * Delay (ms) after each poll tick, to let the UI settle before attempting submission.
 */
const RESUBMIT_SETTLE_DELAY_MS = 2_000;

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

		// Schedule a deferred resubmission: once the current request finishes,
		// type "Start implementation" into the chat input of the SAME session
		// and submit it. The session is already in agent mode from toggleAgentMode.
		//
		// We use `type` + `submit` instead of `chat.open` because `chat.open`
		// creates a NEW session, losing all planning history. The `type` command
		// injects text into the currently focused chat input, which after the
		// request completes is the same session.
		this.scheduleDeferredResubmission(resolvedModel);

		// Tell the LLM to STOP — do not continue in the current request.
		// The deferred resubmission will trigger a new request in agent mode
		// with the correct model.
		return new LanguageModelToolResult([
			new LanguageModelTextPart(
				'Planning phase completed successfully. The session mode has been switched to Agent for implementation. ' +
				'This tool call marks the end of the planning turn — conclude your planning response now untill user\'s conformation to start implementation.'
			)
		]);
	}

	/**
	 * Schedule a deferred resubmission that waits for the current request to
	 * complete, then focuses the chat panel, types "Start implementation" into
	 * the input of the SAME session, and submits it.
	 *
	 * Uses `workbench.panel.chat.view.copilot.focus` to ensure the chat input
	 * has keyboard focus, then `type` to inject the prompt text, then `submit`
	 * to send it. This keeps the request in the same session (unlike `chat.open`
	 * which creates a new session and loses conversation history).
	 */
	scheduleDeferredResubmission(resolvedModel?: { vendor: string; id: string; family: string }): void {
		const startTime = Date.now();
		this.logService.info('[StartImplementationTool] scheduleDeferredResubmission: scheduling deferred resubmission');

		let submitted = false;

		const intervalId = setInterval(async () => {
			const elapsed = Date.now() - startTime;

			if (elapsed > RESUBMIT_TIMEOUT_MS) {
				clearInterval(intervalId);
				this.logService.warn(`[StartImplementationTool] scheduleDeferredResubmission: timed out after ${elapsed}ms, giving up`);
				return;
			}

			if (submitted) {
				return; // Already in progress, skip this tick
			}

			submitted = true;
			try {
				this.logService.info(`[StartImplementationTool] scheduleDeferredResubmission: attempting resubmission after ${elapsed}ms`);
				await this.submitImplementationRequest(resolvedModel);
				clearInterval(intervalId);
				this.logService.info('[StartImplementationTool] scheduleDeferredResubmission: resubmission completed successfully');
			} catch (e) {
				this.logService.warn(`[StartImplementationTool] scheduleDeferredResubmission: resubmission attempt failed: ${e}`);
				submitted = false; // Allow retry on next tick
			}
		}, RESUBMIT_POLL_INTERVAL_MS);
	}

	/**
	 * Focus the chat panel, type "Start implementation" into the chat input
	 * of the current session, and submit.
	 *
	 * Unlike `chat.open`, `type` operates on the currently focused chat input
	 * (which is the same session that was just in plan mode). This preserves
	 * the full conversation history.
	 */
	private async submitImplementationRequest(resolvedModel?: { vendor: string; id: string; family: string }): Promise<void> {
		// Wait for the UI to settle after the current request completes
		await new Promise(resolve => setTimeout(resolve, RESUBMIT_SETTLE_DELAY_MS));

		// Focus the chat panel to ensure the chat input has keyboard focus.
		// After a request completes the panel is visible but the input may not
		// be focused — `type` requires keyboard focus on the target widget.
		this.logService.info('[StartImplementationTool] submitImplementationRequest: focusing chat panel');
		await vscode.commands.executeCommand('workbench.panel.chat.view.copilot.focus');

		// Re-apply the model in case it was not fully applied during the mode switch
		if (resolvedModel) {
			this.logService.info(`[StartImplementationTool] submitImplementationRequest: setting model ${JSON.stringify(resolvedModel)}`);
			await vscode.commands.executeCommand('workbench.action.chat.changeModel', resolvedModel);
		}

		// Type the implementation prompt into the chat input of the current session.
		// `type` injects text into whatever widget currently has keyboard focus,
		// which we ensured is the chat input via the focus command above.
		this.logService.info('[StartImplementationTool] submitImplementationRequest: typing prompt');
		await vscode.commands.executeCommand('type', { text: 'Start implementation' });

		this.logService.info('[StartImplementationTool] submitImplementationRequest: submitting');
		await vscode.commands.executeCommand('workbench.action.chat.submit');

		this.logService.info('[StartImplementationTool] submitImplementationRequest: submitted successfully');
	}

	prepareInvocation(_options: vscode.LanguageModelToolInvocationPrepareOptions<IStartImplementationParams>, _token: vscode.CancellationToken): vscode.ProviderResult<vscode.PreparedToolInvocation> {
		return {
			invocationMessage: new MarkdownString(vscode.l10n.t('Starting implementation...')),
			pastTenseMessage: new MarkdownString(vscode.l10n.t('Started implementation')),
		};
	}
}

ToolRegistry.registerTool(StartImplementationTool);
