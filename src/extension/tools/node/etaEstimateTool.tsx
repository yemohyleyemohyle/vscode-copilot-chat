/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type * as vscode from 'vscode';
import { LanguageModelTextPart, LanguageModelToolResult } from '../../../vscodeTypes';
import { ToolName } from '../common/toolNames';
import { ICopilotTool, ToolRegistry } from '../common/toolsRegistry';

interface IEtaEstimateParams {
	expected_steps: number;
}

class EtaEstimateTool implements ICopilotTool<IEtaEstimateParams> {
	public static readonly toolName = ToolName.EtaEstimate;

	async invoke(options: vscode.LanguageModelToolInvocationOptions<IEtaEstimateParams>, _token: vscode.CancellationToken): Promise<vscode.LanguageModelToolResult> {
		return new LanguageModelToolResult([
			new LanguageModelTextPart('Eta steps collected.')
		]);
	}

	async prepareInvocation(_options: vscode.LanguageModelToolInvocationPrepareOptions<IEtaEstimateParams>, _token: vscode.CancellationToken): Promise<vscode.PreparedToolInvocation> {
		return {
			invocationMessage: `Estimating remaining steps`,
		};
	}
}

ToolRegistry.registerTool(EtaEstimateTool);
