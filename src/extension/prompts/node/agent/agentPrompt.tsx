/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { BasePromptElementProps, Chunk, Image, PromptElement, PromptPieceChild, PromptSizing, Raw, SystemMessage, TokenLimit, UserMessage } from '@vscode/prompt-tsx';
import { isDefined } from '@vscode/test-electron/out/util';
import type { ChatRequestEditedFileEvent, LanguageModelToolInformation, NotebookEditor, TaskDefinition, TextEditor } from 'vscode';
import { ChatLocation } from '../../../../platform/chat/common/commonTypes';
import { ConfigKey, IConfigurationService } from '../../../../platform/configuration/common/configurationService';
import { CacheType } from '../../../../platform/endpoint/common/endpointTypes';
import { IEnvService, OperatingSystem } from '../../../../platform/env/common/envService';
import { getGitHubRepoInfoFromContext, IGitService } from '../../../../platform/git/common/gitService';
import { ILogService } from '../../../../platform/log/common/logService';
import { IChatEndpoint } from '../../../../platform/networking/common/networking';
import { IAlternativeNotebookContentService } from '../../../../platform/notebook/common/alternativeContent';
import { IPromptPathRepresentationService } from '../../../../platform/prompts/common/promptPathRepresentationService';
import { ITabsAndEditorsService } from '../../../../platform/tabs/common/tabsAndEditorsService';
import { ITasksService } from '../../../../platform/tasks/common/tasksService';
import { IWorkspaceService } from '../../../../platform/workspace/common/workspaceService';
import { coalesce } from '../../../../util/vs/base/common/arrays';
import { basename } from '../../../../util/vs/base/common/path';
import { IInstantiationService } from '../../../../util/vs/platform/instantiation/common/instantiation';
import { ChatRequestEditedFileEventKind } from '../../../../vscodeTypes';
import { GenericBasePromptElementProps } from '../../../context/node/resolvers/genericPanelIntentInvocation';
import { GitHubPullRequestProviders } from '../../../conversation/node/githubPullRequestProviders';
import { ChatVariablesCollection } from '../../../prompt/common/chatVariablesCollection';
import { GlobalContextMessageMetadata, RenderedUserMessageMetadata, Turn } from '../../../prompt/common/conversation';
import { InternalToolReference } from '../../../prompt/common/intents';
import { IPromptVariablesService } from '../../../prompt/node/promptVariablesService';
import { ToolName } from '../../../tools/common/toolNames';
import { CopilotIdentityRules } from '../base/copilotIdentity';
import { IPromptEndpoint, renderPromptElement } from '../base/promptRenderer';
import { SafetyRules } from '../base/safetyRules';
import { Tag } from '../base/tag';
import { TerminalAndTaskStatePromptElement } from '../base/terminalAndTaskState';
import { ChatVariables } from '../panel/chatVariables';
import { EXISTING_CODE_MARKER } from '../panel/codeBlockFormattingRules';
import { CustomInstructions } from '../panel/customInstructions';
import { NotebookFormat, NotebookReminderInstructions } from '../panel/notebookEditCodePrompt';
import { NotebookSummaryChange } from '../panel/notebookSummaryChangePrompt';
import { UserPreferences } from '../panel/preferences';
import { TerminalCwdPrompt } from '../panel/terminalPrompt';
import { ChatToolCalls } from '../panel/toolCalling';
import { MultirootWorkspaceStructure } from '../panel/workspace/workspaceStructure';
import { AgentConversationHistory } from './agentConversationHistory';
import { DefaultAgentPrompt, SweBenchAgentPrompt } from './agentInstructions';
import { SummarizedConversationHistory } from './summarizedConversationHistory';

export interface AgentPromptProps extends GenericBasePromptElementProps {
	readonly endpoint: IChatEndpoint;
	readonly location: ChatLocation;

	readonly triggerSummarize?: boolean;

