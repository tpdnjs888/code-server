import { field } from '@coder/logger';
import { setUnexpectedErrorHandler } from 'vs/base/common/errors';
import { CodeServerMessage, VscodeMessage } from 'vs/server/ipc';
import { logger } from 'vs/server/node/logger';
import { enableCustomMarketplace } from 'vs/server/node/marketplace';
import { Vscode } from 'vs/server/node/server';
import * as proxyAgent from 'vs/base/node/proxy_agent';

setUnexpectedErrorHandler((error) => logger.warn(error instanceof Error ? error.message : error));
enableCustomMarketplace();
proxyAgent.monkeyPatch(true);

/**
 * Ensure we control when the process exits.
 */
const exit = process.exit;
process.exit = function(code?: number) {
	logger.warn(`process.exit() was prevented: ${code || 'unknown code'}.`);
} as (code?: number) => never;

// Kill VS Code if the parent process dies.
if (typeof process.env.CODE_SERVER_PARENT_PID !== 'undefined') {
	const parentPid = parseInt(process.env.CODE_SERVER_PARENT_PID, 10);
	setInterval(() => {
		try {
			process.kill(parentPid, 0); // Throws an exception if the process doesn't exist anymore.
		} catch (e) {
			exit();
		}
	}, 5000);
} else {
	logger.error('no parent process');
	exit(1);
}

const vscode = new Vscode();
const send = (message: VscodeMessage): void => {
	if (!process.send) {
		throw new Error('not spawned with IPC');
	}
	process.send(message);
};

// Wait for the init message then start up VS Code. Subsequent messages will
// return new workbench options without starting a new instance.
process.on('message', async (message: CodeServerMessage, socket) => {
	logger.debug('got message from code-server', field('type', message.type));
	logger.trace('code-server message content', field('message', message));
	switch (message.type) {
		case 'init':
			try {
				const options = await vscode.initialize(message.options);
				send({ type: 'options', id: message.id, options });
			} catch (error) {
				logger.error(error.message);
				logger.error(error.stack);
				exit(1);
			}
			break;
		case 'cli':
			try {
				await vscode.cli(message.args);
				exit(0);
			} catch (error) {
				logger.error(error.message);
				logger.error(error.stack);
				exit(1);
			}
			break;
		case 'socket':
			vscode.handleWebSocket(socket, message.query, message.permessageDeflate);
			break;
	}
});
if (!process.send) {
	logger.error('not spawned with IPC');
	exit(1);
} else {
	// This lets the parent know the child is ready to receive messages.
	send({ type: 'ready' });
}
