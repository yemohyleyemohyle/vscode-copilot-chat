/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import * as l10n from '@vscode/l10n';
import { Raw, RenderPromptResult } from '@vscode/prompt-tsx';
import { BudgetExceededError } from '@vscode/prompt-tsx/dist/base/materialized';
import type * as vscode from 'vscode';
import { ChatLocation, ChatResponse } from '../../../platform/chat/common/commonTypes';
import { ConfigKey, IConfigurationService } from '../../../platform/configuration/common/configurationService';
import { modelMightUseReplaceStringExclusively, modelSupportsApplyPatch, modelSupportsReplaceString } from '../../../platform/endpoint/common/chatModelCapabilities';
import { IEndpointProvider } from '../../../platform/endpoint/common/endpointProvider';
import { CacheType } from '../../../platform/endpoint/common/endpointTypes';
import { IEnvService } from '../../../platform/env/common/envService';
import { ILogService } from '../../../platform/log/common/logService';
import { IEditLogService } from '../../../platform/multiFileEdit/common/editLogService';
import { IChatEndpoint } from '../../../platform/networking/common/networking';
import { INotebookService } from '../../../platform/notebook/common/notebookService';
import { IPromptPathRepresentationService } from '../../../platform/prompts/common/promptPathRepresentationService';
import { ITasksService } from '../../../platform/tasks/common/tasksService';
import { IExperimentationService } from '../../../platform/telemetry/common/nullExperimentationService';
import { ITelemetryService } from '../../../platform/telemetry/common/telemetry';
import { ITestProvider } from '../../../platform/testing/common/testProvider';
import { IWorkspaceService } from '../../../platform/workspace/common/workspaceService';
import { CancellationToken } from '../../../util/vs/base/common/cancellation';
import { Event } from '../../../util/vs/base/common/event';
import { IInstantiationService } from '../../../util/vs/platform/instantiation/common/instantiation';
import { ICommandService } from '../../commands/node/commandService';
import { Intent } from '../../common/constants';
import { ChatVariablesCollection } from '../../prompt/common/chatVariablesCollection';
import { Conversation, RenderedUserMessageMetadata } from '../../prompt/common/conversation';
import { IBuildPromptContext } from '../../prompt/common/intents';
import { ChatTelemetryBuilder } from '../../prompt/node/chatParticipantTelemetry';
import { IDefaultIntentRequestHandlerOptions } from '../../prompt/node/defaultIntentRequestHandler';
import { IDocumentContext } from '../../prompt/node/documentContext';
import { IBuildPromptResult, IIntent, IntentLinkificationOptions } from '../../prompt/node/intents';
import { AgentPrompt, AgentPromptProps } from '../../prompts/node/agent/agentPrompt';
import { PromptRenderer } from '../../prompts/node/base/promptRenderer';
import { ICodeMapperService } from '../../prompts/node/codeMapper/codeMapperService';
import { TemporalContextStats } from '../../prompts/node/inline/temporalContext';
import { EditCodePrompt2 } from '../../prompts/node/panel/editCodePrompt2';
import { ToolResultMetadata } from '../../prompts/node/panel/toolCalling';
import { ToolName } from '../../tools/common/toolNames';
import { IToolsService } from '../../tools/common/toolsService';
import { EditCodeIntent, EditCodeIntentInvocation, EditCodeIntentInvocationOptions, mergeMetadata, toNewChatReferences } from './editCodeIntent';
import { getRequestedToolCallIterationLimit, IContinueOnErrorConfirmation } from './toolCallingLoop';

const getTools = (instaService: IInstantiationService, request: vscode.ChatRequest) =>
	instaService.invokeFunction(async accessor => {
		const toolsService = accessor.get<IToolsService>(IToolsService);
		const testService = accessor.get<ITestProvider>(ITestProvider);
		const tasksService = accessor.get<ITasksService>(ITasksService);
		const configurationService = accessor.get<IConfigurationService>(IConfigurationService);
		const experimentationService = accessor.get<IExperimentationService>(IExperimentationService);
		const endpointProvider = accessor.get<IEndpointProvider>(IEndpointProvider);
		const model = await endpointProvider.getChatEndpoint(request);

		// Claude: replace_string AND insert_edits
		// 4.1/o4-mini: apply_patch AND insert_edits
		const allowTools: Record<string, boolean> = {};
		const applyPatchConfigEnabled = configurationService.getExperimentBasedConfig<boolean>(ConfigKey.Internal.EnableApplyPatchTool, experimentationService); // (can't use extension exp config in package.json "when" clause)
		const useApplyPatch = !!(modelSupportsApplyPatch(model) && applyPatchConfigEnabled && toolsService.getTool(ToolName.ApplyPatch));
		allowTools[ToolName.EditFile] = true;
		allowTools[ToolName.ReplaceString] = modelSupportsReplaceString(model) || !!(model.family.includes('gemini') && experimentationService.getTreatmentVariable<boolean>('vscode', 'copilotchat.geminiReplaceString'));
		allowTools[ToolName.ApplyPatch] = useApplyPatch;

		if (modelMightUseReplaceStringExclusively(model) && experimentationService.getTreatmentVariable<boolean>('vscode', 'copilotchat.claudeReplaceStringExclusively')) {
			allowTools[ToolName.ReplaceString] = true;
			allowTools[ToolName.EditFile] = false;
		}

		allowTools[ToolName.RunTests] = await testService.hasAnyTests();
		allowTools[ToolName.RunTask] = !!(configurationService.getConfig(ConfigKey.AgentCanRunTasks) && tasksService.getTasks().length);

		return toolsService.getEnabledTools(request, tool => {
			if (typeof allowTools[tool.name] === 'boolean') {
				return allowTools[tool.name];
			}

			// Must return undefined to fall back to other checks
			return undefined;
		});
	});