	/**
	 * Enables cache breakpoints and summarization
	 */
	readonly enableCacheBreakpoints?: boolean;

	/**
	 * Codesearch mode, aka agentic Ask mode
	 */
	readonly codesearchMode?: boolean;
}

/** Proportion of the prompt token budget any singular textual tool result is allowed to use. */
const MAX_TOOL_RESPONSE_PCT = 0.5;

/**
 * The agent mode prompt, rendered on each request
 */
export class AgentPrompt extends PromptElement<AgentPromptProps> {
	constructor(
		props: AgentPromptProps,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IPromptEndpoint private readonly promptEndpoint: IPromptEndpoint,
	) {
		super(props);
	}
	private bernoulliTrial(p: number = 0.0): boolean {
		return Math.random() < p;
	}

	async render(state: void, sizing: PromptSizing) {
		const instructions = this.configurationService.getConfig(ConfigKey.Internal.SweBenchAgentPrompt) ?
			<SweBenchAgentPrompt availableTools={this.props.promptContext.tools?.availableTools} modelFamily={this.props.endpoint.family} codesearchMode={undefined} /> :
			<DefaultAgentPrompt
				availableTools={this.props.promptContext.tools?.availableTools}
				modelFamily={this.props.endpoint.family}
				codesearchMode={this.props.codesearchMode}
			/>;

		const baseInstructions = <>
			<SystemMessage>
				You are an expert AI programming assistant, working with a user in the VS Code editor.<br />
				<CopilotIdentityRules />
				<SafetyRules />
			</SystemMessage>
			{instructions}
			<UserMessage>
				<CustomInstructions languageId={undefined} chatVariables={this.props.promptContext.chatVariables} />
				{this.props.promptContext.modeInstructions && <Tag name='customInstructions'>
					Below are some additional instructions from the user.<br />
					<br />
					{this.props.promptContext.modeInstructions}
				</Tag>}
			</UserMessage>
			<UserMessage>
				{await this.getOrCreateGlobalAgentContext(this.props.endpoint)}
			</UserMessage>
		</>;

		const maxToolResultLength = Math.floor(this.promptEndpoint.modelMaxPromptTokens * MAX_TOOL_RESPONSE_PCT);

		if (this.props.enableCacheBreakpoints) {
			return <>
				{baseInstructions}
				<SummarizedConversationHistory
					flexGrow={1}
					triggerSummarize={this.props.triggerSummarize}
					priority={900}
					promptContext={this.props.promptContext}
					location={this.props.location}
					maxToolResultLength={maxToolResultLength}
					endpoint={this.props.endpoint}
					tools={this.props.promptContext.tools?.availableTools}
					enableCacheBreakpoints={this.props.enableCacheBreakpoints}
				/>
				{this.bernoulliTrial() && this.props.endpoint.family?.includes('claude-sonnet-4') && (
					<UserMessage priority={-1}>
						<Tag name='reminder'>Before you continue, stop and think on the information you are provided in the tool reports.\nIs it misleading? Is it confusing? Can it be improved? Can it be made more focussed? more precise?.\nProvide your feedback calling report_tool_issue in parallel along with other tools meant to solve the user issue.\nDo not praise the tools, only report issues or possibilities of improvement.\nThis information is very important for tool development.</Tag>
					</UserMessage>
				)}
			</>;
		} else {
			return <>
				{baseInstructions}
				<AgentConversationHistory flexGrow={1} priority={700} promptContext={this.props.promptContext} />
				<AgentUserMessage flexGrow={2} priority={900} {...getUserMessagePropsFromAgentProps(this.props)} />
				<ChatToolCalls priority={899} flexGrow={2} promptContext={this.props.promptContext} toolCallRounds={this.props.promptContext.toolCallRounds} toolCallResults={this.props.promptContext.toolCallResults} truncateAt={maxToolResultLength} enableCacheBreakpoints={false} />
				{this.bernoulliTrial() && this.props.endpoint.family?.includes('claude-sonnet-4') && (
					<UserMessage priority={-1}>
						<Tag name='reminder'>Before you continue, stop and think on the information you are provided in the tool reports.\nIs it misleading? Is it confusing? Can it be improved? Can it be made more focussed? more precise?.\nProvide your feedback calling report_tool_issue in parallel along with other tools meant to solve the user issue.\nDo not praise the tools, only report issues or possibilities of improvement.\nThis information is very important for tool development.</Tag>
					</UserMessage>
				)}
			</>;
		}
	}

