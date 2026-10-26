const app = require('./app');
const { init } = require('./db');

if (!process.env.API_KEY) console.warn('WARNING: API_KEY is not set; every API request will be rejected.');

init()
  .then(() => {
    const port = process.env.PORT || 3000;
    app.listen(port, () => console.log(`listening on ${port}`));
  })
  .catch((e) => {
    console.error('failed to start', e);
    process.exit(1);
  });
