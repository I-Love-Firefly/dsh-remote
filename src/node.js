import z from '@deepseek-ai/schemastery';
import { readFile } from 'node:fs/promises';
import { startTunnel } from './tunnel.mjs';
export const name = 'dsh-remote';
export const inject = ['webServer', 'connection'];
export const Config = z.object({ configFile: z.string().default('') });
export async function apply(ctx, config) {
  const current = typeof config.get === 'function' ? config.get() : config;
  const file = current.configFile || process.env.DSH_REMOTE_CONFIG;
  if (!file) { ctx.logger.info('Set DSH_REMOTE_CONFIG to a private relay configuration file to enable remote access.'); return; }
  const options = JSON.parse(await readFile(file, 'utf8'));
  ctx.effect(() => {
    const tunnel = startTunnel({ ...options,
      getLocalUrl: () => {
        const server = ctx.webServer;
        return ctx.connection.authenticatedUrl(`${server.protocol}//127.0.0.1:${server.port}/`);
      },
      onStatus: status => ctx.logger.info(`Remote relay: ${status}`),
    });
    return () => tunnel.close();
  });
}