	private async getOrCreateGlobalAgentContext(endpoint: IChatEndpoint): Promise<PromptPieceChild[]> {
		const globalContext = await this.getOrCreateGlobalAgentContextContent(endpoint);
		return globalContext ?
			renderedMessageToTsxChildren(globalContext, !!this.props.enableCacheBreakpoints) :
			<GlobalAgentContext enableCacheBreakpoints={!!this.props.enableCacheBreakpoints} />;
	}

	private async getOrCreateGlobalAgentContextContent(endpoint: IChatEndpoint): Promise<Raw.ChatCompletionContentPart[] | undefined> {
		const firstTurn = this.props.promptContext.conversation?.turns.at(0);
		if (firstTurn) {
			const metadata = firstTurn.getMetadata(GlobalContextMessageMetadata);
			if (metadata) {
				return metadata.renderedGlobalContext;
			}
		}

		const rendered = await renderPromptElement(this.instantiationService, endpoint, GlobalAgentContext, { enableCacheBreakpoints: this.props.enableCacheBreakpoints }, undefined, undefined);
		const msg = rendered.messages.at(0)?.content;
		if (msg) {
			firstTurn?.setMetadata(new GlobalContextMessageMetadata(msg));
			return msg;
		}
	}
}

interface GlobalAgentContextProps extends BasePromptElementProps {
	readonly enableCacheBreakpoints?: boolean;
}

/**
 * The "global agent context" is a static prompt at the start of a conversation containing user environment info, initial workspace structure, anything else that is a useful beginning
 * hint for the agent but is not updated during the conversation.
 */
class GlobalAgentContext extends PromptElement<GlobalAgentContextProps> {
	render() {
		return <UserMessage>
			<Tag name='environment_info'>
				<UserOSPrompt />
				<UserShellPrompt />
			</Tag>
			<Tag name='workspace_info'>
				<AgentTasksInstructions />
				<WorkspaceFoldersHint />
				<MultirootWorkspaceStructure maxSize={2000} excludeDotFiles={true} /><br />
				This is the state of the context at this point in the conversation. The view of the workspace structure may be truncated. You can use tools to collect more context if needed.
			</Tag>
			<UserPreferences flexGrow={7} priority={800} />
			{this.props.enableCacheBreakpoints && <cacheBreakpoint type={CacheType} />}
		</UserMessage>;
	}
}

export interface AgentUserMessageProps extends BasePromptElementProps {
	readonly turn?: Turn;
	readonly isHistorical?: boolean;
	readonly request: string;
	readonly endpoint: IChatEndpoint;
	readonly toolReferences: readonly InternalToolReference[];
	readonly availableTools?: readonly LanguageModelToolInformation[];
	readonly chatVariables: ChatVariablesCollection;
	readonly enableCacheBreakpoints?: boolean;
	readonly editedFileEvents?: readonly ChatRequestEditedFileEvent[];
	readonly sessionId?: string;
}

export function getUserMessagePropsFromTurn(turn: Turn, endpoint: IChatEndpoint): AgentUserMessageProps {
	return {
		isHistorical: true,
		request: turn.request.message,
		turn,
		endpoint,
		toolReferences: turn.toolReferences,
		chatVariables: turn.promptVariables ?? new ChatVariablesCollection(),
		editedFileEvents: turn.editedFileEvents,
		enableCacheBreakpoints: false // Should only be added to the current turn - some user messages may get them in Agent post-processing
	};
}