export class AgentIntent extends EditCodeIntent {

	static override readonly ID = Intent.Agent;

	override readonly id = AgentIntent.ID;

	constructor(
		@IInstantiationService instantiationService: IInstantiationService,
		@IEndpointProvider endpointProvider: IEndpointProvider,
		@IConfigurationService configurationService: IConfigurationService,
		@IExperimentationService expService: IExperimentationService,
		@ICodeMapperService codeMapperService: ICodeMapperService,
		@IWorkspaceService workspaceService: IWorkspaceService,
	) {
		super(instantiationService, endpointProvider, configurationService, expService, codeMapperService, workspaceService, { intentInvocation: AgentIntentInvocation, processCodeblocks: false });
	}

	override async handleRequest(conversation: Conversation, request: vscode.ChatRequest, stream: vscode.ChatResponseStream, token: CancellationToken, documentContext: IDocumentContext | undefined, agentName: string, location: ChatLocation, chatTelemetry: ChatTelemetryBuilder, onPaused: Event<boolean>): Promise<vscode.ChatResult> {
		if (request.command === 'list') {
			const editingTools = await getTools(this.instantiationService, request);
			stream.markdown(`Available tools: \n${editingTools.map(tool => `- ${tool.name}`).join('\n')}\n`);
			return {};
		}

		return super.handleRequest(conversation, request, stream, token, documentContext, agentName, location, chatTelemetry, onPaused);
	}

	protected override getIntentHandlerOptions(request: vscode.ChatRequest): IDefaultIntentRequestHandlerOptions | undefined {
		return {
			maxToolCallIterations: getRequestedToolCallIterationLimit(request) ??
				this.configurationService.getNonExtensionConfig('chat.agent.maxRequests') ??
				200, // Fallback for simulation tests
			temperature: this.configurationService.getConfig(ConfigKey.Internal.AgentTemperature) ?? 0,
			overrideRequestLocation: ChatLocation.Agent,
			hideRateLimitTimeEstimate: true
		};
	}
}

export class AgentIntentInvocation extends EditCodeIntentInvocation {

	public override get linkification(): IntentLinkificationOptions {
		// on by default:
		const enabled = this.configurationService.getConfig(ConfigKey.Internal.EditLinkification) !== false;
		return { disable: !enabled };
	}

	public override readonly codeblocksRepresentEdits = false;

	protected prompt: typeof AgentPrompt | typeof EditCodePrompt2 = AgentPrompt;

	protected extraPromptProps: Partial<AgentPromptProps> | undefined;

	constructor(
		intent: IIntent,
		location: ChatLocation,
		endpoint: IChatEndpoint,
		request: vscode.ChatRequest,
		intentOptions: EditCodeIntentInvocationOptions,
		@IInstantiationService instantiationService: IInstantiationService,
		@ICodeMapperService codeMapperService: ICodeMapperService,
		@IEnvService envService: IEnvService,
		@IPromptPathRepresentationService promptPathRepresentationService: IPromptPathRepresentationService,
		@IEndpointProvider endpointProvider: IEndpointProvider,
		@IWorkspaceService workspaceService: IWorkspaceService,
		@IToolsService toolsService: IToolsService,
		@IConfigurationService configurationService: IConfigurationService,
		@IEditLogService editLogService: IEditLogService,
		@ICommandService commandService: ICommandService,
		@ITelemetryService telemetryService: ITelemetryService,
		@INotebookService notebookService: INotebookService,
		@ILogService private readonly logService: ILogService,
		@IExperimentationService private readonly experimentationService: IExperimentationService,
	) {
		super(intent, location, endpoint, request, intentOptions, instantiationService, codeMapperService, envService, promptPathRepresentationService, endpointProvider, workspaceService, toolsService, configurationService, editLogService, commandService, telemetryService, notebookService);
	}

