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

		beforeEach(() => {
			// Stub scheduleDeferredResubmission to prevent real intervals in tests
			vi.spyOn(tool, 'scheduleDeferredResubmission').mockImplementation(() => { });
		});

		test('calls toggleAgentMode without prompt/send when no implement model is configured', async () => {
			await tool.invoke(fakeOptions, fakeToken);

			const toggleCalls = executeCommandSpy.mock.calls.filter((c: any) => c[0] === 'workbench.action.chat.toggleAgentMode');
			assert.equal(toggleCalls.length, 1);
			assert.deepStrictEqual(toggleCalls[0][1], {
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

			// Should have called toggleAgentMode with model but NOT prompt/send
			const toggleCalls = executeCommandSpy.mock.calls.filter((c: any) => c[0] === 'workbench.action.chat.toggleAgentMode');
			assert.equal(toggleCalls.length, 1);
			assert.deepStrictEqual(toggleCalls[0][1], {
				modeId: 'agent',
				sessionResource: fakeOptions.chatSessionResource,
				model: { vendor: 'copilot', id: 'claude-opus-4.6', family: 'claude-opus' },
			});

			// Should have called changeModel after toggleAgentMode
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

		test('schedules deferred resubmission with resolved model', async () => {
			getConfigurationSpy.mockReturnValue({
				get: () => 'claude-opus-4.6',
			} as any);

			selectChatModelsSpy.mockResolvedValue([
				{ vendor: 'copilot', id: 'claude-opus-4.6', family: 'claude-opus' },
			] as any);

			await tool.invoke(fakeOptions, fakeToken);
			const spy = tool.scheduleDeferredResubmission as any;
			assert.equal(spy.mock.calls.length, 1);
			assert.deepStrictEqual(spy.mock.calls[0][0], {
				vendor: 'copilot',
				id: 'claude-opus-4.6',
				family: 'claude-opus',
			});
		});

		test('schedules deferred resubmission with undefined when no model', async () => {
			await tool.invoke(fakeOptions, fakeToken);
			const spy = tool.scheduleDeferredResubmission as any;
			assert.equal(spy.mock.calls.length, 1);
			assert.equal(spy.mock.calls[0][0], undefined);
		});

		test('returns tool result instructing the LLM to stop', async () => {
			const result = await tool.invoke(fakeOptions, fakeToken);
			assert.ok(result);
			const content = (result as any).content ?? (result as any)._content;
			if (content) {
				const text = content[0]?.value ?? content[0]?.text ?? '';
				assert.include(text, 'Do NOT call any more tools');
			}
		});
	});

	suite('scheduleDeferredResubmission', () => {
		test('submits implementation request after poll interval', async () => {
			vi.useFakeTimers();
			const submitSpy = vi.spyOn(tool as any, 'submitImplementationRequest').mockResolvedValue(undefined);

			tool.scheduleDeferredResubmission();

			// Should not have submitted yet
			assert.equal(submitSpy.mock.calls.length, 0);

			// Advance past the poll interval
			await vi.advanceTimersByTimeAsync(2000);

			// Should have attempted submission
			assert.equal(submitSpy.mock.calls.length, 1);
		});

		test('passes resolvedModel to submitImplementationRequest', async () => {
			vi.useFakeTimers();
			const submitSpy = vi.spyOn(tool as any, 'submitImplementationRequest').mockResolvedValue(undefined);
			const model = { vendor: 'copilot', id: 'claude-opus-4.6', family: 'claude-opus' };

			tool.scheduleDeferredResubmission(model);

			await vi.advanceTimersByTimeAsync(2000);
			assert.equal(submitSpy.mock.calls.length, 1);
			assert.deepStrictEqual(submitSpy.mock.calls[0][0], model);
		});

		test('retries on failure', async () => {
			vi.useFakeTimers();
			let callCount = 0;
			vi.spyOn(tool as any, 'submitImplementationRequest').mockImplementation(async () => {
				callCount++;
				if (callCount === 1) {
					throw new Error('Not ready yet');
				}
			});

			tool.scheduleDeferredResubmission();

			// First attempt fails
			await vi.advanceTimersByTimeAsync(2000);
			assert.equal(callCount, 1);

			// Second attempt succeeds
			await vi.advanceTimersByTimeAsync(2000);
			assert.equal(callCount, 2);
		});

		test('times out after max duration', async () => {
			vi.useFakeTimers();
			const submitSpy = vi.spyOn(tool as any, 'submitImplementationRequest').mockRejectedValue(new Error('Always fails'));

			tool.scheduleDeferredResubmission();

			// Advance well past timeout (30s)
			await vi.advanceTimersByTimeAsync(31_000);

			// Should have stopped trying (interval cleared)
			const callsBefore = submitSpy.mock.calls.length;
			await vi.advanceTimersByTimeAsync(5_000);
			const callsAfter = submitSpy.mock.calls.length;
			assert.equal(callsBefore, callsAfter);
		});
	});

	suite('submitImplementationRequest', () => {
		test('uses chat.open with query, mode, and isPartialQuery then submits', async () => {
			vi.useFakeTimers();
			const commandCalls: Array<{ command: string; args: any }> = [];
			executeCommandSpy.mockImplementation(async (command: string, args: any) => {
				commandCalls.push({ command, args });
			});

			const submitPromise = (tool as any).submitImplementationRequest();
			// Advance past settle delay
			await vi.advanceTimersByTimeAsync(2000);
			await submitPromise;

			// Should open chat with query (not use type command)
			const openCall = commandCalls.find(c => c.command === 'workbench.action.chat.open');
			assert.ok(openCall, 'should call workbench.action.chat.open');
			assert.deepStrictEqual(openCall!.args, {
				query: 'Start implementation',
				mode: 'agent',
				isPartialQuery: true,
			});

			// Should submit
			const submitCall = commandCalls.find(c => c.command === 'workbench.action.chat.submit');
			assert.ok(submitCall, 'should call workbench.action.chat.submit');

			// Should NOT use the type command
			const typeCall = commandCalls.find(c => c.command === 'type');
			assert.equal(typeCall, undefined, 'should not use type command');
		});

		test('calls changeModel between chat.open and submit when model is provided', async () => {
			vi.useFakeTimers();
			const callOrder: string[] = [];
			executeCommandSpy.mockImplementation(async (command: string) => {
				callOrder.push(command);
			});

			const model = { vendor: 'copilot', id: 'claude-opus-4.6', family: 'claude-opus' };
			const submitPromise = (tool as any).submitImplementationRequest(model);
			await vi.advanceTimersByTimeAsync(2000);
			await submitPromise;

			assert.deepStrictEqual(callOrder, [
				'workbench.action.chat.open',
				'workbench.action.chat.changeModel',
				'workbench.action.chat.submit',
			]);
		});

		test('skips changeModel when no model is provided', async () => {
			vi.useFakeTimers();
			const callOrder: string[] = [];
			executeCommandSpy.mockImplementation(async (command: string) => {
				callOrder.push(command);
			});

			const submitPromise = (tool as any).submitImplementationRequest();
			await vi.advanceTimersByTimeAsync(2000);
			await submitPromise;

			assert.deepStrictEqual(callOrder, [
				'workbench.action.chat.open',
				'workbench.action.chat.submit',
			]);
		});
	});
});
