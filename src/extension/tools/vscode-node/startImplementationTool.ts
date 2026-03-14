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
const RESUBMIT_POLL_INTERVAL_MS = 500;

/**
 * Maximum time (ms) to wait for the current request to finish before giving up.
 */
const RESUBMIT_TIMEOUT_MS = 30_000;

/**
 * Delay (ms) after the request appears to have finished, to let the UI settle.
 */
const RESUBMIT_SETTLE_DELAY_MS = 1_000;

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
		// The mode change takes effect for subsequent requests, not the current one.
		const toggleArgs = {
			modeId: 'agent',
			sessionResource: options.chatSessionResource,
			...(resolvedModel ? { model: resolvedModel } : {}),
		};
		this.logService.info(`[StartImplementationTool] invoke: calling toggleAgentMode with args = ${JSON.stringify(toggleArgs)}`);
		await vscode.commands.executeCommand('workbench.action.chat.toggleAgentMode', toggleArgs);
		this.logService.info('[StartImplementationTool] invoke: toggleAgentMode completed');

		// Explicitly switch the model AFTER the mode transition as a fallback.
		if (resolvedModel) {
			this.logService.info(`[StartImplementationTool] invoke: calling changeModel with ${JSON.stringify(resolvedModel)}`);
			await vscode.commands.executeCommand('workbench.action.chat.changeModel', resolvedModel);
			this.logService.info('[StartImplementationTool] invoke: changeModel completed');
		} else {
			this.logService.info('[StartImplementationTool] invoke: no model override, skipping changeModel');
		}

		// Schedule a deferred resubmission: once the current request finishes, submit
		// "Start implementation" as a **new** user message in agent mode. This creates
		// a fresh ChatRequest whose `request.model` will be the newly-selected model
		// (e.g. claude-opus-4.6) rather than the plan agent's model (e.g. claude-sonnet-4).
		//
		// The current request's model is immutable (locked at request creation time),
		// so changeModel only affects future requests. The interactive handoff button
		// works because VS Code core creates a new ChatRequest via the handoff's
		// `send: true` + `model` properties. We replicate that here by ending the
		// current request (via the "stop" instruction below) and then submitting a
		// new message once the request completes.
		this.scheduleDeferredResubmission();

		// Tell the LLM to STOP — do not continue in the current request.
		// The deferred resubmission will trigger a new request in agent mode
		// with the correct model.
		return new LanguageModelToolResult([
			new LanguageModelTextPart(
				'Handoff to Agent mode initiated. The planning session is now complete. ' +
				'Do NOT call any more tools or take any further action. ' +
				'A new request will be submitted automatically in Agent mode to begin implementation.'
			)
		]);
	}

	/**
	 * Schedule a deferred resubmission that waits for the current request to complete,
	 * then focuses the chat panel and submits "Start implementation" as a new message.
	 *
	 * This replicates the interactive handoff button behavior programmatically:
	 * the new request runs in agent mode with the model that was set via changeModel.
	 */
	scheduleDeferredResubmission(): void {
		const startTime = Date.now();
		this.logService.info('[StartImplementationTool] scheduleDeferredResubmission: scheduling deferred resubmission');

		// Track if submit was attempted (to help detect issues)
		let submitted = false;

		// Use a polling interval to wait for the current request to finish.
		// We detect completion by attempting to submit and checking if the
		// chat panel accepts it (while a request is in progress, submit may
		// be a no-op or queued by VS Code core).
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
				await this.submitImplementationRequest();
				clearInterval(intervalId);
				this.logService.info('[StartImplementationTool] scheduleDeferredResubmission: resubmission completed successfully');
			} catch (e) {
				this.logService.warn(`[StartImplementationTool] scheduleDeferredResubmission: resubmission attempt failed: ${e}`);
				submitted = false; // Allow retry on next tick
			}
		}, RESUBMIT_POLL_INTERVAL_MS);
	}

	/**
	 * Focus the chat panel, type "Start implementation", and submit.
	 * This mirrors the pattern used in `startReplayInChat()`.
	 */
	private async submitImplementationRequest(): Promise<void> {
		// Wait a short settle period to let the UI finish processing
		await new Promise(resolve => setTimeout(resolve, RESUBMIT_SETTLE_DELAY_MS));

		this.logService.info('[StartImplementationTool] submitImplementationRequest: focusing chat panel');
		await vscode.commands.executeCommand('workbench.panel.chat.view.copilot.focus');

		this.logService.info('[StartImplementationTool] submitImplementationRequest: typing "Start implementation"');
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