export function getUserMessagePropsFromAgentProps(agentProps: AgentPromptProps): AgentUserMessageProps {
	return {
		request: agentProps.promptContext.query,
		// Will pull frozenContent off the Turn if available
		turn: agentProps.promptContext.conversation?.getLatestTurn(),
		endpoint: agentProps.endpoint,
		toolReferences: agentProps.promptContext.tools?.toolReferences ?? [],
		availableTools: agentProps.promptContext.tools?.availableTools,
		chatVariables: agentProps.promptContext.chatVariables,
		enableCacheBreakpoints: agentProps.enableCacheBreakpoints,
		editedFileEvents: agentProps.promptContext.editedFileEvents,
		// TODO:@roblourens
		sessionId: (agentProps.promptContext.tools?.toolInvocationToken as any)?.sessionId,

	};
}

/**
 * Is sent with each user message. Includes the user message and also any ambient context that we want to update with each request.
 * Uses frozen content if available, for prompt caching and to avoid being updated by any agent action below this point in the conversation.
 */
export class AgentUserMessage extends PromptElement<AgentUserMessageProps> {
	constructor(
		props: AgentUserMessageProps,
		@IPromptVariablesService private readonly promptVariablesService: IPromptVariablesService,
		@ILogService private readonly logService: ILogService,
	) {
		super(props);
	}

	async render(state: void, sizing: PromptSizing) {
		const frozenContent = this.props.turn?.getMetadata(RenderedUserMessageMetadata)?.renderedUserMessage;
		if (frozenContent) {
			return <FrozenContentUserMessage frozenContent={frozenContent} enableCacheBreakpoints={this.props.enableCacheBreakpoints} />;
		}

		if (this.props.isHistorical) {
			this.logService.logger.trace('Re-rendering historical user message');
		}

		const query = await this.promptVariablesService.resolveToolReferencesInPrompt(this.props.request, this.props.toolReferences ?? []);
		const hasReplaceStringTool = !!this.props.availableTools?.find(tool => tool.name === ToolName.ReplaceString);
		const hasApplyPatchTool = !!this.props.availableTools?.find(tool => tool.name === ToolName.ApplyPatch);
		const hasCreateFileTool = !!this.props.availableTools?.find(tool => tool.name === ToolName.CreateFile);
		const hasEditFileTool = !!this.props.availableTools?.find(tool => tool.name === ToolName.EditFile);
		const hasEditNotebookTool = !!this.props.availableTools?.find(tool => tool.name === ToolName.EditNotebook);
		const hasTerminalTool = !!this.props.availableTools?.find(tool => tool.name === ToolName.RunInTerminal);
		const attachmentHint = (this.props.endpoint.family === 'gpt-4.1') && this.props.chatVariables.hasVariables() ?
			' (See <attachments> above for file contents. You may not need to search or read the file again.)'
			: '';
		const hasToolsToEditNotebook = hasCreateFileTool || hasEditNotebookTool || hasReplaceStringTool || hasApplyPatchTool || hasEditFileTool;
		return (
			<>
				<UserMessage>
					{hasToolsToEditNotebook && <NotebookFormat flexGrow={5} priority={810} chatVariables={this.props.chatVariables} query={query} />}
					<TokenLimit max={sizing.tokenBudget / 6} flexGrow={3} priority={898}>
						<ChatVariables chatVariables={this.props.chatVariables} isAgent={true} omitReferences />
					</TokenLimit>
					<ToolReferencesHint toolReferences={this.props.toolReferences} />
					<Tag name='context'>
						<CurrentDatePrompt />
						<EditedFileEvents editedFileEvents={this.props.editedFileEvents} />
						<NotebookSummaryChange />
						{hasTerminalTool && <TerminalCwdPrompt sessionId={this.props.sessionId} />}
						{hasTerminalTool && <TerminalAndTaskStatePromptElement sessionId={this.props.sessionId} />}
					</Tag>
					<CurrentEditorContext endpoint={this.props.endpoint} />
					<RepoContext />
					<Tag name='reminderInstructions'>
						{/* Critical reminders that are effective when repeated right next to the user message */}
						{getKeepGoingReminder(this.props.endpoint.family)}
						{getEditingReminder(hasEditFileTool, hasReplaceStringTool)}
						<NotebookReminderInstructions chatVariables={this.props.chatVariables} query={this.props.request} />
					</Tag>
					{query && <Tag name='userRequest' priority={900} flexGrow={7}>{query + attachmentHint}</Tag>}
					{this.props.enableCacheBreakpoints && <cacheBreakpoint type={CacheType} />}
				</UserMessage>
			</>
		);
	}
}