	public override getAvailableTools(): Promise<vscode.LanguageModelToolInformation[]> {
		return getTools(this.instantiationService, this.request);
	}

	override async buildPrompt(
		promptContext: IBuildPromptContext,
		progress: vscode.Progress<vscode.ChatResponseReferencePart | vscode.ChatResponseProgressPart>,
		token: vscode.CancellationToken
	): Promise<IBuildPromptResult> {
		// Add any references from the codebase invocation to the request
		const codebase = await this._getCodebaseReferences(promptContext, token);

		let variables = promptContext.chatVariables;
		let toolReferences: vscode.ChatPromptReference[] = [];
		if (codebase) {
			toolReferences = toNewChatReferences(variables, codebase.references);
			variables = new ChatVariablesCollection([...this.request.references, ...toolReferences]);
		}

		const tools = await this.getAvailableTools();
		const toolTokens = tools?.length ? await this.endpoint.acquireTokenizer().countToolTokens(tools) : 0;

		// Reserve extra space when tools are involved due to token counting issues
		const baseBudget = Math.min(
			this.configurationService.getConfig<number | undefined>(ConfigKey.Internal.SummarizeAgentConversationHistoryThreshold) ?? this.endpoint.modelMaxPromptTokens,
			this.endpoint.modelMaxPromptTokens
		);
		const safeBudget = Math.floor((baseBudget - toolTokens) * 0.85);
		const endpoint = toolTokens > 0 ? this.endpoint.cloneWithTokenOverride(safeBudget) : this.endpoint;
		const summarizationEnabled = this.configurationService.getExperimentBasedConfig(ConfigKey.SummarizeAgentConversationHistory, this.experimentationService) && this.prompt === AgentPrompt;
		this.logService.logger.debug(`AgentIntent: rendering with budget=${safeBudget} (baseBudget: ${baseBudget}, toolTokens: ${toolTokens}), summarizationEnabled=${summarizationEnabled}`);
		let result: RenderPromptResult;
		const props: AgentPromptProps = {
			endpoint,
			promptContext: {
				...promptContext,
				tools: promptContext.tools && {
					...promptContext.tools,
					toolReferences: this.stableToolReferences.filter((r) => r.name !== ToolName.Codebase),
				}
			},
			location: this.location,
			enableCacheBreakpoints: summarizationEnabled,
			...this.extraPromptProps
		};
		try {
			const renderer = PromptRenderer.create(this.instantiationService, endpoint, this.prompt, props);
			result = await renderer.render(progress, token);
		} catch (e) {
			if (e instanceof BudgetExceededError && summarizationEnabled) {
				this.logService.logger.debug(`[Agent] budget exceeded, triggering summarization (${e.message})`);
				if (!promptContext.toolCallResults) {
					promptContext = {
						...promptContext,
						toolCallResults: {}
					};
				}
				e.metadata.getAll(ToolResultMetadata).forEach((metadata) => {
					promptContext.toolCallResults![metadata.toolCallId] = metadata.result;
				});
				try {
					const renderer = PromptRenderer.create(this.instantiationService, endpoint, this.prompt, {
						...props,
						triggerSummarize: true,
					});
					result = await renderer.render(progress, token);
				} catch (e) {
					this.logService.logger.error(e, `[Agent] summarization failed`);
					const errorKind = e instanceof BudgetExceededError ? 'budgetExceeded' : 'error';
					/* __GDPR__
						"triggerSummarizeFailed" : {
							"owner": "roblourens",
							"comment": "Tracks when triggering summarization failed - for example, a summary was created but not applied successfully.",
							"errorKind": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "The success state or failure reason of the summarization." },
							"model": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "The model ID used for the summarization." }
						}
					*/
					this.telemetryService.sendMSFTTelemetryEvent('triggerSummarizeFailed', { errorKind, model: props.endpoint.model });

					// Something else went wrong, eg summarization failed, so render the prompt with no cache breakpoints or summarization
					const renderer = PromptRenderer.create(this.instantiationService, endpoint, this.prompt, {
						...props,
						enableCacheBreakpoints: false
					});
					result = await renderer.render(progress, token);
				}
			} else {
				throw e;
			}
		}

		const lastMessage = result.messages.at(-1);
		if (lastMessage?.role === Raw.ChatRole.User) {
			const currentTurn = promptContext.conversation?.getLatestTurn();
			if (currentTurn && !currentTurn.getMetadata(RenderedUserMessageMetadata)) {
				currentTurn.setMetadata(new RenderedUserMessageMetadata(lastMessage.content));
			}
		}

		addCacheBreakpoints(result.messages);

		if (this.request.command === 'error') {
			// Should trigger a 400
			result.messages.push({
				role: Raw.ChatRole.Assistant,
				content: [],
				toolCalls: [{ type: 'function', id: '', function: { name: 'tool', arguments: '{' } }]
			});
		}

		const tempoStats = result.metadata.get(TemporalContextStats);

		return {
			...result,
			// The codebase tool is not actually called/referenced in the edit prompt, so we ned to
			// merge its metadata so that its output is not lost and it's not called repeatedly every turn
			// todo@connor4312/joycerhl: this seems a bit janky
			metadata: codebase ? mergeMetadata(result.metadata, codebase.metadatas) : result.metadata,
			// Don't report file references that came in via chat variables in an editing session, unless they have warnings,
			// because they are already displayed as part of the working set
			// references: result.references.filter((ref) => this.shouldKeepReference(editCodeStep, ref, toolReferences, chatVariables)),
			telemetryData: tempoStats && [tempoStats]
		};
	}

