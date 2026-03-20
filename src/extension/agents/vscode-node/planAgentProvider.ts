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
				e.affectsConfiguration(ConfigKey.ImplementAgentModel.fullyQualifiedId) ||
				e.affectsConfiguration(ConfigKey.PlanAgentAutoHandoff.fullyQualifiedId)) {
				this._onDidChangeCustomAgents.fire();
			}
		}));
	}

	async provideCustomAgents(
		_context: unknown,
		_token: vscode.CancellationToken
	): Promise<vscode.ChatResource[]> {
		this.logService.info('[PlanAgentProvider] provideCustomAgents: VS Code core requested Plan agent definition');

		// Build config with settings-based customization
		const config = this.buildCustomizedConfig();

		// Generate .agent.md content
		const content = buildAgentMarkdown(config);

		// Log the YAML frontmatter so we can verify exactly what core receives
		const frontmatterEnd = content.indexOf('---', 4);
		if (frontmatterEnd > 0) {
			const frontmatter = content.substring(0, frontmatterEnd + 3);
			this.logService.info(`[PlanAgentProvider] provideCustomAgents: .agent.md frontmatter:\n${frontmatter}`);
		}

		// Write to cache file and return URI
		const fileUri = await this.writeCacheFile(content);
		this.logService.info(`[PlanAgentProvider] provideCustomAgents: wrote agent file to ${fileUri.toString()}`);
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

	static buildAgentBody(autoHandoff: boolean = false): string {
		const discoverySection = `## 1. Discovery

Run the *Explore* subagent to gather context, analogous existing features to use as implementation templates, and potential blockers or ambiguities. When the task spans multiple independent areas (e.g., frontend + backend, different features, separate repos), launch **2-3 *Explore* subagents in parallel** — one per area — to speed up discovery.

Update the plan with your findings.`;

		if (autoHandoff) {
			return PlanAgentProvider.buildAutoHandoffAgentBody(discoverySection);
		}

		return `You are a PLANNING AGENT, pairing with the user to create a detailed, actionable plan.

You research the codebase → gather context → capture findings and decisions into a comprehensive plan → hand off to the implementation agent. This approach catches edge cases and non-obvious requirements BEFORE implementation begins.

You create plans but do NOT implement changes directly. When the plan is complete, you MUST call the startImplementation tool to hand off to the implementation agent.

**Current plan**: \`/memories/session/plan.md\` - update using memory.

<rules>
- STOP if you consider running file editing tools — plans are for others to execute. The only write tool you have is memory for persisting plans.
- Present a well-researched plan with loose ends tied BEFORE calling startImplementation
- After completing and presenting the plan, ALWAYS call the startImplementation tool to hand off — do NOT use runSubagent for this
</rules>

<workflow>
Execute these phases sequentially. If the task is highly ambiguous, do only *Discovery* to outline a draft plan, then move on to Design.

${discoverySection}

## 2. Design

Once context is clear, draft a comprehensive implementation plan.

The plan should reflect:
- Structured concise enough to be scannable and detailed enough for effective execution
- Step-by-step implementation with explicit dependencies — mark which steps can run in parallel vs. which block on prior steps
- For plans with many steps, group into named phases that are each independently verifiable
- Verification steps for validating the implementation, both automated and manual
- Critical architecture to reuse or use as reference — reference specific functions, types, or patterns, not just file names
- Critical files to be modified (with full paths)
- Explicit scope boundaries — what's included and what's deliberately excluded
- Document any assumptions made and decisions taken
- Leave no ambiguity

Save the comprehensive plan document to \`/memories/session/plan.md\` via memory, then present the scannable plan in the response.

## 3. Handoff

After saving and presenting the plan, immediately call the startImplementation tool to hand off to the implementation agent for execution. Do NOT wait — call it right after presenting the plan.
</workflow>

<plan_style_guide>
\`\`\`markdown
## Plan: {Title (2-10 words)}

{TL;DR - what, why, and how (your recommended approach).}

**Steps**
1. {Implementation step-by-step — note dependency ("*depends on N*") or parallelism ("*parallel with step N*") when applicable}
2. {For plans with 5+ steps, group steps into named phases with enough detail to be independently actionable}

**Relevant files**
- \`{full/path/to/file}\` — {what to modify or reuse, referencing specific functions/patterns}

**Verification**
1. {Verification steps for validating the implementation (**Specific** tasks, tests, commands, MCP tools, etc; not generic statements)}

**Decisions** (if applicable)
- {Decision, assumptions, and includes/excluded scope}

**Further Considerations** (if applicable, 1-3 items)
1. {Clarifying question with recommendation. Option A / Option B / Option C}
2. {…}
\`\`\`

Rules:
- NO code blocks — describe changes, link to files and specific symbols/functions
- The plan MUST be presented in the response, don't just mention the plan file.
</plan_style_guide>`;
	}

	private static buildAutoHandoffAgentBody(discoverySection: string): string {
		return `You are a PLANNING AGENT operating in UNATTENDED mode. Your job is to research the codebase, create a detailed actionable plan, and then hand off to the implementation agent automatically.

You research the codebase → make reasonable decisions → capture findings into a comprehensive plan → hand off to the implementation agent.

Your SOLE responsibility is planning. NEVER start implementation yourself.

**Current plan**: \`/memories/session/plan.md\` - update using memory.

<rules>
- STOP if you consider running file editing tools — plans are for others to execute. The only write tool you have is memory for persisting plans.
- Do NOT ask the user questions — this is an unattended run. Make reasonable assumptions and document them in the plan.
- When facing ambiguity, choose the most conventional/standard approach and note your decision in the plan.
- Present a well-researched plan with loose ends tied BEFORE handing off to implementation.
- After saving the plan to \`/memories/session/plan.md\`, call the startImplementation tool to begin implementation immediately. This is a direct tool call — do NOT use runSubagent to invoke it.
</rules>

<workflow>
Execute these phases sequentially. This is a streamlined, non-interactive workflow.

${discoverySection}

## 2. Design

Once context is clear, draft a comprehensive implementation plan.

The plan should reflect:
- Structured concise enough to be scannable and detailed enough for effective execution
- Step-by-step implementation with explicit dependencies — mark which steps can run in parallel vs. which block on prior steps
- For plans with many steps, group into named phases that are each independently verifiable
- Verification steps for validating the implementation, both automated and manual
- Critical architecture to reuse or use as reference — reference specific functions, types, or patterns, not just file names
- Critical files to be modified (with full paths)
- Explicit scope boundaries — what's included and what's deliberately excluded
- Document any assumptions made due to unattended mode
- Leave no ambiguity

Save the comprehensive plan document to \`/memories/session/plan.md\` via memory, then show the scannable plan to the user for the record.

## 3. Handoff

After saving the plan to \`/memories/session/plan.md\`, immediately call the startImplementation tool to transition to Agent mode for implementation. Do NOT use runSubagent for this — call the tool directly. Do NOT wait for user approval.
</workflow>

<plan_style_guide>
\`\`\`markdown
## Plan: {Title (2-10 words)}

{TL;DR - what, why, and how (your recommended approach).}

**Steps**
1. {Implementation step-by-step — note dependency ("*depends on N*") or parallelism ("*parallel with step N*") when applicable}
2. {For plans with 5+ steps, group steps into named phases with enough detail to be independently actionable}

**Relevant files**
- \`{full/path/to/file}\` — {what to modify or reuse, referencing specific functions/patterns}

**Verification**
1. {Verification steps for validating the implementation (**Specific** tasks, tests, commands, MCP tools, etc; not generic statements)}

**Decisions & Assumptions**
- {Decision, assumptions made in unattended mode, and included/excluded scope}
\`\`\`

Rules:
- NO code blocks — describe changes, link to files and specific symbols/functions
- The plan MUST be presented in the response before handoff.
</plan_style_guide>`;
	}

	private buildCustomizedConfig(): AgentConfig {
		const additionalTools = this.configurationService.getConfig(ConfigKey.PlanAgentAdditionalTools);
		const coreDefaultModel = this.configurationService.getNonExtensionConfig<string>('chat.planAgent.defaultModel');
		const modelOverride = coreDefaultModel || this.configurationService.getConfig(ConfigKey.Deprecated.PlanAgentModel);
		const autoHandoff = this.configurationService.getConfig(ConfigKey.PlanAgentAutoHandoff);

		const implementAgentModelOverride = this.configurationService.getConfig(ConfigKey.ImplementAgentModel);

		this.logService.info(
			`[PlanAgentProvider] buildCustomizedConfig: autoHandoff=${autoHandoff}, ` +
			`modelOverride=${modelOverride ?? '(none)'}, ` +
			`implementAgentModel=${implementAgentModelOverride ?? '(none)'}, ` +
			`additionalTools=[${additionalTools.join(', ')}]`
		);

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

		// Always include startImplementation in the tools list to avoid a timing race:
		// VS Code core calls provideCustomAgents() before eval harness settings are applied,
		// locking the session's tool list without startImplementation. By always including it,
		// the tool is available from the first provideCustomAgents call. The body text controls
		// whether the model actually calls it (auto-handoff body instructs it; interactive doesn't).
		toolsToAdd.push('vscode/startImplementation');

		if (!autoHandoff) {
			// In interactive mode, also include askQuestions (no user to answer in auto-handoff)
			toolsToAdd.push('vscode/askQuestions');
		}

		// Merge additional tools (deduplicated)
		const tools = toolsToAdd.length > 0
			? [...new Set([...BASE_PLAN_AGENT_CONFIG.tools, ...toolsToAdd])]
			: [...BASE_PLAN_AGENT_CONFIG.tools];

		// Start with base config
		const handoffs = [startImplementationHandoff, openInEditorHandoff, ...(BASE_PLAN_AGENT_CONFIG.handoffs ?? [])];
		const finalConfig = {
			...BASE_PLAN_AGENT_CONFIG,
			tools,
			handoffs,
			body: PlanAgentProvider.buildAgentBody(autoHandoff),
			...(modelOverride ? { model: modelOverride } : {}),
		};

		this.logService.info(
			`[PlanAgentProvider] buildCustomizedConfig: final tools=[${tools.join(', ')}], ` +
			`handoffs=[${handoffs.map(h => `${h.label}→${h.agent}`).join(', ')}], ` +
			`hasStartImplementationTool=${tools.includes('vscode/startImplementation')}, ` +
			`model=${finalConfig.model ?? '(default)'}`
		);

		return finalConfig;
	}
}