export interface FrozenMessageContentProps extends BasePromptElementProps {
	readonly frozenContent: Raw.ChatCompletionContentPart[];
	readonly enableCacheBreakpoints?: boolean;
}

export class FrozenContentUserMessage extends PromptElement<FrozenMessageContentProps> {
	async render(state: void, sizing: PromptSizing) {
		return <UserMessage priority={this.props.priority}>
			<Chunk>
				{/* Have to move <cacheBreakpoint> out of the Chunk */}
				{renderedMessageToTsxChildren(this.props.frozenContent, false)}
			</Chunk>
			{this.props.enableCacheBreakpoints && <cacheBreakpoint type={CacheType} />}
		</UserMessage>;
	}
}

interface ToolReferencesHintProps extends BasePromptElementProps {
	readonly toolReferences: readonly InternalToolReference[];
}

/**
 * `#` tool references included in the request are a strong hint to the model that the tool is relevant, but we don't force a tool call.
 */
class ToolReferencesHint extends PromptElement<ToolReferencesHintProps> {
	render() {
		if (!this.props.toolReferences.length) {
			return;
		}

		return <>
			<Tag name='toolReferences'>
				The user attached the following tools to this message. The userRequest may refer to them using the tool name with "#". These tools are likely relevant to the user's query:<br />
				{this.props.toolReferences.map(tool => `- ${tool.name}`).join('\n')}
			</Tag>
		</>;
	}
}

export function renderedMessageToTsxChildren(message: string | Raw.ChatCompletionContentPart[], enableCacheBreakpoints: boolean): PromptPieceChild[] {
	if (typeof message === 'string') {
		return [message];
	}

	return message.map(part => {
		if (part.type === Raw.ChatCompletionContentPartKind.Text) {
			return part.text;
		} else if (part.type === Raw.ChatCompletionContentPartKind.Image) {
			return <Image src={part.imageUrl.url} detail={part.imageUrl.detail} />;
		} else if (part.type === Raw.ChatCompletionContentPartKind.CacheBreakpoint) {
			return enableCacheBreakpoints && <cacheBreakpoint type={CacheType} />;
		}
	}).filter(isDefined);
}

class UserOSPrompt extends PromptElement<BasePromptElementProps> {
	constructor(props: BasePromptElementProps, @IEnvService private readonly envService: IEnvService) {
		super(props);
	}

	async render(state: void, sizing: PromptSizing) {
		const userOS = this.envService.OS;
		const osForDisplay = userOS === OperatingSystem.Macintosh ? 'macOS' :
			userOS;
		return <>The user's current OS is: {osForDisplay}</>;
	}
}

class UserShellPrompt extends PromptElement<BasePromptElementProps> {
	constructor(props: BasePromptElementProps, @IEnvService private readonly envService: IEnvService) {
		super(props);
	}

	async render(state: void, sizing: PromptSizing) {
		const shellName = basename(this.envService.shell);
		const shellNameHint = shellName === 'powershell.exe' ? ' (Windows PowerShell v5.1)' : '';
		let additionalHint = '';
		if (shellName === 'powershell.exe') {
			additionalHint = ' Use the `;` character if joining commands on a single line is needed.';
		}
		return <>The user's default shell is: "{shellName}"{shellNameHint}. When you generate terminal commands, please generate them correctly for this shell.{additionalHint}</>;
	}
}

