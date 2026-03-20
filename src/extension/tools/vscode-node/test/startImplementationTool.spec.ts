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

	beforeEach(() => {
		tool = new StartImplementationTool(new TestLogService());
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	test('has correct static toolName matching ToolName enum', () => {
		assert.equal(StartImplementationTool.toolName, ToolName.StartImplementation);
		assert.equal(StartImplementationTool.toolName, 'vscode_startImplementation');
	});

	suite('invoke', () => {
		const fakeOptions = {
			input: {},
			chatSessionResource: { toString: () => 'vscode-chat-session://test/session1' },
		} as any;
		const fakeToken = {} as any;

		test('returns a LanguageModelToolResult', async () => {
			const result = await tool.invoke(fakeOptions, fakeToken);
			assert.ok(result);
		});

		test('result text tells planner to summarize and conclude', async () => {
			const result = await tool.invoke(fakeOptions, fakeToken);
			const content = (result as any).content ?? (result as any)._content;
			assert.ok(content);
			const text: string = content[0]?.value ?? content[0]?.text ?? '';
			assert.include(text, 'Summarize the plan briefly');
			assert.include(text, 'automatically begin implementation');
		});

		test('does not execute any vscode commands', async () => {
			const spy = vi.spyOn(vscode.commands, 'executeCommand').mockResolvedValue(undefined as any);
			await tool.invoke(fakeOptions, fakeToken);
			assert.equal(spy.mock.calls.length, 0);
		});

		test('does not set any timers (no deferred handoff)', async () => {
			vi.useFakeTimers();
			const spy = vi.spyOn(vscode.commands, 'executeCommand').mockResolvedValue(undefined as any);

			await tool.invoke(fakeOptions, fakeToken);

			// Advance time well past any hypothetical deferred timeout
			await vi.advanceTimersByTimeAsync(10_000);
			assert.equal(spy.mock.calls.length, 0);

			vi.useRealTimers();
		});
	});

	suite('prepareInvocation', () => {
		const fakeOptions = { input: {} } as any;
		const fakeToken = {} as any;

		test('returns invocationMessage and pastTenseMessage', () => {
			const prepared = tool.prepareInvocation(fakeOptions, fakeToken);
			assert.ok(prepared);
			assert.ok((prepared as any).invocationMessage);
			assert.ok((prepared as any).pastTenseMessage);
		});
	});
});
