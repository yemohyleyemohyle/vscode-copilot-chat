/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { assert } from 'chai';
import { afterEach, beforeEach, suite, test, vi } from 'vitest';
import * as vscode from 'vscode';
import { TestLogService } from '../../../../platform/testing/common/testLogService';
import { ToolName } from '../../common/toolNames';
import { StartImplementationTool } from '../startImplementationTool';

suite('StartImplementationTool', () => {
	let tool: StartImplementationTool;
	let executeCommandSpy: any;
	let selectChatModelsSpy: any;
	let getConfigurationSpy: any;

	beforeEach(() => {
		tool = new StartImplementationTool(new TestLogService());

		executeCommandSpy = vi.spyOn(vscode.commands, 'executeCommand').mockResolvedValue(undefined as any);
		selectChatModelsSpy = vi.spyOn(vscode.lm, 'selectChatModels').mockResolvedValue([] as any);
		getConfigurationSpy = vi.spyOn(vscode.workspace, 'getConfiguration').mockReturnValue({
			get: () => undefined,
		} as any);
	});

	afterEach(() => {
		vi.restoreAllMocks();
		vi.useRealTimers();
	});

	test('has correct static toolName matching ToolName enum', () => {
		assert.equal(StartImplementationTool.toolName, ToolName.StartImplementation);
		assert.equal(StartImplementationTool.toolName, 'vscode_startImplementation');
	});

	suite('resolveImplementModel', () => {
		test('returns undefined when no model setting is configured', async () => {
			const result = await tool.resolveImplementModel();
			assert.equal(result, undefined);
		});

		test('returns undefined when model setting is empty string', async () => {
			getConfigurationSpy.mockReturnValue({
				get: () => '',
			} as any);

			const result = await tool.resolveImplementModel();
			assert.equal(result, undefined);
		});

		test('resolves model by id when available', async () => {
			getConfigurationSpy.mockReturnValue({
				get: () => 'claude-opus-4.6',
			} as any);

			selectChatModelsSpy.mockImplementation(async (selector: { id?: string; family?: string }) => {
				if (selector.id === 'claude-opus-4.6') {
					return [{ vendor: 'copilot', id: 'claude-opus-4.6', family: 'claude-opus' }];
				}
				return [];
			});

			const result = await tool.resolveImplementModel();
			assert.deepStrictEqual(result, { vendor: 'copilot', id: 'claude-opus-4.6', family: 'claude-opus' });
		});

		test('falls back to family when id lookup returns no models', async () => {
			getConfigurationSpy.mockReturnValue({
				get: () => 'claude-opus',
			} as any);

			selectChatModelsSpy.mockImplementation(async (selector: { id?: string; family?: string }) => {
				if (selector.id === 'claude-opus') {
					return [];
				}
				if (selector.family === 'claude-opus') {
					return [{ vendor: 'copilot', id: 'claude-opus-4.6', family: 'claude-opus' }];
				}
				return [];
			});

			const result = await tool.resolveImplementModel();
			assert.deepStrictEqual(result, { vendor: 'copilot', id: 'claude-opus-4.6', family: 'claude-opus' });

			// Should have tried id first, then family
			assert.equal(selectChatModelsSpy.mock.calls.length, 2);
			assert.deepStrictEqual(selectChatModelsSpy.mock.calls[0][0], { id: 'claude-opus', vendor: 'copilot' });
			assert.deepStrictEqual(selectChatModelsSpy.mock.calls[1][0], { family: 'claude-opus', vendor: 'copilot' });
		});

		test('returns undefined when model cannot be resolved by id or family', async () => {
			getConfigurationSpy.mockReturnValue({
				get: () => 'nonexistent-model',
			} as any);

			selectChatModelsSpy.mockResolvedValue([] as any);

			const result = await tool.resolveImplementModel();
			assert.equal(result, undefined);
		});
	});

	suite('invoke', () => {
		const fakeOptions = {
			input: {},
			chatSessionResource: { toString: () => 'vscode-chat-session://test/session1' },
		} as any;
		const fakeToken = {} as any;

		test('calls toggleAgentMode without model when no implement model is configured', async () => {
			await tool.invoke(fakeOptions, fakeToken);

			const toggleCalls = executeCommandSpy.mock.calls.filter((c: any) => c[0] === 'workbench.action.chat.toggleAgentMode');
			assert.equal(toggleCalls.length, 1);
			assert.deepStrictEqual(toggleCalls[0][1], {
				modeId: 'agent',
				sessionResource: fakeOptions.chatSessionResource,
			});
		});

		test('passes model in toggleAgentMode and calls changeModel when implement model is configured', async () => {
			getConfigurationSpy.mockReturnValue({
				get: () => 'claude-opus-4.6',
			} as any);

			selectChatModelsSpy.mockImplementation(async (selector: { id?: string }) => {
				if (selector.id === 'claude-opus-4.6') {
					return [{ vendor: 'copilot', id: 'claude-opus-4.6', family: 'claude-opus' }];
				}
				return [];
			});

			await tool.invoke(fakeOptions, fakeToken);

			const toggleCalls = executeCommandSpy.mock.calls.filter((c: any) => c[0] === 'workbench.action.chat.toggleAgentMode');
			assert.equal(toggleCalls.length, 1);
			assert.deepStrictEqual(toggleCalls[0][1], {
				modeId: 'agent',
				sessionResource: fakeOptions.chatSessionResource,
				model: { vendor: 'copilot', id: 'claude-opus-4.6', family: 'claude-opus' },
			});

			const changeModelCalls = executeCommandSpy.mock.calls.filter((c: any) => c[0] === 'workbench.action.chat.changeModel');
			assert.equal(changeModelCalls.length, 1);
			assert.deepStrictEqual(changeModelCalls[0][1], {
				vendor: 'copilot',
				id: 'claude-opus-4.6',
				family: 'claude-opus',
			});
		});

		test('does not call changeModel when model resolution fails', async () => {
			getConfigurationSpy.mockReturnValue({
				get: () => 'nonexistent-model',
			} as any);

			selectChatModelsSpy.mockResolvedValue([] as any);

			await tool.invoke(fakeOptions, fakeToken);

			const toggleCalls = executeCommandSpy.mock.calls.filter((c: any) => c[0] === 'workbench.action.chat.toggleAgentMode');
			const changeModelCalls = executeCommandSpy.mock.calls.filter((c: any) => c[0] === 'workbench.action.chat.changeModel');
			assert.equal(toggleCalls.length, 1);
			assert.equal(changeModelCalls.length, 0);
		});

		test('calls toggleAgentMode before changeModel (correct order)', async () => {
			const callOrder: string[] = [];
			executeCommandSpy.mockImplementation(async (command: string) => {
				callOrder.push(command);
			});

			getConfigurationSpy.mockReturnValue({
				get: () => 'claude-opus-4.6',
			} as any);

			selectChatModelsSpy.mockResolvedValue([
				{ vendor: 'copilot', id: 'claude-opus-4.6', family: 'claude-opus' },
			] as any);

			await tool.invoke(fakeOptions, fakeToken);

			assert.deepStrictEqual(callOrder, [
				'workbench.action.chat.toggleAgentMode',
				'workbench.action.chat.changeModel',
			]);
		});

		test('has scheduleDeferredHandoff method for deferred chat.open submission', () => {
			// The tool uses scheduleDeferredHandoff to submit a deferred chat.open
			// command after the Plan response completes. This is necessary because
			// Plan mode uses target: 'vscode' (VS Code core owns the loop), making
			// the ToolCallingLoop._runLoop() follow-up injection dead code.
			assert.equal(typeof (tool as any).scheduleDeferredHandoff, 'function');
		});

		test('returns tool result that tells planner to conclude', async () => {
			const result = await tool.invoke(fakeOptions, fakeToken);
			assert.ok(result);
			const content = (result as any).content ?? (result as any)._content;
			if (content) {
				const text = content[0]?.value ?? content[0]?.text ?? '';
				assert.include(text, 'Summarize the plan briefly and conclude');
				assert.include(text, 'follow-up implementation request');
				assert.notInclude(text.toLowerCase(), 'do not call any more tools');
			}
		});

		test('invoke only calls toggleAgentMode and changeModel synchronously — chat.open is deferred', async () => {
			getConfigurationSpy.mockReturnValue({
				get: () => 'claude-opus-4.6',
			} as any);

			selectChatModelsSpy.mockResolvedValue([
				{ vendor: 'copilot', id: 'claude-opus-4.6', family: 'claude-opus' },
			] as any);

			vi.useFakeTimers();
			await tool.invoke(fakeOptions, fakeToken);

			// Synchronous commands: only toggleAgentMode and changeModel
			const allCommands = executeCommandSpy.mock.calls.map((c: any) => c[0]);
			assert.notInclude(allCommands, 'type');
			assert.notInclude(allCommands, 'workbench.action.chat.submit');
			assert.notInclude(allCommands, 'workbench.panel.chat.view.copilot.focus');
			assert.notInclude(allCommands, 'editor.action.selectAll');
			// chat.open is NOT called synchronously — it's deferred via setTimeout
			assert.notInclude(allCommands, 'workbench.action.chat.open');
		});

		test('deferred handoff calls chat.open after timeout fires', async () => {
			vi.useFakeTimers();
			await tool.invoke(fakeOptions, fakeToken);

			// Before timeout: no chat.open call
			const chatOpenBefore = executeCommandSpy.mock.calls.filter((c: any) => c[0] === 'workbench.action.chat.open');
			assert.equal(chatOpenBefore.length, 0);

			// Advance timers to trigger the deferred handoff
			await vi.advanceTimersByTimeAsync(StartImplementationTool.HANDOFF_DELAY_MS);

			// After timeout: chat.open should have been called
			const chatOpenAfter = executeCommandSpy.mock.calls.filter((c: any) => c[0] === 'workbench.action.chat.open');
			assert.equal(chatOpenAfter.length, 1);
			assert.deepStrictEqual(chatOpenAfter[0][1], {
				query: 'Start implementation. Read the plan from /memories/session/plan.md and execute it.',
				mode: 'agent',
			});
		});

		test('deferred handoff includes modelSelector when model is configured', async () => {
			vi.useFakeTimers();

			getConfigurationSpy.mockReturnValue({
				get: () => 'claude-sonnet-4',
			} as any);

			selectChatModelsSpy.mockResolvedValue([
				{ vendor: 'copilot', id: 'claude-sonnet-4', family: 'claude-sonnet' },
			] as any);

			await tool.invoke(fakeOptions, fakeToken);
			await vi.advanceTimersByTimeAsync(StartImplementationTool.HANDOFF_DELAY_MS);

			const chatOpenCalls = executeCommandSpy.mock.calls.filter((c: any) => c[0] === 'workbench.action.chat.open');
			assert.equal(chatOpenCalls.length, 1);
			assert.deepStrictEqual(chatOpenCalls[0][1], {
				query: 'Start implementation. Read the plan from /memories/session/plan.md and execute it.',
				mode: 'agent',
				modelSelector: { id: 'claude-sonnet-4', vendor: 'copilot' },
			});
		});

		test('deferred handoff does not include modelSelector when no model configured', async () => {
			vi.useFakeTimers();
			await tool.invoke(fakeOptions, fakeToken);
			await vi.advanceTimersByTimeAsync(StartImplementationTool.HANDOFF_DELAY_MS);

			const chatOpenCalls = executeCommandSpy.mock.calls.filter((c: any) => c[0] === 'workbench.action.chat.open');
			assert.equal(chatOpenCalls.length, 1);
			// No modelSelector property
			assert.deepStrictEqual(chatOpenCalls[0][1], {
				query: 'Start implementation. Read the plan from /memories/session/plan.md and execute it.',
				mode: 'agent',
			});
		});
	});
});