class CurrentDatePrompt extends PromptElement<BasePromptElementProps> {
	constructor(
		props: BasePromptElementProps,
		@IEnvService private readonly envService: IEnvService) {
		super(props);
	}

	async render(state: void, sizing: PromptSizing) {
		const dateStr = new Date().toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
		// Only include current date when not running simulations, since if we generate cache entries with the current date, the cache will be invalidated every day
		return (
			!this.envService.isSimulation() && <>The current date is {dateStr}.</>
		);
	}
}

interface CurrentEditorContextProps extends BasePromptElementProps {
	endpoint: IChatEndpoint;
}

/**
 * Include the user's open editor and cursor position, but not content. This is independent of the "implicit context" attachment.
 */
class CurrentEditorContext extends PromptElement<CurrentEditorContextProps> {
	constructor(
		props: CurrentEditorContextProps,
		@ITabsAndEditorsService private readonly tabsAndEditorsService: ITabsAndEditorsService,
		@IPromptPathRepresentationService private readonly promptPathRepresentationService: IPromptPathRepresentationService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IAlternativeNotebookContentService private readonly alternativeNotebookContent: IAlternativeNotebookContentService,
	) {
		super(props);
	}

	async render(state: void, sizing: PromptSizing) {
		if (!this.configurationService.getConfig(ConfigKey.CurrentEditorAgentContext)) {
			return;
		}

		let context: PromptElement | undefined;
		const activeEditor = this.tabsAndEditorsService.activeTextEditor;
		if (activeEditor) {
			context = this.renderActiveTextEditor(activeEditor);
		}

		const activeNotebookEditor = this.tabsAndEditorsService.activeNotebookEditor;
		if (activeNotebookEditor) {
			context = this.renderActiveNotebookEditor(activeNotebookEditor);
		}

		if (!context) {
			return;
		}

		return <Tag name='editorContext'>
			{context}
		</Tag>;
	}

	private renderActiveTextEditor(activeEditor: TextEditor) {
		// Should this include column numbers too? This confused gpt-4.1 and it read the wrong line numbers, need to find the right format.
		const selection = activeEditor.selection;
		// Found that selection is not always defined, so check for it.
		const selectionText = (selection && !selection.isEmpty) ?
			<>The current selection is from line {selection.start.line + 1} to line {selection.end.line + 1}.</> : undefined;
		return <>The user's current file is {this.promptPathRepresentationService.getFilePath(activeEditor.document.uri)}. {selectionText}</>;
	}

	private renderActiveNotebookEditor(activeNotebookEditor: NotebookEditor) {
		const altDocument = this.alternativeNotebookContent.create(this.alternativeNotebookContent.getFormat(this.props.endpoint)).getAlternativeDocument(activeNotebookEditor.notebook);
		let selectionText = '';
		// Found that selection is not always defined, so check for it.
		if (activeNotebookEditor.selection && !activeNotebookEditor.selection.isEmpty && activeNotebookEditor.notebook.cellCount > 0) {
			// Compute a list of all cells that fall in the range of selection.start and selection.end
			const { start, end } = activeNotebookEditor.selection;
			const cellsInRange = [];
			for (let i = start; i < end; i++) {
				const cell = activeNotebookEditor.notebook.cellAt(i);
				if (cell) {
					cellsInRange.push(cell);
				}
			}
			const startCell = cellsInRange[0];
			const endCell = cellsInRange[cellsInRange.length - 1];
			const lastLine = endCell.document.lineAt(endCell.document.lineCount - 1);
			const startPosition = altDocument.fromCellPosition(startCell.index, new Position(0, 0));
			const endPosition = altDocument.fromCellPosition(endCell.index, new Position(endCell.document.lineCount - 1, lastLine.text.length));
			const selection = new Range(startPosition, endPosition);
			selectionText = selection ? ` The current selection is from line ${selection.start.line + 1} to line ${selection.end.line + 1}.` : '';
		}
		return <>The user's current notebook is {this.promptPathRepresentationService.getFilePath(activeNotebookEditor.notebook.uri)}.{selectionText}</>;
	}
}

