const { createApp } = require('./app');
const { migrate, pool } = require('./db');

const PORT = Number(process.env.PORT || 3000);

async function main() {
  await migrate();
  const app = createApp({ apiKey: process.env.API_KEY });
  const server = app.listen(PORT, () => console.log(`clinic-booking-api listening on :${PORT}`));

  const shutdown = () => {
    server.close(() => pool.end().finally(() => process.exit(0)));
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((err) => {
  console.error('failed to start:', err);
  process.exit(1);
});
