// Vercel serverless entry: wraps the Express app, creating tables on the first request.
const app = require('../src/app');
const { init } = require('../src/db');

let ready;
module.exports = async (req, res) => {
  try {
    ready = ready || init();
    await ready;
  } catch (e) {
    ready = null;
    console.error(e);
    return res.status(500).json({ error: 'database unavailable' });
  }
  return app(req, res);
};