class RepoContext extends PromptElement<{}> {
	constructor(
		props: {},
		@IGitService private readonly gitService: IGitService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
	) {
		super(props);
	}

	async render(state: void, sizing: PromptSizing) {
		const activeRepository = this.gitService.activeRepository?.get();
		const repoContext = activeRepository && getGitHubRepoInfoFromContext(activeRepository);
		if (!repoContext || !activeRepository) {
			return;
		}
		const prProvider = this.instantiationService.createInstance(GitHubPullRequestProviders);
		const repoDescription = await prProvider.getRepositoryDescription(activeRepository.rootUri);

		return <Tag name='repoContext'>
			Below is the information about the current repository. You can use this information when you need to calculate diffs or compare changes with the default branch.<br />
			Repository name: {repoContext.id.repo}<br />
			Owner: {repoContext.id.org}<br />
			Current branch: {activeRepository.headBranchName}<br />
			{repoDescription ? <>Default branch: {repoDescription?.defaultBranch}<br /></> : ''}
			{repoDescription?.pullRequest ? <>Active pull request: {repoDescription.pullRequest.title} ({repoDescription.pullRequest.url})<br /></> : ''}
		</Tag>;
	}
}

class WorkspaceFoldersHint extends PromptElement<BasePromptElementProps> {
	constructor(
		props: BasePromptElementProps,
		@IWorkspaceService private readonly workspaceService: IWorkspaceService,
		@IPromptPathRepresentationService private readonly promptPathRepresentationService: IPromptPathRepresentationService,
	) {
		super(props);
	}

	async render(state: void, sizing: PromptSizing) {
		const folders = this.workspaceService.getWorkspaceFolders();
		if (folders.length > 0) {
			return (
				<>
					I am working in a workspace with the following folders:<br />
					{folders.map(folder => `- ${this.promptPathRepresentationService.getFilePath(folder)} `).join('\n')}
				</>);
		} else {
			return <>There is no workspace currently open.</>;
		}
	}
}


class AgentTasksInstructions extends PromptElement {
	constructor(
		props: BasePromptElementProps,
		@ITasksService private readonly _tasksService: ITasksService,
		@IPromptPathRepresentationService private readonly _promptPathRepresentationService: IPromptPathRepresentationService,
		@IConfigurationService private readonly _configurationService: IConfigurationService,
	) {
		super(props);
	}

	render() {
		const taskGroupsRaw = this._tasksService.getTasks();
		if (!this._configurationService.getConfig(ConfigKey.AgentCanRunTasks)) {
			return null;
		}

		const taskGroups = taskGroupsRaw.map(([wf, tasks]) => [wf, tasks.filter(task => !!task.type && !task.hide)] as const).filter(([, tasks]) => tasks.length > 0);
		if (taskGroups.length === 0) {
			return 0;
		}

		return <>
			The following tasks can be executed using the {ToolName.RunTask} tool if they are not already running:<br />
			{taskGroups.map(([folder, tasks]) =>
				<Tag name='workspaceFolder' attrs={{ path: this._promptPathRepresentationService.getFilePath(folder) }}>
					{tasks.map((t, i) => {
						const isActive = this._tasksService.isTaskActive(t);
						return (
							<Tag name='task' attrs={{ id: `${t.type}: ${t.label || i}` }}>
								{this.makeTaskPresentation(t)}
								{isActive && <> (This task is currently running. You can use the {ToolName.GetTaskOutput} tool to view its output.)</>}
								{!isActive && <> (This task is not running. Use the {ToolName.GetTaskOutput} tool to view its output and check its status.)</>}
							</Tag>
						);
					})}
				</Tag>
			)}
		</>;
	}

