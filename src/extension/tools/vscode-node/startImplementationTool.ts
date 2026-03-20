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
 * Instead, this tool schedules a **deferred handoff** via `setTimeout` that uses
 * VS Code core's `getHandoffs` API to discover the "Start Implementation" handoff
 * and execute it via `chat.open`. This mirrors the eval harness's
 * `executeHandoffAndWait` flow. The `chat.open` command handles mode switching,
 * model selection, and prompt submission in one call — no `toggleAgentMode` or
 * `changeModel` needed.
 */
export class StartImplementationTool implements ICopilotTool<IStartImplementationParams> {
	public static readonly toolName = ToolName.StartImplementation;

	/** The handoff ID for the "Start Implementation" button declared in Plan's .agent.md */
	static readonly HANDOFF_ID = 'agent:start-implementation';

	/** The source mode for handoff discovery */
	static readonly SOURCE_CHAT_MODE = 'plan';

	/**
	 * Fallback prompt used when `getHandoffs` fails or the handoff entry cannot be found.
	 * In the happy path, the prompt comes from core's dynamically-generated plan summary.
	 */
	static readonly FALLBACK_PROMPT = 'Start implementation. Read the plan from /memories/session/plan.md and execute it.';

	constructor(
		@ILogService private readonly logService: ILogService,
	) {
		this.logService.info('[StartImplementationTool] constructor: tool instance created and registered with VS Code');
	}

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

	async invoke(_options: vscode.LanguageModelToolInvocationOptions<IStartImplementationParams>, _token: CancellationToken): Promise<vscode.LanguageModelToolResult> {
		this.logService.info('[StartImplementationTool] invoke: entry');

		// Resolve the implement agent model for the deferred handoff's modelSelector
		const resolvedModel = await this.resolveImplementModel();
		this.logService.info(`[StartImplementationTool] invoke: resolvedModel = ${resolvedModel ? JSON.stringify(resolvedModel) : 'undefined'}`);

		// Schedule a deferred handoff that uses VS Code core's getHandoffs API.
		//
		// Plan mode uses `target: 'vscode'`, so VS Code core owns the tool calling loop.
		// The extension's ToolCallingLoop._runLoop() never executes for Plan mode, making
		// the in-loop follow-up injection (~line 930 of toolCallingLoop.ts) dead code.
		//
		// The deferred handoff:
		// 1. Calls getHandoffs({ sourceCustomAgent: 'plan' }) to discover the "Start
		//    Implementation" handoff and its dynamically-generated plan summary prompt
		// 2. Calls chat.open(query=handoff.prompt, mode='agent', modelSelector) to
		//    execute the handoff — this handles mode switch, model, and prompt in one call
		// 3. Falls back to a generic prompt if getHandoffs fails
		this.scheduleDeferredHandoff(resolvedModel);

		// Return a result that concludes the planning turn.
		this.logService.info('[StartImplementationTool] invoke: returning tool result (deferred handoff scheduled)');
		return new LanguageModelToolResult([
			new LanguageModelTextPart(
				'Planning phase completed successfully. ' +
				'Summarize the plan briefly and conclude this planning response. ' +
				'The system will automatically submit a follow-up implementation request.'
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

	/**
	 * The delay (in ms) before submitting the deferred implementation request.
	 * After this tool returns, VS Code core sends the result to the model, the model
	 * produces a brief summary, and the Plan response completes. This delay must be
	 * long enough for that sequence to finish.
	 */
	static readonly HANDOFF_DELAY_MS = 5000;

	/**
	 * Schedule a deferred handoff that uses VS Code core's `getHandoffs` API
	 * to discover the "Start Implementation" handoff, extract the dynamically-
	 * generated plan summary prompt, and execute it via `chat.open`.
	 *
	 * This mirrors the eval harness's `executeHandoffAndWait` flow:
	 * 1. `getHandoffs({ sourceCustomAgent: 'plan' })` → discover available handoffs
	 * 2. Find the handoff with id `agent:start-implementation`
	 * 3. `chat.open({ query: handoff.prompt, mode: handoff.agent, modelSelector })`
	 *
	 * Falls back to {@link FALLBACK_PROMPT} if `getHandoffs` fails or the
	 * handoff entry cannot be found.
	 */
	scheduleDeferredHandoff(resolvedModel?: { vendor: string; id: string; family: string }): void {
		this.logService.info(`[StartImplementationTool] Scheduling deferred handoff in ${StartImplementationTool.HANDOFF_DELAY_MS}ms`);

		setTimeout(async () => {
			try {
				// Try to discover the handoff via core's getHandoffs API.
				// This may return a dynamically-generated plan summary as the prompt.
				const handoff = await this.discoverHandoff();

				const prompt = handoff?.prompt || StartImplementationTool.FALLBACK_PROMPT;
				const targetMode = handoff?.agent || 'agent';

				this.logService.info(`[StartImplementationTool] Submitting deferred handoff: mode=${targetMode}, prompt=${prompt.substring(0, 100)}..., usedGetHandoffs=${!!handoff}`);

				const chatOpenArgs: Record<string, unknown> = {
					query: prompt,
					mode: targetMode,
				};
				if (resolvedModel) {
					chatOpenArgs.modelSelector = { id: resolvedModel.id, vendor: resolvedModel.vendor };
				}
				await vscode.commands.executeCommand('workbench.action.chat.open', chatOpenArgs);
				this.logService.info('[StartImplementationTool] Deferred handoff submitted successfully');
			} catch (e) {
				this.logService.error(`[StartImplementationTool] Failed to submit deferred handoff: ${e}`);
			}
		}, StartImplementationTool.HANDOFF_DELAY_MS);
	}

	/**
	 * Discover the "Start Implementation" handoff from VS Code core using the
	 * `workbench.action.chat.getHandoffs` command.
	 *
	 * @returns The matched handoff entry `{ id, label, agent, prompt }`, or
	 *          `undefined` if the command fails or no match is found.
	 */
	async discoverHandoff(): Promise<{ id: string; label: string; agent: string; prompt: string } | undefined> {
		try {
			this.logService.info(`[StartImplementationTool] Calling getHandoffs for source='${StartImplementationTool.SOURCE_CHAT_MODE}'`);
			const response = await vscode.commands.executeCommand(
				'workbench.action.chat.getHandoffs',
				{ sourceCustomAgent: StartImplementationTool.SOURCE_CHAT_MODE }
			) as {
				result?: Array<{
					id: string;
					name: string;
					handoffs: Array<{ id: string; label: string; agent: string; prompt: string }>;
				}>;
			} | undefined;

			if (!response?.result) {
				this.logService.warn('[StartImplementationTool] getHandoffs returned no result');
				return undefined;
			}

			const allHandoffs = response.result.flatMap(a => a.handoffs);
			this.logService.info(`[StartImplementationTool] getHandoffs returned ${allHandoffs.length} handoff(s): ${allHandoffs.map(h => h.id).join(', ')}`);

			const matched = allHandoffs.find(h => h.id === StartImplementationTool.HANDOFF_ID);
			if (!matched) {
				this.logService.warn(`[StartImplementationTool] Handoff '${StartImplementationTool.HANDOFF_ID}' not found in getHandoffs response`);
				return undefined;
			}

			this.logService.info(`[StartImplementationTool] Matched handoff: id=${matched.id}, agent=${matched.agent}, prompt=${matched.prompt.substring(0, 100)}...`);
			return matched;
		} catch (e) {
			this.logService.warn(`[StartImplementationTool] getHandoffs failed, will use fallback prompt: ${e}`);
			return undefined;
		}
	}
}

ToolRegistry.registerTool(StartImplementationTool);
