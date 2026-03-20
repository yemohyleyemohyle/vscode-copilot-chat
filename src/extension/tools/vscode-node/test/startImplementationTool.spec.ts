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

		test('does not call toggleAgentMode or changeModel — deferred chat.open handles mode+model', async () => {
			vi.useFakeTimers();
			await tool.invoke(fakeOptions, fakeToken);

			const allCommands = executeCommandSpy.mock.calls.map((c: any) => c[0]);
			assert.notInclude(allCommands, 'workbench.action.chat.toggleAgentMode');
			assert.notInclude(allCommands, 'workbench.action.chat.changeModel');
			// chat.open is deferred, not called synchronously
			assert.notInclude(allCommands, 'workbench.action.chat.open');
		});

		test('no synchronous vscode commands are called during invoke', async () => {
			vi.useFakeTimers();
			await tool.invoke(fakeOptions, fakeToken);

			// Only the deferred setTimeout is scheduled; no executeCommand calls during invoke
			assert.equal(executeCommandSpy.mock.calls.length, 0);
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

		test('tool result does not mention mode switching (no toggleAgentMode)', async () => {
			const result = await tool.invoke(fakeOptions, fakeToken);
			const content = (result as any).content ?? (result as any)._content;
			if (content) {
				const text: string = content[0]?.value ?? content[0]?.text ?? '';
				assert.notInclude(text.toLowerCase(), 'switched to agent');
			}
		});
	});

	suite('discoverHandoff', () => {
		test('returns matched handoff when getHandoffs succeeds', async () => {
			executeCommandSpy.mockImplementation(async (cmd: string) => {
				if (cmd === 'workbench.action.chat.getHandoffs') {
					return {
						result: [{
							id: 'plan',
							name: 'Plan',
							handoffs: [
								{
									id: 'agent:start-implementation',
									label: 'Start Implementation',
									agent: 'agent',
									prompt: 'Here is the detailed plan summary...',
								},
								{
									id: 'explore:analyze',
									label: 'Explore',
									agent: 'explore',
									prompt: 'Explore something...',
								},
							],
						}],
					};
				}
				return undefined;
			});

			const handoff = await tool.discoverHandoff();
			assert.ok(handoff);
			assert.equal(handoff!.id, 'agent:start-implementation');
			assert.equal(handoff!.agent, 'agent');
			assert.equal(handoff!.prompt, 'Here is the detailed plan summary...');
		});

		test('returns undefined when getHandoffs returns no result', async () => {
			executeCommandSpy.mockResolvedValue(undefined as any);

			const handoff = await tool.discoverHandoff();
			assert.equal(handoff, undefined);
		});

		test('returns undefined when getHandoffs returns empty result array', async () => {
			executeCommandSpy.mockResolvedValue({ result: [] } as any);

			const handoff = await tool.discoverHandoff();
			assert.equal(handoff, undefined);
		});

		test('returns undefined when handoff ID is not found in response', async () => {
			executeCommandSpy.mockImplementation(async (cmd: string) => {
				if (cmd === 'workbench.action.chat.getHandoffs') {
					return {
						result: [{
							id: 'plan',
							name: 'Plan',
							handoffs: [{
								id: 'explore:something-else',
								label: 'Other',
								agent: 'explore',
								prompt: 'Other prompt...',
							}],
						}],
					};
				}
				return undefined;
			});

			const handoff = await tool.discoverHandoff();
			assert.equal(handoff, undefined);
		});

		test('returns undefined when getHandoffs throws', async () => {
			executeCommandSpy.mockRejectedValue(new Error('Command not found'));

			const handoff = await tool.discoverHandoff();
			assert.equal(handoff, undefined);
		});

		test('calls getHandoffs with correct sourceCustomAgent', async () => {
			executeCommandSpy.mockResolvedValue({ result: [] } as any);

			await tool.discoverHandoff();

			const getHandoffsCalls = executeCommandSpy.mock.calls.filter(
				(c: any) => c[0] === 'workbench.action.chat.getHandoffs'
			);
			assert.equal(getHandoffsCalls.length, 1);
			assert.deepStrictEqual(getHandoffsCalls[0][1], {
				sourceCustomAgent: StartImplementationTool.SOURCE_CHAT_MODE,
			});
		});

		test('searches across multiple agents in response for the handoff', async () => {
			executeCommandSpy.mockImplementation(async (cmd: string) => {
				if (cmd === 'workbench.action.chat.getHandoffs') {
					return {
						result: [
							{
								id: 'explore',
								name: 'Explore',
								handoffs: [{ id: 'explore:other', label: 'Other', agent: 'explore', prompt: 'explore...' }],
							},
							{
								id: 'agent',
								name: 'Agent',
								handoffs: [{ id: 'agent:start-implementation', label: 'Start', agent: 'agent', prompt: 'dynamic plan' }],
							},
						],
					};
				}
				return undefined;
			});

			const handoff = await tool.discoverHandoff();
			assert.ok(handoff);
			assert.equal(handoff!.id, 'agent:start-implementation');
			assert.equal(handoff!.prompt, 'dynamic plan');
		});
	});

	suite('scheduleDeferredHandoff', () => {
		test('calls getHandoffs then chat.open with dynamic prompt after timeout', async () => {
			vi.useFakeTimers();

			executeCommandSpy.mockImplementation(async (cmd: string) => {
				if (cmd === 'workbench.action.chat.getHandoffs') {
					return {
						result: [{
							id: 'plan',
							name: 'Plan',
							handoffs: [{
								id: 'agent:start-implementation',
								label: 'Start Implementation',
								agent: 'agent',
								prompt: 'Dynamic plan summary from core',
							}],
						}],
					};
				}
				return undefined;
			});

			tool.scheduleDeferredHandoff();

			// Before timeout: nothing called
			assert.equal(executeCommandSpy.mock.calls.length, 0);

			await vi.advanceTimersByTimeAsync(StartImplementationTool.HANDOFF_DELAY_MS);

			// After timeout: getHandoffs called first, then chat.open
			const getHandoffsCalls = executeCommandSpy.mock.calls.filter(
				(c: any) => c[0] === 'workbench.action.chat.getHandoffs'
			);
			assert.equal(getHandoffsCalls.length, 1);

			const chatOpenCalls = executeCommandSpy.mock.calls.filter(
				(c: any) => c[0] === 'workbench.action.chat.open'
			);
			assert.equal(chatOpenCalls.length, 1);
			assert.deepStrictEqual(chatOpenCalls[0][1], {
				query: 'Dynamic plan summary from core',
				mode: 'agent',
			});
		});

		test('falls back to FALLBACK_PROMPT when getHandoffs fails', async () => {
			vi.useFakeTimers();

			executeCommandSpy.mockImplementation(async (cmd: string) => {
				if (cmd === 'workbench.action.chat.getHandoffs') {
					throw new Error('Command not available');
				}
				return undefined;
			});

			tool.scheduleDeferredHandoff();
			await vi.advanceTimersByTimeAsync(StartImplementationTool.HANDOFF_DELAY_MS);

			const chatOpenCalls = executeCommandSpy.mock.calls.filter(
				(c: any) => c[0] === 'workbench.action.chat.open'
			);
			assert.equal(chatOpenCalls.length, 1);
			assert.deepStrictEqual(chatOpenCalls[0][1], {
				query: StartImplementationTool.FALLBACK_PROMPT,
				mode: 'agent',
			});
		});

		test('falls back to FALLBACK_PROMPT when handoff ID not found', async () => {
			vi.useFakeTimers();

			executeCommandSpy.mockImplementation(async (cmd: string) => {
				if (cmd === 'workbench.action.chat.getHandoffs') {
					return { result: [{ id: 'plan', name: 'Plan', handoffs: [] }] };
				}
				return undefined;
			});

			tool.scheduleDeferredHandoff();
			await vi.advanceTimersByTimeAsync(StartImplementationTool.HANDOFF_DELAY_MS);

			const chatOpenCalls = executeCommandSpy.mock.calls.filter(
				(c: any) => c[0] === 'workbench.action.chat.open'
			);
			assert.equal(chatOpenCalls.length, 1);
			assert.deepStrictEqual(chatOpenCalls[0][1], {
				query: StartImplementationTool.FALLBACK_PROMPT,
				mode: 'agent',
			});
		});

		test('includes modelSelector when resolvedModel is provided', async () => {
			vi.useFakeTimers();

			executeCommandSpy.mockImplementation(async (cmd: string) => {
				if (cmd === 'workbench.action.chat.getHandoffs') {
					return {
						result: [{
							id: 'plan',
							name: 'Plan',
							handoffs: [{
								id: 'agent:start-implementation',
								label: 'Start',
								agent: 'agent',
								prompt: 'Plan summary',
							}],
						}],
					};
				}
				return undefined;
			});

			const model = { vendor: 'copilot', id: 'claude-sonnet-4', family: 'claude-sonnet' };
			tool.scheduleDeferredHandoff(model);
			await vi.advanceTimersByTimeAsync(StartImplementationTool.HANDOFF_DELAY_MS);

			const chatOpenCalls = executeCommandSpy.mock.calls.filter(
				(c: any) => c[0] === 'workbench.action.chat.open'
			);
			assert.equal(chatOpenCalls.length, 1);
			assert.deepStrictEqual(chatOpenCalls[0][1], {
				query: 'Plan summary',
				mode: 'agent',
				modelSelector: { id: 'claude-sonnet-4', vendor: 'copilot' },
			});
		});

		test('does not include modelSelector when resolvedModel is undefined', async () => {
			vi.useFakeTimers();

			executeCommandSpy.mockImplementation(async (cmd: string) => {
				if (cmd === 'workbench.action.chat.getHandoffs') {
					return {
						result: [{
							id: 'plan',
							name: 'Plan',
							handoffs: [{
								id: 'agent:start-implementation',
								label: 'Start',
								agent: 'agent',
								prompt: 'Plan summary',
							}],
						}],
					};
				}
				return undefined;
			});

			tool.scheduleDeferredHandoff();
			await vi.advanceTimersByTimeAsync(StartImplementationTool.HANDOFF_DELAY_MS);

			const chatOpenCalls = executeCommandSpy.mock.calls.filter(
				(c: any) => c[0] === 'workbench.action.chat.open'
			);
			assert.equal(chatOpenCalls.length, 1);
			// No modelSelector property
			assert.deepStrictEqual(chatOpenCalls[0][1], {
				query: 'Plan summary',
				mode: 'agent',
			});
		});

		test('uses handoff.agent as mode (not hardcoded "agent")', async () => {
			vi.useFakeTimers();

			executeCommandSpy.mockImplementation(async (cmd: string) => {
				if (cmd === 'workbench.action.chat.getHandoffs') {
					return {
						result: [{
							id: 'plan',
							name: 'Plan',
							handoffs: [{
								id: 'agent:start-implementation',
								label: 'Start',
								agent: 'custom-agent-mode',
								prompt: 'Plan summary',
							}],
						}],
					};
				}
				return undefined;
			});

			tool.scheduleDeferredHandoff();
			await vi.advanceTimersByTimeAsync(StartImplementationTool.HANDOFF_DELAY_MS);

			const chatOpenCalls = executeCommandSpy.mock.calls.filter(
				(c: any) => c[0] === 'workbench.action.chat.open'
			);
			assert.equal(chatOpenCalls.length, 1);
			assert.equal(chatOpenCalls[0][1].mode, 'custom-agent-mode');
		});

		test('deferred handoff does not fire before HANDOFF_DELAY_MS', async () => {
			vi.useFakeTimers();
			executeCommandSpy.mockResolvedValue(undefined as any);

			tool.scheduleDeferredHandoff();

			// Advance by less than the delay
			await vi.advanceTimersByTimeAsync(StartImplementationTool.HANDOFF_DELAY_MS - 100);

			// No commands should have been called yet
			assert.equal(executeCommandSpy.mock.calls.length, 0);
		});
	});
});
