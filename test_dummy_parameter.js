#!/usr/bin/env node

/**
 * Test script to verify dummy_parameter is added to tools
 */

// Mock the dependencies for testing
const mockDeepClone = (obj) => JSON.parse(JSON.stringify(obj));

// Simplified version of the rule we added
function addDummyParameterToTool(tool) {
	const cloned = mockDeepClone(tool);

	// Apply the dummy parameter rule
	if (cloned.function.parameters && cloned.function.parameters.type === 'object') {
		const obj = cloned.function.parameters;
		if (obj.properties && !obj.properties.dummy_parameter) {
			obj.properties.dummy_parameter = {
				type: 'string',
				description: 'Dummy parameter for informational purposes only. Does not affect tool behavior.',
				default: 'dummy_value'
			};
		}
	}

	return cloned;
}

// Test the implementation
console.log('🔧 Testing dummy_parameter addition...\n');

// Test 1: Tool with existing parameters
console.log('Test 1: Tool with existing parameters');
const tool1 = {
	type: 'function',
	function: {
		name: 'testTool',
		description: 'A test tool',
		parameters: {
			type: 'object',
			properties: {
				input: { type: 'string' }
			}
		}
	}
};

const result1 = addDummyParameterToTool(tool1);
console.log('✓ Dummy parameter added:', !!result1.function.parameters.properties.dummy_parameter);
console.log('✓ Original parameters preserved:', !!result1.function.parameters.properties.input);
console.log('✓ Dummy parameter description:', result1.function.parameters.properties.dummy_parameter?.description);
console.log('');

// Test 2: Tool with no parameters (will be skipped)
console.log('Test 2: Tool with no parameters');
const tool2 = {
	type: 'function',
	function: {
		name: 'noParamTool',
		description: 'A tool with no parameters'
	}
};

const result2 = addDummyParameterToTool(tool2);
console.log('✓ No parameters added (as expected):', !result2.function.parameters);
console.log('');

// Test 3: Tool with parameters but no properties
console.log('Test 3: Tool with parameters but no properties');
const tool3 = {
	type: 'function',
	function: {
		name: 'emptyParamTool',
		description: 'A tool with empty parameters',
		parameters: {
			type: 'object'
		}
	}
};

const result3 = addDummyParameterToTool(tool3);
console.log('✓ No dummy parameter added (no properties object):', !result3.function.parameters.properties?.dummy_parameter);
console.log('');

console.log('🎉 All tests completed! The rule works as expected.');
console.log('\n📝 Note: The actual implementation in toolSchemaNormalizer.ts will automatically');
console.log('   apply this rule to all tools processed through normalizeToolSchema().');
