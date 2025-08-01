/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type * as vscode from 'vscode';
import { IInstantiationService } from '../../../util/vs/platform/instantiation/common/instantiation';
import { LanguageModelTextPart, LanguageModelToolResult } from '../../../vscodeTypes';
import { IBuildPromptContext } from '../../prompt/common/intents';
import { ToolName } from '../common/toolNames';
import { ICopilotTool, ToolRegistry } from '../common/toolsRegistry';
import { IToolsService } from '../common/toolsService';
import { ReadFileParams, ReadFileTool } from './readFileTool';

export interface IMultiReadFileToolParams {
	explanation: string;
	files: ReadFileParams[];
}

export interface IMultiReadResult {
	totalFiles: number;
	successfulReads: number;
	failedReads: number;
	results: Array<{
		operation: ReadFileParams;
		success: boolean;
		error?: string;
	}>;
}

export class MultiReadFileTool implements ICopilotTool<IMultiReadFileToolParams> {
	public static toolName = ToolName.MultiReadFile;

	private _promptContext: IBuildPromptContext | undefined;

	constructor(
		@IInstantiationService protected readonly instantiationService: IInstantiationService,
		@IToolsService protected readonly toolsService: IToolsService
	) { }

	async invoke(options: any, token: any) {
		// Cast the options to the correct type to work around TypeScript issues
		const typedOptions = options as vscode.LanguageModelToolInvocationOptions<IMultiReadFileToolParams> & { input: IMultiReadFileToolParams };

		// Validate input
		if (!typedOptions.input.files || !Array.isArray(typedOptions.input.files) || typedOptions.input.files.length === 0) {
			throw new Error('Invalid input: files array is required and must contain at least one file read operation');
		}

		if (!this._promptContext?.stream) {
			throw new Error('Invalid context: stream is required');
		}

		const results: IMultiReadResult = {
			totalFiles: typedOptions.input.files.length,
			successfulReads: 0,
			failedReads: 0,
			results: []
		};

		// Get the ReadFileTool instance
		const readFileTool = this.instantiationService.createInstance(ReadFileTool);

		// Process file reads sequentially
		for (let i = 0; i < typedOptions.input.files.length; i++) {
			const fileRead = typedOptions.input.files[i];

			try {
				// Validate individual file read
				if (!fileRead.filePath) {
					throw new Error(`Invalid file read at index ${i}: filePath is required`);
				}

				// Create a new tool invocation options for this file read
				const readOptions = {
					...typedOptions,
					input: fileRead
				};

				// Set the prompt context for the read tool
				await readFileTool.resolveInput(fileRead, this._promptContext);

				// Invoke the read file tool
				await readFileTool.invoke(readOptions as any, token);

				// Record success
				results.results.push({
					operation: fileRead,
					success: true
				});
				results.successfulReads++;

			} catch (error) {
				// Record failure
				const errorMessage = error instanceof Error ? error.message : String(error);
				results.results.push({
					operation: fileRead,
					success: false,
					error: errorMessage
				});
				results.failedReads++;

				// Add error information to the stream using the correct method
				(this._promptContext.stream as any).markdown(`\n⚠️ **Failed read operation ${i + 1}:**\n`);
				(this._promptContext.stream as any).markdown(`- File: \`${fileRead.filePath}\`\n`);
				(this._promptContext.stream as any).markdown(`- Error: ${errorMessage}\n\n`);
			}
		}

		// Provide summary using the correct method
		(this._promptContext.stream as any).markdown(`\n## Multi-Read Summary\n\n`);
		(this._promptContext.stream as any).markdown(`- **Total operations:** ${results.totalFiles}\n`);
		(this._promptContext.stream as any).markdown(`- **Successfully read:** ${results.successfulReads}\n`);
		(this._promptContext.stream as any).markdown(`- **Failed:** ${results.failedReads}\n\n`);

		if (results.failedReads > 0) {
			(this._promptContext.stream as any).markdown(`### Failed Read Operations:\n\n`);
			results.results.filter(r => !r.success).forEach((result, index) => {
				if (this._promptContext?.stream) {
					(this._promptContext.stream as any).markdown(`${index + 1}. **${result.operation.filePath}**\n`);
					(this._promptContext.stream as any).markdown(`   - Error: ${result.error || 'Unknown error'}\n\n`);
				}
			});
		}

		// Return a simple result
		return new LanguageModelToolResult([
			new LanguageModelTextPart(
				`Multi-read operation completed: ${results.successfulReads}/${results.totalFiles} operations successful.`
			)
		]);
	}

	async resolveInput(input: IMultiReadFileToolParams, promptContext: IBuildPromptContext): Promise<IMultiReadFileToolParams> {
		this._promptContext = promptContext;
		return input;
	}

	prepareInvocation(options: any, token: any): any {
		return {
			presentation: 'hidden'
		};
	}
}

ToolRegistry.registerTool(MultiReadFileTool);
