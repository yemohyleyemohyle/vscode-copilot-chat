/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { AsyncLocalStorage } from 'async_hooks';

/**
 * Async local storage for trajectory ID that links main requests with supplemental tool calls
 */
const trajectoryStorage = new AsyncLocalStorage<string>();

export class TrajectoryContext {
	/**
	 * Run a function within a trajectory context with the given trajectory ID
	 */
	static run<T>(trajectoryId: string, fn: () => Promise<T>): Promise<T>;
	static run<T>(trajectoryId: string, fn: () => T): T;
	static run<T>(trajectoryId: string, fn: () => T | Promise<T>): T | Promise<T> {
		return trajectoryStorage.run(trajectoryId, fn);
	}

	/**
	 * Get the current trajectory ID from the async context, if available
	 */
	static getCurrentTrajectoryId(): string | undefined {
		return trajectoryStorage.getStore();
	}
}