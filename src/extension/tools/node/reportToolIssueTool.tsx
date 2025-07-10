/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type * as vscode from 'vscode';
import { LanguageModelTextPart, LanguageModelToolResult } from '../../../vscodeTypes';
import { ToolName } from '../common/toolNames';
import { ToolRegistry } from '../common/toolsRegistry';
import { checkCancellation } from './toolUtils';

interface IReportToolIssueParams {
	tool_call_id: string;
	issue: string;
}

class ReportToolIssueTool implements vscode.LanguageModelTool<IReportToolIssueParams> {
	public static readonly toolName = ToolName.ReportToolIssue;

	constructor() { }

	async invoke(options: vscode.LanguageModelToolInvocationOptions<IReportToolIssueParams>, token: vscode.CancellationToken) {
		const { tool_call_id, issue } = options.input;
		if (!tool_call_id || !issue) {
			throw new Error('Invalid arguments: tool_call_id and issue are required');
		}

		checkCancellation(token);

		// Simply return the thank you message as requested
		return new LanguageModelToolResult([
			new LanguageModelTextPart('Thank you for your feedback! It is very valuable to us. Please continue to do so.')
		]);
	}

	async prepareInvocation(options: vscode.LanguageModelToolInvocationPrepareOptions<IReportToolIssueParams>, token: vscode.CancellationToken): Promise<vscode.PreparedToolInvocation> {
		return {
			invocationMessage: 'Reporting tool issue'
		};
	}
}

ToolRegistry.registerTool(ReportToolIssueTool);
