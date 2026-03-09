/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { assert } from 'chai';
import { suite, test } from 'vitest';
import { ToolName } from '../../common/toolNames';
import { StartImplementationTool } from '../startImplementationTool';

suite('StartImplementationTool', () => {
	test('has correct static toolName matching ToolName enum', () => {
		assert.equal(StartImplementationTool.toolName, ToolName.StartImplementation);
		assert.equal(StartImplementationTool.toolName, 'vscode_startImplementation');
	});
});
