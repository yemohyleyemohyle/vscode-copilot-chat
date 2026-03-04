/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { ConfigKey, IConfigurationService } from '../../../platform/configuration/common/configurationService';
import { AGENT_FILE_EXTENSION } from '../../../platform/customInstructions/common/promptTypes';
import { IVSCodeExtensionContext } from '../../../platform/extContext/common/extensionContext';
import { IFileSystemService } from '../../../platform/filesystem/common/fileSystemService';
import { ILogService } from '../../../platform/log/common/logService';
import { Disposable } from '../../../util/vs/base/common/lifecycle';
import { buildPlanAgentBody } from '../common/planAgentBody';
import { AgentConfig, AgentHandoff, buildAgentMarkdown, DEFAULT_READ_TOOLS } from './agentTypes';

/**
 * Base Plan agent configuration - embedded from Plan.agent.md
 * This avoids runtime file loading and YAML parsing dependencies.
 */
const BASE_PLAN_AGENT_CONFIG: AgentConfig = {
	name: 'Plan',
	description: 'Researches and outlines multi-step plans',
	argumentHint: 'Outline the goal or problem to research',
	target: 'vscode',
	disableModelInvocation: true,
	agents: ['Explore'],
	tools: [
		...DEFAULT_READ_TOOLS,
		'agent',
	],
	handoffs: [], // Handoffs are generated dynamically in buildCustomizedConfig
	body: '' // Body is generated dynamically in buildCustomizedConfig
};

/**
 * Provides the Plan agent dynamically with settings-based customization.
 *
 * This provider uses an embedded configuration and generates .agent.md content
 * with settings-based customization (additional tools and model override).
 * No external file loading or YAML parsing dependencies required.
 */
export class PlanAgentProvider extends Disposable implements vscode.ChatCustomAgentProvider {
	readonly label = vscode.l10n.t('Plan Agent');

	private static readonly CACHE_DIR = 'plan-agent';
	private static readonly AGENT_FILENAME = `Plan${AGENT_FILE_EXTENSION}`;

	private readonly _onDidChangeCustomAgents = this._register(new vscode.EventEmitter<void>());
	readonly onDidChangeCustomAgents = this._onDidChangeCustomAgents.event;

	constructor(
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IVSCodeExtensionContext private readonly extensionContext: IVSCodeExtensionContext,
		@IFileSystemService private readonly fileSystemService: IFileSystemService,
		@ILogService private readonly logService: ILogService,
	) {
		super();

		// Listen for settings changes to refresh agents
		// Note: When settings change, we fire onDidChangeCustomAgents which causes VS Code to re-fetch
		// the agent definition. However, handoff buttons already rendered may not work as
		// these capture the model at render time.
		this._register(this.configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(ConfigKey.PlanAgentAdditionalTools.fullyQualifiedId) ||
				e.affectsConfiguration(ConfigKey.Deprecated.PlanAgentModel.fullyQualifiedId) ||
				e.affectsConfiguration('chat.planAgent.defaultModel') ||
				e.affectsConfiguration(ConfigKey.ImplementAgentModel.fullyQualifiedId)) {
				this._onDidChangeCustomAgents.fire();
			}
		}));
	}

	async provideCustomAgents(
		_context: unknown,
		_token: vscode.CancellationToken
	): Promise<vscode.ChatResource[]> {
		// Build config with settings-based customization
		const config = this.buildCustomizedConfig();

		// Generate .agent.md content
		const content = buildAgentMarkdown(config);

		// Write to cache file and return URI
		const fileUri = await this.writeCacheFile(content);
		return [{ uri: fileUri }];
	}

	private async writeCacheFile(content: string): Promise<vscode.Uri> {
		const cacheDir = vscode.Uri.joinPath(
			this.extensionContext.globalStorageUri,
			PlanAgentProvider.CACHE_DIR
		);

		// Ensure cache directory exists
		try {
			await this.fileSystemService.stat(cacheDir);
		} catch {
			await this.fileSystemService.createDirectory(cacheDir);
		}

		const fileUri = vscode.Uri.joinPath(cacheDir, PlanAgentProvider.AGENT_FILENAME);
		await this.fileSystemService.writeFile(fileUri, new TextEncoder().encode(content));
		this.logService.trace(`[PlanAgentProvider] Wrote agent file: ${fileUri.toString()}`);
		return fileUri;
	}

	static buildAgentBody(): string {
		return buildPlanAgentBody();
	}

	private buildCustomizedConfig(): AgentConfig {
		const additionalTools = this.configurationService.getConfig(ConfigKey.PlanAgentAdditionalTools);
		const coreDefaultModel = this.configurationService.getNonExtensionConfig<string>('chat.planAgent.defaultModel');
		const modelOverride = coreDefaultModel || this.configurationService.getConfig(ConfigKey.Deprecated.PlanAgentModel);

		const implementAgentModelOverride = this.configurationService.getConfig(ConfigKey.ImplementAgentModel);

		// Build handoffs dynamically with model override
		const startImplementationHandoff: AgentHandoff = {
			label: 'Start Implementation',
			agent: 'agent',
			prompt: 'Start implementation',
			send: true,
			...(implementAgentModelOverride ? { model: implementAgentModelOverride } : {})
		};

		const openInEditorHandoff: AgentHandoff = {
			label: 'Open in Editor',
			agent: 'agent',
			prompt: '#createFile the plan as is into an untitled file (`untitled:plan-${camelCaseName}.prompt.md` without frontmatter) for further refinement.',
			showContinueOn: false,
			send: true
		};

		// Collect tools to add
		const toolsToAdd: string[] = [...additionalTools];

		// Always include askQuestions tool (now provided by core)
		toolsToAdd.push('vscode/askQuestions');

		// Merge additional tools (deduplicated)
		const tools = toolsToAdd.length > 0
			? [...new Set([...BASE_PLAN_AGENT_CONFIG.tools, ...toolsToAdd])]
			: [...BASE_PLAN_AGENT_CONFIG.tools];

		// Start with base config
		return {
			...BASE_PLAN_AGENT_CONFIG,
			tools,
			handoffs: [startImplementationHandoff, openInEditorHandoff, ...(BASE_PLAN_AGENT_CONFIG.handoffs ?? [])],
			body: PlanAgentProvider.buildAgentBody(),
			...(modelOverride ? { model: modelOverride } : {}),
		};
	}
}