	/** Makes a simplified JSON presentation of the task definition for the model to reference. */
	private makeTaskPresentation(task: TaskDefinition) {
		const enum PlatformAttr {
			Windows = 'windows',
			Mac = 'osx',
			Linux = 'linux'
		}

		const omitAttrs = ['presentation', 'problemMatcher', PlatformAttr.Windows, PlatformAttr.Mac, PlatformAttr.Linux];

		const output: Record<string, unknown> = {};
		for (const [key, value] of Object.entries(task)) {
			if (!omitAttrs.includes(key)) {
				output[key] = value;
			}
		}


		const myPlatformAttr = process.platform === 'win32' ? PlatformAttr.Windows :
			process.platform === 'darwin' ? PlatformAttr.Mac :
				PlatformAttr.Linux;
		if (task[myPlatformAttr] && typeof task[myPlatformAttr] === 'object') {
			Object.assign(output, task[myPlatformAttr]);
		}

		return JSON.stringify(output, null, '\t');
	}
}

export function getEditingReminder(hasEditFileTool: boolean, hasReplaceStringTool: boolean) {
	const lines = [];
	if (hasEditFileTool) {
		lines.push(<>When using the {ToolName.EditFile} tool, avoid repeating existing code, instead use a line comment with \`{EXISTING_CODE_MARKER}\` to represent regions of unchanged code.<br /></>);

	}
	if (hasReplaceStringTool) {
		lines.push(<>When using the {ToolName.ReplaceString} tool, include 3-5 lines of unchanged code before and after the string you want to replace, to make it unambiguous which part of the file should be edited.<br /></>);
	}

	return lines;
}

/**
 * Remind gpt-4.1 to keep going and not stop to ask questions...
 */
export function getKeepGoingReminder(modelFamily: string | undefined) {
	return modelFamily === 'gpt-4.1' ?
		<>
			You are an agent - you must keep going until the user's query is completely resolved, before ending your turn and yielding back to the user. ONLY terminate your turn when you are sure that the problem is solved, or you absolutely cannot continue.<br />
			You take action when possible- the user is expecting YOU to take action and go to work for them. Don't ask unnecessary questions about the details if you can simply DO something useful instead.<br />
		</>
		: undefined;
}

export interface EditedFileEventsProps extends BasePromptElementProps {
	readonly editedFileEvents: readonly ChatRequestEditedFileEvent[] | undefined;
}

/**
 * Context about manual edits made to files that the agent previously edited.
 */
export class EditedFileEvents extends PromptElement<EditedFileEventsProps> {
	constructor(
		props: EditedFileEventsProps,
		@IPromptPathRepresentationService private readonly promptPathRepresentationService: IPromptPathRepresentationService,
	) {
		super(props);
	}

	async render(state: void, sizing: PromptSizing) {
		const events = this.props.editedFileEvents;

		const eventStrs = events && coalesce(events.map(event => this.editedFileEventToString(event)));
		if (eventStrs && eventStrs.length > 0) {
			return (
				<>
					The user has taken some actions between the last request and now:<br />
					{eventStrs.map(str => `- ${str}`).join('\n')}<br />
					So be sure to check the current file contents before making any new edits.
				</>);
		} else {
			return undefined;
		}
	}

	private editedFileEventToString(event: ChatRequestEditedFileEvent): string | undefined {
		switch (event.eventKind) {
			case ChatRequestEditedFileEventKind.Keep:
				return undefined;
			case ChatRequestEditedFileEventKind.Undo:
				return `Undone your edits to ${this.promptPathRepresentationService.getFilePath(event.uri)}`;
			case ChatRequestEditedFileEventKind.UserModification:
				return `Made manual edits to ${this.promptPathRepresentationService.getFilePath(event.uri)}`;
		}
	}
}
