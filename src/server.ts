import { buildApp } from './app.js';
import { loadConfig } from './config.js';

async function startServer() {
  const config = loadConfig();
  const app = await buildApp(config);

  const shutdown = async (signal: string) => {
    app.log.info(`Received ${signal}. Shutting down voice-service gracefully...`);
    try {
      await app.close();
      app.log.info('Graceful shutdown completed successfully.');
      process.exit(0);
    } catch (err) {
      app.log.error({ err }, 'Error during graceful shutdown');
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  try {
    await app.listen({ port: config.PORT, host: '0.0.0.0' });
    app.log.info(`[voice-service] Server listening on http://0.0.0.0:${config.PORT}`);
    app.log.info(
      `[voice-service] OpenAPI documentation available at http://0.0.0.0:${config.PORT}/docs`
    );
  } catch (err) {
    app.log.error({ err }, 'Failed to start server');
    process.exit(1);
  }
}

startServer().catch((err) => {
  console.error('[voice-service] Fatal startup error:', err);
  process.exit(1);
});
