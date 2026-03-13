/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { assert } from 'chai';
import { afterEach, beforeEach, suite, test, vi } from 'vitest';
import * as vscode from 'vscode';
import { ToolName } from '../../common/toolNames';
import { StartImplementationTool } from '../startImplementationTool';

suite('StartImplementationTool', () => {
	let tool: StartImplementationTool;
	let executeCommandSpy: ReturnType<typeof vi.spyOn>;
	let selectChatModelsSpy: ReturnType<typeof vi.spyOn>;
	let getConfigurationSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		tool = new StartImplementationTool();

		executeCommandSpy = vi.spyOn(vscode.commands, 'executeCommand').mockResolvedValue(undefined as any);
		selectChatModelsSpy = vi.spyOn(vscode.lm, 'selectChatModels').mockResolvedValue([] as any);
		getConfigurationSpy = vi.spyOn(vscode.workspace, 'getConfiguration').mockReturnValue({
			get: () => undefined,
		} as any);
	});

	afterEach(() => {
		vi.restoreAllMocks();
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

			assert.equal(executeCommandSpy.mock.calls.length, 1);
			assert.equal(executeCommandSpy.mock.calls[0][0], 'workbench.action.chat.toggleAgentMode');
			assert.deepStrictEqual(executeCommandSpy.mock.calls[0][1], {
				modeId: 'agent',
				sessionResource: fakeOptions.chatSessionResource,
			});
		});

		test('passes model in toggleAgentMode and calls changeModel after when implement model is configured', async () => {
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

			// Should have called toggleAgentMode with model
			assert.equal(executeCommandSpy.mock.calls.length, 2);
			assert.equal(executeCommandSpy.mock.calls[0][0], 'workbench.action.chat.toggleAgentMode');
			assert.deepStrictEqual(executeCommandSpy.mock.calls[0][1], {
				modeId: 'agent',
				sessionResource: fakeOptions.chatSessionResource,
				model: { vendor: 'copilot', id: 'claude-opus-4.6', family: 'claude-opus' },
			});

			// Should have called changeModel after toggleAgentMode
			assert.equal(executeCommandSpy.mock.calls[1][0], 'workbench.action.chat.changeModel');
			assert.deepStrictEqual(executeCommandSpy.mock.calls[1][1], {
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

			// Only toggleAgentMode, no changeModel
			assert.equal(executeCommandSpy.mock.calls.length, 1);
			assert.equal(executeCommandSpy.mock.calls[0][0], 'workbench.action.chat.toggleAgentMode');
			assert.deepStrictEqual(executeCommandSpy.mock.calls[0][1], {
				modeId: 'agent',
				sessionResource: fakeOptions.chatSessionResource,
			});
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

		test('returns tool result with instructions for the implementation agent', async () => {
			const result = await tool.invoke(fakeOptions, fakeToken);
			assert.ok(result);
		});
	});
});