	modifyErrorDetails(errorDetails: vscode.ChatErrorDetails, response: ChatResponse): vscode.ChatErrorDetails {
		errorDetails.confirmationButtons = [
			{ data: { copilotContinueOnError: true } satisfies IContinueOnErrorConfirmation, label: l10n.t('Try Again') },
		];
		return errorDetails;
	}

	override processResponse = undefined;
}

const MaxCacheBreakpoints = 4;

/**
 * Prompt cache breakpoint strategy:
 *
 * The prompt is structured like
 * - System message
 * - Custom instructions
 * - Global context message (has prompt-tsx cache breakpoint)
 * - History
 * - Current user message with extra context
 * - Current tool call rounds
 *
 * Below the current user message, we add cache breakpoints to the last tool result in each round.
 * We add one to the current user message.
 * And above the current user message, we add breakpoionts to an assistant message with no tool calls (so the terminal response in a turn).
 *
 * There will always be a cache miss when a new turn starts because the previous messages move from below the current user message with extra context to above it.
 * For turns with no tool calling, we will have a hit on the previous assistant message in history.
 * During the agentic loop, each request will have a hit on the previous tool result message.
 */
export function addCacheBreakpoints(messages: Raw.ChatMessage[]) {
	// One or two cache breakpoints are already added via the prompt, assign the rest here.
	let count = MaxCacheBreakpoints - countCacheBreakpoints(messages);
	let isBelowCurrentUserMessage = true;
	const reversedMsgs = [...messages].reverse();
	for (const [idx, msg] of reversedMsgs.entries()) {
		const prevMsg = reversedMsgs.at(idx - 1);
		const hasCacheBreakpoint = msg.content.some(part => part.type === Raw.ChatCompletionContentPartKind.CacheBreakpoint);
		if (hasCacheBreakpoint) {
			continue;
		}

		const isLastToolResultInRound = msg.role === Raw.ChatRole.Tool && prevMsg?.role !== Raw.ChatRole.Tool;
		const isAsstMsgWithNoTools = msg.role === Raw.ChatRole.Assistant && !msg.toolCalls?.length;
		if (isBelowCurrentUserMessage && (isLastToolResultInRound || msg.role === Raw.ChatRole.User) || isAsstMsgWithNoTools) {
			count--;
			msg.content.push({
				type: Raw.ChatCompletionContentPartKind.CacheBreakpoint,
				cacheType: CacheType
			});

			if (count <= 0) {
				break;
			}
		}

		if (msg.role === Raw.ChatRole.User &&
			!msg.content.some(part =>
				part.type === Raw.ChatCompletionContentPartKind.Text &&
				part.text.includes('reminder')
			)) {
			isBelowCurrentUserMessage = false;
		}
	}

	// If we still have cache breakpoints to allocate, add them from the system and custom instructions messages, if applicable.
	for (const msg of messages) {
		if (count <= 0) {
			break;
		}

		const hasCacheBreakpoint = msg.content.some(part => part.type === Raw.ChatCompletionContentPartKind.CacheBreakpoint);
		if ((msg.role === Raw.ChatRole.User || msg.role === Raw.ChatRole.System) && !hasCacheBreakpoint) {
			count--;
			msg.content.push({
				type: Raw.ChatCompletionContentPartKind.CacheBreakpoint,
				cacheType: CacheType
			});
		}

		if (msg.role !== Raw.ChatRole.User && msg.role !== Raw.ChatRole.System) {
			break;
		}
	}
}

function countCacheBreakpoints(messages: Raw.ChatMessage[]) {
	let count = 0;
	for (const msg of messages) {
		count += msg.content.filter(part => part.type === Raw.ChatCompletionContentPartKind.CacheBreakpoint).length;
	}
	return count;
}

export const AgentParticipantId = 'github.copilot.editsAgent';
